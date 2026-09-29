import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { syntheticResponseStream } from "./fixtures/model-response.js";
import { waitForHumanChoice, waitForHumanConfirm } from "./fixtures/agent-harness.js";
import { execFileSync } from "node:child_process";

// A coding task in the actual Electron app with the actual Codex, against a
// scripted model -- no paid call. The Agent keeps a plan, adds a file through
// apply_patch, runs a command and asks a question. What is checked is what the
// person sees: the coding instructions reaching the model, the plan beside the
// conversation, in the execution record the file change with its diff and the
// command with its output, and the question as a card they answer.
//
// The question pins what the pinned Codex does, measured: outside Plan mode it
// answers request_user_input itself unless features.default_mode_request_user_input
// is on, and with it on it forwards the question and waits. So the card must
// appear, nothing may reach the model before the person answers, and the answer
// must arrive as the tool's output. A Codex that stops forwarding fails here.
const directory = await mkdtemp(path.join(os.tmpdir(), "idou-coding-task-desktop-"));
const workspace = path.join(directory, "workspace"), evidence = path.resolve("docs/evidence");
const manualRewind = process.argv.includes("--manual-rewind");
await mkdir(workspace); await mkdir(evidence, { recursive: true });
const sessions = new SessionRegistry(), session = sessions.issue({ tenantId: "synthetic", userId: "synthetic", deviceId: "synthetic" });
const PATCH = "*** Begin Patch\n*** Add File: greet.js\n+export const greet = (name) => `你好，${name}`;\n*** End Patch\n";
// The second turn, once the folder is a repository: a change and a new file, to take back.
const PATCH_2 = "*** Begin Patch\n*** Update File: greet.js\n@@\n-export const greet = (name) => `你好，${name}`;\n+export const greet = (name) => `Hello, ${name}`;\n*** Add File: extra.js\n+export const extra = 1;\n*** End Patch\n";
let app, requests = 0, instructed = false, questionOutput = null, humanAnswer = "", reviewed = false, imageSent = false, commandSent = false;
// A small picture to paste, big enough to see in the screenshot.
const PNG = (await readFile(new URL("./fixtures/pasted-image.png", import.meta.url))).toString("base64");

