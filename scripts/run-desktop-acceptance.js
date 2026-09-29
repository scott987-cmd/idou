#!/usr/bin/env node
// Runs the desktop acceptance smokes.
//
// They existed for a long time with nothing that ran them: twenty-one of the
// thirty-one `scripts/smoke-*.js` files had no npm script and no runner, so
// whether they still passed depended on somebody remembering to type the path.
// A smoke nobody runs is not coverage.
//
// Sequential on purpose. The desktop is single-instance and each smoke launches
// a real Electron app against a real bundled CLI; running two at once makes them
// fight over the singleton lock and produces failures that have nothing to do
// with the code under test.
import "../src/adopt-legacy-env.js";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { manualConfirmationIds } from "./fixtures/confirmation-policy.js";
import { REACHED_CARD } from "./fixtures/agent-harness.js";
import { acceptedFinding } from "./fixtures/ui-invariants/accepted.js";
import { declaredRequirements } from "./fixtures/smoke-requirements.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

// Smokes that need something a bare checkout does not have. Each group runs
// when it is switched on and is reported as skipped -- never as passed -- when
// it is not; a skip that reads like a pass is how a broken suite looks healthy.
//
//   --live               the smokes that call the server's configured chat model
//                        (MiniMax-M3, or GLM-5.3 through a loopback LiteLLM when
//                        IDOU_MODEL_PROVIDER=litellm -- the same paid model
//                        every task uses), and the one that also reaches
//                        DeepWiki's public MCP server. They read the key the
//                        server would: MINIMAX_CONFIG_FILE / MINIMAX_API_KEY, or
//                        IDOU_LITELLM_KEY_FILE / IDOU_LITELLM_API_KEY, so
//                        load the deployment file first:  set -a; . <部署文件>; set +a
//   --docker=/abs/docker the isolated app runtime smokes. The endpoint comes
//                        from the current Docker context and the runtime image is
//                        built from src/apps first (scripts/build-app-runtime.js).
//
// Which smokes need which is said by each smoke in its own header
// (`// @requires live: …`, see fixtures/smoke-requirements.js), and
// test/smoke-requirements.test.js checks the header against what the smoke
// does. This list used to be kept here by hand and fell behind: a default run
// made a paid call and tried to open the operator's own application.
const flags = process.argv.slice(2).filter(value => value.startsWith("--"));
const live = flags.includes("--live");
// --with-person: somebody is at this machine to answer the cards. The smokes
// with a positive confirmation path (fixtures/confirmation-policy.js) then run
// too -- in front, their prompts shown as they come -- instead of being listed
// as 待人工, and they are checked against the UI rules like every other smoke.
// Only a person answers a card; the smokes wait for them (waitForHumanConfirm).
const withPerson = flags.includes("--with-person");
// Without a person, those smokes still run -- as far as their first card that
// needs a person's yes (IDOU_SMOKE_UNTIL_CARD=1, fixtures/agent-harness.js):
// everything before it, and the card itself, is checked like any other smoke,
// and the run stops there without answering. A failure before the card is a
// failure; reaching the card is reported as such, and what comes after the
// person's answer is still theirs to run (--with-person).
// Every desktop smoke also runs under the UI rules in fixtures/ui-invariants:
// while it drives the application into its states, each screen it reaches is
// checked for controls under the Feishu page, controls the Accessibility API
// cannot reach, cut-off text, English, and what a person did being lost to a
// re-draw. --ui=report lists what they find without failing anything (for
// triage); --ui=off leaves them out.
const uiMode = flags.find(value => value.startsWith("--ui="))?.slice("--ui=".length) ?? "enforce";
if (!["enforce", "report", "off"].includes(uiMode)) { process.stderr.write(`--ui 只能是 enforce、report 或 off\n`); process.exit(1); }
const uiHook = pathToFileURL(path.join(here, "fixtures", "ui-invariants", "hook.js")).href;
const uiDirectory = uiMode === "off" ? null : await mkdtemp(path.join(os.tmpdir(), "idou-ui-invariants-"));
const dockerFlag = flags.find(value => value.startsWith("--docker="))?.slice("--docker=".length) ?? null;

const only = process.argv.slice(2).filter(value => !value.startsWith("--"));
const all = (await readdir(here)).filter(name => /^smoke-.*\.js$/.test(name)).sort();
const needs = new Map(await Promise.all(all.map(async name => [name, declaredRequirements(await readFile(path.join(here, name), "utf8"))])));
const LIVE = new Set(all.filter(name => needs.get(name).has("live")));
const DOCKER = new Set(all.filter(name => needs.get(name).has("docker")));
const chosen = only.length ? all.filter(name => only.some(value => name.includes(value))) : all;
if (!chosen.length) { process.stderr.write(`没有匹配的验收脚本：${only.join(" ")}\n`); process.exit(1); }

