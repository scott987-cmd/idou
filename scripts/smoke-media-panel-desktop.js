// The 图片与视频 panel follows the Agent. 2026-09-23: a video was submitted,
// polled for two minutes and finished while the panel on screen still listed
// the four records it had read when it was opened -- nothing told it the Agent
// had moved anything, and only 刷新状态 or reopening the tab would.
//
// No confirmation is answered here, positively or at all: the video was
// confirmed in an earlier session. The job is made on the server by this
// harness and its record written before the app starts, which is what a video
// awaiting its result looks like after a restart. Only media-status -- a read,
// which raises no card -- moves it forward.
import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { MediaService } from "../src/control-plane/media-service.js";
import { MiniMaxMediaProvider } from "../src/control-plane/minimax-media.js";
import { QwenVideoProvider } from "../src/control-plane/qwen-media.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { runAgentTool } from "./fixtures/agent-harness.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "idou-media-panel-")), data = path.join(directory, "app");
// Nothing is uploaded. The one preview, at the end, reads a one-second sample
// video made here, as the fixture stands in for the download.
const sessionFile = path.join(directory, "session.json"), mp4 = path.join(directory, "synthetic.mp4");
execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "color=c=0xc6ccbb:s=640x360:r=24", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4]);

// Video on Qwen, as the server runs it since 2026-09-23, answering in the
// Token Plan's recorded shapes; images on MiniMax (the panel's list leases one).
const TASK = "7aa368f2-e474-40da-9f0d-7fb6118b6eb5";
let finished = false;
const qwen = new QwenVideoProvider({ apiKey: "sk-sp-synthetic-token-plan-key", fetchImpl: async (url, init) => Response.json(init.method === "POST"
  ? { request_id: "synthetic", output: { task_id: TASK, task_status: "PENDING" } }
  : { request_id: "synthetic", output: finished
    ? { task_id: TASK, task_status: "SUCCEEDED", video_url: "https://dashscope-463f.oss-accelerate.aliyuncs.com/synthetic.mp4?Signature=synthetic", orig_prompt: "synthetic" }
    : { task_id: TASK, task_status: "RUNNING" } }) });
const minimax = new MiniMaxMediaProvider({ apiKey: "synthetic-minimax-key", fetchImpl: async () => assert.fail("no image is made here") });
const sessions = new SessionRegistry(), media = new MediaService({ sessions, provider: minimax, providers: { video: qwen }, allowDevelopment: true });
const server = createModelGateway({ sessions, apiKey: "synthetic", authHandler: (req, res) => media.handle(req, res), fetchImpl: () => assert.fail("No text-model call expected") });
server.listen(0, "127.0.0.1"); await once(server, "listening");
const serverUrl = `http://127.0.0.1:${server.address().port}`;
const parent = sessions.issue({ tenantId: "synthetic", userId: "synthetic", deviceId: "device" });
await writeFile(sessionFile, JSON.stringify({ token: parent.token, expiresAt: parent.expiresAt, serverUrl }), { mode: 0o600 });
const post = async (route, token, body) => (await fetch(serverUrl + route, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) })).json();

const launch = () => electron.launch({ executablePath: electronBinary, args: [path.resolve("scripts/fixtures/media-desktop-entry.js")], env: { ...clientEnvironment(),
  ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}),
  IDOU_SESSION_FILE: sessionFile, IDOU_DESKTOP_DATA_DIR: data, MEDIA_FIXTURE_MP4: mp4, MEDIA_FIXTURE_DRIVE: path.join(directory, "drive.json") } });
