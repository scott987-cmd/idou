export function renderSheetGrid(root, sheet, element) {
  const table = element("table"), caption = element("caption", `${sheet.title} · ${sheet.range} · 只读范围快照`), head = element("thead"), headers = element("tr"), body = element("tbody");
  headers.append(element("th", "行 / 列"));
  for (const column of sheet.colIndices) { const th = element("th", column); th.scope = "col"; headers.append(th); }
  head.append(headers);
  for (let i = 0; i < sheet.rowIndices.length; i++) {
    const tr = element("tr"), row = sheet.rowIndices[i], label = element("th", String(row)); label.scope = "row"; tr.append(label);
    for (let j = 0; j < sheet.colIndices.length; j++) {
      const cell = sheet.cells[i][j], td = element("td", cell.value === null ? "" : String(cell.value));
      td.dataset.address = `${sheet.colIndices[j]}${row}`; td.title = `${td.dataset.address}${cell.unsupported ? " · 未展开" : ""}`; tr.append(td);
      if (cell.mergeRelated) { td.dataset.mergeRelated = "true"; td.append(element("small", "合并关联", "merge-marker")); td.title += " · 合并关联，非独立单元格；完整布局请查看飞书"; }
    }
    body.append(tr);
  }
  table.append(caption, head, body); root.replaceChildren(table);
}
import { sheetEditProposal } from "../../application/sheet-proposal.js";

export function renderSheetProposal(text, context, element) {
  const panel = element("section", undefined, "document-proposal sheet-proposal");
  let proposal; try { proposal = sheetEditProposal(text, context); } catch { panel.append(element("strong", "表格修改建议无效 · 未写入")); return panel; }
  panel.dataset.valid = "true";
  panel.append(element("strong", `逐格修改建议 · ${proposal.changes.length} 处 · 未写入`), element("small", `${context.title} · ${context.range} · 基于版本 ${context.sourceRevision}`));
  const cells = new Map(context.rows.flatMap(row => row.cells.map(cell => [cell.address, cell])));
  const display = value => value === null ? "空单元格" : `${typeof value === "string" ? "文本" : typeof value === "number" ? "数字" : "布尔"}：${JSON.stringify(value)}`;
  for (const change of proposal.changes) {
    const row = element("section", undefined, "sheet-change"); row.dataset.cell = change.address;
    const before = element("div"), after = element("div");
    before.append(element("small", "原值"), element("pre", display(cells.get(change.address).value)));
    after.append(element("small", "建议值"), element("pre", display(change.value)));
    row.append(element("strong", change.address), before, after); panel.append(row);
  }
  panel.append(element("small", "这是该版本的建议预览，不代表当前原表。点「核对并写入飞书表格」并确认之前，不会改动原表。"));
  return panel;
}
