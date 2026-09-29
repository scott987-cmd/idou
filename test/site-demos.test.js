import test from "node:test";
import assert from "node:assert/strict";
import { createSiteDemos } from "../src/control-plane/site-demos.js";
import { SITE_TEMPLATES, SITE_STYLES, DEFAULT_STYLE } from "../src/application/site-templates.js";

// The gallery at /demo: what this makes, for somebody who has not got the
// application. It is templates and invented rows, so what these check is that
// it really is only that -- and that every link on the index leads somewhere.
const demos = createSiteDemos();

test("every combination is a page, and the index links to all of them", async () => {
  const index = (await demos.index()).toString();
  const links = [...index.matchAll(/href="\/demo\/([a-z]+)-([a-z]+)\//g)].map(([, template, style]) => `${template}-${style}`);
  const expected = SITE_TEMPLATES.flatMap((template) =>
    (template.styled ? SITE_STYLES.map((style) => style.id) : [DEFAULT_STYLE]).map((style) => `${template.id}-${style}`));
  assert.deepEqual(links, expected);
  for (const combination of links) {
    const [template, style] = combination.split("-");
    const page = await demos.file(template, style, "");
    assert.ok(page, `${combination} 的首页打不开`);
    assert.equal(page.contentType, "text/html; charset=utf-8");
    assert.match(page.bytes.toString(), /<!doctype html>/i);
  }
  // Built once and kept: the bytes come from files the release manifest covers.
  assert.equal((await demos.index()).toString(), index);
});

test("a demo carries the table page's own files and an invented table", async () => {
  const page = (await demos.file("dashboard", "tech", "index.html")).bytes.toString();
  assert.match(page, /data\/table-data\.js/);
  const css = (await demos.file("dashboard", "tech", "site.css")).bytes.toString();
  assert.match(css, /科技/, "风格那一轴在样例里也是真的");
  const data = (await demos.file("dashboard", "tech", "data/table-data.js")).bytes.toString();
  assert.match(data, /北极星科技/, "样例里的数据是编的");
  const contract = JSON.parse(data.replace(/^globalThis\.__IDOU_TABLE__ = globalThis\.__MYDOUBAO_TABLE__ = /, "").replace(/;\n$/, ""));
  // A demo is a still life. Offering a refresh that can never arrive would be a
  // lie told by the page rather than by a person.
  assert.equal(contract.schema.endpoint, null);
  assert.equal(contract.schema.stream, null);
  assert.ok(contract.snapshot.rows.length > 0);
  // Nothing here came from an account: no token, no real table, no identity.
  assert.equal(/bascn[A-Za-z0-9]{10,}/.test(data), false, "样例里出现了像是真实表格的 token");
});

test("a path the gallery does not know is nothing, never a read of something else", async () => {
  assert.equal(await demos.file("dashboard", "tech", "../../../etc/passwd"), null);
  assert.equal(await demos.file("dashboard", "tech", "data/../site.css"), null, "只认它自己列出来的那些名字");
  assert.equal(await demos.file("nope", "tech", ""), null);
  assert.equal(await demos.file("dashboard", "nope", ""), null);
  // The game has no style axis, so it answers on exactly one name.
  assert.ok(await demos.file("game", DEFAULT_STYLE, ""));
  assert.equal(await demos.file("game", "tech", ""), null);
});
