import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { uninstall } from "../scripts/uninstall-mac.js";

// Uninstalling the desktop (scripts/uninstall-mac.js, docs/uninstall.md). Found
// in the long-running review (2026-09-29): there was no way out that did not
// leave the conversations, the Codex transcripts, the Keychain item and the
// privacy permissions behind. Listed by default; moved to the Trash, never
// deleted, when asked; the person's own task folders only when asked for too.
async function mac(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), "idou-uninstall-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const dir of ["Library/Application Support/i豆/accounts/a", ".idou/run", "i豆/2026-09-30", "Library/Caches/io.github.scott987-cmd.idou", "Documents/unrelated"]) {
    await mkdir(path.join(home, dir), { recursive: true });
  }
  await writeFile(path.join(home, "i豆", "2026-09-30", "产出.md"), "你的文件");
  await mkdir(path.join(home, ".Trash", "i豆"), { recursive: true });
  // The applications folder is this fake Mac's own: never the real /Applications
  // (a first version of this test reached it through a default, 2026-09-30).
  const applications = path.join(home, "Applications-root");
  await mkdir(path.join(applications, "i豆.app", "Contents"), { recursive: true });
  const calls = [];
  const exec = async (command, args) => { calls.push([command, ...args]); return command === "security" ? args[2] === "i豆 Safe Storage" : true; };
  return { home, applications, calls, exec };
}

test("by default it only says what it would move, and touches nothing", async (t) => {
  const { home, applications, calls, exec } = await mac(t);
  const report = await uninstall({ home, applications: [applications], exec });
  assert.deepEqual(report.moved.map((place) => path.relative(home, place.at)).sort(),
    [".idou", "Applications-root/i豆.app", "Library/Application Support/i豆", "Library/Caches/io.github.scott987-cmd.idou"]);
  assert.deepEqual(report.kept.map((place) => path.relative(home, place.at)), ["i豆"], "your own files stay unless asked for");
  assert.deepEqual(report.keychain, [{ item: "i豆 Safe Storage", done: false }]);
  assert.ok(calls.every(([command, verb]) => command === "security" && verb === "find-generic-password"), "nothing but looking");
  assert.deepEqual((await readdir(path.join(home, ".Trash"))).sort(), ["i豆"]);
});

test("with --apply everything goes to the Trash, the Keychain item is deleted and the permissions reset; the task folders only with --task-folders", async (t) => {
  const { home, applications, calls, exec } = await mac(t);
  const now = new Date("2026-10-01T02:00:00Z");
  const report = await uninstall({ home, applications: [applications], exec, apply: true, now });
  assert.equal(report.failed.length, 0);
  const trash = (await readdir(path.join(home, ".Trash"))).sort();
  assert.ok(trash.includes(".idou") && trash.includes("io.github.scott987-cmd.idou"));
  assert.ok(trash.some((name) => /^i豆 2026-10-01T02-00-00-000Z$/.test(name)), "a name already in the Trash is kept apart, not overwritten");
  assert.deepEqual(calls.filter(([command, verb]) => command === "security" && verb === "delete-generic-password"), [["security", "delete-generic-password", "-s", "i豆 Safe Storage"]]);
  assert.deepEqual(calls.filter(([command]) => command === "tccutil").map((call) => call.at(-1)), ["io.github.scott987-cmd.idou", "com.mydoubao.desktop"]);
  assert.deepEqual((await readdir(home)).filter((name) => ["i豆", "Documents"].includes(name)).sort(), ["Documents", "i豆"], "your files and everything unrelated stay");
  await uninstall({ home, applications: [applications], exec, apply: true, taskFolders: true, now: new Date("2026-10-01T02:00:01Z") });
  assert.equal((await readdir(home)).includes("i豆"), false);
  assert.ok((await readdir(path.join(home, ".Trash"))).some((name) => name.startsWith("i豆 2026-10-01T02-00-01")), "and they are in the Trash, not gone");
});

// A first version defaulted to the real /Applications, and its own test moved
// the installed application into a temporary folder that was then deleted
// (2026-09-30). Nothing is reached by default now: no home, no applications
// folder, no way to run a command -- it refuses.
test("nothing real is reached by default: without its places named it refuses", async () => {
  const { places } = await import("../scripts/uninstall-mac.js");
  await assert.rejects(uninstall({ home: "/Users/someone", exec: async () => true }), /应用程序/);
  await assert.rejects(uninstall({ applications: ["/Applications"], exec: async () => true }), /家目录/);
  await assert.rejects(uninstall({ home: "/Users/someone", applications: ["/Applications"] }), /运行命令/);
  assert.throws(() => places({ home: "/Users/someone" }), /应用程序/);
  assert.ok(places({ home: "/h", applications: ["/a"] }).every((place) => place.at.startsWith("/h/") || place.at.startsWith("/a/")), "every place under what it was given");
});
