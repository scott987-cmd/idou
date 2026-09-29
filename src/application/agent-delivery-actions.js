import { deliveryConfirmation } from "./delivery-confirmation.js";
import { declined } from "./agent-confirmation.js";
import { DELIVERY_BUSY } from "./document-delivery.js";
import { permitsUnattendedActions } from "../permissions.js";

// Sending a document link to a colleague or a group, asked for in the
// conversation instead of through a dialog.
//
// None of the safety machinery moves here: recipients are still only the
// records the provider itself produced (the Agent picks one by an opaque
// handle, never by typing an open_id), the document is still re-read and
// compared immediately before dispatch, and the durable dispatching record that
// makes a duplicate send impossible after a cancel, a restart or a lost
// acknowledgement still lives in DocumentDelivery. These actions are the same
// three steps the dialog performed, in the same order. From a task on 完全访问
// the send goes without the card: the task's permission is the person's
// authorization (permissions.js).
const CANCELLED = "用户取消了这次发送。";
const HANDLE = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

const handle = (value, name) => {
  if (typeof value !== "string" || !HANDLE.test(value)) throw new Error(`${name} 需要一个来自搜索结果的 handle，不能自己拼 id`);
  return value;
};
const text = (value, limit, name) => {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > limit) throw new Error(`${name} 无效`);
  return value;
};

// Finding recipients only reads; sending is the one that asks, unless the task
// has full access (agent-reads.js).
export const DELIVERY_READS = Object.freeze(["doc-share-search", "doc-share-members"]);

export function agentDeliveryActions({ getScope, confirm }) {
  if (typeof getScope !== "function" || typeof confirm !== "function") throw new Error("Invalid agent delivery action wiring");
  const bind = (taskId) => {
    const scope = getScope();
    if (!scope) throw new Error("应用尚未就绪");
    scope.messageWriteAccess();
    return { scope, task: scope.service.get(taskId) };
  };
  // The document the search was performed against. Losing it means the person
  // navigated away, and the choice made against the old one no longer applies.
  const opened = (scope, taskId) => {
    const entry = scope.documents.opened.get(taskId);
    if (!entry) throw new Error("当前任务没有打开的飞书文档，请先用 doc-share-search 指定要发送的文档");
    return entry.handle;
  };
  return {
    // Step one, and the only place a recipient can come from.
    "doc-share-search": async (params, taskId) => {
      const { scope } = bind(taskId);
      // A read, answered beside a send waiting on its card -- so it must not
      // reopen the document that send is bound to: confirmed afterwards, it
      // failed as out of date (2026-09-25).
      if (scope.documentDelivery.busy(taskId)) throw new Error(DELIVERY_BUSY);
      const kind = params.kind === "group" ? "group" : "user";
      const document = await scope.documents.open(taskId, text(params.doc, 2048, "--doc") || undefined);
      // Asked from inside the Agent's own turn; see DocumentDelivery.entry.
      const found = await scope.documentDelivery.search(taskId, document.handle, text(params.query, 200, "--query"), kind, { origin: "agent" });
      return { document: { title: document.title, sourceUrl: document.sourceUrl }, kind, ...found };
    },
    // Step two, groups only: the members that may be mentioned.
    "doc-share-members": async (params, taskId) => {
      const { scope } = bind(taskId);
      return scope.documentDelivery.members(taskId, opened(scope, taskId), handle(params.recipient, "--recipient"));
    },
    // Step three: preview, ask, send. The preview is built by the same code the
    // dialog used, so what the person approves is byte-identical either way.
    "doc-share": async (params, taskId) => {
      const { scope, task } = bind(taskId);
      const mentions = text(params.mention, 400, "--mention").split(",").map(item => item.trim()).filter(Boolean);
      for (const item of mentions) handle(item, "--mention");
      const preview = await scope.documentDelivery.prepare(taskId, opened(scope, taskId),
        handle(params.recipient, "--recipient"), text(params.note, 1000, "--note"), mentions);
      return scope.documentDelivery.send(taskId, preview.id, async draft => {
        if (permitsUnattendedActions(task)) return true;
        const shown = deliveryConfirmation(draft);
        const choice = await confirm({ type: "warning", title: shown.title, message: shown.message,
          detail: `任务：${task.title}\n${shown.detail}`, technical: shown.technical, boundary: shown.boundary,
          buttons: ["取消", shown.verb], defaultId: 0, cancelId: 0 });
        if (choice.response !== 1) throw declined(choice, CANCELLED);
        return true;
      });
    },
  };
}
