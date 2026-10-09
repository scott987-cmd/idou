import test from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { COMPRESS_REQUESTS_FROM, OLD_SERVER_DATA_BYTES, siteRequestBody } from "../src/application/site-requests.js";

// What the desktop sends a server (docs/sites-phase1.md §1.7): compressed only
// for a server that said it takes that, and a table's data past what the server
// keeps said in words before it goes.
const rows = (count) => Array.from({ length: count }, (_, at) => ({ id: `rec${at}`, values: { fldName: { text: `客户 ${at}`, kind: "text", value: `客户 ${at}` } } }));
const data = (count) => ({ schema: { fields: [] }, snapshot: { digest: "d", rows: rows(count) } });

test("compressed only for a server that said so, and only when it is worth it", async () => {
  const big = { siteId: "s1", ...data(2000) };
  const plain = await siteRequestBody("/v1/sites/data", big, { features: ["versions"] });
  assert.equal(plain.encoding, null, "an older server would refuse it as not JSON");
  assert.deepEqual(JSON.parse(plain.body), big);
  const zipped = await siteRequestBody("/v1/sites/data", big, { features: ["versions", "compressed-requests"] });
  assert.equal(zipped.encoding, "gzip");
  assert.deepEqual(JSON.parse(gunzipSync(zipped.body)), big);
  assert.ok(zipped.body.length * 5 < plain.body.length, `a table's data comes down a lot: ${zipped.body.length} of ${plain.body.length}`);
  const small = await siteRequestBody("/v1/sites/list", {}, { features: ["compressed-requests"] });
  assert.equal(small.encoding, null);
  assert.ok(Buffer.byteLength(JSON.stringify(big)) >= COMPRESS_REQUESTS_FROM);
  // Not asked yet: nothing assumed either way.
  assert.equal((await siteRequestBody("/v1/sites/data", big, { features: null })).encoding, null);
});

test("data past what the server keeps is refused here, in words", async () => {
  const body = { siteId: "s1", ...data(12_000) };
  const size = Buffer.byteLength(JSON.stringify(body));
  assert.ok(size > 1024 * 1024);
  const limits = { dataBytes: 1024 * 1024 };
  await assert.rejects(() => siteRequestBody("/v1/sites/data", body, { features: ["compressed-requests"], limits }), /这份表格数据有 1\.\d MB，超过了服务端能存的 1 MB：请在「文档网站」里减少行数或字段。$/);
  // A publish carries it too.
  await assert.rejects(() => siteRequestBody("/v1/sites/publish", { siteId: "s1", blobs: [], data: data(12_000) }, { features: [], limits }), /超过了服务端能存的 1 MB/);
  // A server too old to say keeps 8 MB, and is named as the thing to upgrade.
  const huge = { siteId: "s1", ...data(1) };
  huge.snapshot.rows[0].values.fldName.text = "x".repeat(OLD_SERVER_DATA_BYTES);
  await assert.rejects(() => siteRequestBody("/v1/sites/data", huge, { features: ["versions"] }), /超过了服务端能存的 8 MB：请在「文档网站」里减少行数或字段，或请管理员把服务端升级到能存更多数据的版本。/);
  // Not asked yet: the server answers for itself.
  assert.equal((await siteRequestBody("/v1/sites/data", huge, { features: null })).encoding, null);
  // Under the limit, sent.
  assert.equal((await siteRequestBody("/v1/sites/data", huge, { features: ["compressed-requests"], limits: { dataBytes: 32 * 1024 * 1024 } })).encoding, "gzip");
});
