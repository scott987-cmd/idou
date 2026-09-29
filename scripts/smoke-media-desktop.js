import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { MediaService } from "../src/control-plane/media-service.js";
import { MiniMaxMediaProvider } from "../src/control-plane/minimax-media.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { runAgentTool, answerConfirm, waitForHumanConfirm } from "./fixtures/agent-harness.js";
import { DriveBudget, DriveBudgetService, drivePolicies } from "../src/control-plane/drive-budget.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "idou-media-ui-")), data = path.join(directory, "app");
const png = path.join(directory, "synthetic.png"), mp4 = path.join(directory, "synthetic.mp4"), sessionFile = path.join(directory, "session.json");
execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "color=c=0xc6ccbb:s=640x360", "-frames:v", "1", png]);
execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "color=c=0xc6ccbb:s=640x360:r=24", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4]);
const sessions = new SessionRegistry(), calls = [], secret = "synthetic-media-key-never-client";
const mediaTokens = [], issueMedia = sessions.issueForMedia.bind(sessions);
sessions.issueForMedia = (...args) => { const lease = issueMedia(...args); mediaTokens.push(lease.token); return lease; };
const issueDrive = sessions.issueForDrive.bind(sessions);
sessions.issueForDrive = (...args) => { const lease = issueDrive(...args); mediaTokens.push(lease.token); return lease; };
const provider = new MiniMaxMediaProvider({ apiKey: secret, fetchImpl: async (url, init) => {
  calls.push({ url, method: init.method }); assert.equal(init.headers.authorization, `Bearer ${secret}`);
  const response = (value) => Response.json({ ...value, base_resp: { status_code: 0 } });
  if (url.endsWith("/image_generation")) return response({ data: { image_urls: ["https://cdn.example.com/synthetic.png"] } });
  if (init.method === "POST") return response({ task_id: "12345" });
  if (url.includes("/query/")) return response({ task_id: "12345", status: "Success", file_id: "23456" });
  return response({ file: { file_id: "23456", purpose: "video_generation", bytes: 5000, download_url: "https://cdn.example.com/synthetic.mp4" } });
} });
const media = new MediaService({ sessions, provider, allowDevelopment: true });
const driveLedger = new DriveBudget({ feishu: SAAS_FEISHU, databaseFile: path.join(directory, "server-budget.sqlite"), policies: [{ authProvider: "development", tenantId: "synthetic", appId: null, providerId: "saas-cli", driveTenantKey: "synthetic-tenant", folderToken: "SyntheticFolder123", maxBytes: 10485760 }] });
const driveBudget = new DriveBudgetService({ sessions, ledger: driveLedger, allowDevelopment: true });
const server = createModelGateway({ sessions, apiKey: secret, authHandler: async (req, res) => await media.handle(req, res) || await driveBudget.handle(req, res), fetchImpl: () => assert.fail("No text-model call expected") });
server.listen(0, "127.0.0.1"); await once(server, "listening");
const parent = sessions.issue({ tenantId: "synthetic", userId: "synthetic", deviceId: "device" });
await writeFile(sessionFile, JSON.stringify({ token: parent.token, expiresAt: parent.expiresAt, serverUrl: `http://127.0.0.1:${server.address().port}` }), { mode: 0o600 });
const evidence = path.resolve("docs/evidence"); await mkdir(evidence, { recursive: true });
const launch = () => electron.launch({ executablePath: electronBinary, args: [path.resolve("scripts/fixtures/media-desktop-entry.js")], env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), IDOU_SESSION_FILE: sessionFile, IDOU_DESKTOP_DATA_DIR: data, MEDIA_FIXTURE_PNG: png, MEDIA_FIXTURE_MP4: mp4, MEDIA_FIXTURE_DRIVE: path.join(directory, "synthetic-remote-drive.json") } });
let app; const errors = [];
const IMAGE_PROMPT = "合成联调样本：一张安静的浅灰绿背景，用于验证图片成果预览。";
const VIDEO_PROMPT = "合成联调样本：浅灰绿的静态画面，验证视频播放控件。";
const FOLDER = "https://synthetic.feishu.cn/drive/folder/SyntheticFolder123";
const promptFile = path.join(directory, "prompt.txt");
const ask = async (taskId, args) => { await writeFile(promptFile, args.prompt ?? ""); return runAgentTool(app, taskId, args.argv, { cwd: directory }); };
// Submission is asynchronous for both kinds, so a job is "running" the moment
// it is created and only settles through polling -- which is exactly what the
// Agent has to do.
const settle = async (taskId, job) => {
  let status = await ask(taskId, { argv: ["media-status", "--job", job] });
  assert.equal(status.code, 0, status.stderr);
  for (let i = 0; i < 25 && status.json?.state === "running"; i++) {
    for (const item of media.jobs.values()) item.nextPollAt = 0;
    await new Promise((resolve) => setTimeout(resolve, 200));
    status = await ask(taskId, { argv: ["media-status", "--job", job] });
  }
  return status;
};
// A task's card shows in that task, and this one was made over IPC, so it is
// not open. It is reached the way a person reaches it: from the card's notice.
// Notices are recorded rather than shown, and following one leaves the window
// where it is -- an acceptance run never takes the screen.
const recordNotices = () => app.evaluate(({ BrowserWindow, Notification }) => {
  globalThis.notices = [];
  Notification.prototype.show = function () { globalThis.notices.push(this); };
  BrowserWindow.getAllWindows()[0].isFocused = () => false;
});
const followNotice = async () => {
  for (let tries = 0; tries < 150 && !(await app.evaluate(() => globalThis.notices.length)); tries++) await new Promise((resolve) => setTimeout(resolve, 100));
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0], show = win.show, focus = win.focus;
    win.show = () => {}; win.focus = () => {};
    try { globalThis.notices.at(-1)?.emit("click"); } finally { win.show = show; win.focus = focus; }
  });
};
try {
  app = await launch(); let page = await app.firstWindow(); page.setDefaultTimeout(20000); page.on("pageerror", (e) => errors.push(e.message));
  await page.locator("#new-task").waitFor();
  let taskId = (await page.evaluate(() => window.idou.createTask({ mode: "cowork" }))).id;
  // Creating a task over IPC does not notify the renderer; a reload picks it up.
  await page.reload(); await page.locator("#new-task").waitFor();
  await recordNotices();

  // Declining generates nothing at all: no upstream call, no record.
  let running = ask(taskId, { prompt: IMAGE_PROMPT, argv: ["media-create", "--kind", "image", "--prompt-file", "prompt.txt"] });
  await followNotice();
  await answerConfirm(page, "取消");
  let result = await running;
  assert.notEqual(result.code, 0); assert.match(result.stderr, /用户取消/);
  assert.equal(calls.length, 0);
  assert.equal((await page.evaluate(async (id) => window.idou.listMedia(id), taskId)).length, 0);

  running = ask(taskId, { prompt: IMAGE_PROMPT, argv: ["media-create", "--kind", "image", "--prompt-file", "prompt.txt"] });
  const generateCard = await waitForHumanConfirm(page, "生成一张图片");
  assert.match(generateCard, new RegExp(IMAGE_PROMPT)); assert.match(generateCard, /可能产生模型费用/);
  result = await running;
  assert.equal(result.code, 0, result.stderr);
  const imageJob = result.json.id;
  assert.equal(result.json.state, "running");
  assert.equal((await settle(taskId, imageJob)).json.state, "awaiting_acceptance");
  assert.equal(calls.filter((row) => row.method === "POST").length, 1);

  // The bytes never reach the conversation or the renderer: the preview is an
  // isolated view with no bridge and no module loader.
  let popupPromise = app.waitForEvent("window");
  assert.equal((await ask(taskId, { argv: ["media-preview", "--job", imageJob] })).code, 0);
  let preview = await popupPromise;
  await preview.locator("img").waitFor(); await preview.waitForFunction(() => document.querySelector("img")?.naturalWidth === 640);
  assert.equal(await preview.evaluate(() => typeof window.idou), "undefined"); assert.equal(await preview.evaluate(() => typeof require), "undefined");
  await preview.screenshot({ path: path.join(evidence, "desktop-media-image-preview-fixture.png"), scale: "css" });
  // Closed the way the panel closes it, which is what releases the temporary
  // copy; dropping the view alone leaves the bytes on disk.
  const previewPath = fileURLToPath(preview.url());
  await page.locator("#close-media-preview").click();
  for (let i = 0; i < 100; i++) { try { await access(previewPath); await new Promise((resolve) => setTimeout(resolve, 50)); } catch { break; } }
  await assert.rejects(access(previewPath), { code: "ENOENT" });

  // Declining the upload spends no budget and uploads nothing.
  running = ask(taskId, { argv: ["media-save", "--job", imageJob, "--folder", FOLDER] });
  const saveCard = await answerConfirm(page, "取消");
  assert.match(saveCard, /不覆盖/); assert.match(saveCard, /托管上传预算/);
  assert.notEqual((await running).code, 0);
  assert.equal(await app.evaluate(() => globalThis.mediaFixture.drive.uploads), 0);
  assert.equal(driveLedger.snapshot(parent).chargedBytes, 0);

  running = ask(taskId, { argv: ["media-save", "--job", imageJob, "--folder", FOLDER] });
  await waitForHumanConfirm(page, "确认上传");
  const saved = await running;
  assert.equal(saved.code, 0, saved.stderr);
  assert.equal(await app.evaluate(() => globalThis.mediaFixture.drive.uploads), 1);
  assert.equal(driveLedger.snapshot(parent).chargedBytes, (await readFile(png)).length);
  const verified = await ask(taskId, { argv: ["media-verify", "--job", imageJob] });
  assert.equal(verified.code, 0); assert.equal(verified.json.url, "https://synthetic.feishu.cn/file/SyntheticFile1123");
  // The documented way out when verification cannot name the file: hand over the
  // destination folder and let the person look. Both exits answer on `.url`, but
  // only this one wraps -- media-verify returns the upload receipt whole, while
  // this returns an envelope the operation builds around a bare link. Pinned
  // together because nothing else keeps the two shapes from drifting apart.
  const folderLink = await ask(taskId, { argv: ["media-folder", "--job", imageJob] });
  assert.equal(folderLink.code, 0, folderLink.stderr);
  assert.deepEqual(folderLink.json, { url: FOLDER });
  assert.deepEqual(Object.keys(verified.json).sort(), ["fileToken", "name", "providerId", "url", "verifiedAt"]);
  assert.notEqual(folderLink.json.url, verified.json.url, "the fallback names the folder, not the file inside it");
  // Reading a destination changes nothing, so it must not interrupt the person.
  assert.equal(await page.locator("#confirmations .confirm-card").count(), 0);
  // A malformed id is refused by the shim before any Drive lookup happens.
  const badJob = await ask(taskId, { argv: ["media-folder", "--job", "not-a-uuid"] });
  assert.notEqual(badJob.code, 0); assert.match(badJob.stderr, /媒体记录 id/);
  await page.screenshot({ path: path.join(evidence, "desktop-media-drive-fixture.png"), scale: "css" });

  // A video is not finished when generation returns.
  running = ask(taskId, { prompt: VIDEO_PROMPT, argv: ["media-create", "--kind", "video", "--prompt-file", "prompt.txt"] });
  await waitForHumanConfirm(page, "生成一段视频");
  result = await running;
  assert.equal(result.code, 0, result.stderr);
  const videoJob = result.json.id;
  assert.equal(result.json.state, "running");
  const status = await settle(taskId, videoJob);
  assert.equal(status.code, 0);
  assert.equal(status.json.state, "awaiting_acceptance", "the video job must resolve through media-status");
  popupPromise = app.waitForEvent("window");
  assert.equal((await ask(taskId, { argv: ["media-preview", "--job", videoJob] })).code, 0);
  preview = await popupPromise;
  await preview.waitForFunction(() => document.querySelector("video")?.readyState >= 1);
  await preview.locator("video").evaluate((video) => video.play()); await preview.waitForFunction(() => document.querySelector("video")?.currentTime > 0);
  await preview.screenshot({ path: path.join(evidence, "desktop-media-video-preview-fixture.png"), scale: "css" });
  await page.locator("#close-media-preview").click();
  await page.screenshot({ path: path.join(evidence, "desktop-media-workspace-fixture.png"), scale: "css" });

  // Over budget the upload is refused before any byte leaves.
  driveLedger.policies = drivePolicies(driveLedger.policies.map(({ key, policyDigest, ...value }) => ({ ...value, maxBytes: (driveLedger.snapshot(parent)).chargedBytes })), SAAS_FEISHU);
  const uploadsBeforeDenial = await app.evaluate(() => globalThis.mediaFixture.drive.uploads);
  const denied = await ask(taskId, { argv: ["media-save", "--job", videoJob, "--folder", FOLDER] });
  assert.notEqual(denied.code, 0); assert.match(denied.stderr, /预算不足/);
  assert.equal(await app.evaluate(() => globalThis.mediaFixture.drive.uploads), uploadsBeforeDenial);
  // The refused upload left no save record, so the fallback has no destination to
  // hand over: it says so rather than pointing at a folder the file is not in.
  const noRecord = await ask(taskId, { argv: ["media-folder", "--job", videoJob] });
  assert.notEqual(noRecord.code, 0); assert.match(noRecord.stderr, /没有待核查的保存记录/);

  // Records survive a restart, and a saved file is still verifiable afterwards.
  await app.close(); app = await launch(); page = await app.firstWindow(); page.setDefaultTimeout(20000); page.on("pageerror", (e) => errors.push(e.message));
  await page.locator("#new-task").waitFor();
  await recordNotices();
  const restored = await page.evaluate(async (id) => window.idou.listMedia(id), taskId);
  assert.equal(restored.length, 2);
  assert.equal(calls.filter((row) => row.method === "POST").length, 2);
  assert.equal((await ask(taskId, { argv: ["media-verify", "--job", imageJob] })).json.url, "https://synthetic.feishu.cn/file/SyntheticFile1123");
  assert.equal(await app.evaluate(() => globalThis.mediaFixture.drive.uploads), 1);

  running = ask(taskId, { argv: ["media-cancel", "--job", videoJob] });
  await followNotice();
  await waitForHumanConfirm(page, "停止并丢弃");
  assert.equal((await running).code, 0);
  assert.equal((await page.evaluate(async (id) => window.idou.listMedia(id), taskId)).find((row) => row.id === videoJob).state, "canceled");

  // Switching accounts takes the records with it, and brings them back.
  const foreignSession = sessions.issue({ tenantId: "synthetic", userId: "foreign", deviceId: "device" }), foreignFile = path.join(directory, "foreign-session.json");
  await writeFile(foreignFile, JSON.stringify({ token: foreignSession.token, expiresAt: foreignSession.expiresAt, serverUrl: `http://127.0.0.1:${server.address().port}` }), { mode: 0o600 });
  await app.evaluate((_electron, filename) => { globalThis.mediaFixture.connectionFile = filename; }, foreignFile);
  await page.evaluate(() => window.idou.connect());
  // Another account sees none of this account's results.
  assert.deepEqual(await page.evaluate(async (id) => window.idou.listMedia(id), taskId), []);
  await app.evaluate((_electron, filename) => { globalThis.mediaFixture.connectionFile = filename; }, sessionFile);
  await page.evaluate(() => window.idou.connect());
  assert.equal((await page.evaluate(async (id) => window.idou.listMedia(id), taskId)).length, 2);
  assert.equal(calls.filter((row) => row.method === "POST").length, 2);

  // Drive resource tokens are journal metadata, not credentials. Exact provider,
  // parent and every issued media credential are scanned below across all files.
  const journal = await readFile(path.join(data, "media-jobs.json"), "utf8"); assert.doesNotMatch(journal, /synthetic-media-key|cdn.example|合成联调/);
  const publicRecords = await page.evaluate(async (id) => window.idou.listMedia(id), taskId);
  assert.doesNotMatch(JSON.stringify(publicRecords), /token|cdn.example|https?:/);
  const scan = async (root) => { for (const entry of await readdir(root, { withFileTypes: true })) { const name = path.join(root, entry.name); if (entry.isDirectory()) await scan(name); else if (entry.isFile()) { const bytes = await readFile(name); for (const value of [secret, parent.token, ...mediaTokens]) assert.equal(bytes.includes(Buffer.from(value)), false, name); } } }; await scan(data);
  assert.equal(errors.length, 0); console.log(JSON.stringify({ passed: true, actualElectron: true, agentDriven: true, inAppConfirmation: true, imageDecoded: true, videoPlayed: true, clientRestart: true, generatedPosts: 2, syntheticDriveUploads: 1, persistentServerBudget: true, overBudgetUploadDenied: true, driveReverifiedAfterRestart: true, driveFolderFallback: true, liveFeishuWrites: 0, paidCalls: 0, rendererErrors: errors }));
} finally { await app?.close(); await media.close(); server.close(); server.closeAllConnections(); driveLedger.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
