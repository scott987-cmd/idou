// The UI rules every desktop smoke is checked against
// (scripts/fixtures/ui-invariants) have to catch what they say they catch --
// a sweep that finds nothing because its rules never fire reads exactly like a
// clean application. One page commits every fault once, in the shape it was
// met while filming the promo; a second page does the same things soundly and
// must come back empty.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { inspect } from "../scripts/fixtures/ui-invariants/inspector.js";

const MAIN = `
const { app, BrowserWindow, WebContentsView } = require("electron");
// Holds the quit for a while, as a card left waiting once did for five minutes.
if (process.env.SLOW_QUIT) {
  let held = false;
  app.on("before-quit", (event) => { if (held) return; held = true; event.preventDefault(); setTimeout(() => app.quit(), Number(process.env.SLOW_QUIT)); });
}
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 600, show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadFile(process.env.UI_PAGE);
  // A native view over part of the page, as the embedded Feishu page is.
  const view = new WebContentsView();
  win.contentView.addChildView(view);
  view.setBounds({ x: 600, y: 300, width: 200, height: 120 });
  await view.webContents.loadURL("data:text/html,<body style='background:%23345'></body>");
  win.showInactive();
});
`;

const STYLE = `body { margin: 0; font: 14px sans-serif; } #native-slot { position: fixed; left: 600px; top: 300px; width: 200px; height: 120px; }`;

// Every fault once. The card at the bottom is rebuilt from nothing every 300 ms,
// as the approval cards were on 2026-09-25.
const FAULTY = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${STYLE}
  #column { position: relative; width: 160px; height: 36px; margin: 8px; }
  #column button { position: absolute; top: 44px; left: 0; }
  #overlap { position: relative; height: 40px; margin-top: 40px; }
  #cover { position: absolute; left: 0; top: 0; width: 200px; height: 40px; background: #fff; }
  .cut { width: 60px; overflow: hidden; white-space: nowrap; }
  #wide { width: 3000px; height: 4px; }
</style></head><body>
  <div id="column"><button>菜单里的选项</button></div>
  <div id="overlap"><button>被盖住的按钮</button><div id="cover">盖子</div></div>
  <div class="cut">这是一段很长很长很长的说明文字</div>
  <button id="icon"><svg width="10" height="10"></svg></button>
  <span id="twice">一</span><span id="twice">二</span>
  <p>Allow the computer MCP server to run tool</p>
  <pre>Allow the computer MCP server to run tool "computer_windows"</pre>
  <pre>收件人：陈宁\n标识：ou_46d524fd9f471a9bc76b3d77d0d39e67</pre>
  <div id="native-slot"></div>
  <button style="position: fixed; left: 400px; top: 330px; width: 300px">在原生页面底下的按钮</button>
  <div id="wide"></div>
  <div id="card" data-approval="a1"></div>
  <script>
    const card = document.getElementById("card");
    const draw = () => {
      const details = document.createElement("details"); details.innerHTML = "<summary>技术详情</summary><pre>{}</pre>";
      const reason = document.createElement("textarea"); reason.setAttribute("aria-label", "告诉它怎么做");
      const toggle = document.createElement("button"); toggle.textContent = "更多"; toggle.setAttribute("aria-expanded", "false");
      toggle.onclick = () => toggle.setAttribute("aria-expanded", "true");
      card.replaceChildren(details, reason, toggle);
    };
    draw(); setInterval(draw, 300);
  </script>
</body></html>`;

// The same things done soundly: nothing to report.
const SOUND = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${STYLE}
  .cut { width: 60px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
</style></head><body>
  <div style="position: relative; width: 160px; margin: 8px"><button>菜单里的选项</button></div>
  <div class="cut" title="这是一段很长很长很长的说明文字">这是一段很长很长很长的说明文字</div>
  <button id="icon" aria-label="关闭"><svg width="10" height="10"></svg></button>
  <p>模型：MiniMax-M3 GLM-5.3</p>
  <pre>Allow the computer MCP server to run tool "computer_windows"</pre>
  <details class="confirm-technical" open><summary>核对信息</summary><pre>标识：ou_46d524fd9f471a9bc76b3d77d0d39e67</pre></details>
  <div id="native-slot"></div>
  <button style="position: fixed; left: 400px; top: 330px; width: 150px">原生页面旁边的按钮</button>
  <div id="card" data-approval="a1"></div>
  <div id="scroller" style="height: 80px; overflow: auto; width: 240px">
    <div style="position: sticky; top: 0; height: 30px; background: #fff">吸顶的标题</div>
    <button>滚到标题下面的按钮</button><div style="height: 200px"></div>
  </div>
  <script>
    // Rebuilt every 300 ms too, but what the person did survives it.
    const card = document.getElementById("card");
    const kept = { open: false, reason: "", expanded: false };
    const draw = () => {
      const details = document.createElement("details"); details.innerHTML = "<summary>技术详情</summary><pre>{}</pre>"; details.open = kept.open;
      details.ontoggle = () => { kept.open = details.open; };
      const reason = document.createElement("textarea"); reason.setAttribute("aria-label", "告诉它怎么做"); reason.value = kept.reason;
      reason.oninput = () => { kept.reason = reason.value; };
      const toggle = document.createElement("button"); toggle.textContent = "更多"; toggle.setAttribute("aria-expanded", String(kept.expanded));
      toggle.onclick = () => { kept.expanded = true; toggle.setAttribute("aria-expanded", "true"); };
      const focused = document.activeElement === card.querySelector("textarea");
      card.replaceChildren(details, reason, toggle);
      if (focused) reason.focus();
    };
    draw(); setInterval(draw, 300);
    // The list scrolled a little: its first button is under the sticky title.
    document.getElementById("scroller").scrollTop = 12;
  </script>
</body></html>`;

