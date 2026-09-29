import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { SITE_TEMPLATES, SITE_STYLES, DEFAULT_STYLE, siteTemplate, siteStyle, previewName, templateFiles, writeTemplate, restyleSite, styleOf } from "../src/application/site-templates.js";

const folder = async (t, prefix = "idou-template-") => {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};

test("every template ships the files it claims, and they are static", async (t) => {
  assert.deepEqual(SITE_TEMPLATES.map((template) => template.id), ["dashboard", "directory", "kanban", "timeline", "landing", "game"]);
  assert.deepEqual(SITE_STYLES.map((style) => style.id), ["clean", "tech", "depth"]);
  for (const template of SITE_TEMPLATES) {
    const directory = await folder(t, `mydoubao-template-${template.id}-`);
    const { written, kept } = await writeTemplate(directory, template.id);
    assert.deepEqual(kept, []);
    assert.ok(written.includes("index.html"), `${template.id} 没有首页`);
    assert.ok(written.includes("site.css") || template.id === "game", `${template.id} 没有样式`);
    assert.ok(written.length >= 2, `${template.id} 只有一个文件`);
    const page = await readFile(path.join(directory, "index.html"), "utf8");
    assert.match(page, /<!doctype html>/i);
    assert.match(page, /<meta name="viewport"/, "手机上要能看");
    assert.match(page, /lang="zh-CN"/);
    // Nothing is fetched from anywhere: a site has to work from a folder, from
    // the preview gateway and inside a published single file.
    assert.equal(/<script[^>]+src="https?:/.test(page), false, `${template.id} 引了外部脚本`);
    assert.equal(/<link[^>]+href="https?:/.test(page), false, `${template.id} 引了外部样式`);
    for (const name of written.filter((file) => file.endsWith(".js"))) {
      const source = await readFile(path.join(directory, name), "utf8");
      // A template that does not parse would ship a blank page to everybody.
      assert.doesNotThrow(() => new vm.Script(source, { filename: name }), `${template.id}/${name} 语法不对`);
      assert.equal(source.includes(".innerHTML"), false, `${template.id}/${name} 用了 innerHTML`);
    }
  }
});

test("a template that shows a table loads the contract, and one that does not never sees it", async (t) => {
  for (const template of SITE_TEMPLATES) {
    const directory = await folder(t, `mydoubao-contract-${template.id}-`);
    await writeTemplate(directory, template.id);
    const page = await readFile(path.join(directory, "index.html"), "utf8");
    const loads = page.includes('src="data/table-data.js"') && page.includes('src="data/table.js"');
    assert.equal(loads, template.table, `${template.id} 与它声明的 table 不符`);
    if (!template.table) assert.equal(page.includes("data/"), false, "不接表格的模版不该提到 data/");
  }
});

test("writing never overwrites somebody's work", async (t) => {
  const directory = await folder(t);
  await writeFile(path.join(directory, "index.html"), "<p>我自己写的</p>");
  const { written, kept } = await writeTemplate(directory, "dashboard");
  assert.deepEqual(kept, ["index.html"]);
  assert.equal(written.includes("index.html"), false);
  assert.equal(await readFile(path.join(directory, "index.html"), "utf8"), "<p>我自己写的</p>");
  assert.ok(written.includes("site.js"), "其余文件照写");
});

test("the files land readable only by this person, in a folder of their own", async (t) => {
  const directory = await folder(t);
  const site = path.join(directory, "site");
  const { written } = await writeTemplate(site, "game");
  assert.equal((await stat(site)).mode & 0o777, 0o700);
  for (const name of written) assert.equal((await stat(path.join(site, name))).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(site)).sort(), [...written].sort());
});

test("only a template this build ships, into a folder named absolutely", async (t) => {
  const directory = await folder(t);
  assert.equal(siteTemplate("dashboard").name, "表格看板");
  assert.equal(siteTemplate("../../etc"), null);
  assert.equal(siteTemplate(""), null);
  await assert.rejects(() => writeTemplate(directory, "../dashboard"), /没有这个模版/);
  await assert.rejects(() => writeTemplate(directory, "nope"), /没有这个模版/);
  await assert.rejects(() => writeTemplate("relative/path", "game"), /绝对路径/);
});

test("a style is one stylesheet, and it fits every scenario", async (t) => {
  // The point of two axes: five scenarios and three styles are fifteen sites
  // out of eight files, not fifteen copies to keep in step. What makes that
  // true is that the markup never changes with the style -- only site.css does.
  for (const template of SITE_TEMPLATES.filter((one) => one.styled)) {
    const seen = new Map();
    for (const style of SITE_STYLES) {
      const files = await templateFiles(template.id, style.id);
      assert.deepEqual(files.map((file) => file.name).sort(), ["index.html", "site.css", "site.js"].filter((name) =>
        name === "site.css" || files.some((file) => file.name === name)).sort(), `${template.id}/${style.id} 的文件不对`);
      for (const file of files) {
        if (file.name === "site.css") { seen.set(style.id, file.bytes.toString()); continue; }
        // Same markup, same behaviour: only the stylesheet may differ.
        const key = `${template.id}:${file.name}`;
        if (seen.has(key)) assert.equal(seen.get(key), file.bytes.toString(), `${key} 会随风格变，那它就不是风格了`);
        else seen.set(key, file.bytes.toString());
      }
    }
    assert.equal(new Set([...seen].filter(([key]) => !key.includes(":")).map(([, css]) => css)).size, SITE_STYLES.length,
      `${template.id} 的三个风格给出了同一份样式`);
  }
  // Every style defines the whole palette on bare :root, so nothing is left to
  // a media query that a viewer may never match.
  for (const style of SITE_STYLES) {
    const [css] = (await templateFiles("dashboard", style.id)).filter((file) => file.name === "site.css");
    const root = css.bytes.toString().split("@media")[0];
    for (const token of ["--bg", "--paper", "--ink", "--muted", "--line", "--accent", "--accent-soft", "--shadow", "--radius"]) {
      assert.ok(root.includes(token), `${style.id} 没有在 :root 上定义 ${token}`);
    }
    assert.match(css.bytes.toString(), /body\s*\{[^}]*background/, `${style.id} 的 body 没有显式底色`);
  }
});

test("a style that cannot be seen is not a choice", async (t) => {
  const directory = await folder(t);
  assert.equal(siteStyle("tech").name, "科技");
  assert.equal(siteStyle("../../etc"), null);
  assert.equal(previewName("dashboard", "tech"), "dashboard-tech.png");
  assert.equal(previewName("game", "tech"), "game.png", "不吃风格的模版只有一张图");
  assert.equal(previewName("dashboard", "nope"), `dashboard-${DEFAULT_STYLE}.png`, "认不得的风格落回默认，而不是没有图");
  assert.equal(previewName("nope", "tech"), null);
  // Every combination has one, or the picker would offer a blank card.
  const { readFile: read } = await import("node:fs/promises");
  for (const template of SITE_TEMPLATES) {
    for (const style of template.styled ? SITE_STYLES : [{ id: DEFAULT_STYLE }]) {
      const file = new URL(`../src/application/site-templates/previews/${previewName(template.id, style.id)}`, import.meta.url);
      const bytes = await read(file);
      assert.equal(bytes.subarray(1, 4).toString(), "PNG", `${template.id}-${style.id} 的预览图不是 PNG`);
    }
  }
  // The style rides with the write, and an unknown one is refused rather than
  // quietly producing a site with no stylesheet.
  const { style } = await writeTemplate(directory, "dashboard", "tech");
  assert.equal(style, "tech");
  assert.match(await (await import("node:fs/promises")).readFile(path.join(directory, "site.css"), "utf8"), /科技/);
});

test("a site can change its look afterwards, and somebody's own stylesheet is not lost", async (t) => {
  const directory = await folder(t);
  await writeTemplate(directory, "dashboard", "clean");
  assert.equal(await styleOf(directory), "clean");
  const markup = await readFile(path.join(directory, "index.html"), "utf8");

  // Changing the look is changing one file, which is the whole reason two axes
  // are worth having: the structure and the behaviour are the scenario's.
  assert.deepEqual(await restyleSite(directory, "tech"), { style: "tech", was: "clean", changed: true, edited: false });
  assert.equal(await styleOf(directory), "tech");
  assert.equal(await readFile(path.join(directory, "index.html"), "utf8"), markup, "换风格不该动结构");
  assert.deepEqual(await restyleSite(directory, "tech"), { style: "tech", was: "tech", changed: false, edited: false },
    "换成它已经穿着的那一个，什么都不用做");

  // A stylesheet somebody wrote is their work: it is recognised by matching no
  // style this build ships, and it takes saying so to replace it.
  await writeFile(path.join(directory, "site.css"), "body{background:#000}");
  assert.equal(await styleOf(directory), null);
  await assert.rejects(() => restyleSite(directory, "clean"), /被改过了/);
  assert.equal(await readFile(path.join(directory, "site.css"), "utf8"), "body{background:#000}", "拒绝之后文件原样");
  assert.deepEqual(await restyleSite(directory, "clean", { force: true }), { style: "clean", was: null, changed: true, edited: true });
  assert.equal(await styleOf(directory), "clean");

  await assert.rejects(() => restyleSite(directory, "nope"), /没有这个风格/);
  await assert.rejects(() => restyleSite("relative", "clean"), /绝对路径/);
  // A folder with no stylesheet at all just gets one.
  const bare = path.join(directory, "bare");
  await (await import("node:fs/promises")).mkdir(bare);
  assert.equal(await styleOf(bare), null);
  assert.deepEqual(await restyleSite(bare, "depth"), { style: "depth", was: null, changed: true, edited: false });
});
