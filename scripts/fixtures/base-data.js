// Synthetic CLI boundary for one Base table; never reads an account or contacts Feishu.
// Shapes follow what the pinned CLI returns (docs/feishu-base.md): string field
// types, and records as columns in the response's own field order.
export const BASE_TOKEN = "SyntheticBaseToken0001", BASE_TABLE = "tblSyntheticTable1";
export function baseDataFixture() {
  const state = { principal: "ou_base_fixture", tenant: "base_tenant", calls: [], reads: 0,
    names: { fldName00001: "名称", fldCount0001: "数量", fldOwner0001: "负责人" },
    records: {
      recSynthetic001: { fldName00001: "<img src=x onerror=window.__basePwned=true>探针一", fldCount0001: 1, fldOwner0001: [{ id: "ou_fixture_owner", name: "张三" }] },
      recSynthetic002: { fldName00001: "探针二", fldCount0001: 2, fldOwner0001: [] },
    } };
  const ok = data => ({ code: 0, stdout: JSON.stringify({ ok: true, identity: "user", data }), stderr: "" });
  const all = (argv, name) => argv.flatMap((value, i) => argv[i - 1] === name ? [value] : []);
  const order = ["fldName00001", "fldOwner0001", "fldCount0001"], types = { fldName00001: "text", fldCount0001: "number", fldOwner0001: "user" };
  const columns = (ids, fieldIds = order) => ({ data: ids.map(id => fieldIds.map(fieldId => state.records[id][fieldId] ?? null)), fields: fieldIds.map(id => state.names[id]),
    field_id_list: fieldIds, field_type_list: fieldIds.map(id => types[id]), record_id_list: ids, has_more: false, rev: 1 });
  const run = async (_binary, argv, options) => {
    state.calls.push(argv); options?.signal?.throwIfAborted();
    if (argv[0] === "auth") return { code: 0, stdout: JSON.stringify({ verified: true, identities: { user: { openId: state.principal, tenantKey: state.tenant, tokenStatus: "valid" } } }), stderr: "" };
    if (argv[0] !== "base") throw new Error("Unexpected fixture command; no live calls permitted");
    if (argv.includes("--help")) return { code: 0, stdout: `Usage: lark-cli base ${argv[1]} [flags]\n\nRisk: write\n`, stderr: "" };
    if (argv[1] === "+table-list") return ok({ tables: [{ id: BASE_TABLE, name: "客户台账", records_count: 2, rev: 1 }], total: 1 });
    if (argv[1] === "+field-list") {
      return ok({ fields: [{ id: "fldName00001", name: "名称", type: "text", style: { type: "plain" } }, { id: "fldCount0001", name: "数量", type: "number", style: { type: "plain", precision: 0 } },
        { id: "fldOwner0001", name: "负责人", type: "user", multiple: true }], total: 3 });
    }
    if (argv[1] === "+record-list") { state.reads++; return ok(columns(Object.keys(state.records))); }
    if (argv[1] === "+record-get") {
      const fields = all(argv, "--field-id");
      return ok(columns(all(argv, "--record-id").filter(id => state.records[id]), fields.length ? fields : undefined));
    }
    if (argv[1] === "+record-batch-update" && argv.includes("--dry-run")) {
      const update = JSON.parse(all(argv, "--json")[0]).update_records;
      return { code: 0, stdout: JSON.stringify({ ok: true, dry_run: true, data: { api: [{ method: "POST", url: `/open-apis/base/v3/bases/${BASE_TOKEN}/tables/${BASE_TABLE}/records/batch_update`, body: { update_records: update } }] } }), stderr: "" };
    }
    if (argv[1] === "+record-batch-update") {
      const update = JSON.parse(all(argv, "--json")[0]).update_records;
      const ids = Object.fromEntries(Object.entries(state.names).map(([id, name]) => [name, id]));
      for (const [recordId, fields] of Object.entries(update)) {
        if (!state.records[recordId]) throw new Error(`Unknown synthetic Base record: ${recordId}`);
        for (const [name, value] of Object.entries(fields)) {
          if (!ids[name]) throw new Error(`Unknown synthetic Base field: ${name}`);
          state.records[recordId][ids[name]] = value;
        }
      }
      return ok({ result: "success", ignored_fields: [] });
    }
    throw new Error("No Base write is implemented by this fixture");
  };
  return { state, run };
}
