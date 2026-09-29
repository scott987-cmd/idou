import test from "node:test";
import assert from "node:assert/strict";
import { SaasBaseReader, BASE_COVERAGE } from "../src/providers/feishu/base-reader.js";

// 一张多维表格有好几页记录：以前只存第一页，后面的行问不到。
const URL = "https://test.feishu.cn/base/BasToken12345?table=tblSynthetic001";
const ok = (data) => ({ code: 0, stdout: JSON.stringify({ ok: true, identity: "user", data }), stderr: "" });

function provider(total) {
  const calls = [];
  return {
    calls,
    id: "saas-cli",
    documentIdentity: async () => ({ tenantKey: "tenant-a", principal: "alice", verifiedAt: 1 }),
    invoke: async (argv) => {
      // The pinned CLI takes a read's query as --params, never in the path.
      assert.doesNotMatch(argv[2], /[?#]/);
      const target = argv[3] === "--params" ? `${argv[2]}?${new URLSearchParams(JSON.parse(argv[4]))}` : argv[2];
      calls.push(target);
      if (/\/apps\/BasToken12345$/.test(target)) return ok({ app: { name: "商机库" } });
      if (target.includes("/tables?")) return ok({ items: [{ table_id: "tblSynthetic001", name: "商机" }], has_more: false });
      if (target.includes("/fields?")) return ok({ items: [{ field_name: "客户" }, { field_name: "金额" }, { field_name: "阶段" }], has_more: false });
      if (target.includes("/records?")) {
        const query = new URLSearchParams(target.split("?")[1]);
        const from = query.get("page_token") ? Number(query.get("page_token").replace("next-", "")) : 0;
        const size = Number(query.get("page_size"));
        const to = Math.min(total, from + size);
        const items = Array.from({ length: to - from }, (_, index) => ({ record_id: `rec${from + index}`,
          fields: { 客户: `客户${from + index}`, 金额: (from + index) * 3, 阶段: (from + index) % 2 ? "谈判" : "签约" } }));
        return ok({ items, has_more: to < total, ...(to < total ? { page_token: `next-${to}` } : {}) });
      }
      throw new Error(`fixture refuses ${target}`);
    },
  };
}

test("一千一百条记录分三页读全，不再只存第一页", async () => {
  const p = provider(1100);
  const table = await new SaasBaseReader(p).read(URL);
  assert.equal(table.records.length, 1100);
  assert.equal(table.records[1099].values[0], "客户1099");
  assert.equal(table.truncated, false);
  const pages = p.calls.filter((target) => target.includes("/records?"));
  assert.equal(pages.length, 3);
  assert.ok(pages[1].includes("page_token=next-500") && pages[2].includes("page_token=next-1000"));
});

test("超过条数或字数上限时停在那里，并标明不是整张表", async () => {
  const many = await new SaasBaseReader(provider(5000)).read(URL);
  assert.equal(many.records.length, BASE_COVERAGE.maxRecords);
  assert.equal(many.truncated, true);
  const wordy = await new SaasBaseReader(provider(1100)).read(URL, { coverage: { ...BASE_COVERAGE, maxChars: 2_000 } });
  assert.ok(wordy.records.length > 0 && wordy.records.length < 1100);
  assert.equal(wordy.truncated, true);
});
