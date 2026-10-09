// Content safety for published sites (site-safety.js): what the rules make of
// what is found, for whom the site will be readable; the model's reading of
// public pages, once per text; what an administrator let through, remembered
// by fingerprint; a record of each check that keeps no value; visits by day.
// On SQLite and on PostgreSQL. Numbers are synthetic, built to pass their checks.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { openAdminDatabase } from "../src/control-plane/admin-db.js";
import { SiteSafety, DEFAULT_RULES, checkRules, audienceOf, rescanSites, scheduleRescans } from "../src/control-plane/site-safety.js";
import { SiteRegistry } from "../src/control-plane/site-registry.js";
import { appHash } from "../src/apps/manifest.js";
import { testPostgres } from "./helpers/postgres.js";

const KINDS = ["sqlite", "postgres"];
const stops = [];
after(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });
let server = null;
const postgres = () => (server ??= testPostgres({ after: (stop) => stops.push(stop) }));
const TENANT = "tenant-a";
const KEY = "a-server-key-of-thirty-two-bytes!";
const SITE = { id: "00000000-0000-4000-8000-000000000001", name: "客户名单", ownerId: "ou_owner" };
const ID_NUMBER = (() => { const body = "11010519900101123"; const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]; return body + "10X98765432"[w.reduce((t, x, i) => t + x * Number(body[i]), 0) % 11]; })();
const page = (body) => [{ path: "index.html", bytes: Buffer.from(`<html><body>${body}</body></html>`) }];

async function setup(t, kind, { verdict = null } = {}) {
  let db;
  if (kind === "postgres") {
    const settings = await (await postgres()).database();
    const pool = new pg.Pool({ ...settings, max: 4 }); pool.on("error", () => {});
    const connect = async () => { const client = new pg.Client(settings); client.on("error", () => {}); await client.connect(); return client; };
    db = await openAdminDatabase({ pool, connect });
    t.after(async () => { await db.close(); await pool.end(); });
  } else { db = await openAdminDatabase(); t.after(() => db.close()); }
  const read = [];
  const moderate = verdict ? async (text) => { read.push(text); return typeof verdict === "function" ? verdict(text) : verdict; } : null;
  const clock = { at: Date.UTC(2026, 9, 2, 8, 0) };
  const safety = await SiteSafety.open({ db, key: KEY, moderate, now: () => clock.at });
  t.after(() => safety.close());
  return { db, safety, read, clock };
}

for (const kind of KINDS) test(`${kind}: what the rules make of what is found, for the internet and for the organisation`, async (t) => {
  const { safety } = await setup(t, kind);
  const check = (audience, body, extra = {}) => safety.assess({ tenantId: TENANT, site: SITE, audience, files: page(body), trigger: "publish", version: "v1", ...extra });
  const phonePublic = await check("public", "<p>联系 13812345678</p>");
  assert.equal(phonePublic.outcome, "review");
  assert.match(phonePublic.reason, /发现 1 处手机号。等管理员审核通过后才会上线/);
  assert.equal((await check("internal", "<p>联系 13812345678</p>")).outcome, "record", "inside the organisation a phone number is recorded, not stopped");
  assert.equal((await check("public", `<p>${ID_NUMBER}</p>`)).outcome, "block");
  assert.match((await check("public", `<p>${ID_NUMBER}</p>`)).reason, /公开网站不允许包含身份证号（发现 1 处身份证号，例如 index.html 第 1 行），没有发布/);
  assert.equal((await check("internal", `<p>${ID_NUMBER}</p>`)).outcome, "record");
  assert.equal((await check("internal", "<script>const key = 'sk-a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5'</script>")).outcome, "block", "a credential, for anybody");
  assert.equal((await check("public", "<p>产品介绍</p>")).outcome, "pass");
  // What an administrator let through is not stopped again.
  const letThrough = { fingerprints: phonePublic.fingerprints, version: "v1" };
  assert.equal((await check("public", "<p>联系 13812345678</p>", { approved: letThrough })).outcome, "record");
  assert.equal((await check("public", "<p>联系 13900001111</p>", { approved: letThrough })).outcome, "review", "another number is another finding");
  // The record keeps where and a masked sample; no value.
  const [latest] = (await safety.checks({ tenantId: TENANT, outcome: "review" })).checks;
  assert.deepEqual(latest.findings.map((finding) => [finding.category, finding.where, finding.sample, finding.action]), [["phone", "index.html 第 1 行", "139****1111", "review"]]);
  assert.match(latest.excerpt, /139\*\*\*\*1111/);
  const stored = JSON.stringify((await safety.checks({ tenantId: TENANT, limit: 100 })).checks);
  for (const value of ["13812345678", "13900001111", ID_NUMBER]) assert.ok(!stored.includes(value), `${value} is not kept`);
});

