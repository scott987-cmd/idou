import test from "node:test";
import assert from "node:assert/strict";
import { Readable, PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { appHash } from "../src/apps/manifest.js";
import { readFrames, writeFrame } from "../src/apps/runtime-frames.js";
import { runtimeConfig, runtimeArgs, verifyRuntimeInspection, removeRuntimeContainer } from "../src/apps/docker-runtime.js";
import { createStaticGateway } from "../src/apps/package-preview.js";
import { staticAppFixture } from "../scripts/fixtures/static-app-package.js";

const config = { dockerPath: "/usr/bin/docker", endpoint: "unix:///run/docker.sock", imageId: `sha256:${"a".repeat(64)}` };
function frame(value) { const body = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4); header.writeUInt32BE(body.length); return Buffer.concat([header, body]); }
async function frames(chunks, limit = 4096) { return Array.fromAsync(readFrames(Readable.from(chunks), () => limit)); }
test("runtime framing preserves split headers, UTF8 bodies and coalesced frames", async () => {
  const values = [{ text: "中文🙂" }, { next: 2 }], bytes = Buffer.concat(values.map(frame));
  assert.deepEqual(await frames(Array.from(bytes, byte => Buffer.from([byte]))), values);
  assert.deepEqual(await frames([bytes]), values);
  const pipe = new PassThrough(); await writeFrame(pipe, values[0]); pipe.end(); assert.deepEqual(await Array.fromAsync(readFrames(pipe, () => 4096)), [values[0]]);
});
test("runtime framing rejects zero, oversized, partial and invalid JSON frames", async () => {
  for (const bytes of [Buffer.alloc(4), Buffer.from([0, 0]), frame({ x: 1 }).subarray(0, 6), Buffer.from([0, 0, 0, 1, 120])]) await assert.rejects(frames([bytes]));
  await assert.rejects(frames([frame({ x: 1 })], 2), /limit/);
});
function worker(t) {
  const child = spawn(process.execPath, ["src/apps/runtime-worker.js"], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin" } });
  const done = once(child, "close"); const iterator = readFrames(child.stdout, () => 3 * 1024 * 1024)[Symbol.asyncIterator]();
  child.stdin.on("error", () => {});
  t.after(async () => { child.stdin.end(); if (child.exitCode === null && child.signalCode === null) child.kill(); await done; });
  const f = staticAppFixture();
  return { child, done, next: async () => (await iterator.next()).value, send: value => writeFrame(child.stdin, value),
    load: { kind: "load", protocol: 1, digest: f.digest, sha256: f.sha256, package: f.bytes.toString("base64"), expiresAt: Date.now() + 10000 }, f };
}
test("trusted worker independently loads canonical archive and returns exact bytes including empty files", { timeout: 5000 }, async t => {
  const w = worker(t); await w.send(w.load); const ready = await w.next(); assert.equal(ready.kind, "ready"); assert.deepEqual(ready.manifest, w.f.manifest);
  for (const [path, text] of Object.entries(w.f.files)) {
    const id = randomUUID(); await w.send({ kind: "read", id, path }); const value = await w.next();
    assert.deepEqual(value, { kind: "file", id, path, base64: Buffer.from(text).toString("base64") });
  }
  const id = randomUUID(); await w.send({ kind: "read", id, path: "/etc/passwd" }); assert.deepEqual(await w.next(), { kind: "missing", id });
  w.child.stdin.end(); assert.equal((await w.done)[0], 0);
});
for (const scenario of ["hash", "package", "content", "expiry", "base64", "extra", "replay"]) {
  test(`trusted worker rejects ${scenario} without reflecting input`, { timeout: 5000 }, async t => {
    const w = worker(t); const load = { ...w.load };
    if (scenario === "hash") load.sha256 = "b".repeat(64);
    if (scenario === "package") load.digest = "c".repeat(64);
    if (scenario === "content") {
      const pkg = JSON.parse(w.f.bytes); pkg.blobs[0].base64 = Buffer.from("tampered source").toString("base64");
      const bytes = Buffer.from(JSON.stringify(pkg)); load.package = bytes.toString("base64"); load.sha256 = appHash(bytes);
    }
    if (scenario === "expiry") load.expiresAt = Date.now() - 1;
    if (scenario === "base64") load.package += "\n";
    if (scenario === "extra") load.secret = "do-not-reflect";
    await w.send(load);
    if (scenario === "replay") { assert.equal((await w.next()).kind, "ready"); await w.send(load); }
    assert.deepEqual(await w.next(), { kind: "error", code: "runtime_input_rejected" });
    w.child.stdin.end(); assert.equal((await w.done)[0], 1);
  });
}
test("runtime config pins local endpoint and immutable image; no mounts, publishing or inherited environment arguments", () => {
  assert.deepEqual(runtimeConfig(config), config);
  for (const bad of [{ dockerPath: "docker" }, { endpoint: "tcp://host:2375" }, { imageId: "node:latest" }, { args: ["--privileged"] }]) assert.throws(() => runtimeConfig({ ...config, ...bad }));
  const args = runtimeArgs(config, "idou-static-test", "owner");
  for (const flag of ["--network=none", "--read-only", "--cap-drop=ALL", "--user=1000:1000", "--pull=never", "--memory=256m", "--pids-limit=32", "--log-driver=none"]) assert.ok(args.includes(flag));
  assert.equal(args.some(arg => /^(-v|--volume|--mount|--env|--publish|--privileged)/.test(arg)), false);
});
test("runtime inspection rejects actual weaker Docker policies rather than trusting requested flags", () => {
  const row = { Id: "d".repeat(64), Image: config.imageId, Config: { Labels: { "idou.runtime.owner": "owner" }, User: "1000:1000" }, State: { Running: true }, Mounts: [], HostConfig: {
    ReadonlyRootfs: true, NetworkMode: "none", IpcMode: "none", Privileged: false, PidMode: "", Memory: 268435456, MemorySwap: 268435456, NanoCpus: 500000000, PidsLimit: 32, AutoRemove: true, Init: true, LogConfig: { Type: "none" }, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"] } };
  const expected = { imageId: config.imageId, owner: "owner" }; assert.equal(verifyRuntimeInspection(row, expected), row.Id);
  for (const change of [{ NetworkMode: "bridge" }, { ReadonlyRootfs: false }, { Privileged: true }, { Memory: 0 }, { PidsLimit: 0 }, { CapDrop: [] }, { SecurityOpt: [] }, { Binds: ["/var/run/docker.sock:/var/run/docker.sock"] }, { PortBindings: { "80/tcp": [{}] } }]) assert.throws(() => verifyRuntimeInspection({ ...row, HostConfig: { ...row.HostConfig, ...change } }, expected));
  assert.throws(() => verifyRuntimeInspection({ ...row, Mounts: [{}] }, expected));
  assert.throws(() => verifyRuntimeInspection(row, { ...expected, owner: "other" }));
});
test("static gateway rejects corrupted runtime bytes and calls release exactly once", async t => {
  const f = staticAppFixture(); let closed = 0;
  const corrupt = Buffer.from(f.files["index.html"]); corrupt[0] ^= 1;
  const gateway = await createStaticGateway({ manifest: f.manifest, expiresAt: Date.now() + 10000, readFile: async () => corrupt, onClose: () => closed++ }); t.after(() => gateway.close());
  assert.equal((await fetch(gateway.url(gateway.entry))).status, 404); gateway.close(); gateway.close(); assert.equal(closed, 1);
});
test("static gateway expiry releases its reader storage and fires expiry once", async t => {
  const f = staticAppFixture(), expired = Promise.withResolvers(); let released = 0, expirations = 0;
  const gateway = await createStaticGateway({ manifest: f.manifest, expiresAt: Date.now() + 100, readFile: async file => Buffer.from(f.files[file]), onClose: () => released++, onExpired: () => { expirations++; expired.resolve(); } }); t.after(() => gateway.close());
  await expired.promise; gateway.close(); assert.equal(released, 1); assert.equal(expirations, 1); await assert.rejects(fetch(gateway.url(gateway.entry)));
});
test("static gateway does not deliver an in-flight response after close", async t => {
  const f = staticAppFixture(), entered = Promise.withResolvers(), reader = Promise.withResolvers(); let released = 0;
  const gateway = await createStaticGateway({ manifest: f.manifest, expiresAt: Date.now() + 10000, readFile: () => { entered.resolve(); return reader.promise; }, onClose: () => released++ }); t.after(() => gateway.close());
  const request = fetch(gateway.url(gateway.entry)); const rejected = assert.rejects(request);
  await entered.promise; gateway.close(); reader.resolve(Buffer.from(f.files["index.html"])); await rejected; assert.equal(released, 1);
});

// Docker's own --rm is often removing the container when close() asks: it
// refuses a second removal as already in progress, and the container stays
// visible until that finishes. One look straight after failed a third of the
// app-runtime smoke's runs; absence now gets a bounded moment to arrive.
test("runtime removal waits for Docker's own removal instead of reading it as a failure", async () => {
  const ID = "a".repeat(64), row = { Id: ID };
  const docker = (visible) => {
    const seen = { removed: [], slept: 0 };
    return { seen, inspect: async () => (visible.length ? visible.shift() : null), remove: async id => { seen.removed.push(id); return { code: 1 }; },
      owns: candidate => candidate.Id === ID, sleep: async () => { seen.slept += 1; } };
  };
  const racing = docker([row, row, row, null]);
  assert.equal(await removeRuntimeContainer(racing), true);
  assert.deepEqual(racing.seen, { removed: [ID], slept: 2 }, "removed once, then waited for it to go");

  const gone = docker([null]);
  assert.equal(await removeRuntimeContainer(gone), false, "nothing to remove");
  assert.deepEqual(gone.seen.removed, []);

  const stuck = docker(Array(60).fill(row));
  await assert.rejects(removeRuntimeContainer({ ...stuck, attempts: 5 }), /removal not confirmed/, "a container that never goes is still an error");
  await assert.rejects(removeRuntimeContainer({ ...docker([{ Id: "b".repeat(64) }]) }), /ownership mismatch/, "and someone else's is never removed");
});
