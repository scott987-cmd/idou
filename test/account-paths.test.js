import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { accountRelocator, relocatedAccountPath } from "../src/application/account-paths.js";
import { TaskStore } from "../src/application/task-store.js";
import { SiteStore } from "../src/application/site-store.js";
import { relinkThreadIndex } from "../src/providers/codex/thread-index.js";

// The shape adoptAccountData leaves behind: the account's data renamed from
// OLD to NEW, with records inside still naming OLD.
const OLD = "a".repeat(64), NEW = "b".repeat(64), OTHER = "c".repeat(64);

async function renamedAccount(t) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "account-paths-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const accounts = path.join(dataRoot, "accounts");
  return { dataRoot, accounts, root: path.join(accounts, NEW), old: path.join(accounts, OLD) };
}

test("a path into the account's directory under another name is the same place under this one", () => {
  const root = path.join("/data", "accounts", NEW);
  assert.equal(relocatedAccountPath(`/data/accounts/${OLD}/codex/sessions/2026/09/17/rollout.jsonl`, root), `${root}/codex/sessions/2026/09/17/rollout.jsonl`);
  assert.equal(relocatedAccountPath(`/data/accounts/${OLD}/workspaces/w1`, root), `${root}/workspaces/w1`);
  for (const untouched of [
    `${root}/workspaces/w1`,                 // already here
    `/data/accounts/${OLD}`,                 // the old directory itself, not something in it
    "/data/accounts/not-an-account/x",       // not an account's name
    `/data/elsewhere/${OLD}/x`,              // not under this account's parent
    "/Users/someone/我的豆包/2026-09-17-8",   // a folder the person chose
    `accounts/${OLD}/x`,                     // not absolute
    null,
  ]) assert.equal(relocatedAccountPath(untouched, root), null, String(untouched));
  // Only an account's own directory is ever a root: the signed-out scope and a
  // development one have nothing to bring along.
  assert.equal(relocatedAccountPath(`/data/accounts/${OLD}/workspaces/w1`, "/data/signed-out"), null);
});

test("a task whose working folder was in the renamed directory is found where it is now, and kept that way", async (t) => {
  const { root, old } = await renamedAccount(t);
  await mkdir(path.join(root, "tasks"), { recursive: true });
  await mkdir(path.join(root, "workspaces", "w1"), { recursive: true });
  const task = (id, cwd) => ({ schemaVersion: 1, id, mode: "cowork", cwd, messages: [], activity: [] });
  const moved = task("11111111-1111-4111-8111-111111111111", path.join(old, "workspaces", "w1"));
  const gone = task("22222222-2222-4222-8222-222222222222", path.join(old, "workspaces", "missing"));
  const chosen = task("33333333-3333-4333-8333-333333333333", "/Users/someone/我的豆包/2026-09-17-8");
  for (const each of [moved, gone, chosen]) await writeFile(path.join(root, "tasks", `${each.id}.json`), JSON.stringify(each));

  const store = new TaskStore(path.join(root, "tasks"));
  const { tasks, warnings } = await store.load();
  assert.deepEqual(warnings, []);
  const cwd = Object.fromEntries(tasks.map((each) => [each.id, each.cwd]));
  assert.equal(cwd[moved.id], path.join(root, "workspaces", "w1"));
  assert.equal(cwd[gone.id], gone.cwd, "a folder that is not in the new place either is left as recorded");
  assert.equal(cwd[chosen.id], chosen.cwd);
  const saved = JSON.parse(await readFile(path.join(root, "tasks", `${moved.id}.json`), "utf8"));
  assert.equal(saved.cwd, path.join(root, "workspaces", "w1"), "written back, so the next start reads it directly");
  assert.deepEqual(saved.messages, [], "nothing else about the record changes");
});

