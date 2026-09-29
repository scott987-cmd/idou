import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PreviewServers } from "../src/application/preview-servers.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

// A stand-in for createArtifactServer that records what was started and closed.
const recorder = ({ failFirst = false } = {}) => {
  const started = [];
  let failures = failFirst ? 1 : 0;
  const create = async (cwd) => {
    await tick(); // a real start is asynchronous, which is what makes a race possible
    if (failures > 0) { failures--; throw new Error("port unavailable"); }
    const index = started.length;
    const server = { cwd, closed: false, url: (relative) => `http://127.0.0.1:${40000 + index}/secret-${index}/${relative}`, close() { server.closed = true; } };
    started.push(server);
    return server;
  };
  return { started, create };
};

test("no preview server for a connection check, a task without a folder, or with 浏览器操作 off", async () => {
  let on = true;
  const { started, create } = recorder();
  const previews = new PreviewServers({ enabled: () => on, create });
  assert.equal(await previews.baseFor({ cwd: "/work" }), undefined, "a connection check has no task id");
  assert.equal(await previews.baseFor({ id: "t1" }), undefined);
  on = false;
  assert.equal(await previews.baseFor({ id: "t1", cwd: "/work" }), undefined);
  assert.equal(started.length, 0);
});

test("a task keeps one server across turns, even when two turns ask at once", async () => {
  const { started, create } = recorder();
  const previews = new PreviewServers({ create });
  const task = { id: "t1", cwd: "/work" };
  const [first, second] = await Promise.all([previews.baseFor(task), previews.baseFor(task)]);
  assert.equal(first, second);
  assert.equal(await previews.baseFor(task), first);
  assert.equal(started.length, 1, "a race must not start, and leak, a second server");
  assert.equal(first, "http://127.0.0.1:40000/secret-0/");
});

test("deleting a task closes only its server, and a later turn starts a fresh one", async () => {
  const { started, create } = recorder();
  const previews = new PreviewServers({ create });
  const one = await previews.baseFor({ id: "t1", cwd: "/one" });
  await previews.baseFor({ id: "t2", cwd: "/two" });
  previews.close("t1");
  await tick();
  assert.deepEqual(started.map((server) => server.closed), [true, false]);
  const again = await previews.baseFor({ id: "t1", cwd: "/one" });
  assert.notEqual(again, one);
  assert.equal(started.length, 3);
  previews.close("unknown"); // nothing to close is not an error

  // Closed while still starting: it closes as soon as it is up.
  const starting = previews.baseFor({ id: "t3", cwd: "/three" });
  previews.close("t3");
  await starting;
  await tick();
  assert.equal(started.at(-1).closed, true);

  previews.closeAll();
  await tick();
  assert.equal(started.every((server) => server.closed), true);
});

test("a failed start is forgotten, so the task's next turn tries again", async () => {
  const { started, create } = recorder({ failFirst: true });
  const previews = new PreviewServers({ create });
  const task = { id: "t1", cwd: "/work" };
  await assert.rejects(previews.baseFor(task), /port unavailable/);
  assert.equal(await previews.baseFor(task), "http://127.0.0.1:40000/secret-0/");
  assert.equal(started.length, 1);
});

test("each task's server serves that task's own folder, and only behind the secret path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-preview-servers-"));
  const previews = new PreviewServers();
  try {
    for (const name of ["one", "two"]) {
      await mkdir(path.join(root, name));
      await writeFile(path.join(root, name, "index.html"), `<h1>${name.toUpperCase()}_PAGE</h1>`);
    }
    const one = await previews.baseFor({ id: "t1", cwd: path.join(root, "one") });
    const two = await previews.baseFor({ id: "t2", cwd: path.join(root, "two") });
    assert.notEqual(new URL(one).origin, new URL(two).origin);
    assert.match(await (await fetch(`${one}index.html`)).text(), /ONE_PAGE/);
    assert.match(await (await fetch(`${two}index.html`)).text(), /TWO_PAGE/);
    assert.equal((await fetch(`${new URL(one).origin}/index.html`)).status, 404, "the folder must not be served without the secret path");
    previews.close("t1");
    await tick();
    await assert.rejects(fetch(`${one}index.html`), "a deleted task's server must stop listening");
    assert.match(await (await fetch(`${two}index.html`)).text(), /TWO_PAGE/, "closing one task must not close another's");
  } finally {
    previews.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});
