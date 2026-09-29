import { createHash, randomUUID } from "node:crypto";
import { successfulUserPayload } from "./document-errors.js";
import { canonicalJson, cliRiskFromHelp, deletionArgv, parseCliWritePlan, validateCliWriteArgv } from "./cli-write-plan.js";
import { permitsUnattendedActions } from "../../permissions.js";

const hash = value => createHash("sha256").update(value).digest("hex");

// Destructive plans authorised by either a person's deletion card or the
// current task's full access, each good for exactly one run. Kept beside the only dispatch method so new callers cannot bypass it.
const approvedDeletions = new WeakSet();

// Takes the person's answer to a deletion card and nothing else. That answer
// carries `destructive: true` only when the card was raised as a deletion and
// its confirming button was the one clicked (confirmInApp in the desktop main
// process); an ordinary confirmation, a timeout or a withdrawal never does.
export function approveDeletion(plan, choice) {
  if (plan?.destructive !== true || choice?.response !== 1 || choice.destructive !== true || choice.reason !== "answered") {
    throw new Error("删除类操作没有得到删除确认，未执行任何操作。");
  }
  approvedDeletions.add(plan);
}

// Full access is a distinct authorization path, never a forged click on a
// deletion card: accepted only from a task whose current effective permission
// is full (permissions.js), for the one plan it is given. Documents, sheets
// and Base since 2026-09-22; calendar events and Feishu tasks since 2026-09-28.
// The plan remains one-shot and still travels under the exact cli.delete
// grant, which the server issues only where the deployment enables deletions.
export function approveDeletionForFullAccess(plan, task) {
  if (plan?.destructive !== true || !permitsUnattendedActions(task)) {
    throw new Error("删除类操作没有得到当前任务的完全访问授权，未执行任何操作。");
  }
  approvedDeletions.add(plan);
}

// A Feishu CLI command the Agent asked for, planned and then run under a grant
// bound to exactly what the plan said. Two invocations of the same command: the
// first with `--dry-run`, which touches no network and only prints the request;
// the second for real. If anything the command reads changed in between -- a
// content file, the range, the record list -- the body changes with it and the
// grant no longer matches, so the write is refused rather than silently
// becoming something the person did not approve.
export class SaasCliWriter {
  constructor(provider) { this.provider = provider; this.risks = new Map(); }
  // A command the Agent wrote. Only `+` shortcuts get this far (validateCliWriteArgv).
  plan(argv, cwd) { return this.prepare(validateCliWriteArgv(argv), cwd); }
  // One of the application's own deletion commands, built from an id alone.
  planDeletion(kind, id, cwd) { return this.prepare(deletionArgv(kind, id), cwd); }
  // The CLI's own risk label for a shortcut, from its local help: no network.
  async risk(argv, cwd) {
    if (!argv[1]?.startsWith("+")) return null;
    const key = `${argv[0]} ${argv[1]}`;
    if (!this.risks.has(key)) {
      const help = await this.provider.invoke([argv[0], argv[1], "--help"], { cwd, timeoutMs: 15_000, maxOutputBytes: 131_072 });
      this.risks.set(key, cliRiskFromHelp(help.stdout));
    }
    return this.risks.get(key);
  }
  // What a deletion card says about the thing it deletes, read just before
  // asking: the title and time a person recognises, not an id. Both are plain
  // reads through the same bridge; neither can change anything.
  async eventForDeletion(id, cwd) {
    deletionArgv("event", id);
    const response = await this.provider.invoke(["calendar", "+get", "--event-id", id, "--as", "user", "--format", "json"], { cwd, timeoutMs: 30_000, maxOutputBytes: 262_144 });
    // Newer CLIs flatten the event into `data`; the API itself nests it under `data.event`.
    const data = successfulUserPayload(response).data ?? {}, event = data.event && typeof data.event === "object" ? data.event : data;
    const attendees = Array.isArray(event.attendees) ? event.attendees.length : null;
    return Object.freeze({ title: String(event.summary ?? "（无标题）").slice(0, 200), start: event.start_time?.datetime ?? event.start_time?.date ?? null,
      end: event.end_time?.datetime ?? event.end_time?.date ?? null, organizer: event.event_organizer?.display_name ?? null, attendees });
  }
  async taskForDeletion(id, cwd) {
    deletionArgv("task", id);
    const response = await this.provider.invoke(["api", "GET", `/open-apis/task/v2/tasks/${id}`, "--params", JSON.stringify({ user_id_type: "open_id" }), "--as", "user", "--format", "json"], { cwd, timeoutMs: 30_000, maxOutputBytes: 262_144 });
    const task = successfulUserPayload(response).data?.task ?? {};
    return Object.freeze({ title: String(task.summary ?? "（无标题）").slice(0, 200), done: Boolean(task.completed_at && task.completed_at !== "0"),
      members: Array.isArray(task.members) ? task.members.length : 0 });
  }
  async prepare(safe, cwd) {
    const response = await this.provider.invoke([...safe, "--as", "user", "--format", "json", "--dry-run"],
      { cwd, timeoutMs: 30_000, maxOutputBytes: 262_144 });
    const plan = parseCliWritePlan(response.stdout);
    const risk = await this.risk(safe, cwd);
    // Destructive when the request is -- the rule the control plane applies
    // too -- or when the CLI itself files the command as high-risk. Either way
    // it is asked for with a deletion card and travels under a deletion grant.
    return Object.freeze({ argv: safe, cwd, method: plan.method, path: plan.path, body: plan.body,
      family: plan.family, bodyHash: hash(canonicalJson(plan.body ?? null)),
      destructive: plan.destructive || risk === "high-risk-write", highRisk: risk === "high-risk-write" });
  }
  async run(plan, beforeDispatch = async () => {}) {
    if (plan.destructive) {
      if (!approvedDeletions.has(plan)) throw new Error("删除类操作必须先经过删除确认，未执行任何操作。");
      approvedDeletions.delete(plan); // One answer, one run: it cannot be replayed.
    }
    await beforeDispatch();
    // The CLI refuses a high-risk command without --yes. The application adds
    // it here, after the deletion card, and never takes it from the Agent.
    const response = await this.provider.invoke([...plan.argv, ...(plan.highRisk ? ["--yes"] : []), "--as", "user", "--format", "json"], {
      cwd: plan.cwd, timeoutMs: 120_000, maxOutputBytes: 262_144, highRiskConfirmed: plan.highRisk === true,
      feishuWriteIntent: { action: plan.destructive ? "cli.delete" : "cli.write", operationId: randomUUID(),
        requestMethod: plan.method, requestPath: plan.path, bodyHash: plan.bodyHash },
    });
    const data = successfulUserPayload(response).data;
    // Several shortcuts report per-item outcomes; a partial success must not be
    // reported to the Agent as a clean one.
    if (Array.isArray(data?.warnings) && data.warnings.length) throw new Error(`飞书返回了警告：${String(data.warnings[0]).slice(0, 160)}`);
    if (data?.result !== undefined && data.result !== "success") throw new Error("未收到成功回执");
    return data ?? null;
  }
}