test("a site whose folder was in the renamed directory refreshes into the folder it has now", async (t) => {
  const { root, old } = await renamedAccount(t);
  const id = "e4f21620-a5c0-401f-8da4-2332763789d7";
  await mkdir(path.join(root, "sites", id), { recursive: true });
  await writeFile(path.join(root, "sites.json"), JSON.stringify({ version: 1, sites: [
    { id, name: "数据表", folder: path.join(old, "sites", id), slice: null },
    { id: "other", name: "游戏", folder: "/Users/someone/game", slice: null },
  ] }));
  const store = await SiteStore.open(path.join(root, "sites.json"), path.join(root, "sites"));
  assert.equal(store.get(id).folder, path.join(root, "sites", id));
  assert.equal(store.get("other").folder, "/Users/someone/game");
  const saved = JSON.parse(await readFile(path.join(root, "sites.json"), "utf8"));
  assert.equal(saved.sites.find((site) => site.id === id).folder, path.join(root, "sites", id));
});

test("Codex's index of the account's conversations follows the rename, only to files that are there", async (t) => {
  const { root, old } = await renamedAccount(t);
  const home = path.join(root, "codex");
  const file = (base, name) => path.join(base, "codex", "sessions", "2026", "09", "17", name);
  await mkdir(path.dirname(file(root, "x")), { recursive: true });
  await writeFile(file(root, "rollout-moved.jsonl"), "{}\n");
  await writeFile(file(root, "rollout-here.jsonl"), "{}\n");
  // Codex's own table has many more columns; only these two are touched.
  const db = new DatabaseSync(path.join(home, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, title TEXT NOT NULL DEFAULT '')");
  const insert = db.prepare("INSERT INTO threads (id, rollout_path, title) VALUES (?, ?, ?)");
  insert.run("moved", file(old, "rollout-moved.jsonl"), "kept");
  insert.run("missing", file(old, "rollout-missing.jsonl"), "");
  insert.run("here", file(root, "rollout-here.jsonl"), "");
  insert.run("elsewhere", path.join(root, "..", OTHER, "codex", "sessions", "rollout-moved.jsonl"), "");
  db.close();
  // An older state file without the table, and Codex's WAL companion, are passed over.
  new DatabaseSync(path.join(home, "state_4.sqlite")).close();
  await writeFile(path.join(home, "state_5.sqlite-wal"), "");

  const relocate = (value) => relocatedAccountPath(value, root);
  assert.equal(await relinkThreadIndex(home, relocate), 1);
  const read = new DatabaseSync(path.join(home, "state_5.sqlite"), { readOnly: true });
  const rows = Object.fromEntries(read.prepare("SELECT id, rollout_path, title FROM threads").all().map((row) => [row.id, row]));
  read.close();
  assert.equal(rows.moved.rollout_path, file(root, "rollout-moved.jsonl"));
  assert.equal(rows.moved.title, "kept");
  assert.equal(rows.missing.rollout_path, file(old, "rollout-missing.jsonl"), "never pointed at a file that is not there");
  assert.equal(rows.here.rollout_path, file(root, "rollout-here.jsonl"));
  assert.equal(rows.elsewhere.rollout_path, path.join(root, "..", OTHER, "codex", "sessions", "rollout-moved.jsonl"), "a file not in the new place stays as recorded");
  assert.equal(await relinkThreadIndex(home, relocate), 0, "the second start finds nothing left to do");
  assert.equal(await relinkThreadIndex(path.join(root, "no-codex-yet"), relocate), 0);
});

test("a path recorded under the account directory's real name is found through a link to it", async (t) => {
  // Codex resolves CODEX_HOME before it indexes a conversation; on macOS a
  // temporary directory is /var/…, recorded as /private/var/…
  const base = await mkdtemp(path.join(os.tmpdir(), "account-link-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(path.join(base, "real", "accounts", NEW), { recursive: true });
  await symlink(path.join(base, "real"), path.join(base, "link"));
  const root = path.join(base, "link", "accounts", NEW);
  const real = path.join(await realpath(path.join(base, "real")), "accounts");
  const relocate = await accountRelocator(root);
  assert.equal(relocate(path.join(real, OLD, "codex", "sessions", "rollout.jsonl")), path.join(real, NEW, "codex", "sessions", "rollout.jsonl"));
  assert.equal(relocate(path.join(base, "link", "accounts", OLD, "workspaces", "w1")), path.join(root, "workspaces", "w1"));
  assert.equal(relocate(path.join(real, NEW, "codex", "x")), null, "already where it is");
});
