// What an organisation decides about its enterprise skills beyond the shelf
// (skill-governance.js, docs/enterprise-skill-governance.md): review before a
// version goes up, publishers added in the console, every version that went
// up, who sees which skill, who used which. On SQLite and on PostgreSQL.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { openAdminDatabase } from "../src/control-plane/admin-db.js";
import { SkillGovernance, SKILL_LIMITS, compareSkills, toolMeaning } from "../src/control-plane/skill-governance.js";
import { testPostgres } from "./helpers/postgres.js";

const KINDS = ["sqlite", "postgres"];
const stops = [];
after(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });
let server = null;
const postgres = () => (server ??= testPostgres({ after: (stop) => stops.push(stop) }));
const TENANT = "tenant_a", KEY = "a-server-key-of-thirty-two-bytes!";
const ADMIN = { userId: "ou_admin", name: "管理员" }, PUBLISHER = { userId: "ou_publisher", name: "平台组小王" };
const bundle = (version = "1.0.0", text = "先读最近一周的记录。", over = {}) => ({
  id: "enterprise-weekly", version, title: "周报助手", description: "把一周记录整理成周报", publisher: "平台组", requiredTools: [], runtimeVersions: { codex: [], feishu: [] },
  files: [{ path: "SKILL.md", text: `---\nname: enterprise-weekly\ndescription: 周报\n---\n${text}` }], ...over });

async function setup(t, kind) {
  let db;
  if (kind === "postgres") {
    const settings = await (await postgres()).database();
    const pool = new pg.Pool({ ...settings, max: 4 }); pool.on("error", () => {});
    const connect = async () => { const client = new pg.Client(settings); client.on("error", () => {}); await client.connect(); return client; };
    db = await openAdminDatabase({ pool, connect });
    t.after(async () => { await db.close(); await pool.end(); });
  } else { db = await openAdminDatabase(); t.after(() => db.close()); }
  const clock = { at: Date.UTC(2026, 9, 3, 8, 0) };
  const governance = await SkillGovernance.open({ db, key: KEY, now: () => clock.at });
  t.after(() => governance.close());
  return { db, governance, clock };
}

for (const kind of KINDS) test(`${kind}: a version waits for an administrator unless review is turned off; approving one ends the older ones waiting`, async (t) => {
  const { governance, clock, db } = await setup(t, kind);
  assert.equal(governance.settings(TENANT).reviewRequired, true, "on until somebody turns it off");
  const first = await governance.submit(TENANT, bundle("1.0.0"), PUBLISHER);
  clock.at += 1000;
  const again = await governance.submit(TENANT, bundle("1.0.0"), PUBLISHER);
  assert.deepEqual([again.id, again.already], [first.id, true], "the same version submitted twice is one submission");
  const second = await governance.submit(TENANT, bundle("1.1.0", "改了第二段"), PUBLISHER);
  assert.equal(await governance.pendingCount(TENANT), 2);
  const read = await governance.submission(TENANT, second.id);
  assert.deepEqual([read.skillId, read.version, read.state, read.submittedBy.name, read.skill.files[0].path], ["enterprise-weekly", "1.1.0", "pending", "平台组小王", "SKILL.md"]);
  assert.equal(await governance.decide(TENANT, second.id, { decision: "approved", by: ADMIN }), true);
  assert.equal(await governance.decide(TENANT, second.id, { decision: "rejected", by: ADMIN, reason: "x" }), false, "decided once");
  assert.equal((await governance.submission(TENANT, first.id)).state, "superseded", "an older version still waiting is ended by a newer one going up");
  clock.at += 1000;
  const third = await governance.submit(TENANT, bundle("1.2.0", "第三版"), PUBLISHER);
  await governance.decide(TENANT, third.id, { decision: "rejected", by: ADMIN, reason: "  先删掉客户名单  " });
  assert.deepEqual((await governance.submissions(TENANT, { state: "rejected" })).map((row) => [row.version, row.decision.reason]), [["1.2.0", "先删掉客户名单"]]);
  assert.deepEqual((await governance.submissions(TENANT, { state: null, submittedBy: PUBLISHER.userId })).map((row) => row.state), ["rejected", "approved", "superseded"]);
  // Turned off, heard by another process too.
  const other = await SkillGovernance.open({ db, key: KEY });
  t.after(() => other.close());
  const { before, after: now } = await governance.setSettings(TENANT, { reviewRequired: false }, ADMIN);
  assert.deepEqual([before.reviewRequired, now.reviewRequired, now.updated.by.name], [true, false, "管理员"]);
  await other.reload();
  assert.equal(other.settings(TENANT).reviewRequired, false);
  assert.equal(other.settings("tenant_b").reviewRequired, true, "another organisation keeps the default");
  await assert.rejects(() => governance.setSettings(TENANT, { reviewRequired: "否" }, ADMIN), /只能是开或关/);
});

