import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { SiteRegistry } from "../src/control-plane/site-registry.js";
import { SiteService } from "../src/control-plane/site-service.js";
import { appHash } from "../src/apps/manifest.js";
import { BASE_TABLE, BASE_TOKEN } from "./fixtures/base-data.js";
import { appReady } from "./fixtures/app-ready.js";

// A published table site following its table on the application's own clock,
// in the actual Electron application (docs/sites-phase1.md §1.7): read in full
// twice, then only asked how it stands while it stands still -- no page of it
// read and nothing sent -- and read and sent again, compressed, the moment it
// moves. No card is involved: the slice was confirmed when the site was made,
// which this smoke records directly, as smoke-site-list-desktop.js does.
// Synthetic Feishu and a synthetic control plane, no network, no model.
const directory = await mkdtemp(path.join(os.tmpdir(), "idou-site-refresh-"));
let app, control = null;
const pack = (text) => ({
  manifest: { schemaVersion: 1, runtime: "static", network: "none", entry: "index.html", files: [{ path: "index.html", bytes: Buffer.byteLength(text), sha256: appHash(Buffer.from(text)) }] },
  blobs: [{ path: "index.html", base64: Buffer.from(text).toString("base64") }],
});
const waitFor = async (what, check, ms = 90_000) => {
  for (const until = Date.now() + ms; Date.now() < until;) { const value = await check(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 250)); }
  throw new Error(`等了 ${ms / 1000} 秒：${what}`);
};
try {
  const published = await SiteRegistry.open(path.join(directory, "published"));
  const sessions = new SessionRegistry();
  const service = new SiteService({ sessions, registry: published, origin: "https://sites.test", notify: () => {} });
  // What reached the server's data route, and how.
  const pushes = [];
  control = createServer(async (req, res) => {
    if (req.url === "/v1/sites/data") pushes.push({ encoding: req.headers["content-encoding"] ?? null, bytes: Number(req.headers["content-length"] ?? 0) });
    if (!await service.handle(req, res)) { res.writeHead(404); res.end(); }
  });
  control.listen(0, "127.0.0.1"); await once(control, "listening");
  const session = sessions.issue({ tenantId: "synthetic", userId: "ou_owner", deviceId: "d1", authProvider: "feishu", appId: "cli_smoke", deviceProof: "ed25519-login" });
  const sessionFile = path.join(directory, "session.json");
  await writeFile(sessionFile, JSON.stringify({ token: session.token, expiresAt: session.expiresAt, serverUrl: `http://127.0.0.1:${control.address().port}` }), { mode: 0o600 });
  app = await electron.launch({ executablePath: electronBinary, args: [path.resolve("scripts/fixtures/site-versions-desktop-entry.js")],
    env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), IDOU_DESKTOP_DATA_DIR: path.join(directory, "data"), IDOU_SESSION_FILE: sessionFile },
    timeout: 30_000 });
  // What the application says of a refresh that failed (main.js refreshDueSites), for the failure below.
  const said = globalThis.said = [];
  app.process().stderr?.on("data", (chunk) => { said.push(String(chunk)); if (said.length > 200) said.shift(); });
  const window = await app.firstWindow(); window.setDefaultTimeout(30_000);
  await appReady(window);
  const errors = []; window.on("pageerror", (error) => errors.push(error.message));
  await window.waitForFunction(() => Boolean(window.idou?.sites), null, { polling: 100 });
  // The list once, as the person opening 文档网站 would: the server says what it takes.
  assert.ok(Array.isArray(await window.evaluate(() => window.idou.sites())));

  // A table of 1,502 rows: more than a page, and data big enough to be worth compressing.
  await app.evaluate(() => {
    for (let n = 3; n <= 1502; n += 1) globalThis.tableFixture.records[`recSynthetic${String(n).padStart(4, "0")}`] = { fldName00001: `客户 ${n}`, fldCount0001: n, fldOwner0001: [] };
  });
  const slice = { kind: "base", token: BASE_TOKEN, tableId: BASE_TABLE, fields: ["fldName00001", "fldCount0001"], rows: 5000, refreshSeconds: 15 };
  const site = await app.evaluate((_electron, value) => globalThis.siteStoreFixture.create({ name: "跟着表格走", slice: value }), slice);
  const up = await published.publish({ ownerId: "ou_owner", tenantId: "synthetic", name: "跟着表格走", share: { scope: "invited" },
    source: { kind: "base", token: BASE_TOKEN, tableId: BASE_TABLE }, ...pack("<!doctype html><title>看板</title><p>看板</p>") });
  await app.evaluate((_electron, { id, publishedId }) => globalThis.siteStoreFixture.recordPublish(id, { publishedId, url: `https://sites.test/s/${publishedId}/`, scope: "invited", inherit: false, offline: false }),
    { id: site.id, publishedId: up.id });
  const calls = () => app.evaluate(() => ({ asked: globalThis.tableFixture.calls.filter((argv) => argv[1] === "+table-list").length, pages: globalThis.tableFixture.reads }));
  const stored = () => app.evaluate((_electron, id) => globalThis.siteStoreFixture.get(id), site.id);

  // 1. The first read: in full, and sent -- compressed, since the server said it takes that.
  const seeded = Date.now();
  const first = await waitFor("第一次自动读取的数据到服务端", async () => (await published.data(up.id))?.snapshot?.rowCount === 1502 && pushes.length);
  assert.ok(first);
  // Within one tick of the clock (every 15 seconds) and the read itself (§1.7).
  const firstMs = Date.now() - seeded;
  assert.ok(firstMs < 30_000, `the first reading reached the server after ${firstMs} ms`);
  assert.equal(pushes[0].encoding, "gzip", "the server listed compressed-requests");
  const plainSize = Buffer.byteLength(JSON.stringify(await published.data(up.id)));
  assert.ok(pushes[0].bytes * 4 < plainSize, `sent ${pushes[0].bytes} bytes of ${plainSize}`);
  assert.equal((await calls()).pages, 8, "1,502 rows are eight pages");

  // 2. Read in full once more before the table's word is trusted; the same data is not sent again.
  // Waited for as recorded, not as asked: the 16th page is asked for before the read is written down.
  const settled = await waitFor("第二次完整读取记下了", async () => { const site = await stored(); return site.probeBefore && site.probe === site.probeBefore ? site : null; });
  assert.equal((await calls()).pages, 16, "read in full twice");
  assert.equal(pushes.length, 1, "nothing new: nothing sent");

  // 3. From now on, while the table stands still: asked, not read, not sent.
  const asked = (await calls()).asked;
  await waitFor("下一次只问版本号", async () => (await calls()).asked > asked);
  await waitFor("又一次只问版本号", async () => (await calls()).asked > asked + 1);
  assert.equal((await calls()).pages, 16, "no page read while the table stood still");
  assert.equal(pushes.length, 1);
  assert.ok((await stored()).lastReadAt > settled.lastReadAt, "the check counts as looking at it");

  // 4. Somebody edits a row in Feishu: its revision moves, and the edit is read and sent.
  await app.evaluate(() => { globalThis.tableFixture.records.recSynthetic0700.fldName00001 = "改过的客户"; globalThis.tableFixture.rev += 1; });
  const moved = await waitFor("改动到服务端", async () => {
    const data = await published.data(up.id);
    return data?.snapshot?.rows?.find((row) => row.id === "recSynthetic0700")?.values?.fldName00001?.text === "改过的客户" ? data : null;
  });
  assert.equal(moved.snapshot.rowCount, 1502);
  assert.equal(pushes.length, 2);
  assert.equal(pushes[1].encoding, "gzip");
  assert.equal((await calls()).pages, 24, "read once in full for the change");

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, actualElectron: true, syntheticFeishu: true, paidCalls: 0, rows: 1502,
    fullReads: 3, probesWhileStill: "≥2", pushes: pushes.length, compressed: pushes.every((push) => push.encoding === "gzip"), sentBytes: pushes[0].bytes, plainBytes: plainSize, firstReadMs: firstMs }));
} catch (error) {
  if (app) {
    const site = await app.evaluate(() => globalThis.siteStoreFixture?.list().find((row) => row.name === "跟着表格走") ?? null).catch(() => null);
    const asked = await app.evaluate(() => globalThis.tableFixture?.calls.map((argv) => argv.slice(0, 2).join(" ")).slice(-12)).catch(() => null);
    console.error(JSON.stringify({ reason: String(error?.message ?? error).split("\n")[0], site: site && { lastReadAt: site.lastReadAt, probe: site.probe, probeBefore: site.probeBefore, digest: site.digest, key: site.key, pushedKey: site.pushedKey },
      asked, said: globalThis.said?.join("").slice(-1500) }));
  }
  throw error;
} finally {
  await app?.close();
  control?.close(); control?.closeAllConnections?.();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
