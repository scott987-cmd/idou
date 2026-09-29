import { createHash, randomUUID } from "node:crypto";
import { feishuCliWriteDigest } from "../providers/feishu/cli-write-contract.js";
import { OPENAPI_PATHS } from "../providers/feishu/openapi.js";
import { ownHeaderName } from "../product-names.js";

// A finished schedule tells its owner what happened, in Feishu, without anyone
// having to open the application. That is half of what the products people
// already use are for: a task nobody watches is only useful if its answer comes
// to you.
//
// Every outward send in this product stops at a card the person clicks. A
// scheduled task has nobody present to click one, so this is the single narrow
// exception, and it is narrow in the way that matters: **the recipient is the
// owner and cannot be anything else.** It is read from the stored schedule, is
// never a parameter of this function, and never comes from the run. A task
// whose prompt was written months ago, or which read a document that told it to
// forward the result somewhere, cannot move where the result goes -- the worst
// it can do is choose the words that arrive in the owner's own chat.
//
// Since 2026-09-28 a result may also go to a chat the owner chose for the task
// when they set it up (`sendToChat`, from schedule-delivery.js). That widens
// who reads it, not who decides: the chat is the person's choice, stored with
// the task and read again just before sending, never a parameter a run can
// reach -- and it is sent as the owner, never as the bot.
//
// There are two ways it can be sent, and they are not the same authority.
//
// As the owner: through the same grant route and the same CLI proxy as every
// other write -- the same contract validation, the same capability gate, the
// same audit trail, the same one-shot grant. Where the operator has not enabled
// `message.send` it is refused exactly as any other write would be.
//
// As the application's own bot: with the application's credential, straight to
// Feishu, past all of that. It was added because the first form is delivered to
// the owner *by* the owner, which in Feishu is the chat nobody looks at -- a real
// run's result arrived there and was reported as never sent. This header used to
// claim the send was "not a new privilege"; for the bot that was simply untrue,
// and a comment asserting a boundary the code does not keep is worse than no
// comment. The privilege is real, so it is switched on by the operator, bounded
// to admitted tenants, addressed only from stored state, and audited with which
// identity sent it.
//
// Either way a refusal must never fail the run, which had already finished and
// been recorded before this was attempted.
export const GRANT_ROUTE = "/v1/feishu/cli-write-grants";
export const PROXY_ROUTE = "/v1/feishu/cli-proxy";
export const PUSH_PATH = OPENAPI_PATHS.message;
export const CHAT_PATH = "/open-apis/im/v1/messages?receive_id_type=chat_id";

// Feishu accepts a good deal more, but a push is a notification rather than a
// transcript: enough to see what happened and decide whether to go and look.
// What the owner's own identity can carry comfortably, and what the application
// can. The smaller number existed because the fallback path builds a grant
// around the exact bytes; the bot has no such ceiling, and a daily digest cut at
// 1,200 characters was arriving as its own first paragraph.
const MAX_DETAIL = 1200;
const BOT_DETAIL = 4000;
// Control characters and the bidirectional overrides. The detail is the
// sandbox's own stdout, so it is the one part of this message a task controls;
// an override left in it can make what displays differ from what is written,
// which is a spoof in a message the owner is meant to trust.
const UNSAFE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f‪-‮⁦-⁩]/g;
// Identifiers are hashed into the audit, never written into it: a notification
// record should say that one happened and on whose behalf, not who the person is.
const digest = (value) => createHash("sha256").update(String(value)).digest("hex");

export const scheduleMessage = ({ title, outcome, detail, room = MAX_DETAIL }) => {
  const said = `${detail ?? ""}`.replace(UNSAFE, "").replace(/\r\n?/g, "\n").trim();
  const cut = said.length > room;
  const body = cut ? `${said.slice(0, room)}…` : said;
  const heading = `定时任务「${`${title ?? ""}`.replace(UNSAFE, "").trim() || "未命名"}」${outcome === "completed" ? "已完成" : "执行失败"}`;
  // Said out loud when it is cut. A digest that stops mid-sentence with nothing
  // to explain it reads as a broken task rather than a long one.
  const tail = cut ? "\n\n（内容较长，已截断；如已归档，请打开「定时任务 - 运行记录」里的飞书云盘报告。）" : "";
  return body ? `${heading}\n\n${body}${tail}` : heading;
};

// 测试通知 (G9): one fixed line, so a test says nothing a person has to read
// twice, and nothing a request could have chosen.
export const TEST_MESSAGE = "这是「i豆」发来的测试通知。定时任务跑完后，结果会像这样发到这里。";