for (const kind of KINDS) test(`${kind}: every version that went up is kept to go back to, the newest ${SKILL_LIMITS.versionsKept}`, async (t) => {
  const { governance, clock } = await setup(t, kind);
  const digests = [];
  for (let n = 0; n < SKILL_LIMITS.versionsKept + 2; n += 1) {
    clock.at += 60_000;
    digests.push((await governance.recordVersion(TENANT, bundle(`1.${n}.0`, `第 ${n} 版`), { publishedBy: PUBLISHER, approvedBy: n % 2 ? ADMIN : null, source: n % 2 ? "approve" : "publish" })).digest);
  }
  const versions = await governance.versions(TENANT, "enterprise-weekly");
  assert.equal(versions.length, SKILL_LIMITS.versionsKept);
  assert.deepEqual(versions.map((version) => version.version), ["1.6.0", "1.5.0", "1.4.0", "1.3.0", "1.2.0"], "newest first");
  assert.deepEqual([versions[1].source, versions[1].approvedBy.name, versions[0].approvedBy], ["approve", "管理员", null]);
  assert.equal((await governance.version(TENANT, "enterprise-weekly", digests[3])).version, "1.3.0");
  assert.equal(await governance.version(TENANT, "enterprise-weekly", digests[0]), null, "past the ones kept");
});

for (const kind of KINDS) test(`${kind}: a skill for named departments is seen there and under them, by nobody else`, async (t) => {
  const { governance } = await setup(t, kind);
  const skills = [bundle(), { ...bundle(), id: "enterprise-contract", title: "合同初审" }];
  const placed = { ou_sales: ["od-root", "od-sales"], ou_legal: ["od-root", "od-legal", "od-legal-cn"], ou_new: [] };
  const departmentsOf = async (who) => placed[who.userId] ?? [];
  await governance.setVisibility(TENANT, "enterprise-contract", { departments: ["od-legal"] }, ADMIN);
  const seen = async (userId) => (await governance.visibleTo({ tenantId: TENANT, userId }, skills, departmentsOf)).map((skill) => skill.id);
  assert.deepEqual(await seen("ou_legal"), ["enterprise-weekly", "enterprise-contract"], "under the department named");
  assert.deepEqual(await seen("ou_sales"), ["enterprise-weekly"]);
  assert.deepEqual(await seen("ou_new"), ["enterprise-weekly"], "the address book never placed them: what is for everybody");
  const { before, after: now } = await governance.setVisibility(TENANT, "enterprise-contract", { departments: [] }, ADMIN);
  assert.deepEqual([before.departments, now.departments], [["od-legal"], []]);
  assert.deepEqual(await seen("ou_sales"), ["enterprise-weekly", "enterprise-contract"], "back to everybody");
  await assert.rejects(() => governance.setVisibility(TENANT, "enterprise-contract", { departments: ["bad id!"] }, ADMIN), /部门无效/);
  await assert.rejects(() => governance.setVisibility(TENANT, "enterprise-contract", { departments: Array.from({ length: 51 }, (_, n) => `od-${n}`) }, ADMIN), /最多指定 50 个部门/);
});

