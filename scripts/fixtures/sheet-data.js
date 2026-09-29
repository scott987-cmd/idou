// Synthetic CLI boundary; never reads an account or contacts Feishu.
export function sheetDataFixture() {
  const state = { revision: 1, principal: "ou_sheet_fixture", tenant: "sheet_tenant", denied: false, calls: [], reads: 0, merges: [] };
  const ok = data => ({ code: 0, stdout: JSON.stringify({ ok: true, identity: "user", data }), stderr: "" });
  const run = async (_binary, argv, options) => {
    state.calls.push(argv); options?.signal?.throwIfAborted();
    if (argv[0] === "auth") return { code: 0, stdout: JSON.stringify({ verified: true, identities: { user: { openId: state.principal, tenantKey: state.tenant, tokenStatus: "valid" } } }), stderr: "" };
    if (state.denied) return { code: 1, stdout: "", stderr: JSON.stringify({ ok: false, error: { type: "authorization", message: "SECRET fixture access denied" } }) };
    if (argv[0] === "api" && argv[1] === "GET" && /^\/open-apis\/sheets\/v3\/spreadsheets\/SyntheticSheet123\/sheets\/(sales|costs)$/.test(argv[2])) {
      await state.onLayout?.(options?.signal);
      const sheetId = argv[2].split("/").at(-1), data = { sheet: { sheet_id: sheetId, title: sheetId === "sales" ? "销售明细" : "费用明细", hidden: false, resource_type: "sheet", grid_properties: { row_count: 50, column_count: 4 }, merges: structuredClone(state.merges) } };
      return ok(state.transform ? state.transform("layout-get", data) : data);
    }
    if (argv[0] !== "sheets") throw new Error("Unexpected fixture command; no live calls permitted");
    // A write card is prepared from the CLI's own local help and dry run; the write itself still throws below.
    if (argv[1] === "+cells-set" && argv.includes("--help")) return { code: 0, stdout: "Usage: lark-cli sheets +cells-set [flags]\n\nRisk: write\n", stderr: "" };
    if (argv[1] === "+cells-set" && argv.includes("--dry-run")) {
      const flag = name => argv[argv.indexOf(name) + 1];
      return { code: 0, stdout: JSON.stringify({ ok: true, dry_run: true, data: { api: [{ method: "POST", url: "/open-apis/sheet_ai/v2/spreadsheets/SyntheticSheet123/tools/invoke_write",
        body: { input: JSON.stringify({ cells: JSON.parse(flag("--cells")), excel_id: "SyntheticSheet123", range: flag("--range"), sheet_id: flag("--sheet-id") }), tool_name: "set_cell_range" } }] } }), stderr: "" };
    }
    let data;
    if (argv[1] === "+revision-get") data = { revision: state.revision };
    else if (argv[1] === "+workbook-info") data = { sheets: [
      { sheet_id: "sales", title: "销售明细", resource_type: "sheet", is_hidden: false, row_count: 50, column_count: 4 },
      { sheet_id: "costs", title: "费用明细", resource_type: "sheet", is_hidden: false, row_count: 50, column_count: 4 },
      { sheet_id: "base1", title: "关联记录", resource_type: "bitable", is_hidden: false },
    ] };
    else if (argv[1] === "+cells-get") {
      state.reads++; await state.onRead?.(options?.signal);
      const requested = argv[argv.indexOf("--range") + 1], [, left, first, right, last] = /^([A-D])(\d+):([A-D])(\d+)$/.exec(requested);
      const row_indices = Array.from({ length: Number(last) - Number(first) + 1 }, (_, i) => Number(first) + i);
      const col_indices = Array.from({ length: right.charCodeAt(0) - left.charCodeAt(0) + 1 }, (_, i) => String.fromCharCode(left.charCodeAt(0) + i));
      const values = { A1: "项目", B1: "编号", C1: "金额", D1: "公式", A2: "研发\n协作", B2: "00123", C2: 1200.5, D2: "=C2*2", A3: "<img src=x onerror=window.__sheetPwned=true>", B3: false, C3: 0 };
      data = { warning_message: "", has_more: false, ranges: [{ actual_range: requested, row_indices, col_indices,
        cells: row_indices.map(row => col_indices.map(col => ({ value: values[`${col}${row}`] ?? null }))) }] };
    } else throw new Error("No spreadsheet write is implemented by this fixture");
    data.revision = state.revision;
    return ok(state.transform ? state.transform(argv[1], data) : data);
  };
  return { state, run };
}