async function sweep(t, html) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-ui-invariants-"));
  await mkdir(path.join(directory, "renderer"));
  const page = path.join(directory, "renderer", "index.html"), main = path.join(directory, "main.cjs");
  await writeFile(page, html); await writeFile(main, MAIN);
  const app = await electron.launch({ executablePath: electronBinary, args: [main], env: { ...process.env, UI_PAGE: page } });
  // Close before removing: a removal that fails must not leave Electron running.
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.after(() => app.close().catch(() => {}));
  const inspector = inspect(app, { every: 0 });
  const screen = await app.firstWindow();
  await screen.waitForFunction(() => Boolean(window.__uiInv) && document.readyState === "complete");
  await screen.waitForTimeout(300);
  // What a person does to the card: open its details, type a reason, open its menu.
  await screen.locator("#card summary").click(); await screen.waitForTimeout(700);
  await screen.locator("#card textarea").fill("先别发，改成只发给我"); await screen.waitForTimeout(700);
  await screen.locator("#card button").click(); await screen.waitForTimeout(700);
  await inspector.sample();
  return inspector;
}

test("the UI rules catch each fault met while filming, and pass a sound page", { timeout: 60_000 }, async (t) => {
  const faulty = await sweep(t, FAULTY);
  const kinds = new Map();
  for (const row of faulty.findings) kinds.set(row.kind, [...(kinds.get(row.kind) ?? []), row]);
  const described = JSON.stringify(faulty.findings, null, 1);
  for (const kind of ["超出父元素", "被遮挡", "文字被截断", "没有名字", "重复的 id", "英文", "页面横向溢出", "被原生页面盖住", "重绘丢状态", "内部标识外露"]) {
    assert.ok(kinds.has(kind), `rule 「${kind}」 did not fire:\n${described}`);
  }
  assert.equal(kinds.get("英文").length, 1, `a command in <pre> is data, not the application speaking:\n${described}`);
  const lost = new Set(kinds.get("重绘丢状态").map((row) => row.detail));
  for (const what of ["展开的详情被收起", "输入的内容被清空", "打开的菜单被关上"]) assert.ok(lost.has(what), `「${what}」 not caught:\n${described}`);
  assert.ok(faulty.stats.samples >= 1 && faulty.stats.installed >= 1, "the sweep must have looked");

  const sound = await sweep(t, SOUND);
  assert.deepEqual(sound.findings, [], `a sound page must come back empty:\n${JSON.stringify(sound.findings, null, 1)}`);
  assert.ok(sound.stats.samples >= 1, "the sweep must have looked");
});

test("closing the application from any state is prompt, or it is reported", { timeout: 60_000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-ui-slow-quit-"));
  await mkdir(path.join(directory, "renderer"));
  const page = path.join(directory, "renderer", "index.html"), main = path.join(directory, "main.cjs");
  await writeFile(page, SOUND); await writeFile(main, MAIN);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const app = await electron.launch({ executablePath: electronBinary, args: [main], env: { ...process.env, UI_PAGE: page, SLOW_QUIT: "1500" } });
  const inspector = inspect(app, { every: 0, slowClose: 800 });
  await (await app.firstWindow()).waitForFunction(() => Boolean(window.__uiInv));
  await app.close();
  assert.deepEqual(inspector.findings.map((row) => row.kind), ["退出太慢"], JSON.stringify(inspector.findings));
});

// A stand-in application whose page answers the monitor from `shown`, taking
// `delay` ms to do it -- so which look sees what is decided by the test, not by
// timing.
function standIn({ delay = 0 } = {}) {
  const shown = { rows: [], after: null };
  const page = {
    url: () => "file:///app/renderer/index.html", isClosed: () => false, on() {}, mainFrame: () => null,
    addInitScript: async () => {}, screenshot: async () => Buffer.alloc(0),
    evaluate: async (fn) => {
      if (!String(fn).includes("__uiInv?.sample")) return true;
      const checks = [...shown.rows];
      if (shown.after) { shown.after(); shown.after = null; }
      await new Promise((resolve) => setTimeout(resolve, delay));
      return { events: [], checks, rows: [], hosts: [] };
    },
  };
  const app = { windows: () => [page], on() {}, evaluate: async () => [], close: async () => {} };
  return { app, page, shown };
}
const ID_SHOWN = { kind: "内部标识外露", where: "li「会话 · oc_ScheduleFixture4…」", detail: "oc_ScheduleFixture456" };
const COVERED = { kind: "被遮挡", where: "button「保存」", detail: "div.toast" };

test("a screenshot is looked at even while another look is under way", async () => {
  const { app, page, shown } = standIn({ delay: 300 });
  const inspector = inspect(app, { every: 0 });
  const earlier = inspector.sample();            // under way, and sees nothing
  shown.rows = [ID_SHOWN];
  await page.screenshot({ path: "desktop-schedules-list.png" });
  shown.rows = [];                               // the smoke moves on at once
  await earlier;
  assert.deepEqual(inspector.findings.map((row) => [row.kind, row.phase]), [["内部标识外露", "desktop-schedules-list.png"]]);
});

test("what the page says counts at first sight; how it is laid out must hold on a second look", async () => {
  const { app, page, shown } = standIn();
  const inspector = inspect(app, { every: 0 });
  shown.rows = [ID_SHOWN, COVERED];
  shown.after = () => { shown.rows = []; };      // gone before the second look
  await page.screenshot({ path: "desktop-schedule-detail.png" });
  assert.deepEqual(inspector.findings.map((row) => row.kind), ["内部标识外露"], JSON.stringify(inspector.findings));
});