for (const kind of KINDS) test(`${kind}: who used which skill, counted once a day a person, and naming nobody`, async (t) => {
  const { governance, clock, db } = await setup(t, kind);
  for (const userId of ["ou_a", "ou_a", "ou_b"]) await governance.recordUse(TENANT, { skillId: "enterprise-weekly", version: "1.0.0", userId });
  clock.at += 86_400_000;
  await governance.recordUse(TENANT, { skillId: "enterprise-weekly", version: "1.1.0", userId: "ou_a" });
  assert.equal(await governance.recordUse(TENANT, { skillId: "not-enterprise", userId: "ou_a" }), false);
  const used = (await governance.usage(TENANT, ["enterprise-weekly", "enterprise-none"], 30));
  assert.deepEqual({ people: used.get("enterprise-weekly").people, uses: used.get("enterprise-weekly").uses }, { people: 2, uses: 4 });
  assert.deepEqual(used.get("enterprise-weekly").daily, [{ day: "2026-10-03", uses: 3 }, { day: "2026-10-04", uses: 1 }]);
  assert.deepEqual(used.get("enterprise-none"), { people: 0, uses: 0, daily: [] });
  const stored = JSON.stringify(await db.all("SELECT * FROM idou_admin_skill_usage"));
  assert.ok(!stored.includes("ou_a") && !stored.includes("ou_b"), "nobody's id is kept");
  clock.at += SKILL_LIMITS.usageDays * 86_400_000;
  assert.equal(await governance.pruneUsage(), 2, "kept for 400 days: the later day is not past them yet");
  clock.at += 86_400_000;
  assert.equal(await governance.pruneUsage(), 1);
});

for (const kind of KINDS) test(`${kind}: publishers added in the console`, async (t) => {
  const { governance } = await setup(t, kind);
  await governance.addPublisher(TENANT, PUBLISHER, ADMIN);
  assert.equal(governance.isPublisher(TENANT, PUBLISHER.userId), true);
  assert.equal(governance.isPublisher("tenant_b", PUBLISHER.userId), false, "for the organisation it was added in");
  assert.deepEqual(governance.publishers(TENANT).map((person) => [person.userId, person.name, person.added.by.name]), [["ou_publisher", "平台组小王", "管理员"]]);
  await assert.rejects(() => governance.addPublisher(TENANT, { userId: "someone" }, ADMIN), /要加的人无效/);
  assert.equal(await governance.removePublisher(TENANT, PUBLISHER.userId), true);
  assert.equal(governance.isPublisher(TENANT, PUBLISHER.userId), false);
});

test("what a version changes, file by file, line by line", () => {
  const before = bundle("1.0.0", "第一段\n第二段\n第三段", { requiredTools: ["cli:local-files"] });
  const after = { ...bundle("1.1.0", "第一段\n第二段改了\n第三段", { requiredTools: ["mcp:crm:lookup"] }), files: [...bundle("1.1.0", "第一段\n第二段改了\n第三段").files, { path: "notes.md", text: "新文件" }] };
  const changes = compareSkills(before, after);
  assert.deepEqual(changes.fields, ["version"]);
  assert.deepEqual(changes.tools, { added: ["mcp:crm:lookup"], removed: ["cli:local-files"] });
  const skillFile = changes.files.find((file) => file.path === "SKILL.md");
  assert.deepEqual([skillFile.change, skillFile.added, skillFile.removed], ["changed", 1, 1]);
  assert.deepEqual(skillFile.hunks, [{ kind: "+", line: "第二段改了" }, { kind: "-", line: "第二段" }]);
  assert.deepEqual(changes.files.find((file) => file.path === "notes.md"), { path: "notes.md", change: "added", lines: 1 });
  assert.equal(compareSkills(null, after).files.length, 2, "nothing up yet: every file is new");
});