for (const kind of KINDS) test(`${kind}: the model reads public pages only, each text once, and its doubts wait for an administrator`, async (t) => {
  const { safety, read } = await setup(t, kind, { verdict: (text) => text.includes("赌") ? { verdict: "block", categories: ["gambling_fraud"], reason: "推广赌博" }
    : text.includes("加微信") ? { verdict: "review", categories: ["advertising"], reason: "引导加私人微信" } : { verdict: "pass", categories: [], reason: "" } });
  const check = (audience, body, extra = {}) => safety.assess({ tenantId: TENANT, site: SITE, audience, files: page(body), trigger: "publish", version: "v1", ...extra });
  assert.equal((await check("public", "<p>欢迎来玩线上赌场</p>")).outcome, "block");
  assert.equal((await check("internal", "<p>欢迎来玩线上赌场</p>")).outcome, "pass", "inside the organisation the model is not asked");
  const doubt = await check("public", "<p>优惠请加微信</p>");
  assert.deepEqual([doubt.outcome, doubt.ai.categories], ["review", ["advertising"]]);
  assert.match(doubt.reason, /AI 审核：引导加私人微信/);
  assert.equal(read.length, 2);
  await check("public", "<p>优惠请加微信</p>");
  assert.equal(read.length, 2, "the same words are not read twice");
  assert.equal((await check("public", "<p>优惠请加微信</p>", { approved: { aiDigest: doubt.textDigest, version: "v1" } })).outcome, "pass", "the same words, let through");
});

for (const kind of KINDS) test(`${kind}: every public site waiting, once a version; data on a clock recorded only when it has something new`, async (t) => {
  const { safety } = await setup(t, kind);
  await safety.setRules(TENANT, { reviewAllPublic: true }, { userId: "ou_admin", name: "管理员" });
  const clean = (extra) => safety.assess({ tenantId: TENANT, site: SITE, audience: "public", files: page("<p>产品介绍</p>"), trigger: "publish", version: "v1", ...extra });
  assert.equal((await clean()).outcome, "review");
  assert.match((await clean()).reason, /公开网站都要管理员审核/);
  assert.equal((await clean({ approved: { version: "v1" } })).outcome, "pass", "approved once for this version");
  assert.equal((await clean({ version: "v2", approved: { version: "v1" } })).outcome, "review", "a new version waits again");
  // A site can go back to a version: any it keeps that was let through counts (review of phase 0, 2026-10-03).
  assert.equal((await clean({ version: "v1", approved: { version: "v2", versions: ["v2", "v1"] } })).outcome, "pass", "back to one already approved");
  // Data: nothing in it, no record; the same findings again, no second record.
  const data = (phone) => ({ schema: { fields: [{ id: "f", name: "电话" }] }, snapshot: { digest: phone, rows: [{ id: "r", values: { f: { kind: "text", value: phone } } }] } });
  const before = (await safety.checks({ tenantId: TENANT, limit: 100 })).checks.length;
  const inside = (value) => safety.assess({ tenantId: TENANT, site: SITE, audience: "internal", data: data(value), trigger: "data", version: "v1" });
  assert.equal((await inside("无")).id, null);
  assert.ok((await inside("13812345678")).id);
  assert.equal((await inside("13812345678")).id, null);
  assert.equal((await safety.checks({ tenantId: TENANT, limit: 100 })).checks.length, before + 1);
});

