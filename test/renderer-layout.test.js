// How the real page and its real stylesheet lay out, in two states the UI rules
// caught on 2026-09-25 that no test had looked at: the narrow window with its
// sidebar open over the page, and the home page with a card taller than the
// window. The page's own script is left out -- what is under test is where the
// stylesheet puts things, and the states are set the way the script sets them.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { _electron as electron } from "playwright";
import electronBinary from "electron";

const renderer = path.resolve("src/desktop/renderer");
const MAIN = `
const { app, BrowserWindow } = require("electron");
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: Number(process.env.WIDTH), height: Number(process.env.HEIGHT), show: false, useContentSize: true });
  await win.loadFile(process.env.PAGE);
});
`;

async function layout(t, { width, height }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-layout-"));
  const html = (await readFile(path.join(renderer, "index.html"), "utf8"))
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")
    .replace(/<script[^>]*><\/script>/g, "")
    .replace('href="app.css"', `href="${pathToFileURL(path.join(renderer, "app.css")).href}"`)
    .replace(/href="\.\.\/\.\.\/\.\.\/node_modules\//, `href="${pathToFileURL(path.resolve("node_modules")).href}/`);
  const page = path.join(directory, "index.html"), main = path.join(directory, "main.cjs");
  await writeFile(page, html); await writeFile(main, MAIN);
  const app = await electron.launch({ executablePath: electronBinary, args: [main], env: { ...process.env, PAGE: page, WIDTH: String(width), HEIGHT: String(height) } });
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.after(() => app.close().catch(() => {}));
  const screen = await app.firstWindow();
  await screen.waitForFunction(() => document.readyState === "complete" && getComputedStyle(document.body).display === "grid");
  return screen;
}

test("in a narrow window with the sidebar open over it, the page keeps its column", { timeout: 60_000 }, async (t) => {
  const screen = await layout(t, { width: 640, height: 600 });
  // What app.js does when the window is narrow and the sidebar is opened.
  const main = await screen.evaluate(() => { document.body.classList.add("sidebar-overlay"); const box = document.querySelector("body>main").getBoundingClientRect(); return { width: box.width, left: box.left, window: innerWidth }; });
  assert.ok(main.width >= main.window - 1, `the page fills the window behind the sidebar, not a zero-width column: ${JSON.stringify(main)}`);
});

test("on the home page a card taller than the window shrinks into it, and the composer stays inside the window", { timeout: 60_000 }, async (t) => {
  const screen = await layout(t, { width: 1000, height: 640 });
  const placed = await screen.evaluate(() => {
    const card = document.createElement("div"); card.className = "confirm-card"; card.style.height = "1400px"; card.textContent = "确认卡片";
    document.querySelector("#confirmations").append(card);
    const composer = document.querySelector("#composer").getBoundingClientRect(), send = document.querySelector("#send").getBoundingClientRect();
    return { composerBottom: composer.bottom, sendBottom: send.bottom, window: innerHeight };
  });
  assert.ok(placed.sendBottom <= placed.window && placed.composerBottom <= placed.window + 1, `发送 and the composer are inside the window: ${JSON.stringify(placed)}`);
});
