import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { TaskService } from "../src/application/task-service.js";
import { TaskStore } from "../src/application/task-store.js";
import { TaskSkillRunner } from "../src/application/task-skill.js";
import { createTaskRuntime } from "../src/application/task-runtime.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { skillDigest } from "../src/skills/catalog-format.js";
import { skillFixture } from "./fixtures/skill-catalog.js";
import { loadConfig } from "../src/config.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "idou-skill-runtime-"));
const workspace = path.join(directory, "workspace"); await mkdir(workspace);
const bundle = skillFixture(); bundle.files[0].text += "\nTASK_SKILL_SCOPE_MARKER_9A7D\n";
const skill = { ...bundle, digest: skillDigest(bundle), compatible: true };
// A skill switched on in 技能中心 is only offered: listed with its name and
// description among the skills the model may open, its SKILL.md not sent. The
// listing is Codex's to do, so this is where a Codex that stopped doing it for
// a registered root would show.
const shelfBundle = { ...skillFixture(), id: "local-weekly-digest", title: "周报摘要助手", description: "把一周的记录整理成固定结构的周报摘要" };
shelfBundle.files = [{ path: "SKILL.md", text: "---\nname: local-weekly-digest\ndescription: 把一周的记录整理成固定结构的周报摘要\n---\n# 周报摘要助手\n\nSHELF_SKILL_BODY_MARKER_3C1E\n" }];
const shelf = { ...shelfBundle, digest: skillDigest(shelfBundle), compatible: true };
const sessions = new SessionRegistry(), session = sessions.issue({ tenantId: "synthetic", userId: "synthetic", deviceId: "synthetic" });
let requests = 0, observedSkill = false, reads = 0, denied = false, leaseRoot, service, lastBody = null;
const server = createModelGateway({ apiKey: "synthetic-no-paid-key", sessions, fetchImpl: async (_url, options) => {
  requests++;
  const body = JSON.parse(options.body); lastBody = body; observedSkill ||= JSON.stringify(body.input).includes("TASK_SKILL_SCOPE_MARKER_9A7D");
  const item = { type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text: "TASK_SKILL_OK", annotations: [] }] };
  const events = [
    { type: "response.created", response: { id: "resp_fixture", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "TASK_SKILL_OK" },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
} });
server.listen(0, "127.0.0.1"); await once(server, "listening");
const config = await loadConfig(), pins = JSON.parse(await readFile("upstreams.lock.json", "utf8"));
config.controlPlane = { sessionFile: path.join(directory, "session.json"), baseUrl: `http://127.0.0.1:${server.address().port}` };
config.codex.dataDir = path.join(directory, "codex"); config.codex.expectedVersion = pins.codex.version; config.feishuBusinessLinked = false;
await writeFile(config.controlPlane.sessionFile, JSON.stringify({ token: session.token, expiresAt: session.expiresAt, serverUrl: config.controlPlane.baseUrl }), { mode: 0o600 });
const runner = new TaskSkillRunner({ read: async (reference) => { if (reference.id === shelf.id) return shelf; reads++; if (denied) throw new Error("Synthetic withdrawn skill"); return skill; } });
try {
  service = new TaskService({ store: new TaskStore(path.join(directory, "tasks")), runtimeFactory: (task) => createTaskRuntime(config, task),
    skillResolver: async (...args) => { const lease = await runner.prepare(...args); leaseRoot = lease.root; return lease; } });
  await service.init(); const task = await service.create({ mode: "cowork", cwd: workspace, enterpriseSkill: skill });
  await service.send(task.id, "按本任务绑定的技能整理一行说明。不访问其他文件或网络。");
  await service.active.get(task.id)?.done.promise;
  const completed = service.get(task.id);
  assert.equal(completed.status, "completed", completed.error); assert.equal(requests, 1); assert.equal(reads, 2); assert.equal(observedSkill, true);
  assert.match(completed.messages.at(-1).text, /TASK_SKILL_OK/); assert.equal(completed.messages[0].skill.digest, skill.digest);
  await assert.rejects(access(leaseRoot), { code: "ENOENT" });
  denied = true; await assert.rejects(service.send(task.id, "已下架后不得发送"), /withdrawn/); assert.equal(requests, 1); assert.equal(completed.messages.length, 2);
  const shelfTask = await service.create({ mode: "cowork", cwd: workspace, enterpriseSkill: shelf });
  await service.send(shelfTask.id, "玄鸟项目现在总预算是多少？"); await service.active.get(shelfTask.id)?.done.promise;
  assert.equal(service.get(shelfTask.id).status, "completed", service.get(shelfTask.id).error); assert.equal(requests, 2);
  const developer = JSON.stringify(lastBody.input.filter((item) => item.role === "developer"));
  assert.equal(JSON.stringify(lastBody).includes("SHELF_SKILL_BODY_MARKER_3C1E"), false, "a shelf skill's SKILL.md is not sent with the message");
  assert.match(developer, /local-weekly-digest: 把一周的记录整理成固定结构的周报摘要 \(file: r\d+\/SKILL\.md\)/, "but it is in the skills list the model reads");
  assert.equal(JSON.stringify(lastBody.input).includes("$local-weekly-digest"), false, "and it is not named in the message");
  console.log(JSON.stringify({ passed: true, codex: pins.codex.version, actualCodexSkillDiscovery: true, explicitSkillInstructionsInModelRequest: observedSkill, shelfSkillListedNotSent: true,
    nativeTaskLifecycle: true, removedLeaseAfterTurn: true, withdrawnContinuationRejected: true, fixtureModelRequests: requests, paidCalls: 0 }));
} finally { await service?.close(); server.close(); server.closeAllConnections(); sessions.revoke(session.token); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