for (const kind of KINDS) test(`${kind}: rules are checked, kept and heard; checks paged and decided; visits counted by day`, async (t) => {
  const { safety, db, clock } = await setup(t, kind);
  assert.throws(() => checkRules({ actions: { secret: { public: "record" } } }), /只能拦截/);
  assert.throws(() => checkRules({ actions: { phone: { public: "ignore" } } }), /处理方式无效/);
  const { after: rules } = await safety.setRules(TENANT, { actions: { phone: { public: "block" } }, keywords: ["机密"], ai: false }, { userId: "ou_admin", name: "管理员" });
  assert.deepEqual([rules.actions.phone.public, rules.actions.email.public, rules.keywords, rules.ai], ["block", DEFAULT_RULES.actions.email.public, ["机密"], false]);
  const other = await SiteSafety.open({ db, key: KEY });
  t.after(() => other.close());
  assert.equal(other.rules(TENANT).actions.phone.public, "block", "another process reads the same rules");
  assert.equal(other.rules("tenant-b").actions.phone.public, "review", "another tenant keeps the defaults");
  const ids = [];
  for (let n = 0; n < 5; n += 1) { clock.at += 1000; ids.push((await safety.assess({ tenantId: TENANT, site: SITE, audience: "public", files: page("<p>机密</p>"), trigger: "publish", version: `v${n}` })).id); }
  const first = await safety.checks({ tenantId: TENANT, limit: 2 });
  const second = await safety.checks({ tenantId: TENANT, limit: 2, cursor: first.next });
  assert.deepEqual([...first.checks, ...second.checks].map((check) => check.id), ids.slice(-4).reverse());
  assert.equal((await safety.checks({ tenantId: TENANT, siteIds: [] })).checks.length, 0, "a scope of no sites sees none");
  assert.equal(await safety.decide(TENANT, ids[4], { decision: "approved", by: { userId: "ou_admin", name: "管理员" } }), true);
  assert.deepEqual((await safety.check(TENANT, ids[4])).decision.by, { userId: "ou_admin", name: "管理员" });
  assert.equal(await safety.decide("tenant-b", ids[4], { decision: "approved", by: {} }), false, "a check is its tenant's");
  for (let n = 0; n < 3; n += 1) safety.countVisit(TENANT, SITE.id, { anonymous: true });
  safety.countVisit(TENANT, SITE.id, { allowed: false });
  await safety.flushVisits();
  safety.countVisit(TENANT, SITE.id, { anonymous: false });
  await safety.flushVisits();
  const seen = (await safety.visits(TENANT, [SITE.id], 7)).get(SITE.id);
  assert.deepEqual({ visits: seen.visits, anonymous: seen.anonymous, refused: seen.refused }, { visits: 4, anonymous: 3, refused: 1 });
  assert.equal(audienceOf({ scope: "anyone" }), "public");
  assert.equal(audienceOf({ scope: "tenant" }), "internal");
});

test("checks made within one millisecond are still newest first in the order they were made", async (t) => {
  const { safety } = await setup(t, "sqlite");
  const ids = [];
  for (let n = 0; n < 20; n += 1) ids.push((await safety.assess({ tenantId: TENANT, site: SITE, audience: "public", files: page(`<p>${13800000000 + n}</p>`), trigger: "publish", version: `v${n}` })).id);
  assert.deepEqual((await safety.checks({ tenantId: TENANT, limit: 100 })).checks.map((check) => check.id), ids.reverse());
  assert.equal((await safety.latest(TENANT, [SITE.id])).get(SITE.id).id, ids[0], "the latest is the last made");
});

