#!/usr/bin/env node
// Builds assets/icon.png and assets/icon.icns from assets/icon.svg.
//
//   node scripts/build-icon.js
//
// There is no SVG rasteriser in this project's dependencies, and adding one for
// an icon is not worth a supply chain. Electron is already here and is a real
// browser, so the icon is rendered the same way anyone would see it: loaded in a
// transparent window at 1024 and photographed. The rest is macOS's own sips and
// iconutil.
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, copyFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SVG = path.join(ROOT, "assets", "icon.svg");
const PNG = path.join(ROOT, "assets", "icon.png");
const ICNS = path.join(ROOT, "assets", "icon.icns");
// What macOS asks an iconset for: each size, and each size again at double
// density. iconutil refuses a set that is missing one.
const SIZES = [16, 32, 128, 256, 512];

const work = await mkdtemp(path.join(os.tmpdir(), "idou-icon-"));
try {
  await copyFile(SVG, path.join(work, "icon.svg"));
  await writeFile(path.join(work, "icon.html"),
    `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}img{display:block;width:1024px;height:1024px}</style><img src="icon.svg">`);
  await writeFile(path.join(work, "entry.cjs"), `const { app, BrowserWindow } = require("electron");
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, backgroundColor: "#00000000" });
  await win.loadFile(${JSON.stringify(path.join(work, "icon.html"))});
});
app.on("window-all-closed", () => {});`);

  const instance = await electron.launch({ executablePath: electronBinary, args: [path.join(work, "entry.cjs")], timeout: 30_000 });
  try {
    const window = await instance.firstWindow();
    await window.locator("img").waitFor({ timeout: 15_000 });
    await window.waitForTimeout(400);
    await window.screenshot({ path: PNG, omitBackground: true, scale: "css" });
  } finally { await instance.close(); }

  const iconset = path.join(work, "icon.iconset");
  await mkdir(iconset);
  for (const size of SIZES) {
    await run("/usr/bin/sips", ["-z", String(size), String(size), PNG, "--out", path.join(iconset, `icon_${size}x${size}.png`)]);
    await run("/usr/bin/sips", ["-z", String(size * 2), String(size * 2), PNG, "--out", path.join(iconset, `icon_${size}x${size}@2x.png`)]);
  }
  await rm(ICNS, { force: true });
  await run("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", ICNS]);
  const { stdout } = await run("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", "-g", "hasAlpha", PNG]);
  console.log(JSON.stringify({ png: PNG, icns: ICNS, sizes: SIZES, measured: stdout.trim().split("\n").slice(1).map((line) => line.trim()) }));
} finally {
  await rm(work, { recursive: true, force: true });
}
