// Live acceptance for the server-managed model (docs/chat-models.md), in the
// operator's own signed-in application against the real control plane.
//
//   node scripts/acceptance-model-failover-live.js --paid [--model <slug>]
//
// Picks <slug> (default GLM-5.3) as the person's model on the server, sends one
// plain turn, and reports which model answered, what the server now says about
// the models, and what 设置 shows. When that model's upstream is refusing the
// account -- as GLM's was on 2026-09-19 -- the turn should still be answered,
// by the next model, and 设置 should say why. When it answers, that is said
// too: nothing here pretends a failover happened.
//
// The person's pick on the server is put back as it was afterwards (following
// the default stays following the default). Paid: one small model call.
// Needs the application NOT running; it is launched on its own data directory.
import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { desktopProfileDir } from "../src/install-names.js";

if (!process.argv.includes("--paid")) {
  console.error("This sends one real conversation turn (a paid model call). Re-run with --paid to proceed.");
  process.exit(2);
}
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DATA = process.env.IDOU_DESKTOP_DATA_DIR || desktopProfileDir();
const SERVER = process.env.IDOU_SERVER_URL || "http://127.0.0.1:3041";
const LOG = process.env.IDOU_CONTROL_PLANE_LOG || "/tmp/idou-control-plane.log";
const modelAt = process.argv.indexOf("--model");
const PICK = modelAt > 0 ? process.argv[modelAt + 1] : "GLM-5.3";
const say = (line) => process.stdout.write(`  · ${line}\n`);

try { execFileSync("pgrep", ["-f", "/Applications/i豆.app/Contents/MacOS/(idou|MyDouBao)$"]); console.error("Quit i豆 first: it is launched here on its own data directory."); process.exit(2); }
catch { /* not running: go on */ }

const healthLines = (after) => readFileSync(LOG, "utf8").split("\n").map((line) => line.slice(line.indexOf("{")))
  .filter((line) => line.includes("\"model-health\"")).map((line) => { try { return JSON.parse(line); } catch { return null; } })
  .filter((event) => event && event.at >= after);

let app, ok = false, restore = null;
try {
  say("launching the operator's own application …");
  app = await electron.launch({ executablePath: electronBinary, args: [ROOT, `--user-data-dir=${DATA}`], timeout: 60_000,
    env: { ...clientEnvironment(), IDOU_DESKTOP_DATA_DIR: DATA, IDOU_SERVER_URL: SERVER } });
  const page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  await page.locator("#new-task").waitFor();
  let status = null;
  for (let i = 0; i < 90 && !status?.connected; i += 1) {
    status = await page.evaluate(() => window.idou.authStatus()).catch(() => null);
    if (!status?.connected) await page.waitForTimeout(1000);
  }
  if (!status?.connected) throw new Error(`the application did not reconnect to Feishu (stage ${status?.stage ?? "unknown"}); sign in and re-run`);
  say("signed in");

  const before = await page.evaluate(() => window.idou.modelOptions());
  say(`before: kept by ${before.kept}, choice ${before.choice ?? "(follows the default)"}, current ${before.current}, default ${before.default}`);
  if (before.kept !== "server") throw new Error("the server does not keep model choices: is the installed control plane .41 or later?");
  restore = async () => page.evaluate((choice) => window.idou.selectModel(choice), before.choice ?? null);
  const startedAt = Date.now();
  const picked = await page.evaluate((slug) => window.idou.selectModel(slug), PICK);
  say(`picked ${PICK}: current ${picked.current}`);

  const known = new Set(((await page.evaluate(() => window.idou.snapshot()))?.tasks ?? []).map((task) => task.id));
  await page.locator('[data-section="cowork"]').click();
  await page.locator("#new-task").click();
  await page.locator("#prompt").fill("说一句「模型自测通过」，不要做别的。");
  await page.locator("#send").click();
  let task = null;
  for (let i = 0; i < 120; i += 1) {
    task = ((await page.evaluate(() => window.idou.snapshot()))?.tasks ?? []).find((item) => !known.has(item.id));
    if (["completed", "failed", "interrupted"].includes(task?.status)) break;
    await page.waitForTimeout(2000);
  }
  await page.waitForFunction(() => /模型自测通过/.test(document.querySelector("#messages")?.innerText.slice(-600) ?? ""), null, { timeout: 30_000, polling: 500 }).catch(() => {});
  const answered = /模型自测通过/.test((await page.locator("#messages").innerText()).slice(-600));
  say(`the turn: ${task?.status}${task?.error ? ` (${task.error})` : ""}; answered: ${answered}`);

  // Whether the server passed the pick over is the server's to say -- its own
  // log -- not the desktop's: a first run of this script read a desktop answer
  // cached before the failover and reported that none had happened.
  const events = healthLines(startedAt - 1000);
  say(`the control plane logged: ${JSON.stringify(events.map((event) => [event.kind, event.model, event.reason]))}`);
  const after = await page.evaluate(() => window.idou.modelOptions());
  const passedOver = (after.unavailable ?? []).find((row) => row.slug === PICK);
  say(`after: choice ${after.choice}, current ${after.current}, unavailable ${JSON.stringify(after.unavailable)}`);
  // Marked during this run, or already marked before it (then the server goes
  // straight past it and logs nothing new): either way, from its own log since
  // the mark began.
  const marked = healthLines(Math.min(startedAt, passedOver?.since ?? startedAt) - 1000)
    .filter((event) => event.kind === "model_unavailable" && event.model === PICK);
  const failedOver = marked.length > 0 || Boolean(passedOver);

  await page.locator("#settings").click();
  await page.waitForFunction(() => document.querySelectorAll("#model-select option").length >= 2, null, { polling: 200 });
  const hint = (await page.locator("#model-select").evaluate((node) => node.parentElement.innerText)).replace(/\s+/g, " ");
  say(`设置 says: ${hint}`);
  await page.locator("#model-select").evaluate((node) => node.parentElement.scrollIntoView());
  await page.locator("#model-select").evaluate((node) => node.parentElement.id = "model-box-under-test");
  await page.locator("#model-box-under-test").screenshot({ path: path.join(ROOT, "docs/evidence/desktop-model-failover-live.png") });

  const checks = failedOver ? [
    [`${PICK} lapsed: the turn was still answered`, task?.status === "completed" && answered],
    ["the server logged it once, with why", marked.length === 1 && Boolean(marked[0].reason)],
    ["the desktop is told: another model is current now", Boolean(passedOver) && after.current !== PICK],
    ["the pick itself is kept", after.choice === PICK],
    ["设置 says it is unavailable, why, and what is used instead", Boolean(passedOver) && hint.includes(`${passedOver.label} 暂不可用`) && hint.includes(passedOver.reason) && hint.includes("现在用的是")],
  ] : [
    [`${PICK} answered: the server passed nothing over, and nothing is claimed`, task?.status === "completed" && answered && !passedOver && after.current === PICK],
  ];
  for (const [what, passed] of checks) process.stdout.write(`${passed ? "OK  " : "FAIL"}  ${what}\n`);
  ok = checks.every(([, passed]) => passed);
} finally {
  if (restore) await restore().then((value) => say(`the person's pick is back as it was: ${value?.choice ?? "(follows the default)"}`)).catch((error) => say(`could not put the pick back: ${error.message}`));
  await app?.close().catch(() => {});
}
process.exit(ok ? 0 : 1);