test("a model that does not answer: words about to go up wait for a person; a site already up stays up", async (t) => {
  const { safety } = await setup(t, "sqlite", { verdict: { verdict: "review", categories: [], reason: "没能连上模型", failed: true } });
  const check = (trigger, extra = {}) => safety.assess({ tenantId: TENANT, site: SITE, audience: "public", files: page("<p>产品介绍</p>"), trigger, version: "v1", ...extra });
  const publish = await check("publish");
  assert.equal(publish.outcome, "review");
  assert.equal(publish.reason, "AI 审核没有完成（没能连上模型）。等管理员审核通过后才会上线，在那之前链接打不开。");
  assert.equal((await check("data")).reason, "AI 审核没有完成（没能连上模型），这次的数据没有更新到线上，下次刷新时会再试。");
  const again = await check("rescan");
  assert.deepEqual([again.outcome, again.reason], ["pass", "补查时 AI 审核没有完成（没能连上模型），网站照常在线，下次补查时再读。"]);
  assert.equal((await check("rescan", { files: page("<p>联系 13812345678</p>") })).outcome, "review", "what the rules find still takes it down");
});

test("sites up before the checks: each checked once at start, taken down for what would have had to wait, read again if the model did not answer", async (t) => {
  let answering = false;
  const { safety, read } = await setup(t, "sqlite", { verdict: (text) => answering || !text.includes("产品介绍")
    ? { verdict: "pass", categories: [], reason: "" } : { verdict: "review", categories: [], reason: "模型没有按时回答", failed: true } });
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-rescan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = await SiteRegistry.open(root);
  const publish = async (name, scope, body) => {
    const bytes = Buffer.from(`<!doctype html><body>${body}</body>`);
    return (await registry.publish({ ownerId: "ou_owner", tenantId: TENANT, name, share: { scope }, anonymousAllowed: true,
      manifest: { schemaVersion: 1, runtime: "static", network: "none", entry: "index.html", files: [{ path: "index.html", bytes: bytes.length, sha256: appHash(bytes) }] },
      blobs: [{ path: "index.html", base64: bytes.toString("base64") }] })).id;
  };
  const phonePublic = await publish("联系表", "anyone", "<p>联系 13812345678</p>");
  const phoneInside = await publish("内部通讯录", "tenant", "<p>联系 13812345678</p>");
  const idPublic = await publish("报名表", "anyone", `<p>${ID_NUMBER}</p>`);
  const clean = await publish("产品页", "anyone", "<p>产品介绍</p>");
  assert.deepEqual(await rescanSites({ registry, safety }), { checked: 4, waiting: 2, unread: 1 });
  const state = (id) => { const site = registry.list().find((item) => item.id === id); return [site.offline, site.review?.state ?? null]; };
  assert.deepEqual(state(phonePublic), [true, "pending"], "a phone number on a public site waits for an administrator");
  assert.deepEqual(state(phoneInside), [false, null], "inside the organisation it is recorded");
  assert.deepEqual(state(idPublic), [true, "pending"]);
  assert.equal(registry.list().find((item) => item.id === idPublic).review.reason,
    "补查发现问题：公开网站不允许包含身份证号（发现 1 处身份证号，例如 index.html 第 1 行），网站已下线，等管理员审核。去掉这些内容后点「更新线上」会重新检查。");
  assert.deepEqual(state(clean), [false, null], "the model not answering takes nothing down");
  // At the next start: only the page the model did not read is read again.
  answering = true;
  const before = read.length;
  assert.deepEqual(await rescanSites({ registry, safety }), { checked: 1, waiting: 0, unread: 0 });
  assert.equal(read.length, before + 1);
  assert.deepEqual(await rescanSites({ registry, safety }), { checked: 0, waiting: 0, unread: 0 }, "and after that, nothing");
  assert.deepEqual(await rescanSites({ registry, safety, tenantId: TENANT, all: true }), { checked: 2, waiting: 0, unread: 0 }, "all: every site up, under the rules as they are now");
});

