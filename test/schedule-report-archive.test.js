import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DriveBudget } from "../src/control-plane/drive-budget.js";
import { KEPT_REPORTS, ScheduleArchiveError, ScheduleReportArchive, reportCandidates } from "../src/control-plane/schedule-report-archive.js";
import { DriveFileNotIntact } from "../src/providers/feishu/drive-files.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";

const IDENTITY = { id: "session-id", audience: "codex-model-gateway", authProvider: "feishu", familyId: "family",
  tenantId: "tenant", userId: "ou_fixture", appId: "cli_fixture", expiresAt: Date.now() + 600_000,
  cliBridge: true, cliDriveWrites: true };
const SCHEDULE = { tenant: "tenant", owner: "ou_fixture", title: "日报" };
const RUN = "11111111-1111-4111-8111-111111111111";
// The owner's own root folder, 我的空间, as the explorer names it.
const ROOT = "RootFixture1234";

async function fixture(t, mode = "success", { actions = undefined, replaceMode = "success" } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-report-archive-"));
  const budget = new DriveBudget({ feishu: SAAS_FEISHU, databaseFile: path.join(directory, "drive.db"), policies: [{
    authProvider: "feishu", tenantId: "tenant", appId: "cli_fixture", providerId: SAAS_FEISHU.id,
    driveTenantKey: "tenant", folderToken: "FolderFixture123", maxBytes: 1_000_000,
  }] });
  t.after(async () => { budget.close(); await rm(directory, { recursive: true, force: true }); });
  const state = { mode, uploads: 0, verifies: 0, sidecars: 0, closed: 0, roots: 0, rootTenant: "tenant" };
  const drive = {
    // Reports no longer go to the tenant's shared folder: asked for it, the
    // fixture fails the test.
    resolveFolder: async () => { throw new Error("the tenant's shared folder is not where a report goes"); },
    resolveRoot: async (origin, { signal } = {}) => { state.roots++; signal?.throwIfAborted(); return { providerId: SAAS_FEISHU.id,
      token: ROOT, url: `${origin}/drive/folder/${ROOT}`, title: "我的空间", root: true, identity: { principal: "p", tenantKey: state.rootTenant } }; },
    upload: async ({ name, folder, onDispatched, onUploaded, signal }) => {
      state.uploads++; state.uploadedTo = folder.token; signal?.throwIfAborted();
      if (state.mode === "before") throw new Error("preflight failed");
      await onDispatched();
      if (state.mode === "lost") throw new Error("socket closed");
      await onUploaded("FileFixture123");
      if (state.mode === "verify-lost") throw new Error("verify unavailable");
      return { providerId: SAAS_FEISHU.id, fileToken: "FileFixture123", name,
        url: "https://fixture.feishu.cn/file/FileFixture123", verifiedAt: Date.now(), folder };
    },
    verify: async ({ name, fileToken }) => { state.verifies++; return { providerId: SAAS_FEISHU.id, fileToken, name,
      url: `https://fixture.feishu.cn/file/${fileToken}`, verifiedAt: Date.now() }; },
    // Per kept report (by file token, or one mode for all): "gone" -- Drive
    // shows it deleted, renamed or changed, found before anything is sent;
    // "error" -- a failure before sending that proves nothing about it;
    // "lost" -- sent, and the answer never came.
    replace: async ({ name, previous, folder, onDispatched, onUploaded, signal }) => {
      state.replaces = (state.replaces ?? 0) + 1; (state.tried ??= []).push(previous.fileToken); state.replacedIn = folder.token;
      state.replaced = { name, previous }; signal?.throwIfAborted();
      const how = typeof replaceMode === "string" ? replaceMode : replaceMode[previous.fileToken] ?? "success";
      if (how === "gone") throw new DriveFileNotIntact("要替换的报告已不在目标文件夹里");
      if (how === "error") throw new Error("云盘清单响应无效，未确认保存成功");
      await onDispatched();
      if (how === "lost") throw new Error("socket closed");
      await onUploaded(previous.fileToken);
      return { providerId: SAAS_FEISHU.id, fileToken: previous.fileToken, name, url: `https://fixture.feishu.cn/file/${previous.fileToken}`, verifiedAt: Date.now() };
    },
    download: async ({ folder, name, fileToken, maxBytes }) => {
      state.downloads = (state.downloads ?? 0) + 1; state.downloaded = { folder: folder.token, name, fileToken, maxBytes };
      return state.downloadBytes ?? Buffer.from("");
    },
  };
  if (replaceMode === "absent") delete drive.replace;
  const archive = new ScheduleReportArchive({ feishu: SAAS_FEISHU, budget,
    sessions: { verify: token => token === "parent" ? IDENTITY : null },
    sourceAccess: { originalOrigins: { tenant: "https://fixture.feishu.cn" }, ...(actions ? { cliWriteActions: actions } : {}), current: token => {
      if (token !== "parent") throw new Error("denied"); return { who: IDENTITY, grant: {} };
    } }, controlPlaneOrigin: "http://127.0.0.1:3041",
    createSidecar: () => ({ async start() { state.sidecars++; return this; }, environment: () => ({}),
      sessionFingerprint: async () => "fingerprint", async close() { state.closed++; } }),
    createClient: () => ({ drive }),
  });
  return { archive, budget, state };
}

