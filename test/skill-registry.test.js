import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { SkillRegistry, MAX_TENANT_SKILLS } from "../src/control-plane/skill-registry.js";
import { EnterpriseSkillCatalog } from "../src/control-plane/skill-catalog.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";

const bundle = (over = {}) => ({
  id: "enterprise-weekly", version: "1.0.0", title: "周报助手", description: "把一周记录整理成周报", publisher: "平台组",
  requiredTools: [], runtimeVersions: { codex: ["0.147.0"], feishu: [] },
  files: [{ path: "SKILL.md", text: "---\nname: enterprise-weekly\ndescription: 周报\n---\n先读最近一周的记录。" }], ...over });

async function setup(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "idou-registry-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, filename: path.join(base, "registry.json") };
}
const admin = { userId: "ou_admin", tenantId: "tenant_a" };

test("只有指定的管理员能上架，而且只能上到自己租户的货架", async (t) => {
  const { filename } = await setup(t);
  const registry = await new SkillRegistry({ filename, administrators: ["ou_admin"] }).load();
  assert.deepEqual(registry.list("tenant_a"), []);

  // Nobody can publish where no administrator is named: that is the safe state
  // for a deployment that has not thought about it, and reading still works.
  const closed = await new SkillRegistry({ filename, administrators: [] }).load();
  await assert.rejects(closed.publish(admin, bundle()), /skill_publish_not_permitted/);
  await assert.rejects(registry.publish({ userId: "ou_other", tenantId: "tenant_a" }, bundle()), /skill_publish_not_permitted/);
  await assert.rejects(registry.publish({ tenantId: "tenant_a" }, bundle()), /skill_publish_not_permitted/);

  const published = await registry.publish(admin, bundle());
  assert.equal(published.id, "enterprise-weekly");
  assert.equal(published.replaced, false);
  assert.equal(registry.list("tenant_a").length, 1);
  // A shelf belongs to one tenant; publishing never reaches another's.
  assert.deepEqual(registry.list("tenant_b"), []);
  assert.equal((await registry.publish({ userId: "ou_admin", tenantId: "tenant_b" }, bundle({ id: "enterprise-other" }))).id, "enterprise-other");
  assert.deepEqual(registry.list("tenant_a").map(item => item.id), ["enterprise-weekly"]);
  assert.deepEqual(registry.list("tenant_b").map(item => item.id), ["enterprise-other"]);
});

test("上架的必须是企业技能，本机导入的要先换身份", async (t) => {
  const { filename } = await setup(t);
  const registry = await new SkillRegistry({ filename, administrators: ["ou_admin"] }).load();
  // A locally imported folder is admitted by its own person's confirmation.
  // Publishing is the step that changes provenance, so it has to be said out
  // loud rather than inherited from a folder name.
  await assert.rejects(registry.publish(admin, bundle({ id: "local-weekly" })), /enterprise_skill_id_required/);
  await assert.rejects(registry.publish(admin, bundle({ files: [] })), /invalid_skill/);
  await assert.rejects(registry.publish(admin, bundle({ version: "not-a-version" })), /invalid_skill/);
  await assert.rejects(registry.publish(admin, { id: "enterprise-x" }), /invalid_skill/);
});

test("同一个技能改版会替换，原样重发会被拒", async (t) => {
  const { filename } = await setup(t);
  const registry = await new SkillRegistry({ filename, administrators: ["ou_admin"] }).load();
  const first = await registry.publish(admin, bundle());
  await assert.rejects(registry.publish(admin, bundle()), /skill_already_published/);
  const second = await registry.publish(admin, bundle({ version: "1.1.0" }));
  assert.equal(second.replaced, true);
  assert.ok(second.revision > first.revision, "每次改动都要抬版本号，客户端才知道手里的旧了");
  assert.deepEqual(registry.list("tenant_a").map(item => item.version), ["1.1.0"]);
  assert.notEqual(second.digest, first.digest);
});

