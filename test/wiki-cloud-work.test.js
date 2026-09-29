import test from "node:test";
import assert from "node:assert/strict";
import { WikiCloudWork } from "../src/knowledge/cloud-work.js";

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = () => new Promise(resolve => setImmediate(resolve));

test("cloud work serializes FIFO, keeps cancelled active work draining, and continues after failure", async () => {
  const queue = new WikiCloudWork(), gate = deferred(), controller = new AbortController(), events = [];
  const first = queue.run(async () => { events.push("first"); await gate.promise; events.push("drained"); throw new Error("operation failed"); }, { signal: controller.signal });
  const failed = assert.rejects(first, /operation failed/);
  const second = queue.run(() => { events.push("second"); return 2; });
  const third = queue.run(() => { events.push("third"); return 3; });
  await flush(); controller.abort(); await flush(); assert.deepEqual(events, ["first"]);
  gate.resolve(); await failed; assert.equal(await second, 2); assert.equal(await third, 3);
  assert.deepEqual(events, ["first", "drained", "second", "third"]);
});

test("cloud work cancels queued work immediately and enforces a bounded waiting queue", async () => {
  const queue = new WikiCloudWork(), gate = deferred(), controller = new AbortController(); let ran = false;
  const first = queue.run(() => gate.promise);
  const cancelled = queue.run(() => { ran = true; }, { signal: controller.signal });
  const denied = assert.rejects(cancelled, /cancelled/); controller.abort(); await denied;
  const waiting = Array.from({ length: 4 }, () => queue.run(() => 1));
  await assert.rejects(queue.run(() => 2), /queue full/);
  await assert.rejects(queue.run(() => 3, { signal: controller.signal }), /cancelled/);
  gate.resolve(); await first; assert.deepEqual(await Promise.all(waiting), [1, 1, 1, 1]); assert.equal(ran, false);
});
