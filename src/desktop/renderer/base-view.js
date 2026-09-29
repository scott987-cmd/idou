import { baseEditProposal } from "../../application/base-proposal.js";

// One page of a Base table as the person reads it: a row per record, a column per
// field. Values are text content only; nothing a record holds becomes markup.
export function renderBaseGrid(root, base, element) {
  const table = element("table"), head = element("thead"), headers = element("tr"), body = element("tbody");
  const span = base.records.length ? `第 ${base.offset + 1}–${base.offset + base.records.length} 条` : "这一页没有记录";
  table.append(element("caption", `${base.title} · ${span}${base.more ? " · 后面还有" : ""} · 只读快照`));
  headers.append(element("th", "记录"));
  for (const field of base.fields) {
    const th = element("th", field.name); th.scope = "col";
    if (!field.writable) { th.title = `${field.name} · 这类字段只能查看，不能在这里修改`; th.dataset.readonly = "true"; }
    headers.append(th);
  }
  head.append(headers);
  for (const record of base.records) {
    const tr = element("tr"), label = element("th", record.id); label.scope = "row"; tr.append(label);
    record.cells.forEach((cell, index) => {
      const td = element("td", cell.text ?? ""); td.dataset.record = record.id; td.dataset.field = base.fields[index].name;
      if (cell.unsupported) td.title = "这一格只显示文字，不能在这里修改";
      tr.append(td);
    });
    body.append(tr);
  }
  table.append(head, body); root.replaceChildren(table);
}

export function renderBaseProposal(text, context, element) {
  const panel = element("section", undefined, "document-proposal sheet-proposal base-proposal");
  let proposal; try { proposal = baseEditProposal(text, context); } catch { panel.append(element("strong", "多维表格修改建议无效 · 未写入")); return panel; }
  panel.dataset.valid = "true";
  panel.append(element("strong", `记录修改建议 · ${proposal.changes.length} 处 · 未写入`),
    element("small", `${context.title} · 第 ${context.offset + 1}–${context.offset + context.rows.length} 条 · 内容摘要 ${context.sourceRevision}`));
  const rows = new Map(context.rows.map(row => [row.record, row]));
  const display = value => value === null || value === undefined ? "空" : `${typeof value === "string" ? "文本" : "数字"}：${JSON.stringify(value)}`;
  for (const change of proposal.changes) {
    const row = rows.get(change.record), cell = row.cells.find(item => item.field === change.field);
    const known = row.cells.find(item => typeof item.value === "string" && item.value.trim());
    const section = element("section", undefined, "sheet-change"); section.dataset.record = change.record; section.dataset.field = change.field;
    const before = element("div"), after = element("div");
    before.append(element("small", "原值"), element("pre", display(cell.value)));
    after.append(element("small", "建议值"), element("pre", display(change.value)));
    section.append(element("strong", `${change.record}${known ? `（${known.field}：${known.value.trim().slice(0, 40)}）` : ""} ·「${change.field}」`), before, after);
    panel.append(section);
  }
  panel.append(element("small", "这是这一页的建议预览，不代表当前多维表格。点「核对并写入飞书多维表格」并确认之前，不会改动原表。"));
  return panel;
}