test("the model's words set inside our sentences: never a doubled stop, whatever it ended with, wherever the check happened", async (t) => {
  let said = "";
  const { safety } = await setup(t, "sqlite", { verdict: () => said });
  const endings = ["建议人工复核。", "推广赌博网站！", "Looks like spam.", "  引导加私人微信；  ", "没有问题"];
  const verdicts = [(reason) => ({ verdict: "review", categories: ["advertising"], reason }), (reason) => ({ verdict: "block", categories: ["gambling_fraud"], reason }),
    (reason) => ({ verdict: "review", categories: [], reason, failed: true })];
  let n = 0;
  for (const ending of endings) for (const verdict of verdicts) for (const trigger of ["publish", "update", "share", "republish", "data", "rescan"]) {
    said = verdict(ending);
    // A new text each time, or the model's earlier reading of it would be reused.
    const check = await safety.assess({ tenantId: TENANT, site: { ...SITE, id: `site-${n}` }, audience: "public", files: page(`<p>第 ${n += 1} 页</p>`), trigger, version: "v1" });
    if (!check.reason) continue;
    assert.doesNotMatch(check.reason, /[。．.！!？?；;，,、：:]\s*[。．.！!？?；;，,]/u, `${trigger} / ${said.verdict}${said.failed ? " (unread)" : ""} / ${JSON.stringify(ending)}: ${check.reason}`);
    assert.match(check.reason, /。$/, check.reason);
  }
});

test("rescans: a few minutes after start, then every half hour while the model left pages unread, at most seven passes", async (t) => {
  let answering = false;
  const { safety, read } = await setup(t, "sqlite", { verdict: () => answering ? { verdict: "pass", categories: [], reason: "" }
    : { verdict: "review", categories: [], reason: "模型没有回答（HTTP 529）", failed: true } });
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-rescan-plan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = await SiteRegistry.open(root);
  const bytes = Buffer.from("<!doctype html><body><p>产品介绍</p></body>");
  await registry.publish({ ownerId: "ou_owner", tenantId: TENANT, name: "产品页", share: { scope: "anyone" }, anonymousAllowed: true,
    manifest: { schemaVersion: 1, runtime: "static", network: "none", entry: "index.html", files: [{ path: "index.html", bytes: bytes.length, sha256: appHash(bytes) }] },
    blobs: [{ path: "index.html", base64: bytes.toString("base64") }] });
  const armed = [];
  const timers = { set: (run, ms) => { const timer = { run, ms, cleared: false }; armed.push(timer); return timer; }, clear: (timer) => { timer.cleared = true; } };
  const logged = [];
  const plan = (options = {}) => scheduleRescans({ registry, safety, log: (event) => logged.push(event), timers, ...options });
  // The model busy: read again half an hour later, and once it answers, no more.
  const schedule = plan();
  assert.deepEqual(armed.map((timer) => timer.ms), [180_000], "the first pass a few minutes after start");
  await armed.at(-1).run(); await settle();
  assert.deepEqual(logged.at(-1), { component: "site-safety", event: "rescanned", checked: 1, waiting: 0, unread: 1 });
  assert.deepEqual(armed.map((timer) => timer.ms), [180_000, 1_800_000], "unread: again in half an hour");
  answering = true;
  await armed.at(-1).run(); await settle();
  assert.deepEqual(logged.at(-1), { component: "site-safety", event: "rescanned", checked: 1, waiting: 0, unread: 0 });
  assert.equal(armed.length, 2, "read: nothing more to do");
  assert.equal(read.length, 2);
  schedule.stop();
  // A model that never answers is not asked for ever: seven passes in all.
  answering = false;
  const another = Buffer.from("<!doctype html><body><p>秋季活动</p></body>");
  await registry.publish({ ownerId: "ou_owner", tenantId: TENANT, name: "活动页", share: { scope: "anyone" }, anonymousAllowed: true,
    manifest: { schemaVersion: 1, runtime: "static", network: "none", entry: "index.html", files: [{ path: "index.html", bytes: another.length, sha256: appHash(another) }] },
    blobs: [{ path: "index.html", base64: another.toString("base64") }] });
  armed.length = 0;
  plan();
  while (armed.length && !armed.at(-1).ran) { const timer = armed.at(-1); timer.ran = true; await timer.run(); await settle(); }
  assert.equal(armed.length, 7);
  // Stopped (the server shutting down): a pass under way arms nothing after it.
  armed.length = 0;
  const stopping = plan();
  stopping.stop();
  assert.equal(armed[0].cleared, true);
  await armed[0].run(); await settle();
  assert.equal(armed.length, 1);
});