// Why a notification did not go, in words the person who pressed 测试通知 can
// act on. Feishu's and the proxy's own words are kept after the explanation:
// they are what an administrator will search for.
const REFUSALS = Object.freeze({
  tenant_not_allowed: "你的飞书租户不在这个服务端允许的范围内（FEISHU_ALLOWED_TENANTS）",
  owner_not_feishu: "当前是开发登录，不是飞书账号，飞书里收不到",
  no_live_session: "登录已失效，请重新登录后再试",
  no_control_plane_origin: "服务端没有配置自己的访问地址，无法以你的身份发送",
  messages_unavailable: "这个飞书部署不能发消息",
  chat_invalid: "会话 ID 无效",
});
export const pushRefusal = (reason) => {
  const said = typeof reason === "string" ? reason : "";
  if (REFUSALS[said]) return REFUSALS[said];
  if (said.startsWith("bot: ")) return `应用机器人发送失败：${said.slice(5)}`;
  if (said.startsWith("unavailable: ")) return `连不上飞书或服务端：${said.slice(13)}`;
  return said ? `服务端拒绝了这次发送（${said}）` : "原因未知";
};

export class SchedulePush {
  // No logger: `deliver` returns why it did or did not send, and the assembly
  // decides what to say about that. An injected dependency this never calls
  // would read as wired when it is not.
  //
  // `bot` is the application speaking as itself. Preferred when it exists,
  // because the fallback below -- a message from the owner to the owner -- is
  // delivered and correct and lands in the chat nobody looks at, with no unread
  // badge and no notification. Measured: a real run's result arrived that way
  // and was reported as never sent.
  //
  // It is a different authority from everything else here, and saying so is the
  // point of this constructor. Every other write goes through the CLI proxy's
  // grant, contract validation and audit; the bot holds the application's own
  // credential and talks to Feishu directly. That is a legitimate way to send a
  // notification and an illegitimate thing to leave implicit, so it is switched
  // on explicitly by the operator, bounded to the tenants the deployment admits,
  // and every outcome is recorded with who sent it and on whose behalf.
  //
  // Both ways are the deployment's capabilities (`feishu`): a deployment that
  // cannot message a person as the application gets no bot, and one that cannot
  // send messages at all sends nothing -- the run still finishes, and the record
  // says why no message came. The owner's id must look like the deployment's
  // own ids, and the proxy is told the deployment's own origin.
  constructor({ feishu, origin, fetch: fetchImpl = fetch, bot = null, allowedTenants = null, audit = () => {} } = {}) {
    if (!feishu?.openApi) throw new Error("定时通知需要一个说 OpenAPI 的飞书部署");
    if (bot && !feishu.supports("botMessages")) throw new Error("这个飞书部署不提供应用机器人通知");
    this.feishu = feishu; this.origin = origin; this.fetch = fetchImpl; this.bot = bot; this.audit = audit;
    this.allowedTenants = allowedTenants ? new Set(allowedTenants) : null;
  }

