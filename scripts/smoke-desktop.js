import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { SaasFeishuCliProvider } from "../src/providers/feishu/saas-cli-provider.js";
import { isProductSkill } from "../src/application/skill-policy.js";
import { builtinAlias } from "../src/desktop/renderer/skill-center.js";

const live = process.argv.includes("--live");
let shownSkills = 0;
if (live && !process.env.IDOU_SESSION_FILE) throw new Error("Live desktop test requires a server-issued IDOU_SESSION_FILE, never a provider key");
const directory = await mkdtemp(path.join(os.tmpdir(), "idou-desktop-test-"));
const workspace = path.join(directory, "workspace"), dataRoot = path.join(directory, "app-data");
const evidence = path.resolve("docs/evidence");
await mkdir(workspace); await mkdir(evidence, { recursive: true });
if (!live) await writeFile(path.join(workspace, "index.html"), '<!doctype html><meta charset="utf-8"><h1>本地应用验收</h1><button id="counter">0</button><script>counter.onclick=()=>counter.textContent=Number(counter.textContent)+1</script>');
const env = { ...clientEnvironment(), IDOU_DESKTOP_DATA_DIR: dataRoot,
  ...(live ? { IDOU_SESSION_FILE: process.env.IDOU_SESSION_FILE } : {}) };
