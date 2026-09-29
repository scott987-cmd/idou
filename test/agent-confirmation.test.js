import assert from "node:assert/strict";
import test from "node:test";
import { request } from "node:http";
import { AgentBridge, agentBridgeContract, agentRequestContext } from "../src/application/agent-bridge.js";
import { declined } from "../src/application/agent-confirmation.js";
import { AGENT_READS } from "../src/application/agent-reads.js";
import { agentFeishuActions } from "../src/application/agent-feishu-actions.js";
import { agentKnowledgeActions } from "../src/application/agent-knowledge-actions.js";
import { agentMediaActions } from "../src/application/agent-media-actions.js";
import { agentDeliveryActions } from "../src/application/agent-delivery-actions.js";
import { agentScheduleActions } from "../src/application/agent-schedule-actions.js";

// Found by a real send to a real group: the Agent's request died while the
// person's confirmation card was still on screen. The bridge created an abort
// signal for exactly that case and never handed it on, so the confirmation
// stayed live -- a late click could still perform the write after the Agent
// had reported failure. The action must be able to see the disconnect.
test("an action can see that the Agent that asked has disconnected", async t => {
  let started, aborted;
  const sawStart = new Promise(resolve => { started = resolve; });
  const sawAbort = new Promise(resolve => { aborted = resolve; });
  const bridge = await new AgentBridge({ actions: {
    wait: () => new Promise(() => {
      const { signal } = agentRequestContext.getStore();
      signal.addEventListener("abort", () => aborted(true), { once: true });
      started();
    }),
  } }).start();
  t.after(() => bridge.close());
  const env = bridge.environment("task-1"), body = JSON.stringify({ action: "wait", params: {} });
  const req = request(`${env.IDOU_FEISHU_BRIDGE}${agentBridgeContract.route}`, { method: "POST",
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body),
      [agentBridgeContract.header]: env.IDOU_FEISHU_BRIDGE_KEY, [agentBridgeContract.taskHeader]: env.IDOU_FEISHU_BRIDGE_TASK } });
  req.on("error", () => {});
  req.end(body);
  await sawStart;
  req.destroy();
  assert.equal(await Promise.race([sawAbort, new Promise(resolve => setTimeout(() => resolve(false), 2000))]), true,
    "the pending action must learn that nobody is waiting for its answer");
});

test("the request context is scoped to the request that asked, not shared", async t => {
  const seen = [];
  const bridge = await new AgentBridge({ actions: { who: (_params, taskId) => { seen.push([taskId, agentRequestContext.getStore()?.taskId]); return "ok"; } } }).start();
  t.after(() => bridge.close());
  assert.equal(agentRequestContext.getStore(), undefined, "nothing outside a request sees a context");
  for (const task of ["task-a", "task-b"]) {
    const env = bridge.environment(task), body = JSON.stringify({ action: "who", params: {} });
    await new Promise((resolve, reject) => {
      const req = request(`${env.IDOU_FEISHU_BRIDGE}${agentBridgeContract.route}`, { method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body),
          [agentBridgeContract.header]: env.IDOU_FEISHU_BRIDGE_KEY, [agentBridgeContract.taskHeader]: task } }, res => { res.resume(); res.on("end", resolve); });
      req.on("error", reject); req.end(body);
    });
  }
  assert.deepEqual(seen, [["task-a", "task-a"], ["task-b", "task-b"]]);
});

// Telling the Agent "the user cancelled" after a timeout made it tell the
// person they had declined something they never got to answer.
test("a timeout and a withdrawn confirmation are not reported as the person cancelling", () => {
  assert.match(declined({ response: 0, reason: "timeout" }, "用户取消了。").message, /5 分钟没有回应/);
  // Seen live: "ask the user to start it again" was taken as leave to re-issue at once.
  assert.match(declined({ response: 0, reason: "timeout" }, "用户取消了。").message, /不要自己重新发起.*等用户明确说准备好了/);
  assert.match(declined({ response: 0, reason: "withdrawn" }, "用户取消了。").message, /已作废/);
  assert.equal(declined({ response: 0, reason: "answered" }, "用户取消了。").message, "用户取消了。");
  assert.equal(declined({ response: 0 }, "用户取消了。").message, "用户取消了。");
});

// The bridge the application builds, from the real action maps, with the
// application's own list of reads.
function applicationBridge({ getScope, confirm }) {
  const never = () => { throw new Error("not in this test"); };
  return new AgentBridge({ actions: {
    ...agentFeishuActions({ getScope, confirm }), ...agentKnowledgeActions({ getScope }),
    ...agentMediaActions({ getScope, confirm, openPreview: never }), ...agentDeliveryActions({ getScope, confirm }),
    ...agentScheduleActions({ getSchedules: () => null, confirm, confirmRemoval: confirm, openDraft: never, unattended: () => false }),
  }, readOnly: [...AGENT_READS] });
}
function ask(env, action, params) {
  const body = JSON.stringify({ action, params });
  return new Promise((resolve, reject) => {
    const req = request(`${env.IDOU_FEISHU_BRIDGE}${agentBridgeContract.route}`, { method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body),
        [agentBridgeContract.header]: env.IDOU_FEISHU_BRIDGE_KEY, [agentBridgeContract.taskHeader]: env.IDOU_FEISHU_BRIDGE_TASK } },
    (res) => { const chunks = []; res.on("data", (chunk) => chunks.push(chunk)); res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")))); });
    req.on("error", reject); req.end(body);
  });
}