test("data held back because the model did not answer goes up only once the model has read it", async (t) => {
  let answering = true;
  const { safety, read, clock } = await setup(t, "sqlite", { verdict: () => answering ? { verdict: "pass", categories: [], reason: "" }
    : { verdict: "review", categories: [], reason: "模型没有回答（HTTP 529）", failed: true } });
  const table = (value) => ({ schema: { fields: [{ id: "f", name: "销售额" }] }, snapshot: { digest: value, rows: [{ id: "r", values: { f: { kind: "text", value } } }] } });
  const refresh = (value) => safety.assess({ tenantId: TENANT, site: SITE, audience: "public", data: table(value), trigger: "data", version: "v1", dataDigest: value });
  assert.equal((await refresh("一月 100")).outcome, "pass");
  clock.at += 2 * 3_600_000;
  answering = false;
  assert.equal((await refresh("二月 200")).outcome, "review", "the model did not answer: the new data is held back");
  // Meanwhile the site as it is up is read again (a rescan), which the model answers.
  answering = true;
  await safety.assess({ tenantId: TENANT, site: SITE, audience: "public", files: page("<p>销售看板</p>"), data: table("一月 100"), trigger: "rescan", version: "v1" });
  const before = read.length;
  assert.equal((await refresh("二月 200")).outcome, "pass");
  assert.equal(read.length, before + 1, "the held-back data is read, not let through on the hour");
  assert.match(read.at(-1), /二月 200/);
  // Owed no longer: within the hour, data is not read again.
  await refresh("三月 300");
  assert.equal(read.length, before + 1);
});

test("rescans: a pass elsewhere that left pages unread is followed up on the same clock; stopping stops a pass under way", async (t) => {
  const { db } = await setup(t, "sqlite");
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-rescan-stop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = await SiteRegistry.open(root);
  for (const name of ["一号", "二号"]) {
    const bytes = Buffer.from(`<!doctype html><body><p>${name}产品介绍</p></body>`);
    await registry.publish({ ownerId: "ou_owner", tenantId: TENANT, name, share: { scope: "anyone" }, anonymousAllowed: true,
      manifest: { schemaVersion: 1, runtime: "static", network: "none", entry: "index.html", files: [{ path: "index.html", bytes: bytes.length, sha256: appHash(bytes) }] },
      blobs: [{ path: "index.html", base64: bytes.toString("base64") }] });
  }
  // A model that answers only when the server stops asking.
  const asked = [];
  const stopped = { verdict: "review", categories: [], reason: "服务端正在停止", failed: true, stopped: true };
  const moderate = (text, { signal } = {}) => new Promise((resolve) => {
    asked.push(text);
    if (signal?.aborted) resolve(stopped); else signal?.addEventListener("abort", () => resolve(stopped), { once: true });
  });
  const safety = await SiteSafety.open({ db, key: KEY, moderate });
  t.after(() => safety.close());
  const armed = [];
  const timers = { set: (run, ms) => { const timer = { run, ms }; armed.push(timer); return timer; }, clear: (timer) => { timer.cleared = true; } };
  const logged = [];
  const schedule = scheduleRescans({ registry, safety, log: (event) => logged.push(event), timers });
  const running = armed[0].run();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(asked.length, 1, "the first page is with the model");
  schedule.stop();
  await running;
  assert.equal(asked.length, 1, "the second page is not asked about once stopped");
  assert.deepEqual(logged.filter((event) => event.event === "rescanned"), [], "nothing said after stopping");
  assert.equal(armed.length, 1, "and nothing armed");
  // again(): idle, it arms a pass half an hour out; already armed, it adds none.
  const later = scheduleRescans({ registry, safety: { latest: async () => new Map([[1, {}]]) }, log: () => {}, timers });
  assert.equal(armed.length, 2);
  later.again();
  assert.equal(armed.length, 2, "a pass is already armed");
  await armed[1].run();
  later.again();
  assert.deepEqual(armed.map((timer) => timer.ms), [180_000, 180_000, 1_800_000]);
  later.stop();
  later.again();
  assert.equal(armed.length, 3, "stopped: again() arms nothing");
  // again() while a pass is under way is kept until it ends -- that pass may already
  // have gone by the pages it was asked about (found in the second review before .270).
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const busyPlan = scheduleRescans({ registry: { list: () => [{ id: "s1", tenantId: TENANT, held: null, review: null }] },
    safety: { latest: async () => { await gate; return new Map([["s1", { ai: null }]]); } }, log: () => {}, timers });
  const underWay = armed.at(-1).run();
  busyPlan.again();
  assert.equal(armed.length, 4, "nothing armed while the pass is under way");
  release(); await underWay;
  assert.deepEqual(armed.slice(4).map((timer) => timer.ms), [1_800_000], "armed once the pass has ended, though it found nothing unread itself");
  busyPlan.stop();
});