const request = (archive, report = Buffer.from("SENSITIVE-REPORT-CONTENT")) => archive.archive({
  schedule: SCHEDULE, parentToken: "parent", runId: RUN, report, signal: new AbortController().signal,
});

test("trusted postprocessor uploads once to the owner's own space and a replay only verifies the receipt", async t => {
  const f = await fixture(t);
  const first = await request(f.archive);
  assert.equal(first.artifact.state, "verified");
  assert.equal(f.state.uploadedTo, ROOT);
  assert.equal(first.artifact.name, `idou-${RUN}.schedule.md`);
  assert.match(first.detail, /飞书云盘/);
  assert.equal(f.state.uploads, 1);
  const replay = await request(f.archive);
  assert.equal(replay.artifact.state, "verified");
  assert.equal(f.state.uploads, 1, "a reported reservation is never uploaded twice");
  assert.equal(f.state.verifies, 1);
  assert.equal(f.state.closed, 2);
  assert.doesNotMatch(JSON.stringify(f.budget.db.prepare("SELECT * FROM drive_reservations").all()), /SENSITIVE-REPORT-CONTENT/);
});

test("a lost response after dispatch is unknown and is never retried", async t => {
  const f = await fixture(t, "lost");
  await assert.rejects(request(f.archive), error => {
    assert.ok(error instanceof ScheduleArchiveError);
    assert.equal(error.artifact.state, "unknown");
    assert.match(error.message, /不会自动重传/);
    return true;
  });
  assert.equal(f.state.uploads, 1);
  await assert.rejects(request(f.archive), /结果不确定/);
  assert.equal(f.state.uploads, 1, "the second attempt stops at the dispatched ledger row");
  assert.equal(f.state.sidecars, 1, "it does not even start a CLI for a known-unknown outcome");
});

test("a failure proven to precede dispatch remains safe to retry", async t => {
  const f = await fixture(t, "before");
  await assert.rejects(request(f.archive), /preflight failed/);
  f.state.mode = "success";
  assert.equal((await request(f.archive)).artifact.state, "verified");
  assert.equal(f.state.uploads, 2, "only the attempt proven not to have dispatched is retried");
});

test("foreign or non-Drive identities are refused before reserving budget or starting a CLI", async t => {
  const f = await fixture(t);
  f.archive.sessions.verify = () => ({ ...IDENTITY, cliDriveWrites: false });
  await assert.rejects(request(f.archive), /没有获准写入云盘/);
  assert.equal(f.state.sidecars, 0);
  assert.equal(f.budget.db.prepare("SELECT COUNT(*) AS n FROM drive_reservations").get().n, 0);
});

