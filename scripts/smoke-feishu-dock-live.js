// @requires live: 用本机真实的应用数据目录和已登录的飞书账号
// The docked Agent remembers each Feishu conversation separately.
//
// This is the one thing no other test here can reach. The messenger is a native
// WebContentsView, so the renderer's own page cannot see into it and Playwright
// cannot click inside it; and the chat identity only exists once a real account
// has real conversations. So it is driven from the main process, which does hold
// that view's webContents, against the operator's own signed-in application.
//
// Written because the defect it covers survived two rounds of reading: the
// binding was attached to one of the renderer's two task-creation paths while
// every message anyone actually sends went through the other, and nothing here
// could tell the difference.
//
//   node scripts/smoke-feishu-dock-live.js
//
// Needs the desktop signed in to Feishu and a control plane at IDOU_SERVER_URL
// (default http://127.0.0.1:3041). Uses the operator's own data directory,
// because the login lives there; quit the running application first.
import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { desktopProfileDir } from "../src/install-names.js";

// Asked for by name: it drives the operator's own signed-in application, and
// the default acceptance run started it without anyone asking (2026-09-25).
if (!process.argv.includes("--live")) throw new Error("Pass --live: this opens the operator's own signed-in application and data directory");
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DATA = process.env.IDOU_DESKTOP_DATA_DIR || desktopProfileDir();
const SERVER = process.env.IDOU_SERVER_URL || "http://127.0.0.1:3041";

const say = (line) => process.stdout.write(`  · ${line}\n`);

// Everything the messenger will tell us about what is open and what could be
// opened. `oc_` ids are looked for on purpose: matching a header name is what
// the binding falls back to, and a real id in the page would be better than it.
// Feishu's own class names are the only handle there is, and they are not ours
// to rely on, so this reports what it saw when it finds nothing -- a smoke that
// fails with "0 conversations" and no way to see why is a smoke nobody can fix.
const ROWS = `[...document.querySelectorAll('[class*="feed_card_item"],[class*="feed-card-item"],[role="listitem"],[class*="chat-item"],[class*="chatItem"],[class*="conversation-item"]')]
  .filter(node => { const box = node.getBoundingClientRect();
    return (node.textContent || "").trim().length > 1 && box.width > 80 && box.height > 20 && box.left < window.innerWidth / 2; })`;

const READ_CHATS = `(() => {
  const inner = (list) => list.filter(n => !n.querySelector('[class*="header_title"],[class*="Header_title"],[class*="headerTitle"]'));
  const header = inner([...document.querySelectorAll('[class*="header_title"],[class*="Header_title"],[class*="headerTitle"]')])
    .map(n => (n.textContent || "").replace(/\\s+/g, " ").trim()).filter(Boolean);
  const rows = ${ROWS}.map((node, index) => ({ index, text: (node.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 30) })).slice(0, 15);
  // What a left-hand list row is actually called here, when the guesses above
  // match nothing. Counted rather than dumped, so one line is enough to act on.
  const seen = {};
  if (!rows.length) {
    for (const node of document.querySelectorAll("div,li,a")) {
      const box = node.getBoundingClientRect();
      if (box.left > window.innerWidth / 2 || box.width < 80 || box.height < 20) continue;
      if ((node.textContent || "").trim().length < 2) continue;
      for (const one of (node.className || "").toString().split(/\\s+/)) {
        if (/item|conversation|chat|list/i.test(one)) seen[one] = (seen[one] || 0) + 1;
      }
    }
  }
  // What the open conversation's name is called now, when the selector the
  // preload uses finds nothing. If that selector has gone stale every chat
  // resolves to no name at all, which pools them into one conversation -- the
  // very symptom the binding was meant to remove, arriving by another road.
  const titles = header.length ? [] : [...document.querySelectorAll('[class*="itle"],[class*="name"],h1,h2')]
    .filter(n => { const b = n.getBoundingClientRect(); return b.top < 120 && b.left > window.innerWidth / 3 && b.width > 30; })
    .map(n => ({ c: (n.className || "").toString().slice(0, 48), t: (n.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 24) }))
    .filter(x => x.t).slice(0, 8);
  return { header: header[0] || "", rows, ready: document.body.innerText.length, titles,
    candidates: Object.entries(seen).sort((a, b) => b[1] - a[1]).slice(0, 12) };
})()`;