// Found in the third review before .270: a check again takes minutes when the
// model reads the page, and the owner may put up a new version meanwhile; what
// was found in the old one is no reason to take the new one down.
test("a site that changed while it was checked again is not taken down for what it no longer has", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { safety } = await setup(t, "sqlite", { verdict: async () => { await gate; return { verdict: "pass", categories: [], reason: "" }; } });
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-rescan-stale-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = await SiteRegistry.open(root);
  const version = (body) => { const bytes = Buffer.from(body); return { manifest: { schemaVersion: 1, runtime: "static", network: "none", entry: "index.html", files: [{ path: "index.html", bytes: bytes.length, sha256: appHash(bytes) }] },
    blobs: [{ path: "index.html", base64: bytes.toString("base64") }] }; };
  const site = await registry.publish({ ownerId: "ou_owner", tenantId: TENANT, name: "联系表", share: { scope: "anyone" }, anonymousAllowed: true, ...version("<p>联系 13812345678</p>") });
  const pass = rescanSites({ registry, safety });
  await new Promise((resolve) => setTimeout(resolve, 30));
  // Meanwhile its owner puts up a version without the number.
  await registry.publish({ siteId: site.id, ownerId: "ou_owner", tenantId: TENANT, name: "联系表", share: { scope: "anyone" }, anonymousAllowed: true, ...version("<p>联系我们</p>") });
  release();
  assert.deepEqual(await pass, { checked: 1, waiting: 0, unread: 0 });
  assert.deepEqual([registry.get(site.id).offline, registry.get(site.id).review?.state ?? null], [false, null], "the new version stays up");
});


// Found in the third review before .270: again() with a pass already armed did
// nothing, so a page the console left unread on the scheduler's last pass got
// that one more reading and no other.
test("rescans: again() with a pass already armed gives it the passes a hand-off is owed", async (t) => {
  const { safety } = await setup(t, "sqlite", { verdict: { verdict: "review", categories: [], reason: "模型没有回答（HTTP 529）", failed: true } });
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-rescan-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = await SiteRegistry.open(root);
  const bytes = Buffer.from("<!doctype html><body><p>产品介绍</p></body>");
  await registry.publish({ ownerId: "ou_owner", tenantId: TENANT, name: "产品页", share: { scope: "anyone" }, anonymousAllowed: true,
    manifest: { schemaVersion: 1, runtime: "static", network: "none", entry: "index.html", files: [{ path: "index.html", bytes: bytes.length, sha256: appHash(bytes) }] },
    blobs: [{ path: "index.html", base64: bytes.toString("base64") }] });
  const armed = [];
  const timers = { set: (run, ms) => { const timer = { run, ms }; armed.push(timer); return timer; }, clear: () => {} };
  const plan = scheduleRescans({ registry, safety, timers, passes: 3 });
  await armed[0].run();               // pass 1 of 3: unread, the next armed
  await armed[1].run();               // pass 2 of 3: unread, the last armed
  assert.equal(armed.length, 3);
  plan.again();                       // a hand-off while the last is armed
  assert.equal(armed.length, 3, "nothing new armed: the armed pass is given more instead");
  await armed[2].run();
  assert.equal(armed.length, 4, "unread again: it goes on, as the hand-off was owed");
  plan.stop();
});