  #record({ schedule, runId, as, sent, reason, kind = "schedule_notified" }) {
    try {
      this.audit(Object.freeze({ kind, at: Date.now(), as, sent,
        tenantHash: digest(`${schedule?.tenant ?? ""}`), ownerHash: digest(`${schedule?.owner ?? ""}`),
        runId: `${runId ?? ""}`, ...(sent ? {} : { reason: `${reason ?? ""}`.slice(0, 160) }) }));
    } catch { /* an audit sink failure must not change what was delivered */ }
  }

  // Returns why it did or did not send, and never throws. The run it reports on
  // is already over and already recorded; a push that fails must leave that
  // record exactly as it is, because a delivered answer and a correct history
  // are two different promises and only one of them was made to the scheduler.
  async deliver({ schedule, parentToken, outcome, detail, runId = null }) {
    const answer = await this.#deliver({ schedule, parentToken,
      compose: (room) => scheduleMessage({ title: schedule?.title, outcome, detail, room }) });
    this.#record({ schedule, runId, as: answer.as ?? "none", sent: answer.sent === true, reason: answer.reason });
    return answer;
  }

  // 测试通知 (G9), pressed in 设置. The same path a result takes, with the same
  // bounds, to the person who pressed it -- `who` is the verified session, never
  // anything the request said -- and one fixed line. Audited as a test.
  async test({ who, parentToken }) {
    const schedule = { tenant: who?.tenantId, owner: who?.userId };
    const answer = await this.#deliver({ schedule, parentToken, compose: () => TEST_MESSAGE });
    this.#record({ schedule, runId: null, as: answer.as ?? "none", sent: answer.sent === true, reason: answer.reason, kind: "schedule_notify_test" });
    return answer;
  }

  // A scheduled task's result, sent to a chat the person chose for it when they
  // set the task up (schedule-deliveries.js). As the owner, through the same
  // grant route and proxy as every other write -- never the bot, which is a
  // different authority and need not be in that chat. The chat comes from the
  // stored task, read again just before this; the words are the run's. `key`
  // is the message's idempotency key, derived from the run and the chat by the
  // caller, so a repeat within Feishu's hour is the same message, not a second
  // one. Returns why it did or did not send, and never throws.
  async sendToChat({ schedule, parentToken, chatId, text, key, runId = null }) {
    let answer;
    if (this.allowedTenants && !this.allowedTenants.has(schedule?.tenant)) answer = { sent: false, reason: "tenant_not_allowed" };
    else if (!this.feishu.ids.chat(chatId)) answer = { sent: false, reason: "chat_invalid" };
    else if (typeof parentToken !== "string" || !parentToken) answer = { sent: false, reason: "no_live_session" };
    else if (!this.origin) answer = { sent: false, reason: "no_control_plane_origin" };
    else if (!this.feishu.supports("messages")) answer = { sent: false, reason: "messages_unavailable" };
    else answer = await this.#send({ parentToken, receiveIdType: "chat_id", receiveId: chatId, text, idempotencyKey: key });
    this.#record({ schedule, runId, as: answer.as ?? "none", sent: answer.sent === true, reason: answer.reason, kind: "schedule_delivered_to_chat" });
    return answer;
  }

  async #deliver({ schedule, parentToken, compose }) {
    const recipient = schedule?.owner;
    // The deployment's own tenant list, checked before anything is addressed.
    // The bot can reach everyone in its tenant, so "the recipient is the owner"
    // is only half the bound; the other half is which tenants this deployment
    // was set up to serve at all.
    if (this.allowedTenants && !this.allowedTenants.has(schedule?.tenant)) return { sent: false, reason: "tenant_not_allowed" };
    // A development login's user id is not an open id. Refused here rather than
    // by Feishu, so a development server never tries at all.
    if (!this.feishu.ids.user(recipient)) return { sent: false, reason: "owner_not_feishu" };
    if (typeof parentToken !== "string" || !parentToken) return { sent: false, reason: "no_live_session" };
    if (!this.origin) return { sent: false, reason: "no_control_plane_origin" };

    const text = compose(this.bot ? BOT_DETAIL : MAX_DETAIL);
    // The bot first. Its refusal is reported rather than silently retried
    // through the owner's own identity: a result that arrives twice, once as the
    // application and once as yourself, is worse than one that says why it did
    // not arrive as expected.
    if (this.bot) {
      const sent = await this.bot.sendText({ openId: recipient, text });
      return sent.sent ? { sent: true, as: "bot" } : { sent: false, reason: `bot: ${sent.reason}` };
    }

    if (!this.feishu.supports("messages")) return { sent: false, reason: "messages_unavailable" };
    return this.#send({ parentToken, receiveIdType: "open_id", receiveId: recipient, text, idempotencyKey: randomUUID() });
  }

  // One text message as the owner: a grant for exactly these bytes, then the
  // proxy. Nothing retries.
  async #send({ parentToken, receiveIdType, receiveId, text, idempotencyKey }) {
    const content = JSON.stringify({ text });
    const path = receiveIdType === "chat_id" ? CHAT_PATH : PUSH_PATH;
    const intent = { action: "message.send", operationId: randomUUID(), receiveIdType,
      receiveId, msgType: "text", contentHash: feishuCliWriteDigest(content), idempotencyKey };

    try {
      const minted = await this.#post(GRANT_ROUTE, parentToken, intent, {});
      if (minted.status !== 201) return { sent: false, reason: await this.#why(minted) };
      const { grant } = await minted.json();
      // The grant lives 30 seconds and is spent once, so minting and sending are
      // one sequence with nothing between them.
      const sent = await this.#post(PROXY_ROUTE, parentToken,
        { content, msg_type: "text", receive_id: receiveId, uuid: idempotencyKey },
        { [ownHeaderName("feishu-target")]: this.feishu.openApi.origin, [ownHeaderName("feishu-path")]: path, [ownHeaderName("feishu-write-grant")]: grant });
      if (sent.status !== 200) return { sent: false, reason: await this.#why(sent) };
      return { sent: true, as: "self" };
    } catch (error) {
      // Includes the case where the send was dispatched and the answer was lost.
      // Nothing retries: a second attempt at an unknown outcome is how a person
      // gets the same message twice, and this message is not worth that.
      return { sent: false, reason: `unavailable: ${String(error?.message ?? error).slice(0, 200)}` };
    }
  }

  async #post(route, parentToken, body, headers) {
    return this.fetch(`${this.origin}${route}`, { method: "POST", redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${parentToken}`, "content-type": "application/json", ...headers },
      body: JSON.stringify(body) });
  }

  // The proxy's own refusal word, so an operator reading a skipped push can tell
  // "not enabled here" from "the login lapsed" without turning on more logging.
  // The proxy route says it as `msg` (the envelope the CLI can parse, which is
  // also what Feishu's own refusals carry); the grant route as `error`.
  async #why(response) {
    try {
      const said = await response.json();
      const word = [said?.msg, said?.error].find((value) => typeof value === "string" && value);
      return `${response.status} ${word ?? "refused"}`;
    } catch { return `${response.status}`; }
  }
}