// 参考上一次的结果 (G4): the last report comes back as the same person, and
// only as the bytes its receipt recorded.
test("the last report is read back only as the bytes its receipt recorded", async t => {
  const f = await fixture(t);
  const { createHash } = await import("node:crypto");
  const sha = bytes => createHash("sha256").update(bytes).digest("hex");
  const bytes = Buffer.from("昨天的要点：甲、乙、丙");
  const artifact = { fileToken: "FileFixture123", name: `mydoubao-${RUN}.schedule.md`, bytes: bytes.length, sha256: sha(bytes) };
  const recall = (extra = {}) => f.archive.recall({ schedule: SCHEDULE, parentToken: "parent", artifact, ...extra });

  f.state.downloadBytes = bytes;
  assert.equal(await recall(), "昨天的要点：甲、乙、丙");
  assert.deepEqual(f.state.downloaded, { folder: ROOT, name: artifact.name, fileToken: "FileFixture123", maxBytes: bytes.length },
    "through the owner's own space, by name and token, no larger than it was");

  f.state.downloadBytes = Buffer.from("昨天的要点：甲、乙、丁");
  await assert.rejects(recall(), /不一致/, "changed in Drive since: not what this task wrote");

  const long = Buffer.from("长".repeat(7000));
  f.state.downloadBytes = long;
  const cut = await f.archive.recall({ schedule: SCHEDULE, parentToken: "parent", artifact: { ...artifact, bytes: long.length, sha256: sha(long) }, maxChars: 6000 });
  assert.equal(cut.length, 6001);
  assert.ok(cut.endsWith("…"));

  const started = f.state.sidecars;
  await assert.rejects(f.archive.recall({ schedule: SCHEDULE, parentToken: "parent", artifact: { ...artifact, name: "../etc/passwd" } }), /记录无效/);
  await assert.rejects(f.archive.recall({ schedule: SCHEDULE, parentToken: "someone-else", artifact }), /没有获准写入云盘/);
  assert.equal(f.state.sidecars, started, "refused before any sidecar starts");
  assert.equal(f.state.closed, f.state.sidecars, "and every sidecar that started was closed");
});

// Each task keeps its KEPT_REPORTS latest reports. The caller hands over the
// ones it may overwrite, oldest first; with drive.replace enabled the first
// still intact is overwritten in place, and the result says whose file it was
// and which were found gone on the way, so those runs stop naming them.
const kept = (n, token) => { const runId = `${n}${n}${n}${n}${n}${n}${n}${n}-2222-4222-8222-222222222222`;
  return { runId, fileToken: token, name: `mydoubao-${runId}.schedule.md`, bytes: 10, sha256: "a".repeat(64) }; };
const OLDEST = kept(2, "KeptOldest12345"), NEXT = kept(3, "KeptNext1234567"), THIRD = kept(4, "KeptThird123456");
const rotating = (archive, candidates = [OLDEST]) => archive.archive({ schedule: SCHEDULE, parentToken: "parent", runId: RUN,
  report: Buffer.from("NEW-REPORT"), signal: new AbortController().signal, candidates });
const BOTH = ["drive.upload", "drive.replace"];

test("a task keeping its reports overwrites the oldest in place, says whose file it was, and a replay only verifies", async t => {
  const f = await fixture(t, "success", { actions: BOTH });
  const saved = await rotating(f.archive);
  assert.deepEqual([f.state.replaces, f.state.uploads], [1, 0]);
  // The kept reports were written before the rename, under the old spelling; the new one carries today's.
  assert.deepEqual(f.state.replaced, { name: `idou-${RUN}.schedule.md`, previous: OLDEST },
    "the new report goes into the kept file, checked against that report's own receipt");
  assert.equal(saved.replaced, OLDEST.runId);
  assert.deepEqual(saved.stale, []);
  assert.deepEqual([saved.artifact.state, saved.artifact.fileToken, saved.artifact.name], ["verified", OLDEST.fileToken, `idou-${RUN}.schedule.md`]);
  assert.match(saved.detail, /替换了这个任务最早的一份/);
  const replay = await rotating(f.archive);
  assert.equal(f.state.replaces, 1, "a reported overwrite is never sent twice");
  assert.equal(replay.replaced, OLDEST.runId, "and the replay still says whose file it was");
});

