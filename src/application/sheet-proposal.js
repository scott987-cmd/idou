// Inert draft data only. This module grants no write authority and emits no CLI payload.
export function sheetEditProposal(text, context) {
  const invalid = () => { throw new Error("表格建议无效：仅支持当前范围内最多 20 个普通单元格的值替换；不支持公式、复杂或合并关联单元格及结构修改。"); };
  if (typeof text !== "string" || text.length > 16000 || context?.kind !== "feishu-sheet" || context.intent !== "propose-edit" || context.truncated || !Array.isArray(context.rows)) return invalid();
  let proposal; try { proposal = JSON.parse(text); } catch { return invalid(); }
  if (!proposal || Array.isArray(proposal) || Object.keys(proposal).sort().join(",") !== "changes,kind" || proposal.kind !== "feishu-sheet-edit" || !Array.isArray(proposal.changes) || !proposal.changes.length || proposal.changes.length > 20) return invalid();
  const cells = new Map(context.rows.flatMap(row => row.cells.map(cell => [cell.address, cell]))), seen = new Set();
  const scalar = value => typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) || (typeof value === "string" && value.length <= 2000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) && !/^\s*=/.test(value));
  const changes = proposal.changes.map(change => {
    if (!change || Array.isArray(change) || Object.keys(change).sort().join(",") !== "address,value" || typeof change.address !== "string" || !/^[A-Z]{1,2}[1-9][0-9]{0,4}$/.test(change.address) || seen.has(change.address)) return invalid();
    const original = cells.get(change.address);
    if (!original || original.unsupported || original.mergeRelated || original.formula || (original.value !== null && !scalar(original.value)) || !scalar(change.value) || Object.is(original.value, change.value)) return invalid();
    seen.add(change.address); return { address: change.address, value: change.value };
  });
  return { kind: "feishu-sheet-edit", changes };
}
