#!/usr/bin/env node
// Renders each site template into the picture the template picker shows.
//
//   node scripts/build-template-previews.js
//
// The picture is the template, actually rendered, with sample data -- not a
// drawing of it. 妙搭's case centre, Kimi 网页's template list and ChatGPT
// Sites' showcase all show the thing itself, and a picture that drifts from
// what you get is worse than no picture. Regenerating is one command, so it
// cannot quietly go stale.
//
// One picture per combination -- a style nobody can see is not a choice anybody
// can make -- so this renders every scenario in every style.
//
// The results land in site-templates/previews/, inside src/, which means the
// release manifest covers them and they cannot be swapped out next to an
// installation. writeTemplate never copies one into a site.
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, mkdir, rm, writeFile, copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SITE_TEMPLATES, SITE_STYLES, DEFAULT_STYLE, previewName, writeTemplate } from "../src/application/site-templates.js";
import { writeContract } from "../src/application/table-contract.js";
import { readBaseSlice } from "../src/application/table-snapshot.js";
import { baseCellText } from "../src/providers/feishu/base-reader.js";
import { SAMPLE_SLICE, SAMPLE_TITLE, SAMPLE_READ_AT, sampleRecords } from "../src/application/site-sample.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATES = path.join(ROOT, "src", "application", "site-templates");
// Wide enough to look like a page rather than a phone, short enough that the
// card stays a card. 16:10, the shape every gallery above uses.
const WIDTH = 1200, HEIGHT = 750;

// The sample table lives in src/ (site-sample.js) so the demos somebody can
// open and these pictures are made of the same rows: a picture that disagreed
// with the demo beside it would be worse than either alone.
//
// Built through the real reader, so a preview shows exactly what a real table
// of these kinds produces -- chips, links, dates, money -- not an approximation.
const read = await readBaseSlice(SAMPLE_SLICE, sampleRecords(),
  { renderCell: (value) => baseCellText(value), title: SAMPLE_TITLE, now: () => SAMPLE_READ_AT });
const SCHEMA = read.schema, SNAPSHOT = read.snapshot;

const work = await mkdtemp(path.join(os.tmpdir(), "idou-template-preview-"));
const made = [];
try {
  for (const template of SITE_TEMPLATES) {
    for (const style of template.styled ? SITE_STYLES : [{ id: DEFAULT_STYLE }]) {
      const name = previewName(template.id, style.id);
      const folder = path.join(work, `${template.id}-${style.id}`);
      await mkdir(folder);
      await writeTemplate(folder, template.id, style.id);
      if (template.table) await writeContract(folder, { schema: SCHEMA, snapshot: SNAPSHOT });
      made.push({ id: template.id, name, file: path.join(folder, "index.html") });
    }
  }
  await writeFile(path.join(work, "entry.cjs"), `const { app, BrowserWindow } = require("electron");
app.whenReady().then(async () => { // useContentSize: the window is the page, not the page plus its frame, so
  // every preview comes out exactly ${WIDTH}x${HEIGHT}.
  const win = new BrowserWindow({ width: ${WIDTH}, height: ${HEIGHT}, useContentSize: true, show: false });
  await win.loadFile(${JSON.stringify(made[0].file)}); });
app.on("window-all-closed", () => {});`);
  const instance = await electron.launch({ executablePath: electronBinary, args: [path.join(work, "entry.cjs")], timeout: 30_000 });
  const written = [];
  try {
    const window = await instance.firstWindow();
    window.setDefaultTimeout(15_000);
    for (const { id, name, file } of made) {
      await window.goto(`file://${file}`);
      // A game's board is drawn on a canvas after its script runs; a table page
      // has rows, cards, columns or events; a landing page is just there.
      const ready = { game: "#board", dashboard: "#rows tr", directory: ".card",
        kanban: ".column", timeline: ".event", landing: ".hero" }[id];
      await window.locator(ready).first().waitFor();
      if (id === "game") {
        // A game at rest is a dark empty box behind a curtain, which says
        // nothing about it. So it is played for a moment first -- started, and
        // steered away from the wall -- and photographed alive.
        await window.locator("#start").click();
        for (const turn of ["ArrowDown", "ArrowLeft", "ArrowUp"]) {
          await window.waitForTimeout(420);
          await window.keyboard.press(turn);
        }
        await window.waitForTimeout(300);
      } else {
        await window.waitForTimeout(600);
      }
      const shot = path.join(work, name);
      await window.screenshot({ path: shot, scale: "css" });
      const target = path.join(TEMPLATES, "previews", name);
      await copyFile(shot, target);
      written.push(path.relative(ROOT, target));
    }
  } finally { await instance.close(); }
  console.log(JSON.stringify({ written, size: `${WIDTH}x${HEIGHT}` }, null, 1));
} finally {
  await rm(work, { recursive: true, force: true });
}