test("下架之后货架和文件都不再有它", async (t) => {
  const { filename } = await setup(t);
  const registry = await new SkillRegistry({ filename, administrators: ["ou_admin"] }).load();
  await registry.publish(admin, bundle());
  await assert.rejects(registry.unpublish(admin, "enterprise-missing"), /skill_not_published/);
  await assert.rejects(registry.unpublish({ userId: "ou_other", tenantId: "tenant_a" }, "enterprise-weekly"), /skill_publish_not_permitted/);
  await registry.unpublish(admin, "enterprise-weekly");
  assert.deepEqual(registry.list("tenant_a"), []);
  assert.doesNotMatch(await readFile(filename, "utf8"), /enterprise-weekly/);
});

test("货架落在磁盘上，换一个进程读到的是同一份", async (t) => {
  const { filename } = await setup(t);
  const first = await new SkillRegistry({ filename, administrators: ["ou_admin"] }).load();
  await first.publish(admin, bundle());
  const reopened = await new SkillRegistry({ filename, administrators: ["ou_admin"] }).load();
  assert.deepEqual(reopened.list("tenant_a").map(item => item.id), ["enterprise-weekly"]);
  assert.equal(reopened.snapshot().revision, first.snapshot().revision);
  // Written for the server alone.
  assert.equal((await stat(filename)).mode & 0o077, 0);

  // A shelf that was never written is empty; one that is corrupt must stop the
  // server rather than quietly look like "no skills yet".
  const missing = await new SkillRegistry({ filename: path.join(path.dirname(filename), "absent.json") }).load();
  assert.deepEqual(missing.list("tenant_a"), []);
  await writeFile(filename, "{ not json");
  await assert.rejects(new SkillRegistry({ filename }).load(), /not valid JSON/);
  await writeFile(filename, JSON.stringify({ schemaVersion: 2, revision: 1, tenants: [] }));
  await assert.rejects(new SkillRegistry({ filename }).load(), /Invalid skill registry/);
});

test("并发上架不会互相覆盖", async (t) => {
  const { filename } = await setup(t);
  const registry = await new SkillRegistry({ filename, administrators: ["ou_admin"] }).load();
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) =>
    registry.publish(admin, bundle({ id: `enterprise-skill-${index}` }))));
  assert.equal(results.filter(item => item.status === "fulfilled").length, 8);
  assert.equal(registry.list("tenant_a").length, 8);
  const persisted = JSON.parse(await readFile(filename, "utf8"));
  assert.equal(persisted.tenants[0].skills.length, 8, "read-modify-write must not lose an entry");
});

test("货架有上限，满了会明说而不是悄悄丢", async (t) => {
  const { filename } = await setup(t);
  const registry = await new SkillRegistry({ filename, administrators: ["ou_admin"] }).load();
  for (let index = 0; index < MAX_TENANT_SKILLS; index++) await registry.publish(admin, bundle({ id: `enterprise-s${index}` }));
  await assert.rejects(registry.publish(admin, bundle({ id: "enterprise-overflow" })), /skill_shelf_full/);
  // Replacing one that is already there is still allowed at the limit.
  assert.equal((await registry.publish(admin, bundle({ id: "enterprise-s0", version: "2.0.0" }))).replaced, true);
});

