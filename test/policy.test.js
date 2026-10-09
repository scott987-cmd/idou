// What administrators let each person use (policy.js), and that the server
// enforces it: the model gateway (models, quota, requests at once), the Feishu
// write proxy, scheduled tasks, sites and media. docs/admin-console.md §7.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import pg from "pg";
import { openAdminDatabase } from "../src/control-plane/admin-db.js";
import { PolicyStore, PolicyEngine, PolicyService, QuotaMeter, policySettings, policyTarget, FEATURE_KEYS } from "../src/control-plane/policy.js";
import { ModelUsage } from "../src/control-plane/model-usage.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { testPostgres } from "./helpers/postgres.js";

const stops = [];
after(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });
let server = null;
const postgres = () => (server ??= testPostgres({ after: (stop) => stops.push(stop) }));

const MODELS = ["MiniMax-M3", "GLM-5.3", "Cheap-1"];
const TENANT = "tenant-a";
const ADMIN = { userId: "ou_admin", name: "管理员" };
const who = (userId) => ({ tenantId: TENANT, userId });

async function engine(t, { ceilings = {}, chats = {}, fileRules = null, defaultVisible = "all", clock = { at: 1_000 } } = {}) {
  const db = await openAdminDatabase();
  const store = await PolicyStore.open({ db, models: MODELS, fileRules });
  const policy = new PolicyEngine({ store, models: MODELS, ceilings, defaultVisible, now: () => clock.at,
    inChat: async (chatId, userId) => (chats[chatId] ?? []).includes(userId) });
  t.after(async () => { store.close(); await db.close(); });
  return { db, store, policy, clock };
}

test("a rule is checked against what this server offers, and says something", () => {
  assert.throws(() => policySettings({ models: { allowed: ["GPT-9"] } }, { models: MODELS }), /这个服务端提供的模型/);
  assert.throws(() => policySettings({ models: { allowed: ["GLM-5.3"], default: "MiniMax-M3" } }, { models: MODELS }), /默认模型要在能用的模型里/);
  assert.throws(() => policySettings({ quota: { downgradeTo: "Cheap-1" } }, { models: MODELS }), /也要设每天的额度/);
  assert.throws(() => policySettings({ quota: { concurrency: 99 } }, { models: MODELS }), /同时进行的请求数/);
  assert.throws(() => policySettings({ features: { teleport: true } }, { models: MODELS }), /没有「teleport」/);
  assert.throws(() => policySettings({ features: { mediaVideo: "yes" } }, { models: MODELS }), /只能是开或关/);
  assert.deepEqual(policySettings({ models: { allowed: ["GLM-5.3", "GLM-5.3"] }, quota: { dailyTokens: 100, downgradeTo: "Cheap-1" }, features: { mediaVideo: false, mediaImage: null } }, { models: MODELS }),
    { models: { allowed: ["GLM-5.3"] }, quota: { dailyTokens: 100, downgradeTo: "Cheap-1" }, features: { mediaVideo: false } });
  assert.throws(() => policyTarget({ kind: "chat", id: "ou_x" }), /群 id/);
  assert.deepEqual(policyTarget({ kind: "everyone", id: "ignored" }), { kind: "everyone", id: "" });
});

test("field by field, the most specific rule decides; at one level, the cautious answer; the deployment is the ceiling", async (t) => {
  const { store, policy } = await engine(t, { ceilings: { mediaVideo: false }, chats: { oc_finance: ["ou_a", "ou_b"], oc_sales: ["ou_b"] } });
  await store.create({ tenantId: TENANT, target: { kind: "everyone" }, settings: { models: { allowed: ["MiniMax-M3", "GLM-5.3"], default: "MiniMax-M3" }, quota: { dailyTokens: 5000, downgradeTo: "GLM-5.3" }, features: { feishuDelete: false } }, by: ADMIN });
  await store.create({ tenantId: TENANT, target: { kind: "chat", id: "oc_finance" }, settings: { quota: { dailyTokens: 2000 }, features: { mediaImage: false, feishuDelete: true } }, by: ADMIN });
  await store.create({ tenantId: TENANT, target: { kind: "chat", id: "oc_sales" }, settings: { quota: { dailyTokens: 3000, downgradeTo: "GLM-5.3" }, features: { mediaImage: true, scheduledTasks: false } }, by: ADMIN });
  await store.create({ tenantId: TENANT, target: { kind: "user", id: "ou_b" }, settings: { models: { allowed: ["GLM-5.3"] } }, by: ADMIN });
  await store.create({ tenantId: "tenant-b", target: { kind: "everyone" }, settings: { features: { sitesPublish: false } }, by: ADMIN });

  const nobody = await policy.effective(who("ou_z"));
  assert.deepEqual(nobody.models, { allowed: ["MiniMax-M3", "GLM-5.3"], default: "MiniMax-M3" });
  assert.deepEqual(nobody.quota, { dailyTokens: 5000, downgradeTo: "GLM-5.3", concurrency: null });
  assert.equal(nobody.features.feishuDelete, false);
  assert.equal(nobody.features.mediaVideo, false, "the deployment does not offer video: off whatever the rules say");
  assert.equal(nobody.features.sitesPublish, true, "another tenant's rule is another tenant's");

  const a = await policy.effective(who("ou_a"));
  assert.deepEqual(a.quota, { dailyTokens: 2000, downgradeTo: null, concurrency: null }, "the group's quota, with its own (absent) move-to model");
  assert.equal(a.features.feishuDelete, true, "a group overrides everyone for the same switch");
  assert.equal(a.features.mediaImage, false);
  assert.deepEqual(a.models.allowed, ["MiniMax-M3", "GLM-5.3"], "what the group does not say, everyone still does");

  const b = await policy.effective(who("ou_b"));
  assert.deepEqual(b.models, { allowed: ["GLM-5.3"], default: "GLM-5.3" }, "their own rule; the default falls to what is allowed");
  assert.equal(b.quota.dailyTokens, 2000, "two groups: the smaller quota");
  assert.equal(b.features.mediaImage, false, "two groups: off if either says off");
  assert.equal(b.features.scheduledTasks, false);
  assert.equal(b.features.feishuDelete, true, "both groups that say it allow it");
  assert.ok(b.sources.dailyTokens.length === 2 && b.sources.models.length === 1, "and which rules decided");
  assert.deepEqual(await policy.visible(who("ou_b")), ["GLM-5.3"]);
  assert.equal(await policy.permits(who("ou_b"), "mediaImage"), false);
  assert.equal(FEATURE_KEYS.length, 11);
});

