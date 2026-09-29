import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { runProcess } from "../src/providers/process-runner.js";
import { inventoryRuns, quarantineRuns } from "../src/control-plane/run-inventory.js";
import { SPELLINGS } from "../src/product-names.js";

// Read-only by default. Explicit quarantine requires a reviewed plan and IDs;
// there is intentionally no delete-all, recursive purge, or default data path.
async function main() {
  const [mode, dataDir, planFile, ...runIds] = process.argv.slice(2);
  if (!["list", "quarantine"].includes(mode) || !dataDir || !path.isAbsolute(dataDir)
      || (mode === "list" && planFile) || (mode === "quarantine" && (!planFile || !runIds.length))) {
    throw new Error("Usage: node scripts/inventory-scheduled-runs.js list /absolute/dataDir\n       node scripts/inventory-scheduled-runs.js quarantine /absolute/dataDir /reviewed-plan.json <run-id> [...]");
  }
  const databaseFile = path.join(dataDir, "schedules.db");
  if (!(await lstat(dataDir)).isDirectory() || !(await lstat(databaseFile)).isFile()) throw new Error("data_directory_or_database_invalid");
  const readInventory = async () => {
    const db = new DatabaseSync(databaseFile, { readOnly: true, allowExtension: false });
    let records;
    try { records = db.prepare(`SELECT r.id, r.tenant, r.schedule_id, r.finished_at, s.owner
      FROM schedule_runs r LEFT JOIN schedules s ON s.tenant=r.tenant AND s.id=r.schedule_id`).all(); }
    finally { db.close(); }
    return inventoryRuns({ dataDir, records });
  };
  if (mode === "list") return console.log(JSON.stringify(await readInventory(), null, 2));
  const owner = createHash("sha256").update(path.resolve(dataDir)).digest("hex").slice(0, 16);
  const verifyOffline = async () => {
    const open = await runProcess("lsof", ["-t", "--", databaseFile], { timeoutMs: 10_000 });
    if (open.code !== 1 || open.stdout.trim() || open.stderr.trim()) throw new Error("stop_control_plane_before_quarantine");
    for (const spelling of SPELLINGS) {
      const containers = await runProcess("docker", ["ps", "--all", "--quiet", "--filter", `label=${spelling}.owner=${owner}`], { timeoutMs: 15_000 });
      if (containers.code !== 0 || containers.stdout.trim()) throw new Error("container_shutdown_not_confirmed");
    }
  };
  await verifyOffline();
  const plan = JSON.parse(await readFile(planFile, "utf8"));
  const current = await readInventory();
  console.log(JSON.stringify(await quarantineRuns({ plan, current, runIds, verifyOffline }), null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
