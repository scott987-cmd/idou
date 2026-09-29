import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../src/providers/codex/app-server-client.js";
import { runProcess } from "../src/providers/process-runner.js";
import { accountRelocator } from "../src/application/account-paths.js";
import { relinkThreadIndex } from "../src/providers/codex/thread-index.js";

// Two things about the real Codex that fixes made on 2026-09-23 depend on, so
// they are asked of the binary rather than assumed (like
// permission-runtime-contract.test.js). A Codex update that changes either one
// fails here instead of in front of someone.
const binary = process.env.IDOU_CODEX_BIN || "codex";
const available = await runProcess(binary, ["--version"], { maxOutputBytes: 4096 }).then((r) => r.code === 0).catch(() => false);
const skip = available ? false : `找不到可执行的 ${binary}`;
const catalog = fileURLToPath(new URL("../src/providers/codex/model-catalog.json", import.meta.url));

// node:test runs a test's after-hooks in the order they were registered and
// skips the rest once one throws. These tests used to register the removal of
// their directory first, so it ran while Codex was still writing its sqlite
// files there: on 2026-09-23 it failed with ENOTEMPTY, the hooks that stop Codex
// and the scripted model were skipped, and the file never exited -- `npm run
// check` waited on it for 37 minutes. Everything a test starts is now stopped,
// newest first, before its directory is removed.
async function scratch(t, prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix)), stops = [];
  const cleanup = async () => {
    for (const stop of stops.splice(0).reverse()) await stop().catch(() => {});
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  t.after(cleanup);
  return { dir, stopLater: (stop) => stops.push(stop), cleanup };
}