const clickRow = (index) => `(() => {
  const node = ${ROWS}[${index}];
  if (!node) return false;
  node.scrollIntoView({ block: "center" });
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }
  return true;
})()`;

let app;
try {
  say("launching the operator's own application …");
  // Both, and they are not the same thing. IDOU_DESKTOP_DATA_DIR moves this
  // application's own files; Feishu's login is a cookie, which lives in
  // Electron's userData. Setting only the first gives a signed-in app looking at
  // a signed-out web page -- measured: the messenger came up with 50 characters
  // of body text and no conversations at all.
  app = await electron.launch({ executablePath: electronBinary, args: [ROOT, `--user-data-dir=${DATA}`], timeout: 60_000,
    env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), IDOU_DESKTOP_DATA_DIR: DATA, IDOU_SERVER_URL: SERVER } });
  const page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.locator("#new-task").waitFor();

  await page.locator('[data-section="feishu"]').click();
  const inMessenger = (script) => app.evaluate(async ({ webContents }, source) => {
    // The messenger specifically. The application hosts more than one Feishu
    // page -- 飞书文档 is another -- and the first match was /drive/home/, which
    // has no conversation list and reported zero of them very convincingly.
    const view = webContents.getAllWebContents().find((contents) => /\/messenger/.test(contents.getURL()));
    return view ? view.executeJavaScript(source, true) : null;
  }, script);

  // Feishu loads its list after the frame is up, and how long that takes is not
  // ours to predict, so it is waited for rather than assumed.
  let seen = await inMessenger(READ_CHATS);
  for (let attempt = 0; attempt < 10 && !(seen?.rows?.length >= 2); attempt += 1) {
    await page.waitForTimeout(5000);
    seen = await inMessenger(READ_CHATS);
  }
  assert.ok(seen, "the messenger view is not there — is the desktop signed in to Feishu?");
  say(`conversations in the list: ${seen.rows.length}`);
  if (!seen.rows.length) say(`row classes it could not match: ${JSON.stringify(seen.candidates)}`);
  assert.ok(seen.rows.length >= 2,
    `this needs two conversations to switch between; the list showed ${seen.rows.length} (page text ${seen.ready} chars)`);

  // A fresh messenger opens on the list with nothing selected, so the first
  // conversation is opened here rather than assumed to be open. Note the side
  // effect this has on a real account: opening a chat marks it read.
  const open = async (index, label) => {
    assert.equal(await inMessenger(clickRow(index)), true, `could not click ${label}`);
    let name = "";
    for (let attempt = 0; attempt < 8 && !name; attempt += 1) {
      await page.waitForTimeout(2500);
      name = (await inMessenger(READ_CHATS))?.header ?? "";
    }
    // The dock only learns the name through its own poll, which is slower. What
    // it says is the decisive signal: if it still names the previous
    // conversation the renderer never saw the change at all, which is a
    // different defect from seeing it and not re-binding.
    await page.waitForTimeout(6000);
    const note = await page.locator("#feishu-dock-note").innerText().catch(() => "");
    const bound = await page.evaluate(() => { const n = document.getElementById("feishu-dock-note");
      return { key: n?.dataset.chatKey ?? "", task: (n?.dataset.taskId ?? "").slice(0, 8) }; });
    say(`    page says ${JSON.stringify(name)}; dock says ${JSON.stringify(note.slice(0, 30))}; bound ${JSON.stringify(bound)}`);
    return name;
  };

  // Measured, not queried. A hidden #conversation still answers innerText in
  // Chromium, so reading it directly reports the previous conversation as
  // present long after the panel has stopped showing it -- the reading half of
  // the trap this project already knows about on the clicking side.
  const shown = async () => page.evaluate(() => {
    const node = document.getElementById("conversation");
    if (!node) return "";
    const box = node.getBoundingClientRect();
    if (node.hidden || box.width < 4 || box.height < 4 || getComputedStyle(node).display === "none") return "";
    return (node.innerText || "").replace(/\s+/g, " ");
  });

  // Whose Feishu the pages are, as the control plane judged it. Waited for, not
  // hurried: when Feishu shows a consent page instead of passing straight
  // through, that page is the person's to click, and this script never clicks it.
  let verdict = await page.evaluate(() => window.idou.webIdentity());
  for (let attempt = 0; attempt < 12 && verdict.state === "checking" && !verdict.needsAttention; attempt += 1) {
    await page.waitForTimeout(2500);
    verdict = await page.evaluate(() => window.idou.webIdentity());
  }
  say(`web pages: ${verdict.state}${verdict.needsAttention ? " (Feishu is showing a page that needs the person)" : ""}${verdict.reason ? ` -- ${verdict.reason}` : ""}`);

  const rows = seen.rows;
  const mine = await open(rows[0].index, "the first conversation");
  const decided = await page.evaluate(() => window.idou.dockedChat());
  say(`the dock's decision: ${decided.binding}${decided.reason ? ` (${decided.reason})` : ""}${decided.remembers ? ", confirmable" : ""}`);
  say(`opened: ${JSON.stringify(mine)}`);
  assert.ok(mine, `the open conversation has no readable name; header candidates were ${JSON.stringify(seen.titles)}`);
  say(`dock says: ${(await page.locator("#feishu-dock-note").innerText()).slice(0, 70)}`);

  // Talk to the Agent about this conversation, which is what creates and binds
  // the record. Nothing is sent to Feishu: the reply is the model's own.
  const mark = `记住${Date.now() % 100000}`;
  await page.locator("#prompt").fill(`只回答这几个字，不要解释，不要使用任何工具：${mark}`);
  await page.locator("#send").click();
  await page.locator("#conversation").filter({ hasText: mark }).first().waitFor({ timeout: 180_000 });
  assert.match(await shown(), new RegExp(mark), "the turn is not actually on screen");
  say(`the panel now holds ${mark}`);

  // Away to another conversation …
  const other = rows.find((row) => row.index !== rows[0].index);
  const away = await open(other.index, "a second conversation");
  say(`switched to: ${JSON.stringify(away)}`);
  const empty = await shown();
  say(`while there the panel holds: ${empty.slice(0, 50) || "(empty)"}`);

  // … and back. This is the whole point.
  const back = await open(rows[0].index, "the first conversation again");
  say(`switched back to: ${JSON.stringify(back)}`);
  const returned = await shown();
  say(`after coming back it holds: ${returned.slice(0, 60) || "(empty)"}`);

  assert.equal(back, mine, "it did not come back to the same conversation");
  assert.match(returned, new RegExp(mark), `the conversation did not come back: ${returned.slice(0, 200)}`);
  assert.doesNotMatch(empty, new RegExp(mark), "the other conversation was showing this one's history");
  // Leaving the section by clicking a recent task, which is how a person leaves
  // it. The embedded messenger is a native view laid over the window; taking it
  // down is switchSection's job and nothing render() does can reach it. Assigning
  // state.section by hand left it attached and visible with stale bounds, over
  // the task the person had just opened. No screenshot can show this -- Playwright
  // captures the page, and a WebContentsView is not part of it -- so it is asked
  // of the main process, which is the only thing that knows.
  const attached = () => app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const walk = (view) => [view, ...(view.children ?? []).flatMap(walk)];
    return walk(win.contentView).filter((view) => /\/messenger/.test(view.webContents?.getURL?.() ?? ""))
      .map((view) => ({ visible: view.getVisible?.() ?? null, bounds: view.getBounds?.() ?? null }));
  });
  assert.equal((await attached())[0]?.visible, true, "the messenger view should be showing while the section is open");

  const recent = page.locator("#recent-tasks .recent-row > button").first();
  if (await recent.count()) {
    say(`leaving by clicking a recent task: ${JSON.stringify((await recent.innerText()).split("\n")[0].slice(0, 20))}`);
    await recent.click();
    await page.waitForTimeout(5000);
    const left = await attached();
    say(`the messenger view is now ${JSON.stringify(left[0] ?? null)}`);
    assert.equal(left[0]?.visible, false, "the embedded messenger stayed over the window after leaving the section");
    const standing = await page.evaluate(() => document.querySelector('[data-section][aria-current="page"]')?.dataset.section ?? "");
    assert.notEqual(standing, "feishu", `the sidebar still says 飞书消息 after opening a task: ${standing}`);
  }

  assert.deepEqual(errors, [], `the page raised errors: ${errors.join(" | ")}`);
  process.stdout.write("ALL CHECKS PASSED — 切走再切回，侧边栏对话还在，另一个会话里看不到它\n");
} finally {
  await app?.close().catch(() => {});
}
