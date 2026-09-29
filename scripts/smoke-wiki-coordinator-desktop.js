import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { once } from "node:events";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { DriveBudget } from "../src/control-plane/drive-budget.js";
import { WikiCoordinator, WikiCoordinatorService } from "../src/control-plane/wiki-coordinator.js";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";
const directory = await mkdtemp(path.join(os.tmpdir(), "idou-wiki-node-ui-")), evidence = path.resolve("docs/evidence");
await mkdir(evidence, { recursive: true });
const sessions = new SessionRegistry(), parent = sessions.issue({ tenantId: "development", userId: "local-developer", deviceId: "synthetic-desktop-node" });
const policy = { authProvider: "development", tenantId: "development", appId: null, providerId: "saas-cli", driveTenantKey: "synthetic-tenant", folderToken: "SyntheticFolder123", maxBytes: 10485760 };
const budget = new DriveBudget({ feishu: SAAS_FEISHU, databaseFile: path.join(directory, "budget.sqlite"), policies: [policy] });
const coordinator = new WikiCoordinator({ databaseFile: path.join(directory, "wiki.sqlite"), tenants: [{ authProvider: "development", tenantId: "development", appId: null, members: ["local-developer"] }], budget });
const service = new WikiCoordinatorService({ sessions, coordinator, allowDevelopment: true });
const calls = []; let unavailable = false;
// The desktop also asks this server which chat model it runs: /healthz (model
// discovery, proved in smoke-discovery-desktop.js) and, since the server keeps
// each person's model, /v1/models/* (docs/chat-models.md). Neither is a
// coordinator contact, so they are answered but not counted.
const server = createServer(async (req, res) => { if (req.url !== "/healthz" && !req.url.startsWith("/v1/models/")) calls.push(req.url); if (unavailable) { res.writeHead(503); res.end(); return; } if (!await service.handle(req, res)) { res.writeHead(404); res.end(); } });
server.listen(0, "127.0.0.1"); await once(server, "listening");
const serverUrl = `http://127.0.0.1:${server.address().port}`, sessionFile = path.join(directory, "session.json");
await writeFile(sessionFile, JSON.stringify({ token: parent.token, expiresAt: parent.expiresAt, serverUrl }), { mode: 0o600 });
let app, page; const errors = [];
try {
  app = await electron.launch({ executablePath: electronBinary, args: [path.resolve("scripts/fixtures/chat-desktop-entry.js")], env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), IDOU_SESSION_FILE: sessionFile, IDOU_DESKTOP_DATA_DIR: path.join(directory, "desktop") } });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
  await page.locator('[data-section="knowledge"]').click();
  await page.locator(".knowledge-advanced > summary").click();
  await page.locator("#knowledge-node-check").waitFor();
  assert.equal(calls.length, 0, "navigation alone must not contact coordinator");
  await page.locator("#knowledge-node-check").click(); await page.locator("#knowledge-node-status").filter({ hasText: "协调服务已连接" }).waitFor();
  const connected = await page.locator("#knowledge-node-status").innerText();
  assert.match(connected, /节点 [0-9a-f]{12} · 分片租约 120 秒/);
  assert.match(connected, /托管云盘剩余 10\.00 MiB/);
  // This sentence used to read "尚未上传 Wiki". /v1/wiki/status answers with node
  // identity, Drive policy and limits only -- it carries no shard, generation or
  // publication count -- so that wording claimed something the response cannot
  // support, the way a refusal used to claim it had been a document read. The
  // product now states what this request actually did, and the guarantee behind
  // the old wording (checking the connection uploads nothing) is proved on both
  // sides: the sentence the user reads, and the untouched Drive ledger and shard
  // table underneath it.
  assert.match(connected, /此次检查仅查询元数据/);
  assert.equal(budget.snapshot(policy).chargedBytes, 0, "a status check must not charge managed Drive budget");
  assert.equal(coordinator.db.prepare("SELECT COUNT(*) AS n FROM wiki_heads").get().n, 0, "a status check must not create a shard head");
  assert.equal(await page.evaluate(() => Object.keys(window.idou).some(key => /acquire|publishWiki|renewWiki/i.test(key))), false, "renderer cannot claim/publish arbitrary shards");
  await page.locator("#knowledge-node-check").evaluate(node => node.parentElement.scrollIntoView({ block: "center", behavior: "instant" }));
  assert.equal(await page.locator("#knowledge-node-check").evaluate(node => { const box = node.getBoundingClientRect(); return box.top >= 60 && box.bottom <= innerHeight; }), true);
  await page.screenshot({ path: path.join(evidence, "desktop-wiki-node-fixture.png"), scale: "css" });
  unavailable = true; await page.locator("#knowledge-node-check").click(); await page.locator("#knowledge-node-status").filter({ hasText: "尚未连接" }).waitFor();
  assert.doesNotMatch(await page.locator("#knowledge-node-status").innerText(), /协调服务已连接/);
  unavailable = false; await page.locator("#knowledge-node-check").click(); await page.locator("#knowledge-node-status").filter({ hasText: "协调服务已连接" }).waitFor();
  sessions.revoke(parent.token); await page.locator("#knowledge-node-check").click(); await page.locator("#knowledge-node-status").filter({ hasText: "尚未连接" }).waitFor();
  assert.equal(coordinator.db.prepare("SELECT COUNT(*) AS n FROM wiki_leases").get().n, 0);
  assert.ok(calls.every(route => ["/auth/wiki-token", "/v1/wiki/status"].includes(route)));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, actualElectronHttpSqlite: true, syntheticIdentityAndFeishu: true, explicitStatusRead: true, noRendererWriteApi: true, quotaVisible: true, metadataOnlyCheck: true, failureClearsStaleSuccess: true, parentRevocation: true, leasesCreated: 0, shardHeads: 0, chargedBytes: 0, liveWrites: 0, modelCalls: 0 }));
} catch (error) { if (page && !page.isClosed()) await page.screenshot({ path: path.join(evidence, "desktop-wiki-node-failure.png"), scale: "css" }); throw error; }
finally { await app?.close(); sessions.revoke(parent.token); server.close(); server.closeAllConnections(); coordinator.close(); budget.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