// A model that answers from a script: each request gets the next reply.
async function scriptedModel(scope, replies) {
  let asked = 0;
  const bodies = [];
  const sse = (events) => events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk)); req.on("end", () => {
      try { bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { bodies.push(null); }
      const item = replies[Math.min(asked++, replies.length - 1)], id = `resp_${asked}`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse([{ type: "response.created", response: { id, status: "in_progress", output: [] } },
        { type: "response.output_item.added", output_index: 0, item },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]));
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  scope.stopLater(async () => { server.close(); server.closeAllConnections(); });
  return { url: `http://127.0.0.1:${server.address().port}/v1`, asked: () => asked, bodies: () => bodies };
}
const say = (text) => ({ type: "message", id: `msg_${text.length}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
const run = (command) => ({ type: "function_call", id: "fc_1", call_id: "call_1", name: "exec_command", status: "completed", arguments: JSON.stringify({ cmd: command, yield_time_ms: 500 }) });

async function codex(scope, { home, cwd, model, provider = "scripted" }) {
  const client = new CodexAppServerClient({ binary, cwd, env: { ...process.env, CODEX_HOME: home }, configOverrides: {
    model: "GLM-5.3", model_provider: provider, model_catalog_json: catalog,
    [`model_providers.${provider}`]: { name: provider, base_url: model.url, wire_api: "responses", request_max_retries: 0, stream_max_retries: 0 },
    approval_policy: "never", sandbox_mode: "danger-full-access" } });
  scope.stopLater(() => client.stop());
  await client.start();
  return client;
}
const waitFor = (client, method, test = () => true, ms = 30_000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { client.off("notification", listen); reject(new Error(`no ${method} within ${ms} ms`)); }, ms);
  const listen = (message) => { if (message.method === method && test(message.params)) { clearTimeout(timer); client.off("notification", listen); resolve(message.params); } };
  client.on("notification", listen);
});

// A write through bin/agent.js waits on the person's card; a turn that ends
// under it used to stop Codex, which ended the command and withdrew the card.
// The task service now keeps Codex up until the write is done, which is only
// any use if Codex leaves the command running when the turn ends and still
// reports how it ended.
test("a command still running when its turn ends keeps running, and Codex reports its end", { skip }, async (t) => {
  const scope = await scratch(t, "codex-background-"), cwd = scope.dir;
  const home = path.join(cwd, "home"); await mkdir(home);
  const marker = path.join(cwd, "answered");
  const model = await scriptedModel(scope, [run(`sleep 3 && echo answered > ${JSON.stringify(marker)}`), say("已发起，请在应用里确认。")]);
  const client = await codex(scope, { home, cwd, model });
  const thread = (await client.request("thread/start", { cwd })).thread.id;
  const ended = waitFor(client, "turn/completed");
  const reported = waitFor(client, "item/completed", (params) => params.item?.type === "commandExecution");
  await client.request("turn/start", { threadId: thread, input: [{ type: "text", text: "发出去", text_elements: [] }] });
  assert.equal((await ended).turn.status, "completed");
  assert.equal(await stat(marker).then(() => true, () => false), false, "the turn ended before the command did");
  const item = (await reported).item;
  assert.equal(item.status, "completed", "Codex reports the command's end after its turn");
  assert.equal(await stat(marker).then(() => true, () => false), true, "the command ran to its end");
  assert.equal(model.asked(), 2, "and nothing more was asked of the model");
});

// The account's directory renamed under Codex's own index, as adoptAccountData
// did on 2026-09-22: every earlier conversation failed to continue with
// "failed to resolve rollout path … file does not exist".
test("a conversation Codex indexed under the account's old directory resumes once the index is brought along", { skip }, async (t) => {
  const scope = await scratch(t, "codex-renamed-"), root = scope.dir;
  const cwd = path.join(root, "work"); await mkdir(cwd);
  const before = path.join(root, "accounts", "a".repeat(64)), after = path.join(root, "accounts", "b".repeat(64));
  await mkdir(path.join(before, "codex"), { recursive: true });
  const model = await scriptedModel(scope, [say("要点如下")]);
  let thread;
  {
    const client = await codex(scope, { home: path.join(before, "codex"), cwd, model });
    thread = (await client.request("thread/start", { cwd })).thread.id;
    const ended = waitFor(client, "turn/completed");
    await client.request("turn/start", { threadId: thread, input: [{ type: "text", text: "总结消息重点", text_elements: [] }] });
    await ended; await client.stop();
  }
  await rename(before, after);

  const renamed = await codex(scope, { home: path.join(after, "codex"), cwd, model });
  // The message depends on how the row was written ("failed to resolve rollout
  // path … file does not exist" in the account it happened to); either way the
  // conversation cannot be continued.
  await assert.rejects(renamed.request("thread/resume", { threadId: thread }), /failed to resolve rollout path|no rollout found/, "the index still names the old directory");
  await renamed.stop();

  // Codex indexed it under the directory's real path (/private/var/… for a
  // temporary directory on macOS), not the one it was handed.
  assert.ok(await relinkThreadIndex(path.join(after, "codex"), await accountRelocator(after)) >= 1);
  const relinked = await codex(scope, { home: path.join(after, "codex"), cwd, model });
  const resumed = await relinked.request("thread/resume", { threadId: thread });
  assert.equal(resumed.thread.id, thread);
});

// The app's model provider was "mydoubao" before the rename and is "idou" now
// (gateway-config.js). Every conversation started before then was recorded
// under the old name, and a task resumes its conversation naming the provider
// it has today (task-service.js). Codex takes the provider named at resume and
// carries the whole conversation over to it.
test("a conversation started under the old provider name continues under the new one, with its history", { skip }, async (t) => {
  const scope = await scratch(t, "codex-provider-"), cwd = scope.dir;
  const home = path.join(cwd, "home"); await mkdir(home);
  const model = await scriptedModel(scope, [say("第一轮的回答"), say("第二轮的回答")]);
  let thread;
  {
    const before = await codex(scope, { home, cwd, model, provider: "mydoubao" });
    thread = (await before.request("thread/start", { cwd, modelProvider: "mydoubao" })).thread.id;
    const ended = waitFor(before, "turn/completed");
    await before.request("turn/start", { threadId: thread, input: [{ type: "text", text: "旧名字下的第一句话", text_elements: [] }] });
    await ended; await before.stop();
  }
  const after = await codex(scope, { home, cwd, model, provider: "idou" });
  const resumed = await after.request("thread/resume", { threadId: thread, cwd, modelProvider: "idou" });
  assert.equal(resumed.thread.id, thread);
  const ended = waitFor(after, "turn/completed");
  await after.request("turn/start", { threadId: thread, input: [{ type: "text", text: "新名字下的第二句话", text_elements: [] }] });
  assert.equal((await ended).turn.status, "completed");
  assert.equal(model.asked(), 2);
  const second = JSON.stringify(model.bodies()[1]);
  assert.match(second, /旧名字下的第一句话/, "the model is sent what was said under the old name");
  assert.match(second, /第一轮的回答/);
});

test("a test's directory is removed only after everything started in it has stopped, even when a stop fails", async (t) => {
  const scope = await scratch(t, "codex-scratch-"), seen = [];
  scope.stopLater(async () => { seen.push(["first", await stat(scope.dir).then(() => true, () => false)]); });
  scope.stopLater(async () => { seen.push(["second", await stat(scope.dir).then(() => true, () => false)]); throw new Error("stop failed"); });
  await scope.cleanup();
  assert.deepEqual(seen, [["second", true], ["first", true]], "stopped newest first, while the directory was still there");
  assert.equal(await stat(scope.dir).then(() => true, () => false), false, "and the directory is gone afterwards");
});
