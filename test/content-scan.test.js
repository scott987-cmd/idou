// What a published site is checked for (content-scan.js): each kind found
// where it is written, the near misses that are not it left alone, and no
// value ever kept -- only where, a masked sample and a keyed fingerprint.
// Every number here is synthetic: identity numbers built with a valid
// checksum, card numbers built to pass Luhn, phone numbers from no one.
import test from "node:test";
import assert from "node:assert/strict";
import { scanSite, validIdCard, luhn, mask, visibleText, countsText, cleanKeywords } from "../src/control-plane/content-scan.js";

// An identity number with a correct checksum, built rather than copied.
function idNumber(body17) {
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const sum = weights.reduce((total, weight, index) => total + weight * Number(body17[index]), 0);
  return body17 + "10X98765432"[sum % 11];
}
// A card number that passes Luhn, built from its first digits.
function cardNumber(prefix, length) {
  let digits = prefix.padEnd(length - 1, "0");
  for (let check = 0; check < 10; check += 1) if (luhn(digits + check)) return digits + check;
  throw new Error("unreachable");
}
const ID = idNumber("11010519900101123");
const CARD = cardNumber("6222", 19);
const page = (body) => ({ path: "index.html", bytes: Buffer.from(`<!doctype html><html><body>${body}</body></html>`) });
// Whatever is shaped like a credential is put together as the test runs, so
// this file holds none written out: the public repository's scan stops that shape.
const MODEL_KEY = ["sk", "proj", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6"].join("-");
const TOKEN = [{ alg: "HS256" }, { sub: "1234567890" }].map((part) => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".") + ".dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";

test("each kind is found where it is written, masked, with no value kept", () => {
  const files = [page(`<p>联系 13812345678</p>\n<p>身份证 ${ID}</p>\n<p>卡号 ${CARD.replace(/(\d{4})(?=\d)/g, "$1 ")}</p>\n<p>hr@example.com</p>`),
    { path: "app.js", bytes: Buffer.from(`const key = "${MODEL_KEY}";\nfetch(url, { headers: { authorization: "Bearer ${TOKEN}" } });`) }];
  const result = scanSite({ files, key: "server-key" });
  assert.deepEqual(result.counts, { secret: 2, idcard: 1, bankcard: 1, phone: 1, email: 1 });
  const by = Object.fromEntries(result.findings.map((finding) => [finding.category, finding]));
  assert.deepEqual([by.phone.where, by.idcard.where], ["index.html 第 1 行", "index.html 第 2 行"]);
  assert.deepEqual(result.findings.filter((finding) => finding.category === "secret").map((finding) => finding.where), ["app.js 第 1 行", "app.js 第 2 行"], "the key and the token, the token once");
  assert.equal(by.phone.sample, "138****5678");
  assert.equal(by.idcard.sample, `110***********${ID.slice(-4)}`);
  assert.match(by.bankcard.sample, /^\*\*\*\* \d{4}（19 位）$/);
  assert.equal(by.email.sample, "h***@example.com");
  const kept = JSON.stringify(result.findings);
  for (const value of ["13812345678", ID, CARD, "hr@example.com", "a1B2c3D4e5F6g7H8"]) assert.ok(!kept.includes(value), `${value} is not kept`);
  assert.match(by.phone.fingerprint, /^[0-9a-f]{32}$/);
  assert.notEqual(scanSite({ files, key: "another-key" }).findings[0].fingerprint, result.findings[0].fingerprint, "keyed: another server's fingerprint differs");
  assert.equal(countsText(result.counts), "2 处密钥或凭据、1 处身份证号、1 处银行卡号、1 处手机号、1 处邮箱地址");
});

test("what looks like them but is not stays unreported", () => {
  const ordinary = [
    "订单 20261002123456789 已发货",                // a long number that is no card and no identity
    `编号 ${ID.slice(0, 17)}5`,                       // an identity number with the wrong checksum
    "时间戳 1696230000000",                          // thirteen digits, not a phone
    "13812345678901",                                // fourteen digits running on
    `<img src="logo@2x.png">`,                        // a picture for sharp screens
    `<div class="${["sk", "folding-cube-loading-spinner-wrapper"].join("-")}">`, // a spinner's class
    "这一段没有任何敏感内容。",
  ].join("\n");
  const result = scanSite({ files: [page(ordinary)] });
  assert.deepEqual(result.findings, [], JSON.stringify(result.findings));
});

test("the table's data is read cell by cell, named by row and field", () => {
  const data = { schema: { fields: [{ id: "fld1", name: "客户" }, { id: "fld2", name: "联系电话" }] },
    snapshot: { digest: "d", rows: [{ id: "r1", values: { fld1: { kind: "text", value: "甲公司" }, fld2: { kind: "number", value: 13900001111 } } },
      { id: "r2", values: { fld1: { kind: "text", value: "乙公司" }, fld2: { kind: "text", value: "暂无" } } }] } };
  const result = scanSite({ files: [page("<p>客户名单</p>")], data });
  assert.deepEqual(result.findings.map((finding) => [finding.category, finding.where]), [["phone", "数据第 1 行 · 联系电话"]]);
  assert.match(result.text, /客户名单/);
  assert.match(result.text, /甲公司/, "what a reader sees, data included, for the reviewer that reads words");
});

test("an organisation's own words, without regard to case", () => {
  const words = cleanKeywords([" 机密 ", "Project Falcon", "机密", ""]);
  assert.deepEqual(words, ["机密", "Project Falcon"]);
  const result = scanSite({ files: [page("<p>机密：project falcon 的进度</p>")], keywords: words });
  assert.deepEqual(result.findings.map((finding) => [finding.category, finding.sample]), [["keyword", "机密"], ["keyword", "Project Falcon"]]);
  assert.throws(() => cleanKeywords(Array.from({ length: 201 }, (_, i) => `词${i}`)), /最多 200 个/);
});

test("what a reader sees of a page: no scripts, styles or markup, entities read", () => {
  assert.equal(visibleText(`<style>p{}</style><script>var x = "13812345678"</script><p>价格 &lt; 100&nbsp;元 &#20013;</p><!-- 备注 -->`), "价格 < 100 元 中");
  assert.ok(validIdCard(ID) && !validIdCard(`${ID.slice(0, 17)}0`.replace(/.$/, ID.endsWith("0") ? "1" : "0")));
  assert.equal(mask("secret", "sk-proj-abcdef0123456789"), "sk-p…（24 个字符）");
});

test("a big table is scanned in turns: the same answer, and the server answers others meanwhile", async () => {
  const { scanSiteInTurns } = await import("../src/control-plane/content-scan.js");
  const rows = Array.from({ length: 5000 }, (_, n) => ({ id: `r${n}`, values: { f1: { kind: "text", text: n === 4321 ? "联系 13812345678" : `客户 ${n}` } } }));
  const data = { schema: { fields: [{ id: "f1", name: "客户" }] }, snapshot: { rows } };
  let others = 0;
  const ticking = setInterval(() => { others += 1; }, 0);
  const result = await scanSiteInTurns({ data, keywords: ["机密"], key: "server-key" }).finally(() => clearInterval(ticking));
  assert.deepEqual(result, scanSite({ data, keywords: ["机密"], key: "server-key" }));
  assert.equal(result.findings[0].where, "数据第 4322 行 · 客户");
  assert.ok(others >= 3, `other work ran while it scanned: ${others}`);
});