let app;
const launch = async () => {
  const instance = await electron.launch({ executablePath: electronBinary, args: [process.cwd()], env, timeout: 30_000 });
  const page = await instance.firstWindow(); page.setDefaultTimeout(20_000);
  await page.locator("#new-task").waitFor();
  return { instance, page };
};
// The page answers a click once its handler has run, and many handlers wait on
// the main process before drawing. A check read once, straight after the click,
// reads whatever was on screen before: under a full acceptance run's load that
// was the old screen twice (the permission of the task just left, an archived
// row still listed), while alone the same smoke passed every time. So a check
// that follows a click polls for the state it expects, and fails with its own
// message if that state never comes.
const eventually = async (read, check, timeout = 10_000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    try { check(value); return value; } catch (error) { if (Date.now() >= deadline) throw error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
const setTheme = async (page, wanted) => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await page.evaluate((theme) => document.documentElement.dataset.theme === theme, wanted)) return;
    await page.locator("#theme-toggle").click();
  }
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), wanted);
};
try {
  let started = await launch(); app = started.instance; let page = started.page;
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  assert.equal(await page.evaluate(() => typeof require), "undefined");
  // 工作任务、编程任务、文档网站、定时任务、技能中心、企业知识库、飞书消息、飞书文档.
  assert.equal(await page.locator('nav[aria-label="主导航"] button').count(), 8);
  // Permission belongs to the draft and files can create their task on demand,
  // so both remain available before the first message. Enterprise knowledge is
  // task-scoped and appears only after that work task exists.
  //
  // #open-media is deliberately NOT in this list any more. Generating an image or
  // a video is asked for in the conversation now, not from a button that opens a
  // panel of its own; the agent operations behind it are covered by
  // smoke-media-desktop.js. This assertion outlived the button by a while because
  // nothing ran this file — see scripts/run-desktop-acceptance.js.
  assert.equal(await page.locator("#permission-field").isVisible(), true, "#permission-field 应当在建任务之前就可用");
  assert.equal(await page.locator("#open-files").isVisible(), true, "任务文件入口应能按需创建任务");
  assert.equal(await page.locator("#knowledge-scope-field").isVisible(), false, "知识范围只能属于已经创建的工作任务");
  // 这两个菜单是向上绝对定位弹出的，父行上任何非 visible 的溢出都会把它们裁成
  // 一条细缝——看着还在，其实点不动。所以量它真实的高度，而不是只看可见性。
  for (const [toggle, menu] of [["#permission-toggle", "#permission-menu"]]) {
    await page.locator(toggle).click();
    await page.locator(menu).waitFor();
    const box = await page.locator(menu).boundingBox();
    assert.ok(box && box.height > 60, `${menu} 展开后高度只有 ${box?.height ?? 0}px，说明被父容器裁掉了`);
    assert.ok(box.y + box.height <= (await page.evaluate(() => innerHeight)), `${menu} 超出了窗口`);
    // 每一项对辅助功能只叫它的短名字，说明是它的描述。名字和说明连成一长串时，
    // 走辅助功能接口的自动化不用这个标题，退回去按坐标命中，落在了没有动作的
    // 文字上——「权限用辅助功能点不中」（2026-09-24 实测）。
    assert.equal(await page.getByRole("menuitemradio", { name: "标准", exact: true }).count(), 1, `${menu} 里「标准」这一项的名字应当只有「标准」`);
    const described = await page.locator(`${menu} [role="menuitemradio"]`).evaluateAll((items) => items.map((item) => item.getAttribute("aria-description") ?? ""));
    assert.ok(described.length >= 3 && described.every(Boolean), `${menu} 的每一项都要有说明：${JSON.stringify(described)}`);
    // 外面每一层框都要把菜单包住。辅助功能接口找元素是沿着「包含这个点的框」往下走的，
    // 菜单画在输入框外面时根本走不进去，落到了后面的对话区上（2026-09-24 实测）。
    const unheld = await page.locator(menu).evaluate((node) => {
      const box = node.getBoundingClientRect(), out = [];
      for (let up = node.parentElement; up && up !== document.documentElement; up = up.parentElement) {
        const around = up.getBoundingClientRect();
        if (box.left < around.left - 1 || box.right > around.right + 1 || box.top < around.top - 1 || box.bottom > around.bottom + 1) out.push(up.id || String(up.className) || up.tagName);
      }
      return out;
    });
    assert.deepEqual(unheld, [], `${menu} 画在了这些外层框之外：${unheld.join("、")}`);
    await page.keyboard.press("Escape").catch(() => {});
    await page.locator("#section-title").click({ position: { x: 2, y: 2 } }).catch(() => {});
  }
  await page.screenshot({ path: path.join(evidence, "desktop-home.png"), scale: "css" });
  await page.locator('[data-section="skills"]').click();
  await page.locator(".skill-card").first().waitFor();
  // The bundled CLI decides which skills there are (1.0.96 added lark-meeting),
  // and the page shows every one of them the product uses -- all but lark-apps.
  // A fixed count here needed editing at every upgrade and said nothing about
  // which card had gone missing.
  const skillConfig = await mkdtemp(path.join(os.tmpdir(), "idou-skill-list-"));
  const skills = (await new SaasFeishuCliProvider({ binary: path.resolve("resources/lark-cli/darwin-arm64/lark-cli"),
    environment: () => ({ LARKSUITE_CLI_AUTH_PROXY: "http://127.0.0.1:9", LARKSUITE_CLI_PROXY_KEY: "smoke", LARKSUITE_CLI_APP_ID: "cli_smoke",
      LARKSUITE_CLI_BRAND: "feishu", LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1", LARKSUITE_CLI_CONFIG_DIR: skillConfig }) })
    .listSkills());
  // Skills that only hand their work to another (lark-vc → lark-meeting) have no
  // card of their own since 2026-09-25; the one they point to does.
  const aliases = new Set(skills.filter((skill) => builtinAlias(skill)).map((skill) => skill.name));
  const embedded = skills.map((skill) => skill.name);
  await rm(skillConfig, { recursive: true, force: true });
  // A card's title is its display name (「即时通讯」); the skill it stands for is
  // in its focus key, `card:f:<name>`.
  const shown = await page.locator(".skill-card").evaluateAll((nodes) => nodes.map((node) => (node.dataset.focus ?? "").replace(/^card:f:/, "")));
  assert.ok(embedded.includes("lark-apps"), "the check below only means something while the CLI still carries lark-apps");
  assert.ok(aliases.size >= 1 && [...aliases].every((name) => !shown.includes(name)), "an alias has no card of its own");
  assert.deepEqual([...shown].sort(), embedded.filter((name) => isProductSkill(name) && !aliases.has(name)).sort(), "every product skill the bundled CLI carries has its card, and only those");
  shownSkills = shown.length;
  assert.equal(await page.getByRole("heading", { name: "lark-apps", exact: true }).count(), 0);
  await page.screenshot({ path: path.join(evidence, "desktop-skills.png"), scale: "css" });
  // Markets, plugins and MCP servers are Codex's own; 技能中心 is the view onto
  // them. Adding each is one step from the toolbar's 添加 menu -- the way 豆包工作
  // and WorkBuddy both do it -- rather than three forms stacked on the landing
  // page, so the controls are checked where that menu takes you.
  await page.locator(".sc-add > summary").click();
  for (const entry of ["#import-local-skill", "#open-add-market", "#open-add-connector"]) {
    assert.equal(await page.locator(entry).isVisible(), true, `${entry} 应当在技能中心的添加菜单里`);
  }
  await page.locator("#open-add-market").click();
  await eventually(() => page.locator("#marketplace-source").isVisible(), (value) => assert.equal(value, true, "添加技能市场应当直接到市场地址输入框"));
  await page.locator(".market-list .empty-note").waitFor();
  await page.locator(".sc-add > summary").click(); await page.locator("#open-add-connector").click();
  for (const control of ["#mcp-name", "#mcp-kind", "#mcp-target", "#add-mcp-server"]) {
    assert.equal(await page.locator(control).isVisible(), true, `${control} 应当在连接器页可用`);
  }
  await page.locator(".mcp-list .empty-note").waitFor();
  // Any item opens the one detail dialog, with its SKILL.md rendered as a
  // document rather than dumped as a file.
  await page.locator('.sc-tab[data-tab="skills"]').click();
  await page.locator(".skill-card").first().click(); await page.locator("#skill-detail[open]").waitFor();
  await page.locator("#skill-detail-body .sd-doc").first().waitFor();
  assert.equal(await page.locator("#skill-detail .try-skill").isVisible(), true);
  await page.locator("#close-skill-detail").click(); await page.locator("#skill-detail[open]").waitFor({ state: "detached" });
  // A legacy machine preference of full access must never reach a new task.
  // Full can still be chosen explicitly for this one draft, and the following
  // draft must immediately return to the safe default.
  await page.evaluate(() => {
    localStorage.removeItem("idou-default-execution-permission");
    localStorage.removeItem("mydoubao-default-execution-permission");
    localStorage.setItem("mydoubao-permission", "full");
  });
  await page.locator('[data-section="coding"]').click();
  await eventually(() => page.locator("#permission-toggle").innerText(), (value) => assert.match(value, /标准/, "旧 full 默认值必须回落标准"));
  await page.locator("#permission-toggle").click();
  await page.locator('#permission-menu [data-permission="full"]').click();
  await eventually(() => page.locator("#permission-toggle").innerText(), (value) => assert.match(value, /完全访问/, "当前草稿仍可明确选择完全访问"));
  // Native picker result is controlled only in the test main process. Production
  // IPC still accepts only one-use workspace handles, not arbitrary file paths.
  await app.evaluate(({ dialog }, cwd) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [cwd] }); }, workspace);
  await page.locator("#pick-workspace").click();
  // Which directory a coding task will write to has to be readable before the
  // first message, not inferred from a caption under a button.
  await page.locator("#project-path").filter({ hasText: workspace }).waitFor();
  assert.equal(await page.locator("#project-name").innerText(), path.basename(workspace));
  // Choosing a folder says nothing about Git, as in Codex and Claude Code: no
  // badge on the row, no standing 初始化 Git 仓库 button. It is offered in
  // 查看改动 below, where a missing baseline is what is actually in the way.
  assert.equal(await page.locator("#project-git").count(), 0);
  assert.equal(await page.locator("#init-git").count(), 0);
  assert.equal(existsSync(path.join(workspace, ".git")), false, "选目录这一步不应当动工作目录");
  await page.locator("#prompt").fill(live
    ? 'Create index.html in this empty workspace, a small self-contained Chinese page titled 企业应用工坊. Include a button with id="counter" showing 0 that increments its visible number on each click. Use understated graphite/off-white colors and inline CSS and JS, no external resources, no network. Write the actual file. Then reply APP_READY. Do not access files outside this workspace.'
    : "桌面验收任务：没有模型连接时应明确报错，不伪造回复。");
  await page.locator("#send").click();
  await page.locator("#task-tabs").waitFor();
  console.log("Desktop task created");
  if (live) {
    await page.locator("#task-status").filter({ hasText: /^(已完成|执行失败|已停止)$/ }).waitFor({ timeout: 180_000 });
    assert.equal(await page.locator("#task-status").innerText(), "已完成", await page.locator("#error-banner").innerText());
    assert.match(await readFile(path.join(workspace, "index.html"), "utf8"), /counter/);
    assert.match(await page.locator("#messages").innerText(), /APP_READY/);
  } else await page.locator("#task-status").filter({ hasText: /^执行失败$/ }).waitFor();
  const permissionTask = await page.evaluate(async () => (await window.idou.snapshot()).tasks[0]);
  assert.equal(permissionTask.permission, "plan", "规划阶段的实际权限必须是只读计划");
  assert.equal(permissionTask.executionPermission, "full", "明确的完全访问只属于当前任务");
  await page.screenshot({ path: path.join(evidence, "task-ui", "u01-explicit-full-plan.png"), scale: "css" });
  await page.locator("#new-task").click();
  // The click returns before the new draft is drawn: opening it saves the draft
  // being left and reads the saved one back first. Read at once, a busy machine
  // shows the task just left -- "执行时：完全访问", which that task was given
  // explicitly -- and the check fails on the old screen, not on inheritance
  // (seen once in a full acceptance run; alone it passed three times of three).
  await page.waitForFunction(() => !/执行时/.test(document.querySelector("#permission-toggle")?.innerText ?? ""), null, { timeout: 10_000, polling: 100 });
  assert.match(await page.locator("#permission-toggle").innerText(), /标准/, "新草稿不得继承前一个任务的完全访问");
  await page.screenshot({ path: path.join(evidence, "task-ui", "u01-safe-new-draft.png"), scale: "css" });
  await page.locator(".recent-row > button:first-child").first().click();
  // 查看改动 in a folder outside a repository: it says what is missing and
  // offers to make one there — the Agent's sandbox can never write `.git`.
  await page.locator("#review-changes").click();
  await page.locator("#changes-panel .diff-dialog-note").filter({ hasText: "还不是 Git 仓库" }).waitFor();
  assert.equal(await page.locator(".diff-dialog").count(), 0, "查看改动应进入工作区，不再只打开弹窗");
  assert.equal(await page.locator("#prompt").isVisible(), true, "宽屏审阅改动时输入框仍属于对话列");
  // A button can be clicked while it is drawn nowhere, so it is measured and
  // photographed, not only found.
  const initBox = await page.locator("#init-git").boundingBox();
  assert.ok(initBox && initBox.width > 70 && initBox.height > 14, `初始化 Git 仓库这个按钮画出来是 ${JSON.stringify(initBox)}`);
  await page.screenshot({ path: path.join(evidence, "desktop-coding-no-git.png"), scale: "css" });
  await page.locator("#init-git").click();
  await page.locator("#changes-panel .diff-dialog-note").filter({ hasText: "还不是 Git 仓库" }).waitFor({ state: "detached" });
  assert.ok(existsSync(path.join(workspace, ".git")), "初始化 Git 仓库后工作目录里应当真的有仓库");
  await page.locator("#collapse-panel").click();
  await eventually(() => page.locator("#changes-panel").isVisible(), (value) => assert.equal(value, false));
  await page.screenshot({ path: path.join(evidence, live ? "desktop-live-task.png" : "desktop-no-session.png"), scale: "css" });
  // Files are no longer a tab: they open in the side panel next to the
  // conversation, on the trailing side, and fold away without being torn down.
  assert.equal(await page.locator('[data-tab="files"]').count(), 0);
  assert.equal(await page.locator('[data-tab="browser"]').count(), 0);
  await page.locator("#open-files").click();
  await page.locator("#file-list").getByRole("button", { name: "index.html", exact: true }).click();
  await eventually(() => page.locator("#prompt").isVisible(), (value) => assert.equal(value, true));
  assert.equal(await page.locator("#messages").isVisible(), true);
  const panelBounds = await page.evaluate(() => ({ fileLeft: document.querySelector("#files").getBoundingClientRect().left, agentLeft: document.querySelector("#agent-panel").getBoundingClientRect().left }));
  assert.ok(panelBounds.agentLeft < panelBounds.fileLeft, "the panel opens after the conversation, not before it");
  const beforeResize = await page.locator("#artifact-panel").boundingBox();
  const separator = await page.locator("#workbench-divider").boundingBox();
  assert.ok(separator && beforeResize, "宽屏工作区应有可拖动分隔条");
  await page.mouse.move(separator.x + separator.width / 2, separator.y + 80);
  await page.mouse.down(); await page.mouse.move(separator.x - 70, separator.y + 80, { steps: 5 }); await page.mouse.up();
  const afterResize = await page.locator("#artifact-panel").boundingBox();
  assert.ok(afterResize.width > beforeResize.width + 40, `拖动分隔条后工作区宽度应改变：${beforeResize.width} -> ${afterResize.width}`);
  // Twice now a shared `width:100%` on a container's buttons has squeezed the
  // real content down to a sliver — once in the sidebar, once here. And twice a
  // header's labels have wrapped into one-character columns. Both are invisible
  // to any textContent assertion, so they are measured instead.
  const layout = await page.evaluate(() => {
    const header = document.querySelector("#files > header");
    const row = document.querySelector("#file-list .file-row");
    const width = (el) => Math.round(el.getBoundingClientRect().width);
    return {
      tallHeaderControls: [...header.children].filter((el) => !el.hidden)
        .filter((el) => el.getBoundingClientRect().height > 34)
        .map((el) => `${el.id || el.className}:${Math.round(el.getBoundingClientRect().height)}`),
      nameWidth: row ? width(row.querySelector("button")) : null,
      siblingWidths: row ? [...row.children].slice(1).map(width) : [],
      listVisible: !document.querySelector("#file-list").hidden,
    };
  });
  assert.deepEqual(layout.tallHeaderControls, [], "任务文件面板的头部控件不该被挤到换行");
  assert.equal(layout.listVisible, true, "任务文件列表必须可见");
  assert.ok(layout.nameWidth > 60, `文件名按钮被挤成 ${layout.nameWidth}px，应当占据整行`);
  for (const sibling of layout.siblingWidths) assert.ok(sibling < layout.nameWidth, "行内的操作按钮不该比文件名还宽");
  await page.screenshot({ path: path.join(evidence, "desktop-work-files-panel.png"), scale: "css" });
  await page.locator("#collapse-panel").click();
  await eventually(() => page.locator("#files").isVisible(), (value) => assert.equal(value, false));
  await page.locator("#reopen-panel").click();
  await eventually(() => page.locator("#files").isVisible(), (value) => assert.equal(value, true));
  assert.match(await page.locator("#file-title").innerText(), /index\.html/);
  await page.locator("#file-content").evaluate((input) => { input.focus(); input.setSelectionRange(0, 10); });
  await page.locator("#quote-selection").click();
  await eventually(() => page.locator("#context-label").innerText(), (value) => assert.match(value, /已选 10 字/));
  const original = await readFile(path.join(workspace, "index.html"), "utf8");
  await writeFile(path.join(workspace, "index.html"), `${original}\n<!-- external-edit-evidence -->`);
  await page.locator("#prompt").fill("这条旧引用不应发送给模型");
  await page.locator("#send").click();
  await page.locator("#error-banner").filter({ hasText: /文件已变化/ }).waitFor();
  assert.equal(await page.locator(".message.user").count(), 1);
  assert.equal(await page.locator("#prompt").inputValue(), "这条旧引用不应发送给模型");
  await page.screenshot({ path: path.join(evidence, "task-ui", "u06-stale-reference.png"), scale: "css" });
  await page.locator('#mention-row button[aria-label^="移除引用"]').click();
  // 刷新、在访达中打开、打开飞书内容都收进了「⋯」，头部只留常用的两个。
  await page.locator("#file-menu-toggle").click();
  await page.locator("#refresh-files").click();
  await eventually(() => page.locator("#file-menu").isVisible(), (value) => assert.equal(value, false, "选完菜单项应当自动收起"));
  await page.waitForFunction(() => document.querySelector("#file-content").value.includes("external-edit-evidence"));
  assert.equal(await page.locator("#clear-selection").isVisible(), false);
  await page.locator("#prompt").fill("");
  await page.screenshot({ path: path.join(evidence, "desktop-side-edit.png"), scale: "css" });
  await setTheme(page, "light");
  await page.screenshot({ path: path.join(evidence, "task-ui", "u04-wide-light.png"), scale: "css" });
  await setTheme(page, "dark");
  await page.screenshot({ path: path.join(evidence, "task-ui", "u04-wide-dark.png"), scale: "css" });
  await setTheme(page, "light");
  await page.locator("#open-preview").click();
  await page.waitForFunction(() => document.querySelector("#preview-area")?.dataset.previewState === "ready" && document.querySelector("#preview-address")?.textContent === "/index.html");
  const guestResult = await app.evaluate(async ({ webContents }) => {
    const guest = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith("http://127.0.0.1:"));
    if (!guest) throw new Error("Native preview missing");
    return guest.executeJavaScript(`({ node: typeof require, appBridge: typeof window.idou, before: document.getElementById('counter').textContent, after: (document.getElementById('counter').click(), document.getElementById('counter').textContent) })`);
  });
  assert.deepEqual(guestResult, { node: "undefined", appBridge: "undefined", before: "0", after: "1" });
  // A BrowserWindow screenshot does not prove a native child view is visible.
  // Check its real attached bounds, then capture the guest itself as separate evidence.
  let previewBounds;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    previewBounds = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const view = win.contentView.children.find((child) => child.webContents?.getURL().startsWith("http://127.0.0.1:"));
      return view?.getBounds();
    });
    if (previewBounds?.width > 200 && previewBounds?.height > 100) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(previewBounds?.x >= 216 && previewBounds?.y >= 100 && previewBounds?.width > 200 && previewBounds?.height > 100, JSON.stringify(previewBounds));
  // The preview now opens after the conversation instead of before it, so the
  // invariant is mirrored: it must start where the agent panel ends. A native
  // view over the composer or the approvals would take clicks nobody can see.
  const agentRight = await page.locator("#agent-panel").evaluate((panel) => panel.getBoundingClientRect().right);
  assert.ok(previewBounds.x >= agentRight, "Native preview must not cover Agent input or approvals");
  const previewPng = await app.evaluate(async ({ webContents }) => {
    const guest = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith("http://127.0.0.1:"));
    await guest.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    return (await guest.capturePage()).toPNG().toString("base64");
  });
  await writeFile(path.join(evidence, live ? "desktop-live-preview.png" : "desktop-preview.png"), Buffer.from(previewPng, "base64"));
  // A modal belongs above the entire desktop. Native child views otherwise sit
  // above renderer DOM and would cover it even when the dialog looks open in a
  // normal page screenshot.
  await page.locator("#prompt").fill("/status"); await page.locator("#send").click();
  await page.locator(".status-dialog[open]").waitFor();
  let coveredPreview;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    coveredPreview = await app.evaluate(({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find((child) => child.webContents?.getURL().startsWith("http://127.0.0.1:"));
      return view && { bounds: view.getBounds(), visible: view.getVisible() };
    });
    if (coveredPreview && !coveredPreview.visible && coveredPreview.bounds.width === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(coveredPreview, { bounds: { x: 0, y: 0, width: 0, height: 0 }, visible: false }, "弹层出现时原生预览必须先隐藏");
  await page.locator(".status-dialog").getByRole("button", { name: "关闭" }).click();
  await page.waitForFunction(() => !document.querySelector(".status-dialog"));
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const restored = await app.evaluate(({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find((child) => child.webContents?.getURL().startsWith("http://127.0.0.1:"));
      return view && view.getVisible() && view.getBounds().width > 200;
    });
    if (restored) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(await app.evaluate(({ BrowserWindow }) => {
    const view = BrowserWindow.getAllWindows()[0].contentView.children.find((child) => child.webContents?.getURL().startsWith("http://127.0.0.1:"));
    return Boolean(view?.getVisible() && view.getBounds().width > 200);
  }), true, "弹层关闭后应恢复同一个预览");
  const beforeIteration = await page.evaluate(async () => (await window.idou.snapshot()).tasks[0]);
  if (live) {
    await page.locator("#prompt").fill('修改当前引用的 index.html：把 id="counter" 按钮的初始数字从 0 改为 7，点击后继续每次加 1。保留现有标题和布局。先读取当前文件，只修改此文件，不访问工作目录之外。完成后回复 ITERATION_READY。');
    await page.locator("#send").click();
    await page.waitForFunction(() => document.querySelectorAll(".message.user").length === 2);
    await page.locator("#task-status").filter({ hasText: /^(已完成|执行失败|已停止)$/ }).waitFor({ timeout: 180_000 });
    assert.equal(await page.locator("#task-status").innerText(), "已完成", await page.locator("#error-banner").innerText());
    assert.match(await page.locator("#messages").innerText(), /ITERATION_READY/);
    assert.equal(await page.locator("#browser").isVisible(), true);
  } else {
    await writeFile(path.join(workspace, "index.html"), '<!doctype html><h1>刷新后的成果</h1><button id="counter">7</button><script>counter.onclick=()=>counter.textContent=Number(counter.textContent)+1</script>');
    await page.locator("#refresh-preview").click();
  }
  await page.waitForFunction(() => document.querySelector("#preview-area").dataset.previewState === "ready");
  let refreshedCounter;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    refreshedCounter = await app.evaluate(async ({ webContents }) => {
      const guest = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith("http://127.0.0.1:"));
      return guest?.executeJavaScript("document.getElementById('counter')?.textContent").catch(() => null);
    });
    if (refreshedCounter === "7") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(refreshedCounter, "7", "Edited artifact must reload, not merely show a successful task status");
  for (let repeat = 0; repeat < 5; repeat += 1) {
    await page.locator("#refresh-preview").click();
    await page.waitForFunction(() => document.querySelector("#preview-area").dataset.previewState === "ready");
    const value = await app.evaluate(async ({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find((child) => child.webContents?.getURL().startsWith("http://127.0.0.1:"));
      return view.webContents.executeJavaScript("document.getElementById('counter').textContent");
    });
    assert.equal(value, "7");
  }
  const afterIteration = await page.evaluate(async () => (await window.idou.snapshot()).tasks[0]);
  assert.equal(afterIteration.codexThreadId, beforeIteration.codexThreadId);
  if (live) assert.equal(afterIteration.messages.filter((message) => message.role === "user")[1].context.path, "index.html");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 760));
  await page.waitForFunction(() => window.innerWidth >= 960 && window.innerWidth < 1200 && document.body.classList.contains("sidebar-hidden")
    && document.querySelector("#work-area").classList.contains("layout-split"));
  assert.equal(await page.locator("#prompt").isVisible(), true, "中屏打开工作区时仍应并排显示对话");
  const medium = await page.evaluate(() => ({ agentRight: document.querySelector("#agent-panel").getBoundingClientRect().right, viewport: innerWidth }));
  let mediumBounds;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    mediumBounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.find((child) => child.webContents?.getURL().startsWith("http://127.0.0.1:"))?.getBounds());
    if (mediumBounds?.width > 200 && mediumBounds.x >= medium.agentRight && mediumBounds.x + mediumBounds.width <= medium.viewport + 1) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(mediumBounds?.width > 200 && mediumBounds.x >= medium.agentRight && mediumBounds.x + mediumBounds.width <= medium.viewport + 1, JSON.stringify({ mediumBounds, medium }));
  await setTheme(page, "light"); await page.screenshot({ path: path.join(evidence, "task-ui", "u04-medium-light.png"), scale: "css" });
  await setTheme(page, "dark"); await page.screenshot({ path: path.join(evidence, "task-ui", "u04-medium-dark.png"), scale: "css" });

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 720));
  await page.waitForFunction(() => window.innerWidth < 960 && document.querySelector("#work-area").classList.contains("layout-single")
    && document.querySelector("#work-area").classList.contains("panel-view"));
  let narrowState;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    narrowState = await app.evaluate(({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find((child) => child.webContents?.getURL().startsWith("http://127.0.0.1:"));
      return view && { bounds: view.getBounds(), visible: view.getVisible() };
    });
    if (narrowState?.visible && narrowState.bounds.width > 500 && narrowState.bounds.x + narrowState.bounds.width <= 801) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(await page.locator("#prompt").isVisible(), false, "窄屏工作区不能把对话和预览横向挤在一起");
  assert.equal(await page.locator("#back-to-chat").isVisible(), true);
  assert.ok(narrowState?.visible && narrowState.bounds.width > 500 && narrowState.bounds.x + narrowState.bounds.width <= 801, JSON.stringify(narrowState));
  await setTheme(page, "light"); await page.screenshot({ path: path.join(evidence, "task-ui", "u04-narrow-light.png"), scale: "css" });
  await setTheme(page, "dark"); await page.screenshot({ path: path.join(evidence, "task-ui", "u04-narrow-dark.png"), scale: "css" });

  // The narrow sidebar is an overlay. It must hide the native preview while it
  // is over that area, and its own close control must remain clickable.
  await page.locator("#sidebar-toggle").click(); await page.locator("#sidebar-close").waitFor();
  let overlayState;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    overlayState = await app.evaluate(({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find((child) => child.webContents?.getURL().startsWith("http://127.0.0.1:"));
      return view && { bounds: view.getBounds(), visible: view.getVisible() };
    });
    if (overlayState && !overlayState.visible && overlayState.bounds.width === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(overlayState, { bounds: { x: 0, y: 0, width: 0, height: 0 }, visible: false });
  await page.locator("#sidebar-close").click();
  await page.locator("#back-to-chat").click();
  await eventually(() => page.locator("#prompt").isVisible(), (value) => assert.equal(value, true));
  let hiddenOnChat;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    hiddenOnChat = await app.evaluate(({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find((child) => child.webContents?.getURL().startsWith("http://127.0.0.1:"));
      return view && { bounds: view.getBounds(), visible: view.getVisible() };
    });
    if (hiddenOnChat && !hiddenOnChat.visible && hiddenOnChat.bounds.width === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(hiddenOnChat, { bounds: { x: 0, y: 0, width: 0, height: 0 }, visible: false }, "返回对话后原生预览不能盖住输入框");
  await page.locator("#workbench-preview").click();
  await page.waitForFunction(() => document.querySelector("#work-area").classList.contains("panel-view"));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1250, 840));
  await page.waitForFunction(() => innerWidth >= 1200 && document.querySelector("#work-area").classList.contains("layout-split"));
  if (await page.evaluate(() => document.body.classList.contains("sidebar-hidden"))) await page.locator("#sidebar-toggle").click();
  await page.locator("#close-preview").click();
  await page.waitForFunction(() => document.querySelector("#file-content").value.includes('counter'));
  await page.screenshot({ path: path.join(evidence, live ? "desktop-live-iteration.png" : "desktop-offline-iteration.png"), scale: "css" });
  // Reproduce an IPC race: hide must invalidate an in-flight file preview,
  // including the path-validation await before creating the native child.
  await page.evaluate(async (id) => { await Promise.allSettled([window.idou.previewFile(id, "index.html"), window.idou.hidePreview()]); }, afterIteration.id);
  assert.equal(await app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((contents) => contents.getURL().startsWith("http://127.0.0.1:")).length), 0);
  await page.locator("#prompt").fill("保留在原任务里的草稿");
  await page.locator('[data-section="cowork"]').click();
  await eventually(() => page.locator("#prompt").inputValue(), (value) => assert.equal(value, ""));
  assert.equal(await page.locator("#file-content").inputValue(), "");
  assert.equal(await app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((contents) => contents.getURL().startsWith("http://127.0.0.1:")).length), 0);
  // The recent list now belongs to the section above it, so the coding task is
  // reached from 编程任务 rather than from 工作任务.
  assert.equal(await page.locator(".recent-row > button:first-child").count(), 0);
  await page.locator('[data-section="coding"]').click();
  await page.locator(".recent-row > button:first-child").click();
  await page.waitForFunction(() => document.querySelector("#prompt")?.value === "保留在原任务里的草稿");
  assert.equal(await page.locator("#prompt").inputValue(), "保留在原任务里的草稿");
  await page.locator(".recent-row").first().getByRole("button", { name: "置顶", exact: true }).click();
  await page.locator(".task-group-label").filter({ hasText: "置顶任务" }).waitFor();
  await page.locator("#task-search").fill(path.basename(workspace));
  assert.equal(await page.locator(".recent-row").count(), 1, "项目路径搜索只返回当前账号匹配的任务");
  await page.locator("#task-search").fill("");
  const records = await readdir(path.join(dataRoot, "tasks"));
  assert.equal(records.filter((name) => name.endsWith(".json")).length, 1);
  const saved = JSON.parse(await readFile(path.join(dataRoot, "tasks", records.find((name) => name.endsWith(".json"))), "utf8"));
  assert.equal(saved.messages[0].role, "user");
  assert.equal(JSON.stringify(saved).includes("api_key"), false);
  await app.close(); app = null;
  started = await launch(); app = started.instance; page = started.page;
  await page.locator(".task-group-label").filter({ hasText: "置顶任务" }).waitFor();
  await page.locator(".recent-row > button:first-child").click();
  await page.waitForFunction(() => document.querySelector("#prompt")?.value === "保留在原任务里的草稿");
  assert.equal(await page.locator("#prompt").inputValue(), "保留在原任务里的草稿", "正常退出必须 flush 并恢复任务草稿");
  await page.locator("#files").waitFor();
  assert.match(await page.locator("#file-title").innerText(), /index\.html/, "重启后应恢复同一工作面板资源");
  await page.locator(".recent-row").first().getByRole("button", { name: "归档", exact: true }).click();
  await eventually(() => page.locator(".recent-row").count(), (value) => assert.equal(value, 0, "归档任务不留在最近列表"));
  await page.locator("#show-archived").click();
  await page.locator(".recent-row").filter({ hasText: "桌面验收任务" }).waitFor();
  assert.equal(existsSync(path.join(workspace, "index.html")), true, "归档只改导航元数据，不删除任务文件");
  await page.screenshot({ path: path.join(evidence, "task-ui", "u05-navigation-restore.png"), scale: "css" });
  await page.locator(".recent-row").first().getByRole("button", { name: "恢复", exact: true }).click();
  await page.locator("#show-archived").click();
  await eventually(() => page.locator(".message.user").count(), (value) => assert.equal(value, live ? 2 : 1));
  if (live) {
    assert.equal(await page.locator("#task-status").innerText(), "已完成");
    assert.match(await page.locator("#messages").innerText(), /APP_READY/);
  }
  // Last, because it deliberately creates a task: using a composer control on
  // the welcome screen is what starts one — nobody has to send a message first
  // just to reach 任务文件.
  await page.locator('[data-section="cowork"]').click();
  await page.waitForFunction(() => document.querySelector('[data-section="cowork"]')?.getAttribute("aria-current") === "page"
    && !document.querySelector("#new-task")?.disabled);
  const beforeOpen = await page.locator(".recent-row > button:first-child").count();
  await page.locator("#open-files").click();
  await page.locator("#files").waitFor();
  assert.equal(await page.locator("#file-empty").isVisible(), true, "空任务应显示一个文件引导，不应留下空列表和空编辑器");
  assert.equal(await page.locator("#file-list").isVisible(), false, "空任务不应显示没有内容的文件栏");
  assert.equal(await page.locator("#file-text-view").isVisible(), false, "空任务不应显示空白文件编辑器");
  assert.equal(await page.locator("#empty-attach-files").isVisible(), true);
  assert.equal(await page.locator("#empty-open-document").isVisible(), true);
  await page.screenshot({ path: path.join(evidence, "desktop-work-files-empty.png"), scale: "css" });
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, path.join(workspace, "index.html"));
  await page.locator("#empty-attach-files").click();
  await page.locator("#file-list").getByRole("button", { name: "index.html", exact: true }).click();
  const workFilesLayout = await page.evaluate(() => {
    const list = document.querySelector("#file-list").getBoundingClientRect();
    const viewer = document.querySelector(".file-workspace>article").getBoundingClientRect();
    const content = document.querySelector("#file-content");
    return { stacked: list.bottom <= viewer.top + 1, noLineNumbers: getComputedStyle(document.querySelector("#file-line-numbers")).display === "none",
      noHorizontalOverflow: content.scrollWidth <= content.clientWidth + 1 };
  });
  assert.equal(workFilesLayout.stacked, true, "窄工作任务面板应把文件列表放在预览上方");
  assert.equal(workFilesLayout.noLineNumbers, true, "工作任务不应把普通资料伪装成代码编辑器");
  assert.equal(workFilesLayout.noHorizontalOverflow, true, "工作任务的文字预览不应出现横向滚动");
  await page.screenshot({ path: path.join(evidence, "desktop-work-files-cowork.png"), scale: "css" });
  assert.equal(await page.locator("#task-tabs").isVisible(), true, "用任务文件应当自动建立任务");
  assert.equal(await page.locator(".recent-row > button:first-child").count(), beforeOpen + 1);
  await page.locator("#prompt").fill("工作任务导航验收"); await page.locator("#send").click();
  await page.locator("#task-status").filter({ hasText: /^(已完成|执行失败|已停止)$/ }).waitFor({ timeout: live ? 180_000 : 20_000 });
  // 任务名来自第一句话，不是永远的「新工作任务」；名字可以就地改。
  await page.locator('[data-section="coding"]').click();
  const row = page.locator(".recent-row").first();
  assert.equal(await row.locator("button:first-child strong, button:first-child").first().innerText().then((text) => text.split("\n")[0]), "桌面验收任务", "任务名应当取自第一句话并在标点处断开");
  await row.locator(".row-action", { hasText: "重命名" }).click();
  await page.locator(".rename-input").fill("改过名的任务");
  await page.locator(".rename-input").press("Enter");
  await page.locator(".recent-row").first().filter({ hasText: "改过名的任务" }).waitFor();
  // 压缩与回退是对这段对话本身的操作，有对话才出现。
  await page.locator(".recent-row > button:first-child").first().click();
  await page.locator("#task-actions").waitFor();
  assert.equal(await page.locator("#task-actions").isVisible(), true);
  assert.equal(await page.locator("#compact-task").isVisible(), true);
  // A coding task is still planning until 开始做, and that line says so rather
  // than counting turns -- what matters to somebody looking at a plan is that
  // nothing has been changed yet.
  assert.match(await page.locator("#task-actions-note").innerText(), /这一轮只读|还没有动任何文件|共 \d+ 轮对话/);
  await page.locator("#prompt").fill("编程任务独立草稿");
  const codingDraftId = await page.evaluate(async () => (await window.idou.snapshot()).tasks.find(task => task.mode === "coding").id);
  await page.waitForTimeout(450);
  assert.equal(await page.evaluate(id => window.idou.taskUiState(id).then(value => value.draft.text), codingDraftId), "编程任务独立草稿", "编程草稿防抖后应进入账号级存储");
  await page.locator('[data-section="cowork"]').click();
  await page.locator(".recent-row > button:first-child").click();
  await page.locator("#prompt").fill("工作任务独立草稿");
  const coworkDraftId = await page.evaluate(async () => (await window.idou.snapshot()).tasks.find(task => task.mode === "cowork").id);
  await page.waitForTimeout(450);
  assert.equal(await page.evaluate(id => window.idou.taskUiState(id).then(value => value.draft.text), coworkDraftId), "工作任务独立草稿", "工作草稿防抖后应进入账号级存储");
  for (let index = 0; index < 10; index += 1) {
    await page.locator('[data-section="coding"]').click(); await page.locator(".recent-row > button:first-child").click();
    await page.waitForFunction(() => document.querySelector("#prompt").value === "编程任务独立草稿");
    assert.equal(await page.locator("#prompt").inputValue(), "编程任务独立草稿");
    await page.locator('[data-section="cowork"]').click(); await page.locator(".recent-row > button:first-child").click();
    await page.waitForFunction(() => document.querySelector("#prompt").value === "工作任务独立草稿");
    assert.equal(await page.locator("#prompt").inputValue(), "工作任务独立草稿");
  }
  await page.locator('[data-section="coding"]').click(); await page.locator(".recent-row > button:first-child").click();
  // 顶栏只在有对话时写出任务名，分隔符跟着任务名走；没有对话的页面两样都不显示。
  assert.equal((await page.locator("#task-title").innerText()).trim(), "改过名的任务");
  assert.equal(await page.locator(".toolbar .divider").isVisible(), true);
  // 飞书消息在拿不到域名时，说明必须出现在这个 section 里，而不是只挂一条
  // 全局横幅、正文一片空白；文案也不能再指向已经删掉的「文件与协作」。
  await page.locator('[data-section="feishu"]').click();
  await page.locator(".feishu-unavailable").waitFor();
  assert.equal(await page.locator("#task-title").isVisible(), false, "飞书消息页没有对话，顶栏不该挂着上一个任务的名字");
  assert.equal(await page.locator("#error-banner").isVisible(), false, "页内已经说明的事不该再占一条全局横幅");
  assert.equal((await page.locator("body").innerText()).includes("文件与协作"), false, "不该再提到已经删除的「文件与协作」");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, live, composerOpensTask: true, feishuGuidanceInPlace: true, nativePreview: guestResult, previewBounds, narrowBounds: narrowState?.bounds, previewRace: "no orphan guest", repeatRefreshes: 5, staleContextRejected: true, responsiveWorkbench: true, refreshedCounter, sameThread: true, restoredTask: true, skillCount: shownSkills, rendererErrors: errors }));
} catch (error) {
  console.error(error);
  if (app) {
    const page = app.windows().find((window) => !window.isClosed());
    if (page) {
      try {
        console.error({ stage: "desktop_failure", banner: await page.locator("#error-banner").innerText() });
        await page.screenshot({ path: path.join(evidence, "desktop-failure.png"), scale: "css" });
      } catch (captureError) { console.error({ captureUnavailable: captureError.message }); }
    }
  }
  throw error;
} finally { if (app) await app.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