// What the person reads before approving. It describes the request the CLI said
// it would send, not the command line, because the command line is the Agent's
// wording and the request is what actually happens.
const readable = value => {
  try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return String(value); }
};
export function describeCliWrite(plan, limit = 1200) {
  const body = plan.body ?? {};
  // The sheets endpoint carries its real payload as a JSON string inside
  // `input`, so showing the raw body would show an escaped blob.
  const detail = plan.method === "DELETE" ? "（删除请求只有地址，没有请求体）"
    : typeof body.input === "string" && typeof body.tool_name === "string"
      ? `操作：${body.tool_name}\n\n${readable(body.input)}`
      : JSON.stringify(body, null, 2);
  // The family's own one-line account comes first where it has one; the exact
  // body stays underneath, because that is what the grant is bound to.
  const headline = plan.family.describe?.(body);
  const consequence = plan.destructive ? plan.family.consequence?.(body) ?? "这是删除或清空类操作，执行后不能在这里撤销。" : null;
  // For a deletion: what goes, then what that means, then the exact request.
  const text = `${headline ? `${headline}\n${consequence ? "" : "\n"}` : ""}${consequence ? `${consequence}\n\n` : ""}${detail}`.replace(/\r\n/g, "\n").trimEnd();
  // A family that both writes and destroys names the destructive case for what it is.
  const named = plan.destructive ? plan.family.destructiveSummary : null;
  return { summary: (typeof named === "function" ? named(body) : named) || plan.family.summary,
    destructive: plan.destructive === true, consequence,
    // What the person recognises comes first; the exact request is what the
    // grant will be bound to, so it is shown too rather than summarised away.
    target: plan.family.resource?.(plan.path) ?? plan.path,
    request: `${plan.method} ${plan.path}`,
    detail: text.length <= limit ? text : `${text.slice(0, limit)}\n…（还有 ${text.length - limit} 字未显示）` };
}
