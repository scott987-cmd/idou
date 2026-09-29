import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

// The request an action is currently serving, visible to whatever it calls --
// in practice the in-app confirmation, which uses the signal to withdraw its
// card when the Agent that asked has gone away. Carried this way rather than
// as a parameter so every action module keeps its existing signature.
export const agentRequestContext = new AsyncLocalStorage();

// Loopback request channel that lets the Agent ask for a Feishu write.
//
// The Agent never receives a write credential. It states an intent here; the
// application decides whether to confirm it with the user and then performs the
// write through the existing provider path, which is what obtains the
// server-issued one-shot grant. Replay is harmless by construction: every
// delivery re-enters confirmation, so a repeated request cannot write twice
// without a second human decision.
const ROUTE = "/v1/agent/feishu";
const MAX_REQUEST_BYTES = 256 * 1024;
const HEADER = "x-idou-agent-key";
const TASK_HEADER = "x-idou-agent-task";
const MAX_CONCURRENT = 4;
// Reads that change nothing -- the knowledge search and read -- are not held to
// one at a time. An Agent asks two or three at once as a matter of course, and
// each one after the first used to be refused as "a Feishu operation awaiting
// confirmation" while nothing awaited anyone: 21 of the 42 knowledge reads that
// failed in this person's own tasks were that (counted 2026-09-21).
const MAX_READS_PER_TASK = 4;
const MAX_READS = 8;

function send(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(value));
}