// 2026-09-23, a real work task: a video had been running for 18 minutes, the
// Agent asked to stop it, and while the stop-card was up asked for the
// video's status again -- to be told "这个任务已有一个飞书操作在等待确认".
test("a job's status is answered while the same task's stop-card is still up", async (t) => {
  const job = "36c87d85-7c76-4962-9b5f-611712f08ad7";
  let raised; const cardUp = new Promise((resolve) => { raised = resolve; });
  const scope = { service: { get: (id) => ({ id, title: "首发活动" }) },
    media: { refresh: async (_task, id) => ({ id, kind: "video", state: "running", hasResult: false, hasError: true, error: "media_provider_protocol_error" }) } };
  // The card is raised and nobody has answered it yet.
  const bridge = await applicationBridge({ getScope: () => scope, confirm: () => { raised(); return new Promise(() => {}); } }).start();
  t.after(() => bridge.close());
  const env = bridge.environment("ce0ed37b-8a4e-441a-bf42-95407bffa02a");
  void ask(env, "media-cancel", { job }).catch(() => {});
  await cardUp;
  const status = await ask(env, "media-status", { job });
  assert.equal(status.ok, true, status.error);
  assert.equal(status.result.state, "running");
  // A second change is still refused while the first one waits on its card.
  const second = await ask(env, "media-save", { job, folder: "https://example.feishu.cn/drive/folder/fldcnExample" });
  assert.equal(second.ok, false);
  assert.match(second.error, /在等待确认/);
});

test("the reads the bridge lets through beside a card are exactly the operations that never ask", () => {
  // Each of these raises a card or a dialog; none may run beside another write.
  for (const write of ["doc-replace", "doc-create", "doc-append", "run", "event-delete", "task-delete", "media-create", "media-save", "media-cancel",
    "doc-share", "schedule-draft", "schedule-pause", "schedule-resume", "schedule-delete", "schedule-run-now"]) {
    assert.equal(AGENT_READS.includes(write), false, `${write} asks the person and must stay the task's one write in flight`);
  }
  for (const read of ["kb-search", "kb-read", "media-status", "media-preview", "media-verify", "media-folder", "doc-share-search", "doc-share-members", "schedule-list"]) {
    assert.ok(AGENT_READS.includes(read), `${read} only reads and must not wait behind a card`);
  }
});

// What the task service waits on before stopping Codex after a turn: the
// task's write, however it ends. Reads do not count; they never raise a card.
test("a task's write is settled only once its card is answered, and a read never holds it", async (t) => {
  let answer; const card = new Promise((resolve) => { answer = resolve; });
  let raised; const cardUp = new Promise((resolve) => { raised = resolve; });
  const bridge = await new AgentBridge({ actions: {
    "doc-share": async () => { raised(); await card; return { sent: true }; },
    "doc-share-search": async () => ({ users: [] }),
  }, readOnly: ["doc-share-search"] }).start();
  t.after(() => bridge.close());
  const env = bridge.environment("task-1");
  let settled = null;
  assert.equal(await bridge.settled("task-1"), false, "nothing in flight: nothing was waited for");
  const sending = ask(env, "doc-share", { recipient: "handle" });
  await cardUp;
  void bridge.settled("task-1").then((waited) => { settled = waited; });
  assert.equal((await ask(env, "doc-share-search", { doc: "x", query: "y" })).ok, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, null, "the card is still up");
  answer();
  assert.deepEqual((await sending).result, { sent: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, true, "settled, and says there was a write to wait for");
  assert.equal(await Promise.race([bridge.settled("task-2"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 20))]), false, "a task with nothing in flight is settled at once");
});

// A search is a read and is answered beside a write waiting on its card
// (e87c573) -- but it opened the document first, which replaced the task's open
// document, and the send waiting on the card, and the recipient chosen for it,
// were bound to the one it replaced: confirmed, it failed as out of date. Found
// when the acceptance run first took smoke-document-group-delivery-desktop.js to
// its card (2026-09-25). With a send under way the search is refused before it
// touches anything.
test("a recipient search beside a send waiting on its card is refused before it reopens the document", async () => {
  let opened = 0;
  const scope = {
    messageWriteAccess() {},
    service: { get: (id) => ({ id, title: "发送文档" }) },
    documents: { open: async () => { opened += 1; return { handle: "h2", title: "文档", sourceUrl: "https://example.feishu.cn/docx/x" }; }, opened: new Map() },
    documentDelivery: { busy: (taskId) => taskId === "task-1", search: async () => { throw new Error("the search must not get this far"); } },
  };
  const actions = agentDeliveryActions({ getScope: () => scope, confirm: async () => ({ response: 0 }) });
  await assert.rejects(actions["doc-share-search"]({ doc: "https://example.feishu.cn/docx/x", query: "陈宁", kind: "user" }, "task-1"), /上一次发送还没结束/);
  assert.equal(opened, 0, "the open document is left as the waiting send has it");
});