test("without drive.replace enabled, or a client that cannot overwrite, a report is a new file as before", async t => {
  for (const [what, options] of [["the operator did not enable it", { actions: ["drive.upload"] }], ["no action list at all", {}],
    ["the provider cannot overwrite", { actions: BOTH, replaceMode: "absent" }]]) {
    const f = await fixture(t, "success", options);
    const saved = await rotating(f.archive);
    assert.deepEqual([f.state.replaces ?? 0, f.state.uploads], [0, 1], what);
    assert.equal(saved.replaced, undefined, what);
    assert.deepEqual(saved.stale, [], what);
    assert.equal(saved.artifact.fileToken, "FileFixture123", what);
  }
});

// The 27 reports deleted on 2026-09-22 left receipts naming files in the recycle
// bin. Counted as kept, they would have had every later run overwrite nothing
// and add a file, for good.
test("a kept report Drive shows is gone is skipped for the next oldest, and named so its run stops counting it", async t => {
  const f = await fixture(t, "success", { actions: BOTH, replaceMode: { [OLDEST.fileToken]: "gone" } });
  const saved = await rotating(f.archive, [OLDEST, NEXT, THIRD]);
  assert.deepEqual(f.state.tried, [OLDEST.fileToken, NEXT.fileToken], "oldest first, and no further than the first intact one");
  assert.equal(f.state.uploads, 0);
  assert.equal(saved.replaced, NEXT.runId);
  assert.deepEqual(saved.stale, [OLDEST.runId]);
  assert.equal(saved.artifact.fileToken, NEXT.fileToken);
});

test("when every kept report is gone the report is a new file, and all of them are named", async t => {
  const f = await fixture(t, "success", { actions: BOTH, replaceMode: "gone" });
  const saved = await rotating(f.archive, [OLDEST, NEXT]);
  assert.deepEqual([f.state.replaces, f.state.uploads], [2, 1], "nothing was sent for either, so a new file is safe");
  assert.equal(saved.replaced, undefined);
  assert.deepEqual(saved.stale, [OLDEST.runId, NEXT.runId]);
  assert.equal(saved.artifact.fileToken, "FileFixture123");
});

test("a failure that proves nothing about a kept report leaves it counted, and the report is a new file", async t => {
  const f = await fixture(t, "success", { actions: BOTH, replaceMode: { [OLDEST.fileToken]: "error" } });
  const saved = await rotating(f.archive, [OLDEST, NEXT]);
  assert.deepEqual(f.state.tried, [OLDEST.fileToken], "a listing that failed is no reason to overwrite a newer report instead");
  assert.equal(f.state.uploads, 1);
  assert.equal(saved.replaced, undefined);
  assert.deepEqual(saved.stale, [], "its receipt is not cleared on no evidence");
  assert.match(saved.unreplaced, /云盘清单响应无效/, "the reason is handed back for the operator's log");
  assert.doesNotMatch(saved.detail, /云盘清单/, "and is not what the person reads");
});

test("an overwrite whose answer is lost after dispatch is unknown, and nothing else is sent", async t => {
  const f = await fixture(t, "success", { actions: BOTH, replaceMode: "lost" });
  await assert.rejects(rotating(f.archive, [OLDEST, NEXT]), (error) => {
    assert.ok(error instanceof ScheduleArchiveError);
    assert.equal(error.artifact.state, "unknown");
    assert.equal(error.artifact.fileToken, null, "no upload receipt came back");
    assert.match(error.message, /不会自动重传/);
    return true;
  });
  assert.deepEqual([f.state.replaces, f.state.uploads], [1, 0], "no second copy, and no second overwrite, after an ambiguous one");
});

