import { createHash } from "node:crypto";
import { DOCUMENT_APPEND, MESSAGE_SEND } from "../providers/feishu/cli-write-contract.js";
import { pushRefusal } from "./schedule-push.js";

// After a scheduled run, its result written to the places its owner chose for
// it when they set the task up (schedule-deliveries.js): appended to the end of
// a document, sent to a chat. Choosing them was the authorization; nobody is
// asked again at run time, because nobody is there (2026-09-28).
//
// Written by the control plane once the run is over, as the owner: through the
// same bridge, grant and proxy as a write the person confirms on a card, with
// the run's report as the words. The run never learns where they go and cannot
// add a place. The list is read from the stored task at this moment, so a place
// taken off it while the run was under way is not written to.
//
// Never throws, and never retries: each place gets one attempt, and the run's
// record says what happened at each. A result that arrives twice is worse than
// one that says it did not arrive.
//
// A document is appended to, never read whole: a task's running log grows every
// day (SaasDocumentAuthoring.appendToEnd). What goes to a chat is what fits a
// message, and where the same run appended to a document, its link.
export const DOCUMENT_BYTES = 60 * 1024;
export const CHAT_CHARS = 6000;
// Control characters and the bidirectional overrides: the report is the run's
// own output, the one part of what is written that a task controls.
const UNSAFE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f‪-‮⁦-⁩]/g;
const said = (error) => String(error?.message ?? error).replace(UNSAFE, "").slice(0, 160);

// At most `limit` bytes of UTF-8, cut between characters.
function cutBytes(text, limit) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return { text, cut: false };
  let end = limit;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString("utf8"), cut: true };
}

// At most `limit` characters, never half of a surrogate pair.
function cutChars(text, limit) {
  if (text.length <= limit) return { text, cut: false };
  const end = /[\ud800-\udbff]/.test(text[limit - 1]) ? limit - 1 : limit;
  return { text: text.slice(0, end), cut: true };
}

// When the run finished, in the task's own time zone, as a person writes it.
export function deliveryStamp(at, timeZone = "Asia/Shanghai") {
  let parts;
  try {
    parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(at).map((part) => [part.type, part.value]));
  } catch { return deliveryStamp(at); }
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

// The message's idempotency key: the same run to the same chat is the same
// message, so a repeat inside Feishu's hour is not a second one.
export const deliveryKey = (runId, chatId) => createHash("sha256").update(`${runId}\n${chatId}`).digest("hex").slice(0, 32);

export function documentEntry({ title, at, report }) {
  const heading = `## ${title} · ${at}`;
  const note = "\n\n（内容较长，只追加了前面部分。）";
  const { text, cut } = cutBytes(report, DOCUMENT_BYTES - Buffer.byteLength(`${heading}\n\n${note}\n`, "utf8"));
  return `${heading}\n\n${text}${cut ? note : ""}\n`;
}

export function chatEntry({ title, at, report, appended = [] }) {
  const { text, cut } = cutChars(report, CHAT_CHARS);
  const links = appended.map((place) => `全文已追加到文档《${place.label}》：${place.reference}`);
  return [`定时任务「${title}」${at} 的结果`, `${text}${cut ? "…" : ""}`, ...links,
    ...(cut && !links.length ? ["（内容较长，已截断。）"] : [])].filter(Boolean).join("\n\n");
}

export class ScheduleDelivery {
  constructor({ feishu, sessions, sourceAccess, store, push, controlPlaneOrigin, now = Date.now,
    createSidecar = (options) => feishu.client.sidecar(options), createClient = (config) => feishu.client.create(config) } = {}) {
    if (!feishu?.client || !sessions || !sourceAccess || !store || typeof push?.sendToChat !== "function" || !controlPlaneOrigin) {
      throw new Error("定时任务结果投递需要飞书安全桥接、会话、任务存储和消息发送");
    }
    Object.assign(this, { feishu, sessions, sourceAccess, store, push, controlPlaneOrigin, now, createSidecar, createClient });
  }