// The suite opens and closes real application windows for ten minutes. On by
// default here so it can run while somebody is using the machine: each window
// comes up without taking focus and the app stays out of the Dock.
// IDOU_DESKTOP_BACKGROUND=0 puts the windows back in front, which is what
// you want when you are watching one smoke to see what it does.
const background = process.env.IDOU_DESKTOP_BACKGROUND !== "0";
const run = (name, args = [], { person = false, untilCard = false } = {}) => new Promise(resolve => {
  const ui = uiDirectory ? { IDOU_UI_INVARIANTS: uiMode, IDOU_UI_INVARIANTS_OUT: path.join(uiDirectory, `${name}.json`) } : { IDOU_UI_INVARIANTS: "0" };
  const child = spawn(process.execPath, [...(uiDirectory ? ["--import", uiHook] : []), path.join(here, name), ...args],
    // Without --live nothing may reach a paid model or the operator's own
    // deployment file, including the smokes that would quietly use it if it
    // were there (smoke-schedules-desktop.js reads the local deployment file, install-names.js localEnvFile).
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...(background && !person ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), ...(live ? {} : { IDOU_SMOKE_NO_LIVE: "1" }), ...(untilCard ? { IDOU_SMOKE_UNTIL_CARD: "1" } : {}), ...ui } });
  // The person needs the smoke's prompts as they come, not after it ends.
  if (person) { child.stdout.on("data", chunk => process.stdout.write(chunk)); child.stderr.on("data", chunk => process.stdout.write(chunk)); }
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  child.on("exit", code => resolve({ code: code ?? 1, output }));
});

// What each switched-off group is told, and what a switched-on group lacks.
// The key a --live smoke needs follows the provider the server would pick; the
// smoke itself validates the rest through the server's own loader.
const liveKeys = new Map([["minimax", ["MINIMAX_API_KEY", "MINIMAX_CONFIG_FILE"]], ["litellm", ["IDOU_LITELLM_API_KEY", "IDOU_LITELLM_KEY_FILE"]]])
  .get(process.env.IDOU_MODEL_PROVIDER || "minimax");
const liveSkip = !live ? "加 --live 运行：会调用服务端配置的对话模型（MiniMax 或 GLM，和平时跑任务是同一个付费模型）"
  : !liveKeys ? "开了 --live 但 IDOU_MODEL_PROVIDER 不对：只能是 minimax 或 litellm"
  : !liveKeys.some(name => process.env[name]?.trim()) ? `开了 --live 但没有 ${liveKeys.join(" / ")}：先 set -a; . <部署文件>; set +a` : null;
