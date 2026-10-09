// What each component's events become in the administration console's audit
// trail (audit-trail.js): who, which kind of action, which object, how it
// ended -- and nothing at all without somebody to attribute it to.
import test from "node:test";
import assert from "node:assert/strict";
import { cliWriteTrail, siteTrail, mediaTrail, scheduleTrail, runTrail, unattendedTrail } from "../src/control-plane/audit-trail.js";
import { auditRow } from "../src/control-plane/audit-log.js";

const who = { tenantId: "tenant-a", userId: "ou_person", displayName: "张三" };

test("a write to Feishu: the kind of write, the object, and how it ended", () => {
  const base = { at: 5, action: "document.append", sessionHash: "x", userHash: "y" };
  const ok = cliWriteTrail({ ...base, kind: "upstream_finished", status: 200 }, { who, resource: "doxcnABC" });
  assert.deepEqual({ action: ok.action, outcome: ok.outcome, actor: ok.actor, target: ok.target, detail: ok.detail },
    { action: "feishu.write", outcome: "ok", actor: { kind: "person", id: "ou_person", name: "张三" }, target: { kind: "document", id: "doxcnABC", name: "" }, detail: { kind: "document.append", status: 200 } });
  assert.equal(cliWriteTrail({ ...base, action: "cli.delete", kind: "upstream_finished", status: 403 }, { who }).action, "feishu.delete");
  assert.equal(cliWriteTrail({ ...base, action: "cli.delete", kind: "upstream_finished", status: 403 }, { who }).outcome, "failed");
  assert.equal(cliWriteTrail({ ...base, action: "message.send", kind: "grant_rejected", reason: "x" }, { who }).outcome, "refused");
  assert.equal(cliWriteTrail({ ...base, action: "drive.replace", kind: "outcome_unknown" }, { who }).action, "feishu.upload");
  assert.equal(cliWriteTrail({ ...base, kind: "grant_issued" }, { who }), null, "one line per write, at its end");
  assert.equal(cliWriteTrail({ ...base, kind: "upstream_finished", status: 200 }, null), null, "nobody to name, no line");
});

test("sites, media, schedules, runs and unattended grants each become a line the log takes", () => {
  const rows = [
    siteTrail({ event: "site-published", siteId: "site-1", version: 2, scope: "tenant" }, { who, name: "销售看板" }),
    siteTrail({ event: "site-withdrawn", siteId: "site-1" }, { who, name: "销售看板" }),
    mediaTrail({ event: "media-submitted", job: "job-1", kind: "video", model: "happyhorse" }, { who }),
    scheduleTrail({ route: "create", scheduleId: "sched-1", title: "每天汇总" }, { who }),
    scheduleTrail({ route: "remove", scheduleId: "sched-1" }, { who }),
    runTrail({ kind: "completed", whose: { tenant: "tenant-a", owner: "ou_person", id: "sched-1", title: "每天汇总" } }),
    runTrail({ kind: "suspended", whose: { tenant: "tenant-a", owner: "ou_person", id: "sched-1", title: "每天汇总" }, reason: "你的 i豆 账号已被管理员停用" }),
    unattendedTrail({ kind: "unattended_consent_granted", at: 1, expiresAt: Date.UTC(2026, 9, 30) }, { tenantId: "tenant-a", userId: "ou_person" }),
  ];
  assert.deepEqual(rows.map((row) => [row.category, row.action, row.outcome]), [
    ["site", "site.publish", "ok"], ["site", "site.withdraw", "ok"], ["media", "media.video", "ok"],
    ["schedule", "schedule.create", "ok"], ["schedule", "schedule.delete", "ok"], ["schedule", "schedule.run", "ok"],
    ["schedule", "schedule.run", "refused"], ["schedule", "schedule.unattended.grant", "ok"]]);
  for (const row of rows) assert.doesNotThrow(() => auditRow(row), row.action);
  assert.equal(rows[0].target.name, "销售看板");
  assert.equal(rows[7].detail.until, "2026-10-30");
  assert.equal(scheduleTrail({ route: "list" }, { who }), null, "reading is not an action");
  assert.equal(runTrail({ kind: "store-unavailable" }), null);
});