test("a change takes effect at once in this process and, through the database, in another", async (t) => {
  const settings = await (await postgres()).database();
  const pools = [];
  const connect = async () => { const client = new pg.Client(settings); client.on("error", () => {}); await client.connect(); return client; };
  const open = async () => {
    const pool = new pg.Pool({ ...settings, max: 4 }); pool.on("error", () => {}); pools.push(pool);
    const db = await openAdminDatabase({ pool, connect });
    const store = await PolicyStore.open({ db, models: MODELS });
    return { db, store, policy: new PolicyEngine({ store, models: MODELS }) };
  };
  const [one, two] = [await open(), await open()];
  t.after(async () => { for (const side of [one, two]) { side.store.close(); await side.db.close(); } for (const pool of pools) await pool.end(); });
  assert.equal(await two.policy.permits(who("ou_x"), "mediaVideo"), true);
  const rule = await one.store.create({ tenantId: TENANT, target: { kind: "user", id: "ou_x" }, settings: { features: { mediaVideo: false } }, by: ADMIN });
  assert.equal(await one.policy.permits(who("ou_x"), "mediaVideo"), false, "here at once, despite the minute's cache");
  const deadline = Date.now() + 5000;
  while (await two.policy.permits(who("ou_x"), "mediaVideo")) { if (Date.now() > deadline) throw new Error("never heard"); await new Promise((resolve) => setTimeout(resolve, 20)); }
  await assert.rejects(one.store.create({ tenantId: TENANT, target: { kind: "user", id: "ou_x" }, settings: { features: { mediaImage: false } }, by: ADMIN }), /已经有一条规则/);
  const { before, after: changed } = await one.store.update(rule.id, { tenantId: TENANT, settings: { features: { mediaVideo: true } }, by: ADMIN });
  assert.deepEqual([before.settings.features.mediaVideo, changed.settings.features.mediaVideo], [false, true]);
  await assert.rejects(one.store.update(rule.id, { tenantId: "tenant-b", settings: { features: { mediaVideo: false } }, by: ADMIN }), /没有这条规则/, "not another tenant's");
  await one.store.remove(rule.id, { tenantId: TENANT });
  assert.equal(one.store.size, 0);
});

test("the deployment file's rules still count, beside the console's, and 'none' leaves the unmatched with nothing", async (t) => {
  const { store, policy } = await engine(t, { fileRules: [{ kind: "chat", id: "oc_lab", models: ["Cheap-1"] }], chats: { oc_lab: ["ou_lab"] }, defaultVisible: "none" });
  assert.deepEqual(await policy.visible(who("ou_lab")), ["Cheap-1"]);
  assert.deepEqual(await policy.visible(who("ou_else")), [], "IDOU_MODEL_DEFAULT_VISIBLE=none, as before");
  assert.equal(store.rules(TENANT)[0].source, "file");
  assert.equal(policy.enabled, true);
});

test("today's tokens: what the ledger said, plus what this replica has added since", async (t) => {
  const usage = await ModelUsage.open({});
  t.after(() => usage.close());
  const clock = { at: Date.UTC(2026, 9, 2, 12) };
  const meter = new QuotaMeter({ ledger: usage, now: () => clock.at });
  usage.record({ who: who("ou_q"), model: "MiniMax-M3", usage: { total_tokens: 700 }, at: clock.at });
  assert.equal(await meter.used(who("ou_q")), 700);
  meter.add(who("ou_q"), 300);
  assert.equal(await meter.used(who("ou_q")), 1000);
  clock.at += 86_400_000;
  assert.equal(await meter.used(who("ou_q")), 0, "a new day starts from nothing");
});