let app; const errors = [];
try {
  // A work task to hold the video.
  app = await launch(); let page = await app.firstWindow(); page.setDefaultTimeout(20_000);
  await page.locator("#new-task").waitFor();
  const taskId = (await page.evaluate(() => window.idou.createTask({ mode: "cowork" }))).id;
  await app.close();
  // A task nobody has spoken to is not in the sidebar after a restart; the
  // message the person typed is what puts it back (as in smoke-app-review).
  const taskFile = path.join(data, "tasks", `${taskId}.json`), saved = JSON.parse(await readFile(taskFile, "utf8"));
  saved.messages.push({ id: randomUUID(), role: "user", text: "做一段 6 秒概念视频。", createdAt: Date.now() });
  await writeFile(taskFile, JSON.stringify(saved), { mode: 0o600 });

  // The video as an earlier session left it: made on the server, recorded here.
  const lease = await post("/auth/media-token", parent.token, { kind: "video" });
  assert.equal(lease.offer.provider, "qwen");
  const rowId = randomUUID();
  const job = await post("/v1/media/jobs", lease.token, { kind: "video", prompt: "合成联调样本：墨蓝底上三个浅色窗格。", idempotencyKey: rowId, instanceId: lease.instanceId, confirmed: true, model: lease.offer.model });
  await Promise.all([...media.pending]);
  const { owner } = lease;
  const ownerKey = createHash("sha256").update(JSON.stringify([serverUrl, owner.authProvider, owner.tenantId, owner.appId, owner.userId])).digest("hex");
  await writeFile(path.join(data, "media-jobs.json"), JSON.stringify({ schemaVersion: 1, rows: [
    { id: rowId, taskId, instanceId: lease.instanceId, jobId: job.id, kind: "video", state: "running", ownerKey, createdAt: Date.now() }] }), { mode: 0o600 });

  app = await launch(); page = await app.firstWindow(); page.setDefaultTimeout(20_000); page.on("pageerror", (error) => errors.push(error.message));
  await page.locator("#new-task").waitFor();
  await page.locator("#recent-tasks .recent-row", { hasText: "新工作任务" }).locator("button").first().click();
  await page.locator('#task-tabs button[data-tab="media"]').click();
  const panel = page.locator("#media-results");
  await panel.locator(".media-card", { hasText: "正在生成视频" }).waitFor();
  assert.match(await page.locator("#media-notice").textContent(), /^1 项媒体记录/);

  // From here nothing in the panel is touched. A refresh the Agent causes
  // must not blank the list either: it is replaced when the new one is in hand.
  await page.evaluate(() => {
    globalThis.__blanked = [];
    new MutationObserver(() => { if (/正在读取/.test(document.querySelector("#media-notice").textContent)) globalThis.__blanked.push(Date.now()); })
      .observe(document.querySelector("#media-notice"), { childList: true, characterData: true, subtree: true });
  });
  const status = () => runAgentTool(app, taskId, ["media-status", "--job", rowId], { cwd: directory });
  let checked = await status();
  assert.equal(checked.code, 0, checked.stderr); assert.equal(checked.json.state, "running");
  finished = true;
  for (let i = 0; i < 25 && checked.json?.state === "running"; i++) {
    for (const item of media.jobs.values()) item.nextPollAt = 0;
    await new Promise((resolve) => setTimeout(resolve, 200));
    checked = await status();
  }
  assert.equal(checked.json.state, "awaiting_acceptance", checked.stderr);
  const done = panel.locator(".media-card", { hasText: "视频临时成果" });
  await done.waitFor({ timeout: 10_000 });
  assert.match(await done.innerText(), /可预览 · 尚未保存/);
  await done.getByRole("button", { name: "预览临时成果" }).waitFor();
  assert.equal(await panel.locator(".media-card", { hasText: "正在生成视频" }).count(), 0, "the running card is gone, not left beside the finished one");
  assert.deepEqual(await page.evaluate(() => globalThis.__blanked), [], "a refresh nobody asked for keeps the list on screen");

  // The result shown -- a read the Agent makes, which raises no card -- and then
  // the task left for another section. Leaving by the panel's own tabs took the
  // result down; leaving the task did not, and its view stayed on the window out
  // of sight, 播放 and 静音 still there for a screen reader (2026-09-23).
  const previewViews = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children
    .filter((view) => view.webContents && !view.webContents.isDestroyed() && view.webContents.getURL().includes("idou-media-preview"))
    .map((view) => ({ visible: view.getVisible(), width: view.getBounds().width })));
  const waitFor = async (accept, label) => {
    let value;
    for (const deadline = Date.now() + 15_000; Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 200))) if (accept(value = await previewViews())) return value;
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(value)}`);
  };
  const shown = await runAgentTool(app, taskId, ["media-preview", "--job", rowId], { cwd: directory });
  assert.equal(shown.code, 0, shown.stderr);
  await waitFor((views) => views.length === 1 && views[0].visible && views[0].width > 0, "the result on screen in its panel");
  await page.locator('[data-section="coding"]').click();
  await waitFor((views) => views.length === 0, "the result's view off the window once its task is left");
  assert.deepEqual(errors, []);
  console.log("media panel desktop smoke passed");
} finally {
  await app?.close().catch(() => {});
  await media.close(); server.close(); server.closeAllConnections();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
