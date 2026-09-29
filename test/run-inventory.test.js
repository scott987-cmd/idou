import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { inventoryRuns, quarantineRuns } from "../src/control-plane/run-inventory.js";

const runId = "3f2504e0-4f89-11d3-9a0c-0305e82c3302";
async function fixture(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "idou-inventory-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const target = path.join(dataDir, "runs", runId);
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "task.json"), "PRIVATE-CONTENT-MARKER");
  const records = [{ id: runId, tenant: "private-tenant", owner: "private-owner", schedule_id: "schedule", finished_at: 123 }];
  const inventory = () => inventoryRuns({ dataDir, records });
  return { dataDir, target, records, inventory };
}
test("inventory exposes only metadata and does not follow symlinks", async t => {
  const f = await fixture(t);
  await symlink(f.dataDir, path.join(f.target, "loop"));
  await mkdir(path.join(f.dataDir, "runs", "unrelated"));
  const plan = await f.inventory();
  const text = JSON.stringify(plan);
  assert.ok(!/PRIVATE-CONTENT|private-tenant|private-owner/.test(text));
  assert.equal(plan.entries.find(row => row.runId === runId).eligible, true);
  assert.equal(plan.entries.find(row => row.runId === "unrelated").eligible, false);
});
test("quarantine preserves the only copy and reports its recovery path", async t => {
  const f = await fixture(t), plan = await f.inventory();
  let checks = 0;
  const result = await quarantineRuns({ plan, current: await f.inventory(), runIds: [runId], verifyOffline: async () => { checks++; } });
  assert.equal(checks, 2);
  assert.equal(await readFile(path.join(result.moved[0].to, "task.json"), "utf8"), "PRIVATE-CONTENT-MARKER");
  assert.equal(result.moved[0].from, f.target);
  await assert.rejects(readFile(path.join(f.target, "task.json")), /ENOENT/);
});
test("changed, active, unowned or online work cannot be quarantined", async t => {
  const f = await fixture(t), plan = await f.inventory();
  const args = { plan, current: plan, runIds: [runId], verifyOffline: async () => {} };
  await assert.rejects(quarantineRuns({ ...args, verifyOffline: async () => { throw new Error("online"); } }), /online/);
  f.records[0].finished_at = null;
  await assert.rejects(quarantineRuns({ ...args, current: await f.inventory() }), /unowned/);
  f.records.length = 0;
  await assert.rejects(quarantineRuns({ ...args, current: await f.inventory() }), /unowned/);
  await writeFile(path.join(f.target, "task.json"), "changed");
  await assert.rejects(quarantineRuns(args), /stale/);
  assert.equal(await readFile(path.join(f.target, "task.json"), "utf8"), "changed");
});