async function gateway(t, { rules = [], usedToday = 0 } = {}) {
  const { store, policy } = await engine(t);
  for (const rule of rules) await store.create({ tenantId: TENANT, by: ADMIN, ...rule });
  const usage = await ModelUsage.open({});
  t.after(() => usage.close());
  if (usedToday) usage.record({ who: who("ou_q"), model: "MiniMax-M3", usage: { total_tokens: usedToday } });
  const sessions = new SessionRegistry();
  const session = sessions.issue({ tenantId: TENANT, userId: "ou_q", deviceId: "d1" });
  const asked = [];
  const models = MODELS.map((model) => ({ provider: "minimax", upstreamOrigin: "https://api.minimaxi.com", model, upstreamModel: model, apiKey: "k", maxOutputTokens: 1000 }));
  const server = createModelGateway({ models, sessions, policy, meter: new QuotaMeter({ ledger: usage }), usage,
    fetchImpl: async (url, request) => { asked.push(JSON.parse(request.body).model); return Response.json({ output_text: "ok", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }); } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.close(); server.closeAllConnections(); });
  const post = (model = "MiniMax-M3") => fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` }, body: JSON.stringify({ model, input: "hi" }) });
  return { post, asked, server, usage };
}

test("the gateway: past the day's quota, the request goes to the chosen model and says so; without one it is refused as the quota", async (t) => {
  const moved = await gateway(t, { rules: [{ target: { kind: "user", id: "ou_q" }, settings: { quota: { dailyTokens: 1000, downgradeTo: "Cheap-1" } } }], usedToday: 1000 });
  const answer = await moved.post("MiniMax-M3");
  assert.equal(answer.status, 200);
  assert.equal(answer.headers.get("x-idou-quota"), "downgraded");
  assert.equal(answer.headers.get("x-idou-model"), "Cheap-1");
  assert.equal(answer.headers.get("x-idou-model-requested"), "MiniMax-M3");
  assert.deepEqual(moved.asked, ["Cheap-1"]);
  const refused = await gateway(t, { rules: [{ target: { kind: "user", id: "ou_q" }, settings: { quota: { dailyTokens: 1000 } } }], usedToday: 1000 });
  const no = await refused.post("MiniMax-M3");
  assert.equal(no.status, 429);
  assert.equal((await no.json()).error.code ?? "quota_exhausted", "quota_exhausted");
  assert.equal(refused.asked.length, 0);
  assert.equal(refused.server.capacity().rejected.quota, 1);
  const under = await gateway(t, { rules: [{ target: { kind: "user", id: "ou_q" }, settings: { quota: { dailyTokens: 1000, downgradeTo: "Cheap-1" } } }], usedToday: 900 });
  assert.equal((await under.post("MiniMax-M3")).headers.get("x-idou-model"), "MiniMax-M3", "under the quota, untouched");
  assert.equal((await under.post("MiniMax-M3")).headers.get("x-idou-model"), "MiniMax-M3", "its own answers counted: 900 + 15 is still under");
});

test("the gateway: a model the policy does not allow is refused like one that does not exist", async (t) => {
  const g = await gateway(t, { rules: [{ target: { kind: "everyone" }, settings: { models: { allowed: ["GLM-5.3"] } } }] });
  const refused = await g.post("MiniMax-M3");
  assert.equal(refused.status, 403);
  assert.equal((await g.post("GLM-5.3")).status, 200);
});

test("a person's own desktop learns what is off and how their quota stands, and nobody else's", async (t) => {
  const { store, policy } = await engine(t, { ceilings: { mediaVideo: false } });
  await store.create({ tenantId: TENANT, target: { kind: "user", id: "ou_q" }, settings: { quota: { dailyTokens: 100 }, features: { fullAccess: false } }, by: ADMIN });
  const usage = await ModelUsage.open({});
  t.after(() => usage.close());
  usage.record({ who: who("ou_q"), model: "MiniMax-M3", usage: { total_tokens: 150 } });
  const sessions = new SessionRegistry();
  const mine = sessions.issue({ tenantId: TENANT, userId: "ou_q", deviceId: "d1", authProvider: "feishu", appId: "cli_x", deviceProof: "ed25519-login" });
  const service = new PolicyService({ sessions, engine: policy, meter: new QuotaMeter({ ledger: usage }) });
  const server = (await import("node:http")).createServer(async (req, res) => { if (!await service.handle(req, res)) { res.writeHead(404); res.end(); } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => server.close());
  const ask = (token, headers = {}) => fetch(`http://127.0.0.1:${server.address().port}/v1/policy`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...headers }, body: "{}" });
  const answer = await (await ask(mine.token)).json();
  assert.equal(answer.features.fullAccess, false);
  assert.equal(answer.features.mediaVideo, false);
  assert.deepEqual(answer.clientEnforced, ["fullAccess"]);
  assert.deepEqual({ used: answer.quota.usedToday, exhausted: answer.quota.exhausted }, { used: 150, exhausted: true });
  assert.equal((await ask("not-a-token")).status, 401);
  assert.equal((await ask(mine.token, { origin: "https://evil.example" })).status, 403);
});
