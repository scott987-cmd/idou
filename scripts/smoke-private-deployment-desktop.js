import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { ensureTask, openFeishuResource, openFileMenuItem } from "./fixtures/open-document.js";
import { PRIVATE_DOMAIN, PRIVATE_ID, privateToken, privateUser } from "./fixtures/private-feishu.js";

// The same desktop, told by name to talk to a Feishu deployment this build does
// not ship (scripts/fixtures/private-feishu.js): its own domains, identifier
// rules and link shapes, no document search, no spreadsheets, no Base and no
// application bot. No application code is changed for it -- a module hook only
// lets the registry hand that deployment out.
//
// What this proves: the interface says what the deployment lacks before anyone
// tries, a lacking capability is refused with its reason rather than answered
// from Feishu SaaS, and the deployment's own documents open, are quoted and are
// kept in the knowledge copy only while their reader may still read them. What
// it does not prove: anything about a real private Feishu, whose CLI does not
// exist yet. Synthetic data only; nothing leaves the machine.
const directory = await mkdtemp(path.join(os.tmpdir(), "idou-private-deployment-"));
const evidence = path.resolve("docs/evidence"); await mkdir(evidence, { recursive: true });
const TOKEN = privateToken("private-smoke-document");
const LINK = `https://docs.${PRIVATE_DOMAIN}/d/${TOKEN}`;
let app;
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`); if (!ok) throw new Error(`${name}${detail ? `: ${detail}` : ""}`); };
try {
  app = await electron.launch({ executablePath: electronBinary, args: [path.resolve("scripts/fixtures/private-desktop-entry.js")],
    env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), IDOU_DESKTOP_DATA_DIR: directory, IDOU_FEISHU_PROVIDER: PRIVATE_ID } });
  const page = await app.firstWindow(); page.setDefaultTimeout(20_000);
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await app.evaluate((_electron, { token, user }) => {
    globalThis.privateDeploymentFixture.documents.set(token, { title: "私有化回款制度（合成）", text: "回款以银行到账日为准，逾期三十天需升级。", revision: 7, readers: [user] });
  }, { token: TOKEN, user: privateUser("alice") });
  await page.locator("#new-task").waitFor();

  const resolved = await app.evaluate(() => globalThis.privateDeploymentFixture.resolved);
  check("the desktop asked the registry for the deployment it was configured with", resolved.includes(PRIVATE_ID), resolved.join(","));
  const deployment = await page.evaluate(() => window.idou.feishuDeployment());
  check("the interface is told which deployment this is", deployment.id === PRIVATE_ID && deployment.label.includes("私有化"));
  check("and what it lacks, with reasons", ["documentSearch", "sheets", "base", "botMessages"].every((key) => /不提供/.test(deployment.unavailable[key] ?? "")),
    Object.keys(deployment.unavailable).join(","));

  await ensureTask(page);
  await openFileMenuItem(page, "#show-document-url");
  const sheetOption = page.locator('#resource-kind option[value="sheet"]'), baseOption = page.locator('#resource-kind option[value="base"]');
  check("spreadsheets are offered as unavailable, with the reason", await sheetOption.isDisabled() && /当前飞书部署不提供/.test(await sheetOption.innerText())
    && /不提供「电子表格」/.test(await sheetOption.getAttribute("title")));
  check("Base is offered as unavailable too", await baseOption.isDisabled());
  check("the box says search is not available here", /不提供搜索/.test(await page.locator("#document-url").getAttribute("placeholder")));
  await page.locator("#document-url").fill("回款");
  await page.locator("#document-url").press("Enter");
  await page.locator("#error-banner").filter({ hasText: /不提供「搜索飞书文档」/ }).waitFor();
  check("a keyword is refused with the deployment's reason, and nothing is searched", (await page.locator("#document-search-results").count()) === 0
    || (await page.locator("#document-search-results > *").count()) === 0);

  // Another deployment's link is not this one's document.
  await openFeishuResource(page, "https://contract.feishu.cn/docx/ContractDocToken1");
  await page.locator("#error-banner").filter({ hasText: /私有化部署的文档链接/ }).waitFor();
  check("a Feishu SaaS link is refused as not this deployment's", true);

  await openFeishuResource(page, LINK);
  await page.locator("#file-title").filter({ hasText: "私有化回款制度" }).waitFor();
  check("the deployment's own document opens", /银行到账日/.test(await page.locator("#file-content").inputValue()));
  check("with its revision", /版本 7/.test(await page.locator("#document-meta").innerText()));
  await page.locator("#file-content").evaluate((input) => { const start = input.value.indexOf("逾期"); input.focus(); input.setSelectionRange(start, start + 7); });
  await page.locator("#quote-selection").click();
  check("and can be quoted", /已选 7 字/.test(await page.locator("#context-label").innerText()));
  await page.screenshot({ path: path.join(evidence, "desktop-private-deployment-fixture.png"), scale: "css" });

  await page.locator('[data-section="knowledge"]').click();
  await page.locator("#knowledge-query").fill("银行到账"); await page.locator("#search-knowledge").click();
  await page.locator(".knowledge-card").waitFor();
  check("the knowledge copy answers from it", /银行到账日/.test(await page.locator(".knowledge-card").innerText()));
  await app.evaluate((_electron, token) => { globalThis.privateDeploymentFixture.documents.get(token).readers = []; }, TOKEN);
  await page.locator("#knowledge-query").fill("逾期"); await page.locator("#search-knowledge").click();
  await page.locator("#knowledge-status").filter({ hasText: "已核验 0" }).waitFor();
  check("and stops the moment its reader may no longer read it", (await page.locator(".knowledge-card").count()) === 0);
  check("no page script error", errors.length === 0, errors.join(" | "));
  console.log(`\n${results.length} checks passed against ${PRIVATE_ID}; a real private Feishu remains unverified.`);
} finally {
  await app?.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
