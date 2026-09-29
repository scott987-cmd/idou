import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
// An Agent reply is read by a person, so its Markdown is rendered: the table is
// a table, the heading a heading, the command a code block. What the reply
// cannot do is just as much the point: run the script it quotes, fetch the
// image it names, or navigate this window when its link is clicked.
const directory = await mkdtemp(path.join(os.tmpdir(), "idou-reply-markdown-")), evidence = path.resolve("docs/evidence/task-ui");
await mkdir(evidence, { recursive: true }); let app;
try {
  app = await electron.launch({ executablePath: electronBinary, args: [path.resolve("scripts/fixtures/reply-markdown-desktop-entry.js")], env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), IDOU_DESKTOP_DATA_DIR: directory } });
  const page = await app.firstWindow(), errors = []; page.setDefaultTimeout(20_000); page.on("pageerror", error => errors.push(error.message));
  await page.locator("#new-task").waitFor();
  await page.locator("#open-files").click(); await page.locator("#task-tabs").waitFor(); await page.locator("#collapse-panel").click();
  await page.locator("#knowledge-scope-field").waitFor();
  const entry = page.url();
  // 菜单先拿走 ↑↓/Enter；选择项的 Enter 不能变成发送。
  await page.locator("#knowledge-scope-toggle").click();
  await page.locator("#knowledge-scope-menu").waitFor();
  await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
  await page.locator("#knowledge-scope-toggle").filter({ hasText: "知识：全部" }).waitFor();
  assert.equal((await page.evaluate(() => window.idou.snapshot())).tasks[0].messages.length, 0, "菜单 Enter 只能选择菜单项");
  // 中文候选 Enter 只提交输入法；Shift+Enter 只换行。
  await page.locator("#prompt").fill("中文候选");
  await page.locator("#prompt").evaluate((node) => {
    node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "中文" }));
    node.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", keyCode: 229, isComposing: true }));
    node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中文候选" }));
  });
  assert.equal((await page.evaluate(() => window.idou.snapshot())).tasks[0].messages.length, 0, "输入法候选 Enter 不得发送");
  await page.waitForTimeout(60); await page.locator("#prompt").press("Shift+Enter");
  assert.match(await page.locator("#prompt").inputValue(), /\n$/); assert.equal((await page.evaluate(() => window.idou.snapshot())).tasks[0].messages.length, 0);
  // 打开「全部知识库」，这一问才会带上本机资料——来源卡片说的就是这批资料。
  await page.locator("#prompt").fill("用 **表格** 总结今天的日程和任务");
  await page.evaluate(() => { document.querySelector("#composer").requestSubmit(); document.querySelector("#composer").requestSubmit(); });
  await page.locator("#send").filter({ hasText: "停止" }).waitFor();
  assert.equal((await app.evaluate(() => globalThis.replyMarkdownFixture.turns)).length, 1, "双重提交最多派发一次");
  await page.waitForFunction(async () => await window.idou.snapshot().then((value) => value.tasks.some((task) => task.status === "running")));
  // 插话在调用时失去本轮，不得自动变成新一轮；草稿原样保留。
  await app.evaluate(() => { globalThis.replyMarkdownFixture.rejectSteer = true; });
  await page.locator("#prompt").fill("竞态补充仍要保留"); await page.locator("#send").click();
  await page.locator("#error-banner").filter({ hasText: "本轮刚刚结束" }).waitFor();
  assert.equal(await page.locator("#prompt").inputValue(), "竞态补充仍要保留");
  assert.equal((await app.evaluate(() => globalThis.replyMarkdownFixture.turns)).length, 1, "插话失败不能静默启动下一轮");
  await page.screenshot({ path: path.join(evidence, "u06-composer-race.png"), scale: "css" });
  await page.locator("#prompt").fill("补充：只看仍然有效的制度");
  await page.locator("#send").click();
  await page.waitForFunction(() => document.querySelectorAll(".message.user").length === 2);
  assert.equal(await page.locator(".message.user .steer-reference").innerText(), "运行中补充");
  assert.deepEqual(await app.evaluate(() => globalThis.replyMarkdownFixture.steers), ["补充：只看仍然有效的制度"]);
  await app.evaluate(() => globalThis.replyMarkdownFixture.release());
  await page.locator("#task-status").filter({ hasText: "已完成" }).waitFor();
  const reply = page.locator(".message.assistant .message-text.markdown");
  await reply.waitFor();
  // What the person typed stays exactly as typed.
  assert.equal(await page.locator(".message.user .message-text").first().innerText(), "用 **表格** 总结今天的日程和任务");
  // The Agent's search of the knowledge copy asked to run outside its sandbox:
  // it was let through at once, with no card, and its step says why.
  assert.deepEqual(await app.evaluate(() => globalThis.replyMarkdownFixture.answers), [{ id: 9001, result: { decision: "accept" } }]);
  assert.equal((await page.evaluate(async () => (await window.idou.snapshot()).approvals)).length, 0);
  assert.equal(await page.locator("#activity-panel").isHidden(), true, "new work steps no longer duplicate into a task-wide execution log");
  const firstTurn = page.locator(".work-turn:not(.work-turn-legacy)").first();
  const read = firstTurn.locator(".work-step", { hasText: "检索知识库" });
  assert.match(await read.locator("summary").innerText(), /^检索知识库\s+住宿费上限\s+已完成\s+只读检索，自动允许$/);
  assert.equal((await read.locator("summary").innerText()).includes("/bin/zsh"), false, "the default row is business language, not a shell command");
  await read.locator("summary").click();
  assert.match(await read.locator(".work-technical code").innerText(), /kb-search --query "住宿费上限"/, "the exact command remains available under technical details");
  await read.locator("summary").click();
  assert.match(await firstTurn.locator(".work-plan strong").innerText(), /^计划 · 已完成 1\/2$/);
  assert.equal((await firstTurn.locator(".work-plan").innerText()).includes("undefined"), false);
  const failedRead = firstTurn.locator(".work-step.bad", { hasText: "cat unavailable-policy.md" });
  assert.match(await failedRead.locator("summary").innerText(), /^处理任务\s+失败$/);
  assert.equal(await failedRead.evaluate((node) => node.open), true, "failed work remains open by default");
  assert.equal(await failedRead.locator("pre").innerText(), "permission denied");
  assert.match(await firstTurn.locator(".work-turn-summary").innerText(), /完成 · 用时 .* · 生成或更新 1 个文件/);
  assert.match(await page.locator("#task-actions-note").innerText(), /上下文剩余 50%/);
  assert.deepEqual(await reply.locator("h3").allInnerTexts(), ["1) 今天（2026-09-11）的日程", "一句话总览"]);
  assert.deepEqual(await reply.locator("table th").allInnerTexts(), ["问题", "结论"]);
  assert.equal(await reply.locator("table tbody tr").count(), 3);
  assert.equal(await reply.locator("table tbody tr").nth(1).locator("td").nth(1).innerText(), "不忙，全空可约");
  assert.match(await reply.locator("pre.md-code code").innerText(), /^lark-cli calendar \+agenda/);
  assert.equal(await reply.locator("strong").first().innerText(), "命令：");
  assert.deepEqual(await reply.locator(".md-task").allInnerTexts(), ["☐", "☑"]);
  // Nothing the reply quotes becomes live.
  assert.equal(await page.locator("#messages script, #messages img, #messages iframe").count(), 0);
  assert.equal(await page.evaluate(() => typeof window.__replyPwned), "undefined");
  assert.match(await reply.locator("blockquote").innerText(), /<script>window\.__replyPwned = 1<\/script>/);
  assert.match(await reply.locator(".md-image").innerText(), /\[图片\] 季度图表/);
  // A wide table scrolls inside its own box; the page never scrolls sideways.
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  // 回答下面是这次带上的资料：引用过的排在前面并标出来，没被引用的照样列出来，
  // 每一张都能点开原文自己核对。
  const chips = page.locator(".answer-sources .answer-source");
  await chips.first().waitFor();
  assert.equal(await chips.count(), 2);
  assert.match(await page.locator(".answer-sources-label").innerText(), /已引用 1 篇/);
  assert.match(await page.locator(".answer-sources-label").innerText(), /另有 1 篇这次没能重新核验/, "没参与回答的资料要说出来，不能默默消失");
  assert.equal(await page.locator(".answer-source-mark").count(), 1, "只有被引用的那一张标「已引用」");
  assert.match(await chips.nth(0).innerText(), /员工手册（2026 版）/);
  assert.equal(await chips.nth(0).evaluate((node) => node.classList.contains("answer-source-cited")), true);
  assert.match(await chips.nth(1).innerText(), /住宿费管理细则（2024 版）/);
  assert.match(await chips.nth(1).innerText(), /已被替代/, "旧版本要当场说明它已经被替代");
  assert.equal(await chips.nth(1).evaluate((node) => node.classList.contains("answer-source-cited")), false);
  await page.screenshot({ path: path.join(evidence, "u09-cowork-timeline.png"), scale: "css" });
  // 点一张卡片＝在这个任务里打开那篇原文。
  await chips.nth(0).click();
  await page.waitForFunction(() => globalThis.__chipOpened || document.querySelector("#file-title"));
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(await app.evaluate(() => globalThis.replyMarkdownFixture.documents), ["https://test.feishu.cn/docx/DocCurrent"],
    "点来源卡片就是去读那一篇原文，不是打开外部浏览器");
  assert.deepEqual(await app.evaluate(() => globalThis.replyMarkdownFixture.opened.filter((url) => url.includes("DocCurrent"))), []);
  // A click hands the https address to the system browser and nothing else.
  await reply.getByRole("link", { name: "本周周报" }).click();
  await page.waitForFunction(() => true);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(await app.evaluate(() => globalThis.replyMarkdownFixture.opened), ["https://example.feishu.cn/docx/SyntheticDoc123"]);
  await reply.getByRole("link", { name: "本周周报" }).click({ button: "middle" });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(await app.evaluate(() => globalThis.replyMarkdownFixture.opened.length), 1, "a middle click opens nothing");
  assert.equal(page.url(), entry, "the window never navigates");
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  // The main process refuses anything but https, whatever the renderer sends.
  for (const bad of ["http://example.com", "file:///etc/passwd", "javascript:alert(1)", "https://user:pw@example.com"]) {
    const outcome = await page.evaluate(url => window.idou.openExternalLink(url).then(() => "opened", () => "refused"), bad);
    assert.equal(outcome, "refused", bad);
  }
  assert.equal(await app.evaluate(() => globalThis.replyMarkdownFixture.opened.length), 1);
  // 模型把来源链接抄错了一位（DocCurrenr）：点它，打开的是这一问真正引用的那篇，
  // 旁边写着「已更正」；回答的文字本身不改。
  const fixed = reply.getByRole("link", { name: "员工手册全文" });
  assert.equal(await fixed.getAttribute("data-external-link"), "https://test.feishu.cn/docx/DocCurrent");
  assert.match(await reply.locator(".md-link-corrected").first().innerText(), /已更正/);
  await fixed.click();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.ok((await app.evaluate(() => globalThis.replyMarkdownFixture.opened)).includes("https://test.feishu.cn/docx/DocCurrent"), "点抄错的链接要打开正确的来源");
  assert.equal((await app.evaluate(() => globalThis.replyMarkdownFixture.opened)).some((url) => url.includes("DocCurrenr")), false, "抄错的地址不能被打开");
  // 工作任务的逐轮回退只撤回对话。先打开卡片再取消，记录、文件和飞书侧
  // 计数都必须保持原样；自动化从不点击肯定按钮。
  const beforeBack = await page.evaluate(async () => { const snapshot = await window.idou.snapshot(), task = snapshot.tasks.find((row) => row.id === document.body.dataset.taskId) ?? snapshot.tasks[0]; return { id: task.id, messages: task.messages.length, activity: task.activity.length, files: await window.idou.taskFiles(task.id) }; });
  await page.locator(".message.user .rewind-here").first().click();
  await page.locator(".confirm-card strong", { hasText: "确认撤回" }).waitFor();
  assert.match(await page.locator(".confirm-card pre").innerText(), /工作任务只撤回对话；本地成果、飞书修改、已发送消息和已经发生的媒体生成都不会撤销/);
  await page.screenshot({ path: path.join(evidence, "u09-work-rewind.png"), scale: "css" });
  await page.locator(".confirm-card .confirm-actions button").first().click();
  await page.locator(".confirm-card").waitFor({ state: "detached" });
  const afterBack = await page.evaluate(async (id) => { const task = (await window.idou.snapshot()).tasks.find((row) => row.id === id); return { messages: task.messages.length, activity: task.activity.length, files: await window.idou.taskFiles(id) }; }, beforeBack.id);
  assert.deepEqual(afterBack, { messages: beforeBack.messages, activity: beforeBack.activity, files: beforeBack.files }, "canceling rewind changes neither conversation nor results");
  // A second turn gets its own search, file step, answer sources and footer.
  await page.locator("#prompt").fill("再生成一份差旅总结"); await page.locator("#send").click();
  await page.locator("#send").filter({ hasText: "停止" }).waitFor(); await app.evaluate(() => globalThis.replyMarkdownFixture.release());
  await page.locator("#task-status").filter({ hasText: "已完成" }).waitFor();
  const workTurns = page.locator(".work-turn:not(.work-turn-legacy)");
  assert.equal(await workTurns.count(), 2);
  for (let index = 0; index < 2; index++) {
    assert.equal(await workTurns.nth(index).locator(".work-step", { hasText: "检索知识库" }).count(), 1);
    assert.equal(await workTurns.nth(index).locator(".work-step", { hasText: "生成文件" }).count(), 1);
    assert.match(await workTurns.nth(index).locator(".work-turn-summary").innerText(), /完成 · 用时 .* · 生成或更新 1 个文件/);
  }
  assert.equal(await page.locator(".answer-sources").count(), 2, "each answer keeps the sources of its own question");
  await workTurns.nth(1).locator(".work-result-open").click();
  await page.locator("#file-title").filter({ hasText: "第2轮差旅总结.md" }).waitFor();
  assert.match(await page.locator("#file-title").innerText(), /第2轮差旅总结\.md$/);
  await page.screenshot({ path: path.join(evidence, "u09-cowork-timeline.png"), scale: "css" });
  // 同一位置、同一个上游 itemId 出现在另一个任务时，不能继承前一任务
  // 的展开状态；切回去时，前一任务自己的状态仍然保留。
  const firstTaskTitle = await page.locator("#task-title").innerText();
  const expandedRead = page.locator(".work-turn:not(.work-turn-legacy)").first().locator(".work-step", { hasText: "检索知识库" });
  if (!await expandedRead.evaluate((node) => node.open)) await expandedRead.locator("summary").click();
  await page.locator("#new-task").click();
  await page.locator("#prompt").fill("第二个任务检查折叠归属");
  await page.locator("#send").click();
  await page.locator("#send").filter({ hasText: "停止" }).waitFor();
  await app.evaluate(() => globalThis.replyMarkdownFixture.release());
  await page.locator("#task-status").filter({ hasText: "已完成" }).waitFor();
  const secondRead = page.locator(".work-turn:not(.work-turn-legacy) .work-step", { hasText: "检索知识库" }).first();
  assert.equal(await secondRead.evaluate((node) => node.open), false, "task B must not inherit task A's open item");
  await secondRead.locator("summary").click();
  await page.locator("#recent-tasks .recent-row", { hasText: firstTaskTitle }).locator("button").first().click();
  const restoredRead = page.locator(".work-turn:not(.work-turn-legacy)").first().locator(".work-step", { hasText: "检索知识库" });
  assert.equal(await restoredRead.evaluate((node) => node.open), true, "task A keeps its own open item when revisited");
  // 运行中只有一个按钮在「发送」的位置：没写内容时是「停止」，写了内容就是「补充」，
  // 旁边没有另一个停止键可以误点（2026-09-23 录制时的误点）。
  await page.locator("#new-task").click(); await page.locator("#prompt").fill("停止交互测试"); await page.locator("#send").click();
  await page.locator("#send").filter({ hasText: "停止" }).waitFor();
  const stops = () => app.evaluate(() => globalThis.replyMarkdownFixture.stopRequests);
  const beforeStops = await stops();
  await page.locator("#composer").screenshot({ path: path.join(evidence, "u13-running-nothing-typed.png") });
  await page.locator("#prompt").fill("补一句");
  await page.locator("#send").filter({ hasText: "补充" }).waitFor();
  assert.equal(await page.locator("#composer").getByRole("button", { name: "停止" }).count(), 0, "写了内容时发送旁边没有停止键");
  await page.locator("#composer").screenshot({ path: path.join(evidence, "u13-running-something-typed.png") });
  await page.locator("#prompt").fill("");
  await page.locator("#send").filter({ hasText: "停止" }).waitFor();
  // 空输入框里按回车不是停止。
  await page.locator("#prompt").press("Enter");
  assert.equal(await stops(), beforeStops, "回车不能停止任务");
  // 菜单先吃掉第一下 Escape；再按一下只提示，第二下才停止，停止也只请求一次。
  await page.locator("#prompt").fill("@"); await page.locator("#mention-menu").waitFor(); await page.locator("#prompt").press("Escape");
  assert.equal(await page.locator("#mention-menu").isHidden(), true); assert.equal(await stops(), beforeStops);
  await page.locator("#prompt").press("Escape");
  await page.locator("#stop-hint").waitFor();
  assert.equal(await stops(), beforeStops, "按一下 Esc 只是提示");
  await page.locator("#prompt").press("Escape"); await page.locator("#prompt").press("Escape");
  await page.locator("#task-status").filter({ hasText: "已停止" }).waitFor();
  assert.equal(await stops(), beforeStops + 1, "第二下才停止，停止期间再按也不重复请求");
  assert.deepEqual(errors, []);
  console.log("reply markdown desktop smoke passed");
} finally { await app?.close().catch(() => {}); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