async function readBody(req) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) throw new Error("请求过大");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const matches = (supplied, expected) => {
  const a = Buffer.from(String(supplied ?? "")), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

export class AgentBridge {
  // `actions` maps an action name to `(params, taskId) => Promise<result>`. An
  // action that writes is responsible for its own user confirmation; this layer
  // only proves which task asked and keeps one write in flight per task.
  // `readOnly` names the actions that change nothing, which a task may have a
  // few of in flight at once, beside a write or not.
  constructor({ actions, readOnly = [] }) {
    if (!actions || typeof actions !== "object" || Array.isArray(actions) || !Object.keys(actions).length ||
        Object.values(actions).some(value => typeof value !== "function")) throw new Error("Invalid agent Feishu bridge actions");
    if (!Array.isArray(readOnly) || readOnly.some(name => !Object.hasOwn(actions, name))) throw new Error("Invalid agent Feishu bridge read-only actions");
    this.actions = { ...actions }; this.readOnly = new Set(readOnly);
    // One key per task, and the task is the key's: see environment().
    this.keys = new Map();
    this.busy = new Set(); this.reading = new Map(); this.reads = 0; this.controllers = new Set(); this.closed = false;
    // Each task's write in flight, as a promise that settles when it is done
    // however it ends: answered, timed out, withdrawn (settled()).
    this.writing = new Map();
  }
  async start() {
    if (this.closed || this.server) throw new Error("Agent Feishu bridge cannot be started");
    this.server = createServer((req, res) => { void this.handle(req, res); });
    await new Promise((resolve, reject) => { this.server.once("error", reject); this.server.listen(0, "127.0.0.1", resolve); });
    this.address = `http://127.0.0.1:${this.server.address().port}`;
    return this;
  }
  // Injected into one task's Agent shell. The key is that task's own, and a
  // request is served as the task its key was issued to. It used to be one key
  // for every task, with the task taken from a header the request supplied: a
  // task in standard mode could name a task with full access, whose document
  // writes need no card, and write as it (found 2026-09-27). The task header is
  // still sent; it must name the key's own task.
  environment(taskId) {
    if (!this.address || this.closed) throw new Error("Agent Feishu bridge is not active");
    if (typeof taskId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(taskId)) throw new Error("Invalid task id");
    if (!this.keys.has(taskId)) this.keys.set(taskId, randomBytes(32).toString("base64url"));
    return { IDOU_FEISHU_BRIDGE: this.address, IDOU_FEISHU_BRIDGE_KEY: this.keys.get(taskId), IDOU_FEISHU_BRIDGE_TASK: taskId };
  }
  // The task a key was issued to, or null. Every key is compared, each in
  // constant time, so how long this takes says nothing about which one matched.
  #taskFor(supplied) {
    let found = null;
    for (const [taskId, key] of this.keys) if (matches(supplied, key)) found = taskId;
    return found;
  }
  async handle(req, res) {
    const controller = new AbortController(); this.controllers.add(controller);
    const cancel = () => controller.abort(); res.once("close", cancel);
    // What this request holds, so that only it is let go: a request refused as
    // the task's second write used to release the first one's hold on its way out.
    let taskId = null, lane = null;
    try {
      // A browser-issued request always carries Origin; a native child process
      // does not. Refusing it keeps a rendered page from reaching this port.
      if (this.closed || req.headers.origin) throw new Error("仅接受本机 Agent 进程的请求");
      if (req.method !== "POST" || req.url !== ROUTE) throw new Error("请求地址无效");
      const owner = this.#taskFor(req.headers[HEADER]);
      if (!owner) throw new Error("Agent 桥接密钥不匹配");
      const claimed = req.headers[TASK_HEADER];
      if (claimed !== undefined && claimed !== owner) throw new Error("Agent 任务标识与桥接密钥不符");
      taskId = owner;
      // Which hold a request takes depends on what it asks for, so the body --
      // small and bounded -- is read first.
      const body = await readBody(req);
      let value; try { value = JSON.parse(body.toString("utf8")); } catch { throw new Error("请求不是合法 JSON"); }
      if (!value || typeof value !== "object" || Array.isArray(value) ||
          Object.keys(value).sort().join(",") !== "action,params") throw new Error("请求必须只包含 action 和 params");
      const action = Object.hasOwn(this.actions, value.action) ? this.actions[value.action] : null;
      if (!action) throw new Error(`不支持的飞书操作：${String(value.action).slice(0, 64)}`);
      if (!value.params || typeof value.params !== "object" || Array.isArray(value.params)) throw new Error("params 必须是对象");
      if (this.readOnly.has(value.action)) {
        const mine = this.reading.get(taskId) ?? 0;
        if (mine >= MAX_READS_PER_TASK || this.reads >= MAX_READS) throw new Error("同时进行的查询太多，等前面的结果回来再查");
        this.reading.set(taskId, mine + 1); this.reads++; lane = "read";
      } else {
        if (this.busy.has(taskId)) throw new Error("这个任务已有一个飞书操作在等待确认");
        if (this.busy.size >= MAX_CONCURRENT) throw new Error("飞书操作繁忙，请稍后重试");
        this.busy.add(taskId); lane = "write";
        let finish; this.writing.set(taskId, { done: new Promise((resolve) => { finish = resolve; }), finish });
      }
      // `controller` aborts when the Agent's connection closes. It used to be
      // created and never handed on, so a confirmation whose Agent had already
      // given up stayed live -- and answering it could still perform the write
      // after the Agent had reported that it failed.
      // Stable for this one bridge request and never accepted back from the
      // caller. The confirmation UI can use it to keep repeated paints of the
      // same operation together without confusing it with a Codex item id.
      const actionId = randomBytes(18).toString("base64url");
      const result = await agentRequestContext.run({ signal: controller.signal, taskId, actionId, action: value.action }, () => action(value.params, taskId));
      send(res, 200, { ok: true, result: result ?? null });
    } catch (error) {
      // The Agent reads this text and decides what to tell the user, so it says
      // what happened rather than carrying an internal identifier.
      if (!res.headersSent) send(res, 400, { ok: false, error: String(error?.message ?? error).slice(0, 500) });
      else res.destroy();
    } finally {
      if (lane === "write") { this.busy.delete(taskId); this.writing.get(taskId)?.finish(); this.writing.delete(taskId); }
      if (lane === "read") { const left = this.reading.get(taskId) - 1; if (left) this.reading.set(taskId, left); else this.reading.delete(taskId); this.reads--; }
      res.off("close", cancel); this.controllers.delete(controller);
    }
  }
  // Settles once the task has no write in flight -- true if it had one to wait
  // for. A turn that ended while its Agent's write was still waiting on the
  // person's card waits on this before Codex is stopped: stopping it ended the
  // command that asked, and that withdrew the card before the person could
  // answer (task-service.js).
  settled(taskId) { const write = this.writing.get(taskId); return write ? write.done.then(() => true) : Promise.resolve(false); }
  async close() {
    if (this.closed) return; this.closed = true; this.keys.clear();
    for (const controller of this.controllers) controller.abort();
    if (this.server) await new Promise(resolve => { this.server.close(resolve); this.server.closeAllConnections(); });
  }
}

export const agentBridgeContract = Object.freeze({ route: ROUTE, header: HEADER, taskHeader: TASK_HEADER, maxRequestBytes: MAX_REQUEST_BYTES });