// Fourth review before .270: a check again dropped what it found whenever the
// site changed at all -- a collaborator added, say -- and never looked again.
// Only a new version, audience or data, each checked when put there, does that.
test("a check again still takes a site down when what changed meanwhile is not what was checked; new data is what was checked", async (t) => {
  let release;
  let gate = new Promise((resolve) => { release = resolve; });
  const { safety } = await setup(t, "sqlite", { verdict: async () => { await gate; return { verdict: "pass", categories: [], reason: "" }; } });
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-rescan-members-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = await SiteRegistry.open(root);
  const bytes = Buffer.from("<p>联系 13812345678</p>");
  const publish = (name, data = null) => registry.publish({ ownerId: "ou_owner", tenantId: TENANT, name, share: { scope: "anyone" }, anonymousAllowed: true,
    manifest: { schemaVersion: 1, runtime: "static", network: "none", entry: "index.html", files: [{ path: "index.html", bytes: bytes.length, sha256: appHash(bytes) }] },
    blobs: [{ path: "index.html", base64: bytes.toString("base64") }] }).then(async (site) => { if (data) await registry.putData(site.id, data); return site; });
  // A collaborator added while it is read: still taken down.
  const site = await publish("联系表");
  let pass = rescanSites({ registry, safety });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await registry.setShare(site.id, { scope: "anyone", members: [{ type: "user", id: "ou_colleague", name: "同事" }] }, { ownerId: "ou_owner", anonymousAllowed: true });
  release();
  assert.deepEqual(await pass, { checked: 1, waiting: 1, unread: 0 });
  assert.equal(registry.get(site.id).review.state, "pending");
  // New data while it is read: the data it found the number in is gone.
  gate = new Promise((resolve) => { release = resolve; });
  const table = (value) => ({ schema: { fields: [{ id: "f", name: "备注" }] }, snapshot: { digest: value, rows: [{ id: "r", values: { f: { kind: "text", value } } }] } });
  const quiet = Buffer.from("<p>看板</p>");
  const board = await registry.publish({ ownerId: "ou_owner", tenantId: TENANT, name: "看板", share: { scope: "anyone" }, anonymousAllowed: true,
    manifest: { schemaVersion: 1, runtime: "static", network: "none", entry: "index.html", files: [{ path: "index.html", bytes: quiet.length, sha256: appHash(quiet) }] },
    blobs: [{ path: "index.html", base64: quiet.toString("base64") }] });
  await registry.putData(board.id, table("13900001111"));
  pass = rescanSites({ registry, safety });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await registry.putData(board.id, table("已更新"));
  release();
  assert.deepEqual(await pass, { checked: 1, waiting: 0, unread: 0 });
  assert.equal(registry.get(board.id).offline, false, "the data now up is not the data that was checked");
  // Found in the files, while a dashboard's data refreshes as it does every
  // minute: still taken down (fifth review before .270: the refresh made it vanish).
  gate = new Promise((resolve) => { release = resolve; });
  const contact = await publish("联系看板", table("一月"));
  pass = rescanSites({ registry, safety });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await registry.putData(contact.id, table("二月"));
  release();
  assert.deepEqual(await pass, { checked: 1, waiting: 1, unread: 0 });
  assert.equal(registry.get(contact.id).review.state, "pending", "the number is in the page itself");
  // A page file that happens to be called 数据…: still the page's (sixth review before .270).
  gate = new Promise((resolve) => { release = resolve; });
  const named = Buffer.from("<p>联系 13812345678</p>");
  const filed = await registry.publish({ ownerId: "ou_owner", tenantId: TENANT, name: "数据看板", share: { scope: "anyone" }, anonymousAllowed: true,
    manifest: { schemaVersion: 1, runtime: "static", network: "none", entry: "数据.html", files: [{ path: "数据.html", bytes: named.length, sha256: appHash(named) }] },
    blobs: [{ path: "数据.html", base64: named.toString("base64") }] });
  await registry.putData(filed.id, table("一月"));
  pass = rescanSites({ registry, safety });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await registry.putData(filed.id, table("二月"));
  release();
  assert.deepEqual(await pass, { checked: 1, waiting: 1, unread: 0 });
});

const settle = () => new Promise((resolve) => setImmediate(resolve));