let dockerArgs = null, dockerSkip = "加 --docker=<docker 的绝对路径> 运行（端点取当前 Docker 上下文，镜像会先构建）";
if (dockerFlag && chosen.some(name => DOCKER.has(name))) {
  try {
    if (!path.isAbsolute(dockerFlag)) throw new Error("--docker 必须是绝对路径");
    const endpoint = (await execFileAsync(dockerFlag, ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], { timeout: 15_000 })).stdout.trim();
    if (!/^unix:\/\/\/[^\x00-\x20?#]+$/.test(endpoint)) throw new Error(`当前 Docker 上下文不是本机 unix 端点：${endpoint || "（空）"}`);
    const built = (await execFileAsync(process.execPath, [path.join(here, "build-app-runtime.js"), dockerFlag], { timeout: 600_000 })).stdout.trim().split("\n").pop();
    const { imageId } = JSON.parse(built);
    dockerArgs = [dockerFlag, endpoint, imageId]; dockerSkip = null;
    process.stdout.write(`Docker：${endpoint} · 运行时镜像 ${imageId.slice(0, 19)}…\n`);
  } catch (error) { dockerSkip = `Docker 准备失败：${String(error.message).split("\n")[0].slice(0, 160)}`; }
}
// A switched-off group is told what the smoke itself says it needs.
const skipReason = name => LIVE.has(name) ? (live ? liveSkip : liveSkip && `加 --live 运行：${needs.get(name).get("live")}`)
  : DOCKER.has(name) ? (dockerFlag ? dockerSkip : dockerSkip && `${dockerSkip}；它需要${needs.get(name).get("docker")}`) : null;
const argsFor = name => LIVE.has(name) ? ["--live"] : DOCKER.has(name) ? dockerArgs : [];

const passed = [], failed = [], manual = [], skipped = [], faults = [], atCard = [];
// What the UI rules found while a smoke ran. A smoke that launched the
// application but was never looked at is itself a finding: a sweep that did
// not run reads exactly like a clean one.
const uiFindings = async (name) => {
  if (!uiDirectory) return { rows: [], note: "" };
  let result;
  try { result = JSON.parse(await readFile(path.join(uiDirectory, `${name}.json`), "utf8")); }
  catch { return { rows: [], note: "" }; }
  const { stats, rows } = result;
  // Installed on the application's page and never looked: an Electron app that
  // is not i豆 (a template renderer, say) has nothing to install on.
  if (stats.installed && !stats.samples) return { rows: [{ kind: "巡检没有运行", where: name, detail: `装上 ${stats.installed} 次，检查 0 次` }], note: "" };
  const open = rows.filter(row => !acceptedFinding(row)), known = rows.length - open.length;
  return { rows: open, note: stats.launches ? `巡检 ${stats.samples} 次${open.length ? `，${open.length} 处问题` : ""}${known ? `，${known} 处已知` : ""}` : "" };
};
for (const name of chosen) {
  const manualIds = manualConfirmationIds(name);
  const reason = skipReason(name);
  if (reason) {
    if (manualIds) manual.push({ name, ids: manualIds });
    skipped.push(name); process.stdout.write(`跳过  ${name} —— ${reason.trim()}\n`); continue;
  }
  const person = Boolean(manualIds) && withPerson, untilCard = Boolean(manualIds) && !withPerson;
  if (person) process.stdout.write(`需要人  ${name} —— ${manualIds.join("、")}：窗口会出现在最前面，照提示亲手点卡片\n`);
  const started = Date.now();
  const { code, output } = await run(name, argsFor(name), { person, untilCard });
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  const ui = await uiFindings(name);
  for (const row of ui.rows) faults.push({ smoke: name, ...row });
  const blocked = uiMode === "enforce" && ui.rows.length > 0;
  // Stopped at its first card, as asked: not a pass -- the rest is the person's.
  const reached = untilCard && code !== 0 && output.includes(REACHED_CARD);
  if (reached && !blocked) {
    atCard.push(name); manual.push({ name, ids: manualIds });
    const where = output.split("\n").find(line => line.includes(REACHED_CARD))?.split(REACHED_CARD)[1]?.split("：")[0]?.trim() ?? "";
    process.stdout.write(`到卡片  ${name}  ${seconds}s${ui.note ? `  ${ui.note}` : ""}  停在「${where}」，确认之后的部分待人工（${manualIds.join("、")}）\n`);
    continue;
  }
  if (code === 0 && !blocked) { passed.push(name); process.stdout.write(`通过  ${name}  ${seconds}s${ui.note ? `  ${ui.note}` : ""}\n`); continue; }
  failed.push(name);
  if (code !== 0) process.stdout.write(`失败  ${name}  ${seconds}s${ui.note ? `  ${ui.note}` : ""}\n${output.split("\n").slice(-25).map(line => `      ${line}`).join("\n")}\n`);
  else process.stdout.write(`失败  ${name}  ${seconds}s  冒烟本身通过，但${ui.note}\n`);
}
if (faults.length) {
  process.stdout.write(`\n界面巡检发现的问题（${faults.length} 处${uiMode === "report" ? "，本次只列出、不判失败" : ""}）：\n`);
  const byKind = new Map();
  for (const row of faults) byKind.set(row.kind, [...(byKind.get(row.kind) ?? []), row]);
  for (const [kind, rows] of byKind) {
    process.stdout.write(`  ${kind}（${rows.length}）\n`);
    for (const row of rows) process.stdout.write(`    ${row.where}${row.detail ? ` — ${row.detail}` : ""}  〔${row.smoke}${row.phase ? ` · ${row.phase}` : ""}〕\n`);
  }
  if (uiDirectory) process.stdout.write(`  明细：${uiDirectory}\n`);
}

process.stdout.write(`\n通过 ${passed.length} · 失败 ${failed.length} · 到卡片为止 ${atCard.length} · 未运行 ${skipped.length}（共 ${chosen.length}）\n`);
if (atCard.length) process.stdout.write(`到卡片为止不是通过：卡片之前和卡片本身已自动检查，确认之后的部分要有人在场用 --with-person 跑\n`);
if (manual.length) process.stdout.write(`待人工不是通过：${manual.map(({ name, ids }) => `${name}(${ids.join("/")})`).join("、")}\n`);
if (skipped.length) process.stdout.write(`跳过的不是通过：${skipped.join("、")}\n`);
process.exit(failed.length ? 1 : 0);