const call = (name, args) => {
  const item = { type: "function_call", id: `fc_${requests}`, call_id: `call_${requests}`, name, arguments: JSON.stringify(args), status: "completed" };
  const events = [{ type: "response.created", response: { id: `resp_${requests}`, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "", status: "in_progress" } },
    { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: `resp_${requests}`, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
};
const server = createModelGateway({ apiKey: "synthetic-no-paid-key", sessions, fetchImpl: async (_url, options) => {
  const body = JSON.parse(options.body); requests += 1;
  // A project's own slash command arrives as its text, filled in.
  if (JSON.stringify(body.input ?? []).includes("给 greet 补一个测试。")) { commandSent = true; return syntheticResponseStream("COMMAND_DONE 测试补好了。"); }
  // Codex's review mode asks with its own guidelines and takes the findings as JSON.
  if (/^# Review guidelines/.test(body.instructions ?? "")) {
    reviewed = true;
    return syntheticResponseStream(JSON.stringify({ findings: [{ title: "[P1] greet 丢了名字", body: "名字没有用上。", confidence_score: 0.8, priority: 1,
      code_location: { absolute_file_path: path.join(workspace, "greet.js"), line_range: { start: 1, end: 1 } } }],
      overall_correctness: "patch is incorrect", overall_explanation: "改动把名字弄丢了。", overall_confidence_score: 0.7 }));
  }
  // The planning turn reads, plans and asks; it cannot write, so nothing here
  // tries to. The file change and the command belong to the turn after 开始做.
  if (requests === 1) {
    instructed = /apply_patch <<'EOF'/.test(body.instructions ?? "");
    return call("update_plan", { explanation: "先写函数，再确认存储方式", plan: [{ step: "读项目", status: "completed" }, { step: "加 greet 函数", status: "in_progress" }, { step: "确认数据库", status: "pending" }] });
  }
  if (!manualRewind && requests === 2) return call("request_user_input", { questions: [{ id: "db", header: "数据库", question: "用哪个数据库？", options: [{ label: "SQLite", description: "单文件" }, { label: "Postgres", description: "独立服务" }] }] });
  if (!manualRewind && requests === 3) {
    const output = body.input?.find((item) => item.call_id === "call_2" && /output/.test(item.type ?? ""))?.output;
    questionOutput = typeof output === "string" ? output : JSON.stringify(output ?? null);
    try { humanAnswer = JSON.parse(questionOutput)?.answers?.db?.answers?.[0] ?? ""; } catch { humanAnswer = ""; }
    return syntheticResponseStream(`CODING_SMOKE_DONE 方案：加 greet 函数，存储用 ${humanAnswer}。`, { totalTokens: 100_000 });
  }
  if (manualRewind && requests === 2) return syntheticResponseStream("CODING_SMOKE_DONE 方案：加 greet 函数。", { totalTokens: 100_000 });
  // 开始做 sends its own turn: this is it, and it is where the files change.
  const scenarioRequest = requests + (manualRewind ? 1 : 0);
  if (scenarioRequest === 4) return call("exec_command", { cmd: `apply_patch <<'EOF'\n${PATCH}EOF` });
  if (scenarioRequest === 5) return call("exec_command", { cmd: "printf 'SMOKE_OUTPUT_LINE\\n'" });
  if (scenarioRequest === 6) return syntheticResponseStream("BUILD_DONE 按方案加好了 greet.js。");
  if (scenarioRequest === 7) {
    imageSent = (body.input ?? []).some((item) => Array.isArray(item.content) && item.content.some((part) => part.type === "input_image" && part.image_url === `data:image/png;base64,${PNG}`));
    return call("exec_command", { cmd: `apply_patch <<'EOF'\n${PATCH_2}EOF` });
  }
  return syntheticResponseStream("SECOND_TURN_DONE 改成英文了，还加了 extra.js。");
} });
server.listen(0, "127.0.0.1"); await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`, sessionFile = path.join(directory, "session.json");
await writeFile(sessionFile, JSON.stringify({ token: session.token, expiresAt: session.expiresAt, serverUrl: origin }), { mode: 0o600 });

try {
  app = await electron.launch({ executablePath: electronBinary, args: ["."], env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), IDOU_DESKTOP_DATA_DIR: path.join(directory, "data"), IDOU_SESSION_FILE: sessionFile, IDOU_SERVER_URL: origin }, timeout: 30_000 });
  const page = await app.firstWindow(); page.setDefaultTimeout(60_000);
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.locator("#new-task").waitFor();
  await page.locator('[data-section="coding"]').click();
  await app.evaluate(({ dialog }, cwd) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [cwd] }); }, workspace);
  await page.locator("#pick-workspace").click();
  await page.locator("#project-path").filter({ hasText: workspace }).waitFor();
  const initialPrompt = manualRewind ? "加一个 greet 函数。" : "加一个 greet 函数，存储方式先问我。";
  await page.locator("#prompt").fill(initialPrompt); await page.locator("#send").click();

  // The question, as a card the person answers -- and nothing reaches the model until they do.
  if (!manualRewind) {
    await page.waitForFunction(() => document.querySelector("#approvals").textContent.includes("Agent 想先问你") || ["已完成", "执行失败"].includes(document.querySelector("#task-status").textContent));
    const card = await page.locator("#approvals").innerText();
    assert.match(card, /Agent 想先问你/, `no question card (status: ${await page.locator("#task-status").innerText()}, error: ${await page.locator("#error-banner").innerText()})`);
    assert.match(card, /用哪个数据库？/); assert.match(card, /SQLite/); assert.match(card, /Postgres/);
    assert.equal(requests, 2, "the model must not be asked anything more while the question is open");
    await page.screenshot({ path: path.join(evidence, "desktop-coding-question.png"), scale: "css" });
    await waitForHumanChoice(page.locator("#approvals .approval").first(), "回答");
  }

  await page.locator("#task-status").filter({ hasText: /^(已完成|执行失败)$/ }).waitFor();
  assert.equal(await page.locator("#task-status").innerText(), "已完成", await page.locator("#error-banner").innerText());
  assert.equal(instructed, true, "a coding task carries the coding instructions");
  assert.equal(requests, manualRewind ? 2 : 3);
  if (!manualRewind) assert.ok(humanAnswer.trim(), `the person's non-empty answer reaches the model as the tool's output: ${questionOutput}`);
  assert.equal(await page.locator("#approvals").innerText(), "", "the answered card is gone");
  if (!manualRewind) assert.ok((await page.locator("#messages").innerText()).includes(`存储用 ${humanAnswer}`), "the answer is reflected in the model's reply");


  // How much of the model's context is left, as Codex's footer says it: what
  // Codex reported for the turn's last response (100,000 tokens) against the
  // model's window, both less the 12,000 always there.
  const usage = (await page.evaluate(() => window.idou.snapshot())).tasks[0]?.contextUsage;
  assert.equal(usage?.tokens, 100_000, "Codex's figure for the last response reached the task");
  assert.ok(usage.window > 100_000, `with the model's window (${usage.window})`);
  const left = Math.round((usage.window - 100_000) / (usage.window - 12_000) * 100);
  await page.locator("#task-actions-note").filter({ hasText: `上下文剩余 ${left}%` }).waitFor({ timeout: 10_000 });

  // That first turn was the plan, the way Codex and Claude Code look before
  // they touch anything. Until now a request went straight to work and the
  // first thing the person saw was files changing. The turn ran read-only
  // whatever 权限 says, the label says so, and 开始做 is what ends it.
  assert.match(await page.locator("#permission-toggle").innerText(), /^执行时：/);
  assert.match(await page.locator("#task-actions-note").innerText(), /还没有动任何文件/);
  const begin = page.locator("#start-building");
  assert.equal(await begin.isVisible(), true, "方案给完了却没有「开始做」");
  await begin.click();
  // The previous turn's 已完成 is still on screen for a moment, so waiting for a
  // terminal status straight away matches the plan's, not the build's.
  await page.waitForFunction(() => !["已完成", "执行失败"].includes(document.querySelector("#task-status").textContent),
    null, { polling: 100 });
  await page.locator("#task-status").filter({ hasText: /^(已完成|执行失败)$/ }).waitFor();
  assert.equal(await begin.isVisible(), false, "开始做之后这个按钮还在");
  assert.match(await page.locator("#permission-toggle").innerText(), /^权限：/, "开始做之后权限该回到人选的那个");
  assert.match(await page.locator("#messages .message.user").last().innerText(), /按上面的方案开始做/);

  // The turn as it happened, the way Codex and Claude Code show one
  // (docs/coding-task-parity.md, C1-C3, C10): the plan, the new file with its
  // diff, the command as it was written and its output, then the answer, and
  // at the end how long it took and what it changed.
  const flow = page.locator("#messages .coding-turn").first();
  const plan = flow.locator(".coding-step.plan");
  assert.match(await plan.innerText(), /计划 · 已完成 1\/3/); assert.match(await plan.innerText(), /加 greet 函数/); assert.match(await plan.innerText(), /确认数据库/);
  // The change and the command are in the turn 开始做 sent, not in the plan:
  // a planning turn is read-only, so a file change in it would be the bug.
  assert.equal(await flow.locator(".coding-step.change").count(), 0, "方案那一轮不该有文件改动");
  const built = page.locator("#messages .coding-turn").nth(1);
  const change = built.locator(".coding-step.change").first();
  assert.match((await change.locator("summary").innerText()).replace(/\s+/g, " "), /新增 greet\.js \+1 −0/, "named from the project's root, with what it added");
  assert.equal(await change.getAttribute("open"), "", "a short diff is shown without being asked for");
  assert.match(await change.locator(".activity-diff").innerText(), /你好/);
  assert.match(await readFile(path.join(workspace, "greet.js"), "utf8"), /你好/);
  const command = built.locator(".coding-step.command").first();
  const commandLine = (await command.locator("summary").innerText()).replace(/\s+/g, " ");
  assert.match(commandLine, /运行 printf 'SMOKE_OUTPUT_LINE\\n' 成功/, `the command as the Agent wrote it: ${commandLine}`);
  assert.doesNotMatch(commandLine, /\/bin\/(z|ba)?sh/, "not the shell Codex wrapped it in");
  await command.locator("summary").click();
  assert.match(await command.locator(".activity-output").innerText(), /^SMOKE_OUTPUT_LINE/);
  // In the order it happened. The plan turn is the plan and its answer; the
  // build turn is the change, the command and its answer.
  const kinds = (turn) => turn.evaluate((node) => [...node.children].map((child) => child.classList.contains("plan") ? "plan"
    : child.classList.contains("change") ? "change" : child.classList.contains("command") ? "command"
      : child.classList.contains("coding-text") ? "text" : child.classList.contains("coding-turn-summary") ? "summary" : null).filter(Boolean));
  const planned = await kinds(flow), made = await kinds(built);
  assert.deepEqual(planned.filter((kind, index) => kind !== planned[index - 1]), ["plan", "text", "summary"], JSON.stringify(planned));
  assert.deepEqual(made.filter((kind, index) => kind !== made[index - 1]), ["change", "command", "text", "summary"], JSON.stringify(made));
  const summaryText = (turn) => turn.locator(".coding-turn-summary").evaluate((node) => node.firstChild?.textContent ?? "");
  assert.match(await summaryText(flow), /^完成 · 用时 .+$/, "方案那一轮什么都没改");
  assert.match(await summaryText(built), /^完成 · 用时 .+ · 改动 1 个文件 \+1 −0$/);
  assert.equal(await page.locator("#activity-panel").isVisible(), false, "no separate record under the conversation");
  await page.screenshot({ path: path.join(evidence, "desktop-coding-task.png"), scale: "css" });

  // / opens a coding task's commands, @ names a file of its project (C5, C6).
  const prompt = page.locator("#prompt");
  await prompt.fill("/");
  await page.locator("#mention-menu .mention-option", { hasText: "/undo" }).waitFor();
  assert.match(await page.locator("#mention-menu").innerText(), /\/diff[\s\S]*\/review[\s\S]*\/init/);
  await prompt.press("Escape");
  await prompt.fill("看一下 @gre");
  await page.locator("#mention-menu .mention-option", { hasText: "greet.js" }).waitFor();
  await prompt.press("Enter");
  assert.equal(await prompt.inputValue(), "看一下 @greet.js ", "the file is named in the message");
  await prompt.fill("");

  // ↑ in the empty box brings back what was sent and ↓ goes back to empty, as
  // in Codex and Claude Code; a draft of one's own is left alone.
  await prompt.press("ArrowUp");
  assert.equal(await prompt.inputValue(), initialPrompt, "↑ brings back what was sent");
  await prompt.press("ArrowDown");
  assert.equal(await prompt.inputValue(), "", "↓ past the newest is the empty box again");
  await prompt.fill("我自己的草稿"); await prompt.press("ArrowUp");
  assert.equal(await prompt.inputValue(), "我自己的草稿", "a draft is never replaced");
  await prompt.fill("");

  // A second turn, now that the folder is a repository: the changes are shown
  // for the working tree (C8), and taking the turn back puts the files back (C9).
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "smoke", GIT_AUTHOR_EMAIL: "smoke@example.com", GIT_COMMITTER_NAME: "smoke", GIT_COMMITTER_EMAIL: "smoke@example.com" };
  // A command of the project's own, committed with it (Claude Code's .claude/commands).
  await mkdir(path.join(workspace, ".claude", "commands"), { recursive: true });
  await writeFile(path.join(workspace, ".claude", "commands", "add-test.md"), "---\ndescription: 给函数补测试\nargument-hint: <函数名>\n---\n给 $ARGUMENTS 补一个测试。\n");
  for (const args of [["init", "-q"], ["add", "."], ["commit", "-qm", "before the second turn"]]) execFileSync("git", args, { cwd: workspace, env: gitEnv, stdio: "ignore" });
  // An image pasted into the box goes with the message, as in Codex and Claude Code.
  await prompt.focus();
  await page.evaluate((base64) => {
    const data = new DataTransfer(); data.items.add(new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], "shot.png", { type: "image/png" }));
    document.querySelector("#prompt").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, PNG);
  await page.locator("#image-row img").waitFor();
  await prompt.fill("把问候改成英文。"); await page.locator("#send").click();
  await page.locator("#messages").filter({ hasText: "SECOND_TURN_DONE" }).waitFor();
  assert.equal(imageSent, true, "Codex sent the pasted image to the model, with the message");
  assert.equal(await page.locator("#image-row").isHidden(), true, "and it is no longer waiting in the box");
  // The newest user message, not a fixed index: 开始做 sends one of its own.
  await page.waitForFunction(() => [...document.querySelectorAll("#messages .message.user")].at(-1)
    ?.querySelector(".message-images img")?.src.startsWith("data:image/png"), null, { polling: 200 });
  // Let the turn finish before touching the list. Reaching the terminal status
  // repaints #messages, and a node resolved a moment earlier is detached out
  // from under the scroll -- which is what this step used to fail on. Waiting
  // first also means the screenshot is of the finished turn, not a passing one.
  await page.locator("#task-status").filter({ hasText: /^(已完成|执行失败)$/ }).waitFor();
  await page.locator("#messages .message.user").last().scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(evidence, "desktop-coding-image.png"), scale: "css" });
  // The newest turn: there are three now -- the plan, the build 开始做 sent,
  // and this one.
  const second = page.locator("#messages .coding-turn").last();
  const secondText = (await second.innerText()).replace(/\s+/g, " ");
  assert.match(secondText, /修改 greet\.js \+1 −1/); assert.match(secondText, /新增 extra\.js \+1 −0/);
  assert.match(secondText, /SECOND_TURN_DONE/, "the second turn's own answer, in the second turn");
  assert.match(await page.locator("#messages .coding-turn").first().innerText(), /CODING_SMOKE_DONE/, "and the first turn's answer where it was");
  assert.equal(await readFile(path.join(workspace, "extra.js"), "utf8"), "export const extra = 1;\n");
  await page.locator("#review-changes").click();
  const changes = page.locator("#changes-panel");
  await changes.waitFor();
  await page.locator("#changes-content .diff-dialog-note", { hasText: "2 个文件" }).waitFor();
  const listed = (await page.locator("#changes-content").innerText()).replace(/\s+/g, " ");
  assert.match(listed, /2 个文件 · \+2 −1/, listed);
  assert.match(listed, /修改 greet\.js \+1 −1/); assert.match(listed, /新增 extra\.js \+1 −0 未跟踪/);
  await changes.screenshot({ path: path.join(evidence, "desktop-coding-diff.png"), scale: "css" });
  await page.locator("#collapse-panel").click();
  await changes.waitFor({ state: "hidden" });

  await prompt.fill("/undo"); await prompt.press("Escape"); await prompt.press("Enter");
  const undoCard = await waitForHumanConfirm(page, "撤回并恢复文件");
  assert.match(undoCard, /恢复 greet\.js/); assert.match(undoCard, /删除 extra\.js/); assert.match(undoCard, /手动改过/);
  assert.match(undoCard, /只撤回对话/, "the conversation alone can go too, as in Claude Code's rewind");
  // Two left: the plan, and the build 开始做 sent. Undo takes back one turn.
  await page.waitForFunction(() => document.querySelectorAll("#messages .coding-turn").length === 2, null, { polling: 200 });
  assert.match(await readFile(path.join(workspace, "greet.js"), "utf8"), /你好/, "the file is back as it was before the turn");
  await assert.rejects(readFile(path.join(workspace, "extra.js"), "utf8"), { code: "ENOENT" }, "and the file the turn made is gone");
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: workspace }).toString(), "", "the working tree is the committed one again");
  assert.equal(await prompt.inputValue(), "把问候改成英文。", "what was asked there is back in the box, to be changed and sent again");
  await prompt.fill("");

  // /status says where the task works, under what, and how much it carries.
  await prompt.fill("/status"); await prompt.press("Escape"); await prompt.press("Enter");
  const statusDialog = page.locator("dialog.status-dialog");
  await statusDialog.waitFor();
  const said = (await statusDialog.innerText()).replace(/\s+/g, " ");
  assert.match(said, new RegExp(`项目目录 ${workspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)); assert.match(said, /权限 标准/); assert.match(said, /对话 2 轮/);
  assert.match(said, /上下文 还没有数据/, "taken back, the conversation is shorter: nothing is claimed until the next response");
  await statusDialog.getByRole("button", { name: "关闭" }).click();

  // /review is Codex's review mode: typed whole it offers what to look at, and
  // the pick runs as a turn of its own through review/start. It runs from the
  // form's own submit, where a second submit is ignored unless deferred.
  await prompt.fill("/review"); await prompt.press("Escape"); await prompt.press("Enter");
  await page.locator("#mention-menu .mention-option", { hasText: "未提交的改动" }).click();
  await page.waitForFunction(() => document.querySelectorAll("#messages .coding-turn").length === 3, null, { polling: 200, timeout: 60_000 });
  await page.locator("#task-status").filter({ hasText: /^(已完成|执行失败)$/ }).waitFor();
  assert.equal(await page.locator("#task-status").innerText(), "已完成", await page.locator("#error-banner").innerText());
  assert.match(await page.locator("#messages .message.user").last().innerText(), /审查：未提交的改动/);
  assert.equal(reviewed, true, "the model was asked with Codex's review guidelines");
  assert.match(await page.locator("#messages .coding-turn").last().innerText(), /\[P1\] greet 丢了名字/, "Codex's prioritised finding, as the turn's answer");
  // Taking the review back on its own: Codex keeps a review's turn under the id
  // it starts with, and forking before any other is refused (measured).
  await prompt.fill("/undo"); await prompt.press("Escape"); await prompt.press("Enter");
  assert.match(await waitForHumanConfirm(page, "撤回"), /撤回最近 1 轮/);
  await page.waitForFunction(() => document.querySelectorAll("#messages .coding-turn").length === 2, null, { polling: 200, timeout: 60_000 });
  assert.equal(await prompt.inputValue(), "审查：未提交的改动", "what was asked comes back to the box");
  await prompt.fill("");

  // The project's own slash command, as Claude Code and Codex offer them: / lists
  // it beside the product's, and its text goes with what followed it.
  await prompt.fill("/add");
  await page.locator("#mention-menu .mention-option", { hasText: "add-test" }).waitFor();
  assert.match(await page.locator("#mention-menu").innerText(), /给函数补测试/);
  await prompt.press("Escape");
  await prompt.fill("/add-test greet"); await prompt.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll("#messages .coding-turn").length === 3, null, { polling: 200, timeout: 60_000 });
  await page.locator("#task-status").filter({ hasText: /^(已完成|执行失败)$/ }).waitFor();
  assert.equal(commandSent, true, "the command's text, filled in, reached the model");
  const commanded = await page.locator("#messages .message.user").last().innerText();
  assert.match(commanded, /项目命令：\/add-test · \.claude\/commands\/add-test\.md/); assert.match(commanded, /给 greet 补一个测试。/);

  // Back to before the first turn from its own message (回到这里), as Claude
  // Code's rewind and Codex's backtrack: the turns after it go with it, and
  // what was asked there comes back to the box. That turn ran before the
  // folder was a repository, so its snapshot was kept in the application's own
  // data, and going back also takes away what it made.
  await page.locator("#messages .message.user").first().getByRole("button", { name: "回到这里" }).click();
  const rewindCard = await waitForHumanConfirm(page, "撤回并恢复文件");
  // Three now: the plan, the build 开始做 sent, and the project command.
  assert.match(rewindCard, /撤回最近 3 轮/, rewindCard); assert.match(rewindCard, /删除 greet\.js/, rewindCard);
  await page.waitForFunction(() => document.querySelectorAll("#messages .coding-turn").length === 0, null, { polling: 200, timeout: 60_000 });
  await assert.rejects(readFile(path.join(workspace, "greet.js"), "utf8"), { code: "ENOENT" }, "the file the first turn made is gone");
  assert.equal(await prompt.inputValue(), initialPrompt);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, actualElectron: true, actualCodex: true, codingInstructions: instructed, planShown: true, patchAppliedWithDiff: true, commandOutputShown: true, questionAnsweredInCard: manualRewind ? "not part of the isolated M02 path" : `${humanAnswer} reached the model`, slashCommands: true, fileMention: true, workingTreeDiff: true, undoRestoredFiles: true, modelRequests: requests, paidCalls: 0 }));
} catch (error) {
  if (app) { const page = await app.firstWindow(); console.error(JSON.stringify({ reason: String(error?.message ?? error).split("\n")[0], requests, questionOutput, status: await page.locator("#task-status").innerText().catch(() => "unavailable"), error: await page.locator("#error-banner").innerText().catch(() => "unavailable"), approvals: await page.locator("#approvals").innerText().catch(() => "unavailable") })); }
  throw error;
} finally {
  await app?.close(); sessions.revoke(session.token); server.close(); server.closeAllConnections();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
