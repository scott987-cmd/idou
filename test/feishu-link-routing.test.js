// Where a link an embedded Feishu page opens goes (src/desktop/feishu-link-routing.js).
// Reported 2026-09-27: in 飞书消息, a document link in a conversation replaced
// the conversation with the document, and the section was unusable after that.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { divertsFromMessenger, routeFeishuLink } from "../src/desktop/feishu-link-routing.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";

const feishuPage = (value) => SAAS_FEISHU.web.pageUrl(value);
const resource = (value) => SAAS_FEISHU.references.resource(value);

const DOCUMENTS = [
  "https://tenant.feishu.cn/docx/AbCdEfGhIjKlMnOpQrStUvWxYz1",
  "https://tenant.feishu.cn/sheets/AbCdEfGhIjKlMnOpQrStUvWxYz1?sheet=20RQ2y",
  "https://tenant.feishu.cn/base/AbCdEfGhIjKlMnOpQrStUvWxYz1?table=tbl123",
  "https://tenant.feishu.cn/wiki/AbCdEfGhIjKlMnOpQrStUvWxYz1",
];
const MESSENGER_PAGES = [
  "https://tenant.feishu.cn/next/messenger/",
  "https://accounts.feishu.cn/accounts/page/login?app_id=1&redirect_uri=https%3A%2F%2Ftenant.feishu.cn%2Fnext%2Fmessenger%2F",
];

test("a document linked in a conversation opens in 飞书文档, and the conversation stays", () => {
  for (const target of DOCUMENTS) {
    assert.equal(feishuPage(target), true, `a page the views may show: ${target}`);
    assert.equal(routeFeishuLink({ kind: "messenger", target, visible: true, feishuPage }), "docs", target);
  }
});

test("any other Feishu page a conversation opens goes there too, never over the conversation", () => {
  for (const target of ["https://tenant.feishu.cn/calendar/", "https://tenant.feishu.cn/next/messenger/"]) {
    assert.equal(routeFeishuLink({ kind: "messenger", target, visible: true, feishuPage }), "docs", target);
  }
});

test("a messenger that is not on screen moves nothing", () => {
  for (const target of [...DOCUMENTS, "https://example.com/"]) {
    const route = routeFeishuLink({ kind: "messenger", target, visible: false, feishuPage });
    assert.notEqual(route, "docs", target);
    assert.notEqual(route, "here", target);
  }
});

test("飞书文档 and a task's document view open their links in place, as they always did", () => {
  for (const kind of ["drive", "document"]) {
    for (const target of DOCUMENTS) assert.equal(routeFeishuLink({ kind, target, visible: true, feishuPage }), "here", `${kind}: ${target}`);
  }
});

test("a link out of Feishu goes to the system browser from any view, and anything not https goes nowhere", () => {
  for (const kind of ["messenger", "drive", "document"]) {
    assert.equal(routeFeishuLink({ kind, target: "https://example.com/page", visible: true, feishuPage }), "external", kind);
    for (const target of ["http://tenant.feishu.cn/docx/AbCdEfGhIjKlMnOpQrStUvWxYz1", "javascript:alert(1)", "file:///etc/passwd", "", undefined]) {
      assert.equal(routeFeishuLink({ kind, target, visible: true, feishuPage }), "ignore", `${kind}: ${String(target)}`);
    }
  }
});

test("the messenger's own page is diverted only when it would leave for a document", () => {
  for (const target of DOCUMENTS) assert.equal(divertsFromMessenger({ kind: "messenger", target, feishuPage, resource }), true, target);
  // Its own addresses and Feishu's sign-in must go on as before.
  for (const target of MESSENGER_PAGES) assert.equal(divertsFromMessenger({ kind: "messenger", target, feishuPage, resource }), false, target);
  for (const kind of ["drive", "document"]) {
    for (const target of DOCUMENTS) assert.equal(divertsFromMessenger({ kind, target, feishuPage, resource }), false, `${kind}: ${target}`);
  }
});

// The rule only helps if the views use it. Read from the main process's
// source, since the views cannot be built outside Electron.
test("every embedded Feishu view asks the rule before opening or following a link", async () => {
  const main = await readFile(new URL("../src/desktop/main.js", import.meta.url), "utf8");
  const build = main.slice(main.indexOf("const buildFeishuView = async"), main.indexOf("const hideFeishuView"));
  assert.ok(build.length > 1000, "the view builder is where it was");
  const opener = /setWindowOpenHandler\(\(\{ url: asked \}\) => \{([\s\S]*?)return \{ action: "deny" \};/.exec(build)?.[1] ?? "";
  // A report link written in the old form is repaired before anything decides
  // where it goes (drive-files.js, 2026-09-29), so the rule sees the real page.
  assert.match(opener, /const target = feishuProvider\.repairedLink\(asked\);[\s\S]*routeFeishuLink\(\{ kind, target/, "new windows are repaired, then routed");
  assert.doesNotMatch(opener.replace(/if \(route === "here"\) void contents\.loadURL\(target\)/, ""), /contents\.loadURL\((target|asked)\)/, "and loaded in place only when the rule says so");
  const navigate = /contents\.on\("will-navigate", \(event, asked\) => \{([\s\S]*?)\n    \}\);/.exec(build)?.[1] ?? "";
  assert.match(navigate, /const target = feishuProvider\.repairedLink\(asked\);[\s\S]*if \(!feishuPage\(target\)\)/, "a page followed in place is repaired before it is judged");
  assert.match(navigate, /divertsFromMessenger\(\{ kind, target, feishuPage, resource: \(value\) => feishuProvider\.references\.resource\(value\) \?\? driveFileAt\(value\) \}\)/, "a document or Drive file followed in place is diverted");
});
