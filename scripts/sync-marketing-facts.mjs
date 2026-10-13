import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.dirname(here);
const filmFacts = path.resolve(site, "../剪辑/promo2/scenes/facts.js");
const facts = JSON.parse(readFileSync(path.join(site, "marketing-facts.json"), "utf8"));

const generated = `// Generated from ../../../github-page/marketing-facts.json by
// github-page/scripts/sync-marketing-facts.mjs. Do not edit by hand.
export const FACTS = ${JSON.stringify({
  tests: facts.release.strictGatePassed,
  releaseId: facts.release.id,
  securityTestFiles: facts.source.securityTestFiles,
  srcFiles: facts.source.files,
  srcLines: facts.source.lines,
  npmPackages: facts.dependencies.total,
  licenses: facts.dependencies.licenses,
  codexVersion: facts.upstreams.codex,
  larkCliVersion: facts.upstreams.larkCli,
  nodeVersion: facts.upstreams.node,
  electronVersion: facts.upstreams.electron,
  knowledgeCurrentDocumentHitPercent: facts.knowledge.nearDuplicateCurrentDocumentHitPercent,
  templates: 10,
  styles: 3,
}, null, 2)};\n`;
writeFileSync(filmFacts, generated);

const html = readFileSync(path.join(site, "index.html"), "utf8");
const readme = readFileSync(path.join(site, "README.md"), "utf8");
const required = [
  `${facts.release.strictGatePassed.toLocaleString("en-US")} / ${facts.release.strictGateTotal.toLocaleString("en-US")}`,
  facts.release.id,
  `${facts.dependencies.total} 个 npm 依赖`,
  `MIT ${facts.dependencies.licenses[0][1]}`,
  facts.upstreams.codex,
  facts.upstreams.larkCli,
  `${facts.admin.syntheticPeople.toLocaleString("en-US")}<small>人</small>`,
  `${facts.knowledge.nearDuplicateCurrentDocumentHitPercent}<small>%</small>`,
];
for (const value of required) {
  if (!html.includes(value)) throw new Error(`index.html is not synchronized with marketing-facts.json: ${value}`);
}
const forbidden = ["8 / 10", "17 → 27", "43→75", "68→75", "飞书官方 CLI", "企业部署平台尚未具备", "登录即用"];
for (const [name, content] of [["index.html", html], ["README.md", readme]]) {
  for (const value of forbidden) {
    if (content.includes(value)) throw new Error(`stale or misleading marketing copy remains in ${name}: ${value}`);
  }
}
console.log(`marketing facts synchronized for ${facts.release.id}`);
