import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { SiteRegistry } from "../src/control-plane/site-registry.js";
import { SiteService } from "../src/control-plane/site-service.js";
import { runAgentTool, waitForHumanChoice } from "./fixtures/agent-harness.js";
import { appReady } from "./fixtures/app-ready.js";

// A site published from a conversation (docs/sites-phase1.md §1.1), in the
// actual Electron application: bin/agent.js run as a work task's Agent runs
// it, through the application's real bridge, to a real (synthetic) control
// plane. From a standard task it stops at the publish card, named for the task
// that asked -- cancelled here, since only the person answers a card -- and
// nothing goes out. From a task its person put on 完全访问 it publishes with
// no card, and again later updates the same site. No model, no Feishu, nothing
// billed.
// --with-person: somebody at this machine answers the publish card instead of it being cancelled.
const withPerson = process.argv.includes("--with-person");
const directory = await mkdtemp(path.join(os.tmpdir(), "idou-agent-site-"));
const evidence = path.resolve("docs/evidence");
await mkdir(evidence, { recursive: true });
let app, control = null;
try {
  const published = await SiteRegistry.open(path.join(directory, "published"));
  const sessions = new SessionRegistry();
  const service = new SiteService({ sessions, registry: published, origin: "https://sites.test", notify: () => {} });
  control = createServer(async (req, res) => { if (!await service.handle(req, res)) { res.writeHead(404); res.end(); } });
  control.listen(0, "127.0.0.1"); await once(control, "listening");
  const session = sessions.issue({ tenantId: "synthetic", userId: "ou_owner", deviceId: "d1", authProvider: "feishu", appId: "cli_smoke", deviceProof: "ed25519-login" });
  const sessionFile = path.join(directory, "session.json");
  await writeFile(sessionFile, JSON.stringify({ token: session.token, expiresAt: session.expiresAt, serverUrl: `http://127.0.0.1:${control.address().port}` }), { mode: 0o600 });
  app = await electron.launch({ executablePath: electronBinary, args: [path.resolve("scripts/fixtures/site-versions-desktop-entry.js")],
    env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), IDOU_DESKTOP_DATA_DIR: path.join(directory, "data"), IDOU_SESSION_FILE: sessionFile },
    timeout: 30_000 });
  const page = await app.firstWindow(); page.setDefaultTimeout(30_000);
  await appReady(page);
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.idou?.createTask), null, { polling: 100 });

  // A work task, and the page its Agent made in its own folder.
  const task = await page.evaluate(() => window.idou.createTask({ mode: "cowork" }));
  const cwd = (await page.evaluate(async (id) => (await window.idou.snapshot()).tasks.find((row) => row.id === id), task.id)).cwd;
  await writeFile(path.join(cwd, "index.html"), "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><title>销售看板</title><h1 id=\"mark\">第一版</h1></html>");
  await app.evaluate(({ BrowserWindow }, taskId) => BrowserWindow.getAllWindows()[0].webContents.send("idou:open-task", { taskId }), task.id);

  // Standard task: the card, named for the task, saying who will be able to open it.
  const asked = runAgentTool(app, task.id, ["site-publish", "--dir", ".", "--name", "销售看板", "--scope", "tenant"], { cwd });
  const card = page.locator("#confirmations .confirm-card");
  await card.waitFor();
  assert.equal(await card.locator("strong").first().innerText(), "确认发布这个网站");
  const said = await card.innerText();
  assert.match(said, /「销售看板」· 1 个文件/);
  assert.match(said, /里的智能体要发布这个网站/);
  assert.match(said, /谁能打开：组织内获得链接的人可阅读/);
  await page.screenshot({ path: path.join(evidence, "desktop-agent-site-card.png"), clip: await card.boundingBox() });
  if (withPerson) {
    // Answered by the person at this machine: published, as the card said.
    await waitForHumanChoice(card, "发布");
    const answered = await asked;
    assert.equal(answered.code, 0, answered.stderr);
    assert.deepEqual([answered.json.name, answered.json.updated, answered.json.online, answered.json.scope], ["销售看板", false, true, "tenant"]);
    assert.equal(published.list({ ownerId: "ou_owner" }).length, 1, "published by the person's answer");
  } else {
    // The person's to answer: cancelled here, and nothing went out.
    await card.getByRole("button", { name: "取消" }).click();
    const declined = await asked;
    assert.notEqual(declined.code, 0);
    assert.match(declined.stderr, /用户没有发布这个网站：什么都没有发出去/);
    assert.equal(published.list({ ownerId: "ou_owner" }).length, 0, "cancelled: nothing published");
  }

  // 完全访问 is the person's authorization for this task: published with no card.
  await page.evaluate((id) => window.idou.setTaskPermission(id, "full"), task.id);
  // 发布本身 10 秒内 (docs/sites-phase1.md §1.7): measured here, where no card waits on anybody.
  let started = Date.now();
  // Already up when the person answered the card: an update, which takes no --scope.
  const done = await runAgentTool(app, task.id, ["site-publish", "--dir", ".", "--name", "销售看板", ...(withPerson ? [] : ["--scope", "tenant"])], { cwd });
  const publishMs = Date.now() - started;
  assert.equal(done.code, 0, done.stderr);
  assert.ok(publishMs < 10_000, `publishing took ${publishMs} ms`);
  assert.deepEqual([done.json.name, done.json.updated, done.json.online, done.json.scope], ["销售看板", withPerson, true, "tenant"]);
  const [site] = published.list({ ownerId: "ou_owner" });
  assert.equal(done.json.url, `https://sites.test/s/${site.id}/`, "the Agent is given the link to say");
  // The one cancelled above may still be shown as answered; none is waiting.
  assert.equal(await page.locator("#confirmations .confirm-card:not(.settled)").count(), 0, "no card on full access");
  // It joined 文档网站 on its own folder.
  const listed = await page.evaluate(() => window.idou.sites());
  const folder = await realpath(cwd);
  assert.ok(listed.some((row) => row.path === folder && row.published), `the task's folder is a site in the list: ${JSON.stringify(listed.map((row) => [row.path, row.published]))}`);

  // Changed and published again: the same site, updated; who may open it is not the Agent's to change.
  await writeFile(path.join(cwd, "index.html"), "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><title>销售看板</title><h1 id=\"mark\">第二版</h1></html>");
  const widened = await runAgentTool(app, task.id, ["site-publish", "--dir", ".", "--scope", "anyone"], { cwd });
  assert.notEqual(widened.code, 0);
  assert.match(widened.stderr, /谁能打开不变/);
  started = Date.now();
  const updated = await runAgentTool(app, task.id, ["site-publish", "--dir", "."], { cwd });
  const updateMs = Date.now() - started;
  assert.equal(updated.code, 0, updated.stderr);
  assert.ok(updateMs < 10_000, `updating took ${updateMs} ms`);
  assert.equal(updated.json.updated, true);
  assert.equal(published.list({ ownerId: "ou_owner" }).length, 1, "the same site, not a second one");
  assert.equal((await published.file(site.id, "/")).bytes.toString().includes("第二版"), true);
  const mine = await runAgentTool(app, task.id, ["site-list"], { cwd });
  assert.equal(mine.code, 0, mine.stderr);
  assert.deepEqual(mine.json.sites.map((row) => [row.name, row.online, row.onThisComputer]), [["销售看板", true, true]]);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, actualElectron: true, realBridge: true, paidCalls: 0, cardCancelled: !withPerson, cardAnswered: withPerson, fullAccessPublished: true, updated: true, publishMs, updateMs }));
} finally {
  await app?.close();
  control?.close(); control?.closeAllConnections?.();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
