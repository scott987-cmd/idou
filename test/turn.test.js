import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { runTurn } from "../src/application/turn.js";

const complete = (client, threadId, id) => client.emit("notification", { method: "turn/completed", params: { threadId, turn: { id, status: "completed", items: [] } } });

test("a subagent's own thread keeps the parent turn alive, and still cannot end it", async () => {
  const client = new EventEmitter();
  client.request = async () => {
    // Only the child thread shows any sign of life, and it completes too. The
    // parent must stay alive on the first and ignore the second.
    const beat = setInterval(() => client.emit("notification", { method: "item/agentMessage/delta", params: { threadId: "child-thread" } }), 20);
    setTimeout(() => complete(client, "child-thread", "child-turn"), 60);
    setTimeout(() => { clearInterval(beat); complete(client, "thread", "parent-turn"); }, 300);
    return { turn: { id: "parent-turn" } };
  };
  const result = await runTurn(client, { threadId: "thread", input: [], idleTimeoutMs: 120, relatedThreads: new Set(["child-thread"]) });
  assert.equal(result.id, "parent-turn");
  assert.equal(client.listenerCount("notification"), 0);
});

test("a thread that is not this turn's subagent is still not a sign of life", async () => {
  const client = new EventEmitter();
  client.request = async () => {
    const beat = setInterval(() => client.emit("notification", { method: "item/agentMessage/delta", params: { threadId: "child-thread" } }), 10);
    setTimeout(() => clearInterval(beat), 400);
    return { turn: { id: "parent-turn" } };
  };
  await assert.rejects(runTurn(client, { threadId: "thread", input: [], idleTimeoutMs: 60 }), /没有任何动静/);
  assert.equal(client.listenerCount("notification"), 0);
});

test("turn tracks exact IDs even when completion precedes start acknowledgement", async () => {
  const client = new EventEmitter();
  client.request = async () => {
    complete(client, "other-thread", "right-turn");
    complete(client, "thread", "wrong-turn");
    complete(client, "thread", "right-turn");
    return { turn: { id: "right-turn" } };
  };
  const result = await runTurn(client, { threadId: "thread", input: [] });
  assert.equal(result.id, "right-turn");
  assert.equal(client.listenerCount("notification"), 0);
  assert.equal(client.listenerCount("stopped"), 0);
});

test("start rejection cleans up all turn listeners and timers", async () => {
  const client = new EventEmitter();
  client.request = async () => { throw new Error("start rejected"); };
  await assert.rejects(runTurn(client, { threadId: "thread", input: [] }), /start rejected/);
  assert.equal(client.listenerCount("notification"), 0);
  assert.equal(client.listenerCount("stopped"), 0);
});

test("runtime exit terminates a waiting turn instead of leaving a 30-minute waiter", async () => {
  const client = new EventEmitter();
  client.request = async () => { queueMicrotask(() => client.emit("stopped", new Error("runtime exited"))); return { turn: { id: "turn" } }; };
  await assert.rejects(runTurn(client, { threadId: "thread", input: [] }), /runtime exited/);
  assert.equal(client.listenerCount("notification"), 0);
});

test("硬上限到点会中断已知的这一轮并如实说明", async () => {
  const client = new EventEmitter();
  const calls = [];
  client.request = async (method, params) => { calls.push({ method, params }); return { turn: { id: "turn" } }; };
  await assert.rejects(runTurn(client, { threadId: "thread", input: [], timeoutMs: 20, idleTimeoutMs: 5000 }), /为避免无限运行/);
  assert.deepEqual(calls.at(-1), { method: "turn/interrupt", params: { threadId: "thread", turnId: "turn" } });
  assert.equal(client.listenerCount("notification"), 0);
  assert.equal(client.listenerCount("serverRequest"), 0);
});

test("一直没动静的一轮会被停掉，并说清已经写好的东西还在", async () => {
  const client = new EventEmitter();
  client.request = async () => ({ turn: { id: "turn" } });
  await assert.rejects(runTurn(client, { threadId: "thread", input: [], idleTimeoutMs: 40 }), /没有任何动静/);
  assert.equal(client.listenerCount("notification"), 0);
});

test("只要还有动静就不算卡住——包括在等人回答审批", async () => {
  for (const [what, poke] of [
    ["模型还在输出", (client) => client.emit("notification", { method: "item/agentMessage/delta", params: { threadId: "thread" } })],
    ["正在等人审批", (client) => client.emit("serverRequest", { method: "item/commandExecution/requestApproval", params: { threadId: "thread" } })],
  ]) {
    const client = new EventEmitter();
    client.request = async () => ({ turn: { id: "turn" } });
    const pending = runTurn(client, { threadId: "thread", input: [], idleTimeoutMs: 120 });
    // 每 60ms 动一下，总时长远超 120ms 的空闲上限；只要有动静就不该被停。
    const beat = setInterval(() => poke(client), 60);
    setTimeout(() => { clearInterval(beat); client.emit("notification", { method: "turn/completed", params: { threadId: "thread", turn: { id: "turn" } } }); }, 500);
    assert.deepEqual(await pending, { id: "turn" }, `${what} 时不应判定为卡住`);
  }
});

test("等人审批时即使很久没有新动静，也不会被空闲上限停掉", async () => {
  const client = new EventEmitter();
  client.request = async () => ({ turn: { id: "turn" } });
  const pending = runTurn(client, { threadId: "thread", input: [], idleTimeoutMs: 40 });
  let settled = false; pending.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 5));
  // 一次审批请求后就静默：若空闲钟只是被重置而非暂停，40ms 后就会误停。
  client.emit("serverRequest", { method: "item/commandExecution/requestApproval", params: { threadId: "thread" } });
  await new Promise((resolve) => setTimeout(resolve, 160));
  assert.equal(settled, false, "等人审批期间不应被空闲上限停掉");
  // 人回答后 Codex 恢复、产出动静并完成。
  client.emit("notification", { method: "turn/completed", params: { threadId: "thread", turn: { id: "turn" } } });
  assert.deepEqual(await pending, { id: "turn" });
});

test("别的会话的动静不能替这一轮续命", async () => {
  const client = new EventEmitter();
  client.request = async () => ({ turn: { id: "turn" } });
  const pending = runTurn(client, { threadId: "thread", input: [], idleTimeoutMs: 120 });
  const beat = setInterval(() => client.emit("notification", { method: "item/agentMessage/delta", params: { threadId: "另一个会话" } }), 40);
  await assert.rejects(pending, /没有任何动静/);
  clearInterval(beat);
});

test("pre-cancelled task never starts a turn", async () => {
  const client = new EventEmitter();
  client.request = () => assert.fail("must not start");
  await assert.rejects(runTurn(client, { threadId: "thread", input: [], signal: AbortSignal.abort() }), /cancelled/);
});

test("a turn can be started another way -- a review -- and still ends on its own completion", async () => {
  const client = new EventEmitter(); const asked = [];
  client.request = async (method) => { asked.push(method); return {}; };
  const start = async () => { asked.push("review/start"); setTimeout(() => complete(client, "thread", "review-turn"), 20); return { turn: { id: "review-turn" } }; };
  let reported = null;
  const result = await runTurn(client, { threadId: "thread", input: [], start, onTurn: (id) => { reported = id; } });
  assert.deepEqual([result.id, reported, asked], ["review-turn", "review-turn", ["review/start"]], "no turn/start as well");
});
