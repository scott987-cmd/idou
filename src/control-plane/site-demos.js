// The demo gallery the site listener serves at /demo.
//
// What this exists for: somebody who does not have the application -- a
// colleague, whoever is deciding whether this is worth turning on -- opening a
// link and seeing what the thing makes. A screenshot cannot tell you whether
// the sorting works.
//
// What it is made of is only what this build already ships: the templates
// themselves, and a table of invented rows (site-sample.js). It never reads the
// registry, never reads Feishu, and holds nothing of anybody's, so there is no
// data here to get wrong. It is still behind the listener's own sign-in --
// site-server.js decides that, not this file.
//
// Built once on first use and kept in memory: the bytes come from files inside
// src/, which the release manifest covers, so they cannot change under a
// running process.
import { SITE_TEMPLATES, SITE_STYLES, DEFAULT_STYLE, siteTemplate, siteStyle, templateFiles } from "../application/site-templates.js";
import { contractFiles } from "../application/table-contract.js";
import { readBaseSlice } from "../application/table-snapshot.js";
import { SAMPLE_SLICE, SAMPLE_TITLE, SAMPLE_READ_AT, sampleRecords } from "../application/site-sample.js";
import { siteContentType } from "./site-registry.js";

const escape = (value) => String(value).replace(/[&<>"]/g, (character) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);

export function createSiteDemos({ renderCell = null } = {}) {
  const built = new Map();
  let index = null;

  // One combination's files, the same ones writeTemplate would put in a folder,
  // plus the contract a table page reads. Nothing is written to disk.
  async function build(templateId, styleId) {
    const key = `${templateId}-${styleId}`;
    if (built.has(key)) return built.get(key);
    const template = siteTemplate(templateId);
    const files = new Map();
    for (const file of await templateFiles(templateId, styleId)) files.set(file.name, file.bytes);
    if (template.table) {
      const { schema, snapshot } = await readBaseSlice(SAMPLE_SLICE, sampleRecords(),
        { renderCell, title: SAMPLE_TITLE, now: () => SAMPLE_READ_AT });
      // No endpoint and no stream: a demo is a still life. It is not following
      // anything, and offering a refresh that can never arrive would be a lie
      // told by a page rather than by a person.
      //
      // And no source identifiers. The sample's token is invented, but a page
      // served to people outside the product should not carry a string shaped
      // like a table's address at all -- the only part of the source a page
      // uses is its title.
      const shown = { ...schema, endpoint: null, stream: null, source: { kind: schema.source.kind, title: schema.source.title } };
      for (const [name, bytes] of contractFiles({ schema: shown, snapshot })) {
        files.set(name, Buffer.from(bytes));
      }
    }
    built.set(key, files);
    return files;
  }

  return {
    // Every combination, as a gallery. Plain links: this page is served to a
    // browser that may have nothing to do with the product.
    async index() {
      if (index) return index;
      const cards = [];
      for (const template of SITE_TEMPLATES) {
        for (const style of template.styled ? SITE_STYLES : [{ id: DEFAULT_STYLE, name: "" }]) {
          cards.push(`<li><a href="/demo/${template.id}-${style.id}/"><strong>${escape(template.name)}</strong>`
            + `${style.name ? `<em>${escape(style.name)}</em>` : ""}`
            + `<span>${escape(template.summary)}</span></a></li>`);
        }
      }
      index = Buffer.from(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>样例</title>
<style>
:root{color-scheme:light dark;--bg:#f4f6f6;--paper:#fff;--ink:#16201f;--muted:#62736f;--line:#dfe6e4;--accent:#0f766e}
@media (prefers-color-scheme:dark){:root{--bg:#0e1413;--paper:#161e1d;--ink:#e9efed;--muted:#8fa4a0;--line:#26302e;--accent:#5eead4}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,-apple-system,"PingFang SC","Hiragino Sans GB",sans-serif}
main{max-width:1000px;margin:0 auto;padding:48px 20px 72px}
h1{margin:0 0 8px;font-size:clamp(24px,5vw,32px);font-weight:600;letter-spacing:-.02em}
.lead{margin:0 0 32px;color:var(--muted);max-width:56ch}
ul{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}
a{display:flex;flex-direction:column;gap:4px;padding:18px 20px;background:var(--paper);border:1px solid var(--line);
  border-radius:14px;text-decoration:none;color:inherit}
a:hover{border-color:var(--accent)}
strong{font-size:16px;font-weight:600}
em{font-style:normal;font-size:12px;color:var(--accent)}
span{font-size:13px;color:var(--muted)}
footer{margin-top:36px;font-size:12px;color:var(--muted)}
</style></head><body><main>
<h1>样例</h1>
<p class="lead">下面每一个都能直接点开来用：可以排序、筛选、搜索，游戏可以玩。页面里的数据是编的，不是任何人的表格。</p>
<ul>${cards.join("")}</ul>
<footer>这些是「文档网站」里现成的模版。接上你自己的飞书表格之后，数值会跟着表格走。</footer>
</main></body></html>`);
      return index;
    },

    // One file of one demo. Only the names that combination actually has: a
    // path this does not know is a 404, never a read of something else.
    async file(templateId, styleId, rest) {
      const template = siteTemplate(templateId);
      if (!template) return null;
      if (template.styled && !siteStyle(styleId)) return null;
      if (!template.styled && styleId !== DEFAULT_STYLE) return null;
      const files = await build(template.id, template.styled ? styleId : DEFAULT_STYLE);
      const name = !rest || rest === "/" ? "index.html" : rest;
      const bytes = files.get(name);
      if (!bytes) return null;
      return { path: name, bytes, contentType: siteContentType(name) };
    },
  };
}