test("each declared tool, in words an administrator can weigh", () => {
  assert.equal(toolMeaning("cli:local-files").level, "files");
  assert.match(toolMeaning("mcp:crm:lookup").meaning, /连接器「crm」的工具「lookup」.*每次调用仍要本人确认/);
  assert.equal(toolMeaning("feishu.write").level, "declared");
});

// Found in review (2026-10-03): names from the desktop were never stored (its
// identity says displayName); nothing bounded what may wait; a decision could
// be taken twice; the version up before versions were recorded was lost.
for (const kind of KINDS) test(`${kind}: a publisher's name is kept, what may wait is bounded, a decision is taken once`, async (t) => {
  const { governance, clock } = await setup(t, kind);
  const desktop = { userId: "ou_desk", displayName: "桌面上的小李" };
  const first = await governance.submit(TENANT, bundle("2.0.0", "第二版", { requiredTools: ["cli:local-files"] }), desktop);
  const listed = await governance.submissions(TENANT);
  assert.deepEqual([listed[0].submittedBy.name, listed[0].requiredTools], ["桌面上的小李", ["cli:local-files"]], "the list is read without the bundle");
  // Claimed: a second decision is refused; reopened when the version could not go up.
  assert.equal(await governance.decide(TENANT, first.id, { decision: "approved", by: ADMIN }), true);
  assert.equal(await governance.decide(TENANT, first.id, { decision: "rejected", by: ADMIN, reason: "x" }), false);
  await governance.reopen(TENANT, first.id);
  assert.equal((await governance.submission(TENANT, first.id)).state, "pending");
  // Ten waiting at once per publisher, a hundred per organisation.
  for (let n = 1; n < SKILL_LIMITS.pendingPerPublisher; n += 1) { clock.at += 1; await governance.submit(TENANT, bundle(`2.0.${n}`, `改 ${n}`), desktop); }
  await assert.rejects(() => governance.submit(TENANT, bundle("2.1.0", "再一个"), desktop), (error) => error.status === 429 && error.message === "skill_submissions_waiting");
  // Decided ones are kept 180 days.
  await governance.decide(TENANT, first.id, { decision: "rejected", by: ADMIN, reason: "旧的" });
  clock.at += (SKILL_LIMITS.decidedDays + 1) * 86_400_000;
  assert.equal(await governance.pruneSubmissions(), 1);
  await assert.rejects(() => governance.setVisibility(TENANT, "enterprise-weekly", { departments: "od-legal" }, ADMIN), /列表/, "not a list is refused, not taken as everybody");
});

for (const kind of KINDS) test(`${kind}: what is up is kept once before it is replaced, and a withdrawn skill can be found`, async (t) => {
  const { governance, clock } = await setup(t, kind);
  const live = { ...bundle("0.9.0", "早就在线上"), digest: "listed-digest-is-ignored" };
  await governance.keepLive(TENANT, live);
  await governance.keepLive(TENANT, live);
  clock.at += 1000;
  await governance.recordVersion(TENANT, bundle("1.0.0", "新版"), { publishedBy: PUBLISHER, source: "approve" });
  assert.deepEqual((await governance.versions(TENANT, "enterprise-weekly")).map((version) => [version.version, version.source]), [["1.0.0", "approve"], ["0.9.0", "earlier"]]);
  assert.deepEqual((await governance.withdrawn(TENANT, [])).map((skill) => [skill.id, skill.version, skill.title]), [["enterprise-weekly", "1.0.0", "周报助手"]]);
  assert.deepEqual(await governance.withdrawn(TENANT, ["enterprise-weekly"]), [], "up now is not withdrawn");
  // One person's uses of a skill in a day are bounded.
  for (let n = 0; n < SKILL_LIMITS.usesPerPersonDay + 5; n += 1) await governance.recordUse(TENANT, { skillId: "enterprise-weekly", version: "1.0.0", userId: "ou_busy" });
  assert.equal((await governance.usage(TENANT, ["enterprise-weekly"], 1)).get("enterprise-weekly").uses, SKILL_LIMITS.usesPerPersonDay);
});
