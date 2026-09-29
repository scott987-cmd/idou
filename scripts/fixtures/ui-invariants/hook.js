// Puts the UI rules (./page-monitor.js, ./inspector.js) into every desktop
// smoke without touching the smoke:
//
//   node --import ./scripts/fixtures/ui-invariants/hook.js scripts/smoke-x.js
//
// run-desktop-acceptance.js does this for the whole suite. Each smoke drives
// the application into its own states -- cards of every kind, the Feishu
// section, menus, narrow windows -- and while it does, every screen it reaches
// is checked against the same rules. A rule written once covers every state any
// smoke reaches, including ones nobody wrote a smoke about.
//
// IDOU_UI_INVARIANTS: "0" switches it off.
// IDOU_UI_INVARIANTS_OUT: where to write what was found (JSON); without it
// the findings are printed when the smoke exits.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { inspect } from "./inspector.js";

if (process.env.IDOU_UI_INVARIANTS !== "0") {
  const found = new Map();
  // How much was looked at: a sweep that never ran reads exactly like a clean one.
  const stats = { launches: 0, pages: 0, samples: 0, installed: 0 };
  const smoke = path.basename(process.argv[1] ?? "");
  const { _electron: electron } = await import("playwright");
  const launch = electron.launch.bind(electron);
  electron.launch = async (options) => {
    const app = await launch(options);
    inspect(app, { found, stats });
    return app;
  };
  process.on("exit", () => {
    const rows = [...found.values()];
    const out = process.env.IDOU_UI_INVARIANTS_OUT;
    if (out) { try { writeFileSync(out, `${JSON.stringify({ smoke, stats, rows }, null, 2)}\n`); } catch { /* the smoke's own result stands */ } return; }
    if (!stats.launches) return;
    process.stderr.write(`\n界面巡检（${smoke}）：启动 ${stats.launches} 次，检查 ${stats.samples} 次（装上 ${stats.installed} 次），${rows.length} 处问题\n`);
    for (const row of rows) process.stderr.write(`  [${row.kind}] ${row.where}${row.detail ? ` — ${row.detail}` : ""}${row.phase ? `（${row.phase}）` : ""}\n`);
  });
}