test("an overwrite cancelled after dispatch is still recorded as unknown", async t => {
  const f = await fixture(t, "success", { actions: BOTH });
  const controller = new AbortController();
  f.archive.budget.change = new Proxy(f.archive.budget.change, { apply(target, self, args) {
    const result = Reflect.apply(target, self, args); if (args[2] === true) controller.abort(); return result; } });
  await assert.rejects(f.archive.archive({ schedule: SCHEDULE, parentToken: "parent", runId: RUN, report: Buffer.from("NEW-REPORT"),
    signal: controller.signal, candidates: [OLDEST] }), (error) => {
    assert.ok(error instanceof ScheduleArchiveError, "a cancelled overwrite that may have landed is not a plain failure");
    assert.equal(error.artifact.state, "unknown");
    return true;
  });
  assert.equal(f.state.uploads, 0);
});

test("nothing is replaced until a task keeps three reports, and then the oldest first", () => {
  const newestFirst = ["d", "c", "b", "a"].map((id) => ({ runId: id }));
  const ids = (list) => reportCandidates(list).map((row) => row.runId);
  assert.equal(KEPT_REPORTS, 3);
  assert.deepEqual(ids([]), []);
  assert.deepEqual(ids(newestFirst.slice(2)), [], "two kept: a new file");
  assert.deepEqual(ids(newestFirst.slice(1)), ["a"], "three kept: the oldest");
  assert.deepEqual(ids(newestFirst), ["a", "b"], "more kept: every one but the newest two, oldest first");
  assert.deepEqual(reportCandidates(undefined), []);
});

// Found in the security review of 2026-09-27: every person's reports went to
// the one folder the administrator named for the tenant. Every task owner had
// to be able to save there, so everyone could open everyone's reports -- and
// a report is excerpts of its owner's own documents.
test("a report goes to its owner's own space, charged to the tenant, bound to where it went", async t => {
  const f = await fixture(t, "success", { actions: BOTH });
  const saved = await rotating(f.archive, []);
  assert.equal(f.state.uploadedTo, ROOT, "我的空间, found as the owner");
  assert.equal(f.state.roots, 1);
  assert.equal(saved.artifact.state, "verified");
  const { createHash } = await import("node:crypto");
  const input = { id: RUN, policyDigest: f.budget.snapshot(IDENTITY).policyDigest, providerId: SAAS_FEISHU.id, driveTenantKey: "tenant",
    bytes: 10, sha256: createHash("sha256").update("NEW-REPORT").digest("hex") };
  assert.equal(f.budget.reservation(IDENTITY, { ...input, folderToken: ROOT }, { own: true }).state, "reported", "the ledger names where it went");
  assert.throws(() => f.budget.reservation(IDENTITY, { ...input, folderToken: "FolderFixture123" }), /not_found/, "not the shared folder");
  assert.ok(f.budget.snapshot(IDENTITY).chargedBytes >= 10, "and the tenant's budget still counts it");
  // Kept reports rotate within the owner's space too: one that was left in
  // the shared folder is not there, and is let go like any report that is gone.
  const g = await fixture(t, "success", { actions: BOTH, replaceMode: { [OLDEST.fileToken]: "gone" } });
  const rotated = await rotating(g.archive, [OLDEST, NEXT]);
  assert.equal(g.state.replacedIn, ROOT);
  assert.deepEqual(rotated.stale, [OLDEST.runId]);
});

test("a deployment that cannot find a person's own space saves no report, and says why", async t => {
  const f = await fixture(t);
  delete (await f.archive.createClient()).drive.resolveRoot;
  await assert.rejects(request(f.archive), /还不能把报告存到本人的云空间/);
  assert.equal(f.state.uploads, 0);
  assert.equal(f.budget.db.prepare("SELECT COUNT(*) AS n FROM drive_reservations").get().n, 0, "nothing charged");
  const g = await fixture(t);
  g.state.rootTenant = "someone-elses-tenant";
  await assert.rejects(request(g.archive), /云空间实时核验不一致/, "a root that is not in the task's tenant");
  assert.equal(g.state.uploads, 0);
  assert.equal(g.state.closed, g.state.sidecars, "every sidecar closed");
});
