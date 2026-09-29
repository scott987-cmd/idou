import test from "node:test";
import assert from "node:assert/strict";
import { SaasFeishuCliProvider } from "../src/providers/feishu/saas-cli-provider.js";
import { parseSaasDocumentReference, projectDocumentXml } from "../src/providers/feishu/document-format.js";

const url = "https://test.feishu.cn/docx/DocumentToken123";
const auth = { verified: true, identities: { user: { openId: "ou_test", tokenStatus: "valid", tenantKey: "tenant-test" } } };
const document = { document_id: "DocumentToken123", revision_id: 7, content: '<title>验证文档</title><p>第一段 &amp; 第二段</p><p>结论</p>' };
const result = (payload, code = 0) => ({ code, stdout: code === 0 ? JSON.stringify(payload) : "", stderr: code ? JSON.stringify(payload) : "" });

function provider(responses = [result(auth), result({ ok: true, identity: "user", data: { document } }), result(auth)]) {
  const calls = [], p = new SaasFeishuCliProvider();
  // Fixture replaces the process boundary only; no enterprise API is contacted.
  p.invoke = async (args) => { calls.push(args); if (!responses.length) throw new Error("Unexpected invocation"); return responses.shift(); };
  return { p, calls };
}

test("document read preserves user identity, version and anchored source; command is read-only", async () => {
  const { p, calls } = provider(); const doc = await p.readDocument(`${url}?from=share#share-anchor`);
  assert.equal(doc.sourceRevision, "7"); assert.equal(doc.sourceUrl, `${url}#share-anchor`);
  assert.equal(doc.title, "验证文档"); assert.match(doc.text, /第一段 & 第二段/); assert.equal(doc.partial, true);
  assert.equal(doc.identity.tenantKey, "tenant-test"); assert.match(doc.contentHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(calls[1], ["docs", "+fetch", "--doc", `${url}#share-anchor`, "--as", "user", "--doc-format", "xml", "--detail", "simple", "--format", "json"]);
  assert.equal(calls.filter((args) => args[0] === "auth").length, 2);
  assert.ok(calls.every((args) => !args.includes("+update") && !args.includes("login") && !args.includes("--yes")));
});

test("invalid source links fail before CLI access; supported wiki anchors remain intact", async () => {
  const { p, calls } = provider([]);
  for (const link of ["file:///secret", "http://test.feishu.cn/docx/DocumentToken123", "https://test.feishu.cn.evil.com/docx/DocumentToken123", "https://a:secret@test.feishu.cn/docx/DocumentToken123", "https://test.feishu.cn/base/BaseToken123", "https://test.feishu.cn:4433/docx/DocumentToken123", "https://test.feishu.cn/docx/DocumentToken123#../../x"]) await assert.rejects(p.readDocument(link));
  assert.equal(calls.length, 0);
  assert.equal(parseSaasDocumentReference("https://work.doubao.com/wiki/WikiNodeToken123#share-abc").partial, true);
});

test("keychain and permission errors never disclose raw hints, secrets or cached content", async () => {
  const secret = "NEVER_ECHO_THIS";
  const { p, calls } = provider([result({ ok: false, error: { message: "keychain not initialized", hint: secret } }, 1)]);
  const connection = await p.documentConnection(); assert.equal(connection.connected, false);
  assert.match(connection.message, /钥匙串/); assert.ok(!connection.message.includes(secret)); assert.equal(calls.length, 1);
  const denied = provider([result(auth), result({ ok: false, error: { type: "authorization", message: secret } }, 1)]);
  await assert.rejects(denied.p.readDocument(url), /没有这项权限/);
});

test("bot responses, account switches, missing revisions and wrong resource targets fail closed", async () => {
  for (const changed of [{ ...document, revision_id: undefined }, { ...document, document_id: "AnotherDocument" }]) {
    await assert.rejects(provider([result(auth), result({ ok: true, identity: "user", data: { document: changed } })]).p.readDocument(url));
  }
  await assert.rejects(provider([result(auth), result({ ok: true, identity: "bot", data: { document } })]).p.readDocument(url), /用户身份/);
  const switched = { ...auth, identities: { user: { openId: "ou_other", tokenStatus: "valid", tenantKey: "tenant-test" } } };
  await assert.rejects(provider([result(auth), result({ ok: true, identity: "user", data: { document } }), result(switched)]).p.readDocument(url), /身份已变化/);
});

test("unknown or expired user token status cannot be mistaken for a verified user", async () => {
  for (const tokenStatus of [undefined, "expired", "unknown"]) {
    const candidate = { ...auth, identities: { user: { ...auth.identities.user, tokenStatus } } };
    const { p, calls } = provider([result(candidate)]);
    await assert.rejects(p.readDocument(url), /尚未验证/); assert.equal(calls.length, 1);
  }
});

test("XML reader is inert, strict and honest about omitted embedded resources", () => {
  const projected = projectDocumentXml('<title>项目计划</title><p>安全 &lt;script&gt; 引用</p><script>alert(1)</script><sheet token="SheetToken" sheet-id="s1"/><fragment><p>部分内容</p></fragment>');
  assert.match(projected.text, /安全 <script> 引用/); assert.doesNotMatch(projected.text, /alert/);
  assert.equal(projected.resources[0].token, "SheetToken"); assert.equal(projected.partial, true); assert.equal(projected.warnings.length, 2);
  for (const invalid of ['<!DOCTYPE a [<!ENTITY e SYSTEM "file:///secret">]><p>&e;</p>', "<p>未关闭", "<p>&unknown;</p>", "<p>".repeat(70) + "</p>".repeat(70)]) assert.throws(() => projectDocumentXml(invalid));
});