  // The run's own identity, as the report archive checks it: the owner's
  // Feishu session, still bound to the grant the bridge will use.
  #identity(parentToken, schedule) {
    const who = this.sessions.verify(parentToken);
    if (!who || who.audience !== "codex-model-gateway" || who.authProvider !== "feishu" ||
        who.tenantId !== schedule.tenant || who.userId !== schedule.owner || who.cliBridge !== true) return null;
    try { this.sourceAccess.current(parentToken); } catch { return null; }
    return who;
  }

  // One line per place, for the run's record; none where the task names none.
  async deliver({ schedule, parentToken, runId, report, signal }) {
    try { return await this.#deliver({ schedule, parentToken, runId, report, signal }); }
    catch (error) { return [`结果没有写到任务指定的地方：${said(error)}`]; }
  }

  async #deliver({ schedule, parentToken, runId, report, signal }) {
    const fresh = await this.store.get({ tenantId: schedule.tenant, userId: schedule.owner }, schedule.id);
    const places = fresh && fresh.owner === schedule.owner && Array.isArray(fresh.deliveries) ? fresh.deliveries : [];
    if (!places.length) return [];
    const documents = places.filter((place) => place.kind === "document");
    const chats = places.filter((place) => place.kind === "chat");
    const who = this.#identity(parentToken, schedule);
    if (!who) return places.map((place) => `${place.kind === "document" ? `没有追加到文档《${place.label}》` : `没有发到「${place.label}」`}：这次运行的身份没有获准写入飞书`);

    const title = `${fresh.title ?? ""}`.replace(UNSAFE, "").replace(/\s+/g, " ").trim() || "未命名";
    const at = deliveryStamp(this.now(), fresh.spec?.timeZone);
    const text = (Buffer.isBuffer(report) ? report.toString("utf8") : `${report ?? ""}`).replace(/\r\n?/g, "\n").replace(UNSAFE, "").trim() || "任务已完成，没有输出。";
    const lines = [], appended = [];

    if (documents.length && (who.cliDocumentWrites !== true || !this.sourceAccess.cliWriteActions?.includes(DOCUMENT_APPEND))) {
      for (const place of documents) lines.push(`没有追加到文档《${place.label}》：这个服务端或你的登录没有开启飞书文档写入`);
    } else if (documents.length) {
      const sidecar = await this.createSidecar({ appId: who.appId,
        getSession: async () => ({ token: parentToken, expiresAt: who.expiresAt, serverUrl: this.controlPlaneOrigin, identity: who }) }).start();
      try {
        const client = this.createClient({ profile: null, environment: (intent) => sidecar.environment(intent),
          identityKey: () => sidecar.sessionFingerprint() });
        for (const place of documents) {
          let dispatched = false;
          try {
            signal?.throwIfAborted();
            await client.documentAuthoring.appendToEnd(place.id, documentEntry({ title, at, report: text }), async () => { signal?.throwIfAborted(); dispatched = true; });
            lines.push(`已追加到文档《${place.label}》`);
            appended.push(place);
          } catch (error) {
            // Sent and never heard back from: it may be there. Said so, and not
            // sent again.
            lines.push(dispatched
              ? `追加到文档《${place.label}》的结果不确定，请打开文档核查；系统不会重试（${said(error)}）`
              : `没有追加到文档《${place.label}》：${said(error)}`);
          }
        }
      } finally { await sidecar.close(); }
    }

    for (const place of chats) {
      if (who.cliMessageWrites !== true || !this.sourceAccess.cliWriteActions?.includes(MESSAGE_SEND)) {
        lines.push(`没有发到「${place.label}」：这个服务端或你的登录没有开启飞书发消息`);
        continue;
      }
      if (signal?.aborted) { lines.push(`没有发到「${place.label}」：任务已取消`); continue; }
      const answer = await this.push.sendToChat({ schedule, parentToken, chatId: place.id, runId,
        text: chatEntry({ title, at, report: text, appended }), key: deliveryKey(runId, place.id) });
      lines.push(answer.sent ? `已发到「${place.label}」` : `没有发到「${place.label}」：${pushRefusal(answer.reason)}`);
    }
    return lines;
  }
}
