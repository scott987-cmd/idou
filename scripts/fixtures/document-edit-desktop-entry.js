// Synthetic Feishu transport and native dialogs; production services remain real.
import "../../src/adopt-legacy-env.js";
import { dialog } from "electron";
import { readFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { SaasFeishuCliProvider } from "../../src/providers/feishu/saas-cli-provider.js";
const f = globalThis.documentEditFixture = { revision: 1, writes: 0, calls: [], dialogs: [],
  xml: '<title>文档修改验收（合成）</title><p>请团队确认以下安排。</p><p><b>下周交付初稿</b>，保留这里的补充说明。</p><img token="SyntheticImageKeep"/>' };
const original = SaasFeishuCliProvider.prototype.invoke;
SaasFeishuCliProvider.prototype.invoke = async function(args, options) {
  f.calls.push(args);
  if (args[0] === "auth") return { code: 0, stdout: JSON.stringify({ verified: true, identities: { user: { openId: "synthetic-user", tenantKey: "synthetic-tenant", tokenStatus: "valid" } } }) };
  if (args[0] !== "docs") return original.call(this, args, options);
  const ok = data => ({ code: 0, stdout: JSON.stringify({ ok: true, identity: "user", data }) });
  if (args[1] === "+fetch") return ok({ document: { document_id: "SyntheticEditable123", revision_id: f.revision, content: f.xml } });
  assert.equal(args[1], "+update"); assert.equal(args[args.indexOf("--doc") + 1], "SyntheticEditable123");
  assert.equal(args[args.indexOf("--revision-id") + 1], String(f.revision)); assert.equal(args[args.indexOf("--command") + 1], "str_replace");
  assert.equal(args[args.indexOf("--as") + 1], "user"); assert.equal(args.includes("--yes"), false);
  const pattern = args[args.indexOf("--pattern") + 1], content = await readFile(path.join(options.cwd, "replacement.xml"), "utf8");
  assert.ok(f.xml.includes(pattern)); f.xml = f.xml.replace(pattern, content); f.revision++; f.writes++;
  if (f.lost) throw new Error("synthetic lost update acknowledgment");
  return ok({ result: "success", updated_blocks_count: 1, warnings: [], document: { revision_id: f.revision } });
};
// Confirming a document edit is an in-app card, not a native alert, so nothing
// here answers one on the script's behalf. The stub only records, and the
// script asserts it recorded nothing.
dialog.showMessageBox = async (_win, options) => { f.dialogs.push(options); return { response: 0 }; };
await import("../../src/desktop/main.js");