test("签名下发的目录来自可写货架，且只给本租户", async (t) => {
  const { base, filename } = await setup(t);
  const key = path.join(base, "sign.pem");
  await writeFile(key, generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const sessions = new SessionRegistry();
  const catalog = await EnterpriseSkillCatalog.fromConfig({ origin: "https://agent.example", sessions,
    env: { IDOU_SKILL_SIGNING_KEY_FILE: key, IDOU_SKILL_REGISTRY_FILE: filename, IDOU_SKILL_ADMINS: "ou_admin" } });
  assert.ok(catalog.registry, "a configured registry file means the writable shelf");
  await catalog.registry.publish(admin, bundle());

  const identity = { tenantId: "tenant_a", appId: "cli_x", expiresAt: Date.now() + 60_000 };
  const signed = await catalog.signedCatalog(identity, "n".repeat(43));
  assert.equal(JSON.parse(Buffer.from(signed.payload, "base64url").toString("utf8")).skills[0].id, "enterprise-weekly");
  assert.ok(signed.keyId && signed.signature, "the shelf is served signed, never bare");
  assert.equal(catalog.shelf().revision, catalog.registry.snapshot().revision);
  // A tenant with nothing published yet still has a writable shelf -- an empty
  // one. Refusing it made an administrator's first publish unreachable and told
  // everyone else the catalogue was unavailable. It is scoped, signed and empty.
  const other = JSON.parse(Buffer.from((await catalog.signedCatalog({ ...identity, tenantId: "tenant_z" }, "n".repeat(43))).payload, "base64url").toString("utf8"));
  assert.equal(other.tenantId, "tenant_z");
  assert.deepEqual(other.skills, [], "another tenant never sees tenant_a's skills");
  // Withdrawing the last skill drops the tenant key; the shelf is empty, not gone.
  await catalog.registry.unpublish(admin, "enterprise-weekly");
  assert.deepEqual(JSON.parse(Buffer.from((await catalog.signedCatalog(identity, "n".repeat(43))).payload, "base64url").toString("utf8")).skills, []);

  // Configuring nothing keeps the whole feature off, which is what every
  // deployment has been running: the routes are simply not registered.
  assert.equal(await EnterpriseSkillCatalog.fromConfig({ origin: "https://agent.example", sessions, env: {} }), null);
});

test("上架闭环：本机技能转企业身份、经 HTTP 上架、签名核验后人人可见、可下架", async (t) => {
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const { SessionRegistry: Sessions } = await import("../src/control-plane/sessions.js");
  const { EnterpriseSkillsClient } = await import("../src/application/enterprise-skills.js");
  const { buildLocalSkill, promoteToEnterprise } = await import("../src/skills/local-skills.js");

  const { base, filename } = await setup(t);
  const key = path.join(base, "sign.pem");
  const pair = generateKeyPairSync("ed25519");
  await writeFile(key, pair.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const sessions = new Sessions();
  const catalog = await EnterpriseSkillCatalog.fromConfig({ origin: "http://127.0.0.1:1", sessions,
    env: { IDOU_SKILL_SIGNING_KEY_FILE: key, IDOU_SKILL_REGISTRY_FILE: filename, IDOU_SKILL_ADMINS: "ou_admin" } });
  const server = createServer(async (req, res) => { if (!await catalog.handle(req, res)) { res.writeHead(404); res.end(); } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.close(); server.closeAllConnections(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  catalog.origin = origin;

  const client = (userId) => {
    const session = sessions.issue({ tenantId: "tenant_a", userId, deviceId: "d", authProvider: "feishu", appId: "cli_x", deviceProof: "ed25519-login" });
    return new EnterpriseSkillsClient({ publicKey: pair.publicKey.export({ format: "pem", type: "spki" }),
      runtimeVersions: { codex: "0.147.0", feishu: "1.0.78" },
      getSession: async () => ({ token: session.token, expiresAt: session.expiresAt, serverUrl: origin,
        identity: { provider: "feishu", tenantId: "tenant_a", userId, appId: "cli_x" } }) });
  };
  const boss = client("ou_admin"), everyone = client("ou_plain");
  assert.equal((await boss.shelf()).administrator, true);
  assert.equal((await everyone.shelf()).administrator, false);

  // Importing a folder produces a local skill; publishing is where its
  // provenance changes, so the identity changes with it.
  const local = buildLocalSkill({ folderName: "weekly-report", files: [{ path: "SKILL.md", text: "---\nname: 周报助手\ndescription: 整理周报\n---\n先读记录。" }] });
  assert.equal(local.id, "local-weekly-report");
  const promoted = promoteToEnterprise(local, { publisher: "平台组" });
  assert.equal(promoted.id, "enterprise-weekly-report");
  assert.match(promoted.files[0].text, /name: enterprise-weekly-report/, "SKILL.md must agree with the id it was given");
  assert.deepEqual(promoted.requiredTools, [], "publishing must not become the way a folder grants itself tools");

  // A refusal has to say what to do about it, not just that the service is unwell.
  await assert.rejects(everyone.publish(promoted), /不在企业技能上架人名单/);
  assert.equal((await everyone.shelf()).skills.length, 0);

  assert.equal((await boss.publish(promoted)).id, "enterprise-weekly-report");
  assert.deepEqual((await everyone.shelf()).skills.map(item => item.id), ["enterprise-weekly-report"]);
  // And it arrives through the signed path, not just the management view.
  const seen = await everyone.catalog();
  assert.deepEqual(seen.skills.map(item => item.id), ["enterprise-weekly-report"]);
  assert.ok(seen.revision >= 2);

  await assert.rejects(everyone.unpublish("enterprise-weekly-report"), /不在企业技能上架人名单/);
  await boss.unpublish("enterprise-weekly-report");
  assert.equal((await everyone.shelf()).skills.length, 0);
});

// The empty-shelf rule above is for a writable shelf only. A static catalogue
// that does not list a tenant still has nothing for it, and that stays a refusal.
test("a static catalogue still refuses a tenant it does not list", async () => {
  const sessions = new SessionRegistry();
  const privateKey = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" });
  const catalog = new EnterpriseSkillCatalog({ origin: "https://agent.example", sessions, privateKey,
    catalog: { schemaVersion: 1, revision: 1, tenants: [{ tenantId: "tenant_a", skills: [bundle()] }] } });
  const identity = { tenantId: "tenant_z", appId: "cli_x", expiresAt: Date.now() + 60_000 };
  await assert.rejects(() => catalog.signedCatalog(identity, "n".repeat(43)), /skill_catalog_not_available/);
});

// docs/enterprise-skill-governance.md, as the desktop meets it: with review on,
// a publish waits and the shelf does not change; a publisher added in the
// console may publish; a skill for one department is in nobody else's signed
// catalogue; a task started with a skill is counted; each step is written down.
test("governed: a publish waits for review, the console's publishers count, the catalogue follows departments, use is counted", async (t) => {
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const { SessionRegistry: Sessions } = await import("../src/control-plane/sessions.js");
  const { EnterpriseSkillsClient } = await import("../src/application/enterprise-skills.js");
  const { openAdminDatabase } = await import("../src/control-plane/admin-db.js");
  const { SkillGovernance } = await import("../src/control-plane/skill-governance.js");
  const { skillTrail } = await import("../src/control-plane/audit-trail.js");
  const { base, filename } = await setup(t);
  const key = path.join(base, "sign.pem");
  const pair = generateKeyPairSync("ed25519");
  await writeFile(key, pair.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const sessions = new Sessions();
  const catalog = await EnterpriseSkillCatalog.fromConfig({ origin: "http://127.0.0.1:1", sessions,
    env: { IDOU_SKILL_SIGNING_KEY_FILE: key, IDOU_SKILL_REGISTRY_FILE: filename, IDOU_SKILL_ADMINS: "ou_admin" } });
  const db = await openAdminDatabase();
  const governance = await SkillGovernance.open({ db, key: catalog.usageKey() });
  t.after(async () => { governance.close(); await db.close(); });
  const placed = { ou_legal: ["od-legal"], ou_plain: [] };
  const trail = [];
  catalog.govern({ governance, departmentsOf: async (who) => placed[who.userId] ?? [], audit: (event, context) => { const row = skillTrail(event, context); if (row) trail.push(row); } });
  const server = createServer(async (req, res) => { if (!await catalog.handle(req, res)) { res.writeHead(404); res.end(); } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.close(); server.closeAllConnections(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  catalog.origin = origin;
  const client = (userId) => {
    const session = sessions.issue({ tenantId: "tenant_a", userId, deviceId: "d", authProvider: "feishu", appId: "cli_x", deviceProof: "ed25519-login" });
    return new EnterpriseSkillsClient({ publicKey: pair.publicKey.export({ format: "pem", type: "spki" }), runtimeVersions: { codex: "0.147.0", feishu: "1.0.78" },
      getSession: async () => ({ token: session.token, expiresAt: session.expiresAt, serverUrl: origin, identity: { provider: "feishu", tenantId: "tenant_a", userId, appId: "cli_x" } }) });
  };
  const boss = client("ou_admin"), legal = client("ou_legal"), plain = client("ou_plain");
  // Review on (the default): the publish waits, the shelf is as it was.
  const waiting = await boss.publish(bundle());
  assert.deepEqual([waiting.pending, waiting.version], [true, "1.0.0"]);
  assert.deepEqual((await plain.catalog()).skills, [], "nothing up until an administrator approves");
  const mine = await boss.shelf();
  assert.deepEqual([mine.review.required, mine.submissions.map((row) => [row.skillId, row.state])], [true, [["enterprise-weekly", "pending"]]]);
  // Turned down in the console: the publisher sees why.
  await governance.decide("tenant_a", waiting.submission, { decision: "rejected", by: { userId: "ou_owner" }, reason: "先删掉客户名单" });
  assert.deepEqual((await boss.shelf()).submissions.map((row) => [row.state, row.reason]), [["rejected", "先删掉客户名单"]]);
  // Review off: up at once, and kept as a version.
  await governance.setSettings("tenant_a", { reviewRequired: false }, { userId: "ou_owner" });
  assert.equal((await boss.publish(bundle())).id, "enterprise-weekly");
  assert.equal((await governance.versions("tenant_a", "enterprise-weekly")).length, 1);
  // A publisher added in the console publishes like a configured one.
  await assert.rejects(legal.publish(bundle({ id: "enterprise-contract", title: "合同初审", files: [{ path: "SKILL.md", text: "---\nname: enterprise-contract\ndescription: 合同\n---\n逐条核对。" }] })), /不在企业技能上架人名单/);
  await governance.addPublisher("tenant_a", { userId: "ou_legal", name: "法务小李" }, { userId: "ou_owner" });
  assert.equal((await legal.publish(bundle({ id: "enterprise-contract", title: "合同初审", files: [{ path: "SKILL.md", text: "---\nname: enterprise-contract\ndescription: 合同\n---\n逐条核对。" }] }))).id, "enterprise-contract");
  // For the legal department only: in their signed catalogue, nobody else's.
  await governance.setVisibility("tenant_a", "enterprise-contract", { departments: ["od-legal"] }, { userId: "ou_owner" });
  assert.deepEqual((await legal.catalog()).skills.map((skill) => skill.id).sort(), ["enterprise-contract", "enterprise-weekly"]);
  assert.deepEqual((await plain.catalog()).skills.map((skill) => skill.id), ["enterprise-weekly"]);
  // Nor in the management view, which anybody's skill center reads -- and no
  // files there, for anybody (found in review, 2026-10-03: it handed every
  // desktop the whole shelf, files included).
  const shelfOf = async (who) => (await who.shelf()).skills;
  assert.deepEqual((await shelfOf(plain)).map((skill) => skill.id), ["enterprise-weekly"]);
  assert.deepEqual((await shelfOf(boss)).map((skill) => skill.id).sort(), ["enterprise-contract", "enterprise-weekly"], "a publisher manages all of it");
  assert.ok((await shelfOf(boss)).every((skill) => skill.files === undefined && skill.digest));
  // A task started with a skill is counted; the person is not named in what is
  // kept; a skill they cannot see, or one not up, is not counted for them.
  await plain.used("enterprise-weekly", "1.0.0");
  await plain.used("enterprise-weekly", "9.9.9");
  await plain.used("enterprise-contract", "1.0.0");
  await plain.used("enterprise-nothing", "1.0.0");
  const used = (await governance.usage("tenant_a", ["enterprise-weekly", "enterprise-contract", "enterprise-nothing"], 30));
  assert.deepEqual([used.get("enterprise-weekly").people, used.get("enterprise-weekly").uses, used.get("enterprise-contract").uses, used.get("enterprise-nothing").uses], [1, 2, 0, 0]);
  // Taken down from a desktop; every step in the trail, by whom.
  await boss.unpublish("enterprise-weekly");
  assert.deepEqual(trail.map((row) => [row.action, row.actor.id, row.target.id]), [
    ["skill.submit", "ou_admin", "enterprise-weekly"], ["skill.publish", "ou_admin", "enterprise-weekly"],
    ["skill.publish", "ou_legal", "enterprise-contract"], ["skill.unpublish", "ou_admin", "enterprise-weekly"]]);
});
