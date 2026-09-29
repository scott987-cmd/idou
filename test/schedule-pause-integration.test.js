import test from "node:test";
import assert from "node:assert/strict";
import { ScheduleStore } from "../src/control-plane/schedule-store.js";
import { SandboxEgressService, EGRESS_ROUTE } from "../src/control-plane/sandbox-egress.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";
import { makeScheduleCapability } from "../src/control-plane/schedule-capability.js";

const who = { tenantId: "tenant", userId: "owner", familyId: "family" };
async function fixture(t, frequency = "daily") {
  let now = Date.UTC(2026, 8, 18, 0, 0);
  const store = new ScheduleStore({ databaseFile: ":memory:", now: () => now });
  t.after(() => store.close());
  const schedule = store.create(who, { title: "test", prompt: "read", mode: "cowork",
    schedule: frequency === "daily" ? { frequency, time: "09:00", timeZone: "Asia/Shanghai" }
      : { frequency: "once", at: now + 60_000, timeZone: "Asia/Shanghai" },
    capabilityBinding: makeScheduleCapability({ feishu: SAAS_FEISHU, who,
      resources: [{ kind: "chat", id: "oc_FixtureChat123" }] }) });
  now = schedule.nextAt;
  const claim = store.claim(schedule);
  let reads = 0;
  const grant = { token: Buffer.from("fixture"), controller: new AbortController() };
  const egress = new SandboxEgressService({ schedules: store,
    sourceAccess: { feishu: SAAS_FEISHU, current: () => ({ who, grant }) },
    fetchImpl: async () => { reads++; return new Response('{"ok":true}', { headers: { "content-type": "application/json" } }); } });
  const token = egress.open({ schedule: claim.schedule, runId: claim.runId, parentToken: "fixture", ttlMs: 60_000 });
  const read = async () => {
    const res = { headersSent: false, once() {}, off() {}, writeHead(status) { this.status = status; this.headersSent = true; }, end(body) { this.body = body; } };
    await egress.handle({ method: "GET", url: EGRESS_ROUTE, headers: { "x-mydoubao-run": token,
      "x-mydoubao-feishu-path": "/open-apis/im/v1/messages?container_id_type=chat&container_id=oc_FixtureChat123" }, resume() {} }, res);
    return res;
  };
  return { store, schedule, read, reads: () => reads };
}

test("real store pause followed by resume cannot revive an already running token", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.read()).status, 200);
  f.store.setState(who, f.schedule.id, "paused");
  assert.equal((await f.read()).status, 403);
  f.store.setState(who, f.schedule.id, "active");
  assert.equal((await f.read()).status, 403);
  assert.equal(f.reads(), 1);
});

test("automatic completion of a one-off schedule does not revoke its final run", async (t) => {
  const f = await fixture(t, "once");
  assert.equal(f.store.get(who, f.schedule.id).state, "paused");
  assert.equal((await f.read()).status, 200);
});
