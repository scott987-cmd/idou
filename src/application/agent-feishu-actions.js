import { authoredMarkdown, authoredTitle } from "../providers/feishu/document-authoring.js";
import { approveDeletion, approveDeletionForFullAccess, describeCliWrite } from "../providers/feishu/cli-writer.js";
import { permitsUnattendedActions } from "../permissions.js";
import { declined } from "./agent-confirmation.js";

// Enough of the content to recognise it, never so much that the confirmation
// stops being readable. The person is deciding about a change they asked for,
// so the prompt has to show the change, not summarise it.
const PREVIEW = 800;
export function preview(value) {
  const text = String(value).replace(/\r\n/g, "\n").trimEnd();
  return text.length <= PREVIEW ? text : `${text.slice(0, PREVIEW)}\n…（还有 ${text.length - PREVIEW} 字未显示）`;
}

const CANCELLED = "用户取消了这次飞书写入。";
const CANCELLED_DELETE = "用户取消了这次删除，没有删除任何东西。";
const string = (value, name, limit = 200) => {
  if (typeof value !== "string" || !value.trim() || value.length > limit) throw new Error(`${name} 无效`);
  return value.trim();
};

// Every action follows the same shape: validate, read the current state, apply
// the current task's confirmation policy, then hand the authorised intent to
// the provider, which obtains the server-issued one-shot grant. The Agent never
// holds one.
export function agentFeishuActions({ getScope, confirm }) {
  if (typeof getScope !== "function" || typeof confirm !== "function") throw new Error("Invalid agent Feishu action wiring");
  // Binds the request to a task in the live scope, so a stale channel from a
  // previous account cannot act after a sign-out.
  const bind = (taskId) => {
    const scope = getScope();
    if (!scope) throw new Error("应用尚未就绪");
    const task = scope.service.get(taskId); // Throws for an unknown or foreign task.
    return { scope, task };
  };
  const BOUNDARY = "以当前飞书登录身份写入。本次确认只授权这一次操作：服务端据此签发绑定目标与内容的一次性许可，用后立即失效。结果不确定时不会自动重试或回滚。";
  const ask = async (task, { title, message, detail, verb, boundary = BOUNDARY, destructive = false }) => {
    // Full access is an explicit per-task decision, not a global preference.
    // There is no card to automate: the task permission is the authorization
    // (permissions.js). Destructive plans enter the writer through its separate
    // full-access authorization function; this result never imitates a card
    // click, so approveDeletion still refuses it.
    if (permitsUnattendedActions(task)) return { response: 1, reason: "full-access" };
    // Kept out of `detail` so it cannot be scrolled off by long content.
    const choice = await confirm({ type: "warning", title, message, detail, boundary, buttons: ["取消", verb], defaultId: 0, cancelId: 0, destructive });
    if (choice.response !== 1) throw declined(choice, destructive ? CANCELLED_DELETE : CANCELLED);
    return choice;
  };
  // What a deletion card authorises. It is its own card, never an ordinary
  // write card with different words. Other tasks need that exact answer;
  // full-access tasks use the separate writer authorization path.
  const approve = (plan, choice, task) => choice.reason === "full-access" ? approveDeletionForFullAccess(plan, task) : approveDeletion(plan, choice);
  const DELETE_BOUNDARY = "以当前飞书登录身份执行删除。本次确认只授权上面这一个删除请求：服务端据此签发只能用于它的一次性删除许可，用后立即失效。结果不确定时不会自动重试。";
  const deletable = scope => {
    if (typeof scope.destructiveWriteAccess !== "function") throw new Error("当前应用没有删除类操作的访问检查，拒绝执行删除。");
    scope.destructiveWriteAccess();
  };
  const between = (start, end) => [start, end].filter(Boolean).map(value => String(value).replace("T", " ").replace(/:00(\+\d{2}:\d{2}|Z)?$/, "")).join(" – ") || "未知";
  // Only the routes that write into an existing document re-read and compare
  // before dispatching, so only they may promise it. A creation has nothing to
  // compare against and must not claim otherwise.
  const VERIFIED = `${BOUNDARY.replace("结果不确定时", "写入前会再读一次文档核对，期间被别人改动就会中止。结果不确定时")}`;
  const document = async (taskId, reference) => {
    const { scope, task } = bind(taskId);
    scope.documentWriteAccess();
    const parsed = scope.feishuProvider.references.document(string(reference, "--doc", 2048));
    return { scope, task, document: await scope.feishu.readDocument(parsed.url) };
  };
  return {
    "doc-create": async (params, taskId) => {
      const { scope, task } = bind(taskId);
      scope.documentWriteAccess();
      const content = authoredMarkdown(params.content);
      await ask(task, { title: "确认新建飞书文档", message: `新建文档「${authoredTitle(content)}」？`, verb: "确认新建",
        detail: `任务：${task.title}\n\n内容：\n${preview(content)}` });
      return scope.feishu.documentAuthoring.create(content);
    },
    "doc-append": async (params, taskId) => {
      const { scope, task, document: current } = await document(taskId, params.doc);
      const content = authoredMarkdown(params.content);
      await ask(task, { title: "确认追加到飞书文档", message: `在「${current.title}」末尾追加内容？`, verb: "确认追加",
        detail: `任务：${task.title}\n文档：${current.sourceUrl}\n读到的版本：${current.sourceRevision}\n\n追加内容：\n${preview(content)}`, boundary: VERIFIED });
      return scope.feishu.documentAuthoring.append(current, content);
    },
    // Sheets, Base and finer document edits: the Agent writes an ordinary Feishu
    // CLI command and the CLI itself declares what that command would send. The
    // task policy authorises that declared request, and the grant covers only it.
    run: async (params, taskId) => {
      const { scope, task } = bind(taskId);
      scope.documentWriteAccess();
      const plan = await scope.feishu.cliWriter.plan(params.argv, task.cwd);
      // A command that turns out to delete or clear something is asked for as
      // a deletion, whatever the Agent called it.
      if (plan.destructive) deletable(scope);
      const shown = describeCliWrite(plan);
      const choice = await ask(task, { title: `确认${shown.summary}`, message: `${shown.summary}？`, verb: plan.destructive ? "确认删除" : "确认执行", destructive: plan.destructive,
        detail: `任务：${task.title}\n目标：${shown.target}\n请求：${shown.request}\n\n${shown.detail}`,
        boundary: plan.destructive ? `${DELETE_BOUNDARY} 这条命令由飞书 CLI 自己声明会发出上面这一个请求，许可只绑定它。`
          : `${BOUNDARY} 这条命令由飞书 CLI 自己声明会发出上面这一个请求，许可只绑定它；确认后如果内容有任何变化，写入会被拒绝而不是改成别的。` });
      if (plan.destructive) approve(plan, choice, task);
      return scope.feishu.cliWriter.run(plan);
    },
    // Deleting an event or a task. The CLI has no shortcut for either, so the
    // Agent gives an id and the application builds the one fixed request. What
    // is being deleted is read first, so the card names it.
    "event-delete": async (params, taskId) => {
      const { scope, task } = bind(taskId);
      deletable(scope);
      const id = string(params.eventId, "--event-id", 200);
      const event = await scope.feishu.cliWriter.eventForDeletion(id, task.cwd);
      const plan = await scope.feishu.cliWriter.planDeletion("event", id, task.cwd);
      if (!plan.destructive) throw new Error("删除日程的请求没有被识别为删除，未执行");
      const shown = describeCliWrite(plan);
      const choice = await ask(task, { title: "确认删除日程", message: `删除日程「${event.title}」？`, verb: "确认删除", destructive: true, boundary: DELETE_BOUNDARY,
        detail: `任务：${task.title}\n日程：${event.title}\n时间：${between(event.start, event.end)}\n${event.organizer ? `组织者：${event.organizer}\n` : ""}${event.attendees ? `参会人：${event.attendees} 人，他们会收到取消通知\n` : ""}目标：${shown.target}\n请求：${shown.request}\n\n${shown.consequence}` });
      approve(plan, choice, task);
      await scope.feishu.cliWriter.run(plan);
      return { deleted: "event", eventId: id, title: event.title };
    },
    "task-delete": async (params, taskId) => {
      const { scope, task } = bind(taskId);
      deletable(scope);
      const id = string(params.taskId, "--task-id", 64);
      const target = await scope.feishu.cliWriter.taskForDeletion(id, task.cwd);
      const plan = await scope.feishu.cliWriter.planDeletion("task", id, task.cwd);
      if (!plan.destructive) throw new Error("删除任务的请求没有被识别为删除，未执行");
      const shown = describeCliWrite(plan);
      const choice = await ask(task, { title: "确认删除任务", message: `删除任务「${target.title}」？`, verb: "确认删除", destructive: true, boundary: DELETE_BOUNDARY,
        detail: `任务：${task.title}\n要删除的飞书任务：${target.title}（${target.done ? "已完成" : "未完成"}）\n${target.members ? `负责人和关注人：${target.members} 人\n` : ""}目标：${shown.target}\n请求：${shown.request}\n\n${shown.consequence}` });
      approve(plan, choice, task);
      await scope.feishu.cliWriter.run(plan);
      return { deleted: "task", taskId: id, title: target.title };
    },
    "doc-replace": async (params, taskId) => {
      const { scope, task, document: current } = await document(taskId, params.doc);
      const pattern = string(params.pattern, "--pattern-file", 2000);
      const replacement = typeof params.content === "string" ? params.content : "";
      const prepared = await scope.feishu.documentEdits.prepare(current, pattern, replacement);
      await ask(task, { title: "确认修改飞书文档", message: `修改「${current.title}」的一处文字？`, verb: "确认修改",
        detail: `任务：${task.title}\n文档：${current.sourceUrl}\n读到的版本：${current.sourceRevision}\n\n原文：\n${preview(pattern)}\n\n替换为：\n${replacement ? preview(replacement) : "（删除这段文字）"}\n\n请确认这份文档允许修改；其他协作者可以看到修改。`, boundary: VERIFIED });
      const written = await scope.feishu.documentEdits.apply(prepared, async () => {});
      return { documentId: current.resourceId, sourceUrl: written.sourceUrl, revision: written.sourceRevision };
    },
  };
}
