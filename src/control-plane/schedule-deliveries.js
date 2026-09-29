// Where a scheduled task's result goes besides its owner's own Drive space and
// chat (2026-09-28): at most three places the person chose when they created
// or edited the task -- a document to append each result to, a chat (a group or
// a one-to-one conversation) to send it to. By default a task only reads; this
// is the person's authorization for it to write out, to exactly these places,
// with no card at run time. The run cannot name a place, and never learns
// these: the control plane writes after the run is over, as the owner, reading
// the list again at that moment (schedule-delivery.js), so a place taken off the
// list is not written to by a run already under way.
//
// Stored beside the task, not inside its read grant (schedule-capability.js):
// an older build validates that grant key by key and would pause every task it
// found one it did not know in. A column it does not select is invisible to it.
export const MAX_DELIVERIES = 3;
const DOCUMENT_ID = /^[A-Za-z0-9]{8,64}$/;
const CHAT_ID = /^oc_[A-Za-z0-9_-]{1,128}$/;
const label = (value) => (typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 120) : "");

// A stored list, checked the same way wherever it is read: a document by its id
// and the link it was chosen by, a chat by its id; each with the name the
// person saw. Sorted -- documents first, the order they are written in, since a
// chat's message links the document -- so the same choice is always the same list.
export function scheduleDeliveries(value) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_DELIVERIES) throw new Error(`结果最多写到 ${MAX_DELIVERIES} 个地方`);
  const seen = new Set(), rows = [];
  for (const row of value) {
    if (row?.kind === "document") {
      let url; try { url = new URL(row.reference); } catch { throw new Error("写入的文档链接无效"); }
      if (!DOCUMENT_ID.test(row.id ?? "") || url.protocol !== "https:" || url.username || url.password || url.href.length > 2048) throw new Error("写入的文档无效");
      if (Object.keys(row).some((key) => !["kind", "id", "reference", "label"].includes(key))) throw new Error("写入的文档无效");
      if (!seen.has(`document\n${row.id}`)) rows.push({ kind: "document", id: row.id, reference: url.href, label: label(row.label) || url.href });
      seen.add(`document\n${row.id}`);
    } else if (row?.kind === "chat") {
      if (!CHAT_ID.test(row.id ?? "") || Object.keys(row).some((key) => !["kind", "id", "label"].includes(key))) throw new Error("写入的会话要用 oc_ 开头的会话 ID");
      if (!seen.has(`chat\n${row.id}`)) rows.push({ kind: "chat", id: row.id, label: label(row.label) || row.id });
      seen.add(`chat\n${row.id}`);
    } else throw new Error("结果只能写到文档（document）或会话（chat）");
  }
  const order = { document: 0, chat: 1 };
  return rows.sort((a, b) => order[a.kind] - order[b.kind] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// What a desktop or a draft sends before it is resolved: a document by its link
// (the server finds its id and proves the person may edit it), a chat by its id.
export function deliveryRequests(value) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_DELIVERIES) throw new Error(`结果最多写到 ${MAX_DELIVERIES} 个地方`);
  return value.map((row) => {
    if (row?.kind === "document") {
      if (typeof row.reference !== "string" || !row.reference.startsWith("https://") || row.reference.length > 2048) throw new Error("写入的文档要给完整的 https 链接");
      return { kind: "document", reference: row.reference, label: label(row.label) };
    }
    if (row?.kind === "chat") {
      if (!CHAT_ID.test(row.id ?? "")) throw new Error("写入的会话要用 oc_ 开头的会话 ID");
      return { kind: "chat", id: row.id, label: label(row.label) };
    }
    throw new Error("结果只能写到文档（document）或会话（chat）");
  });
}
