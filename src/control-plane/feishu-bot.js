import { createHash, randomUUID } from "node:crypto";

// The application speaking as itself.
//
// Everything else in this product acts as a person: their OAuth token, their
// permissions, their name on the message. That is the right default, and it is
// why a scheduled task's result used to arrive as a message you had sent to
// yourself -- delivered, correct, and landing in the one chat nobody looks at,
// with no unread badge and no notification.
//
// A bot message needs the application's own credential, which is a different
// thing from every credential above it: minted from the app id and secret with
// nobody's consent involved, valid about two hours, refreshed on its own. It can
// speak to anyone in the tenant, so what bounds it here is not the credential
// but the caller: `sendText` takes an open id and refuses anything that is not
// one, and the only caller passes the schedule's stored owner.
//
// The secret never leaves this module and never reaches a log: the audit sink
// gets hashes, and a failure reports Feishu's own code and message, which are
// about the request rather than the credential.
//
// Which Feishu that is, what its ids look like and whether it lets an
// application message a person at all are the deployment's (`feishu`). One that
// does not is refused here, at construction, rather than at the first send.

// Refreshed before it expires rather than after it fails: a token that lapses
// mid-send turns one scheduled result into a silent miss.
const RENEW_BEFORE_MS = 5 * 60_000;
const MAX_TEXT = 30_000;

const digest = (value) => createHash("sha256").update(String(value)).digest("hex");

export class FeishuBot {
  constructor({ feishu, appId, appSecret, fetch: fetchImpl = fetch, now = Date.now, audit = () => {} } = {}) {
    if (!feishu?.openApi) throw new Error("机器人需要一个说 OpenAPI 的飞书部署");
    feishu.require("botMessages");
    if (!feishu.ids.app(appId)) throw new Error("机器人需要一个有效的飞书应用 ID");
    if (typeof appSecret !== "string" || !appSecret.trim()) throw new Error("机器人需要飞书应用密钥");
    Object.assign(this, { feishu, appId, appSecret, fetch: fetchImpl, now, audit });
    this.held = null;
    this.minting = null;
  }

  // One mint at a time: several schedules finishing together would otherwise
  // each ask Feishu for a token, and the extra ones buy nothing.
  async token() {
    if (this.held && this.held.expiresAt - this.now() > RENEW_BEFORE_MS) return this.held.value;
    if (this.minting) return this.minting;
    this.minting = this.#mint().finally(() => { this.minting = null; });
    return this.minting;
  }

  async #mint() {
    const response = await this.fetch(this.feishu.openApi.tenantTokenUrl, { method: "POST", redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }) });
    let payload; try { payload = await response.json(); } catch { throw new Error("飞书租户令牌接口返回了无法解析的内容"); }
    if (payload?.code !== 0 || typeof payload.tenant_access_token !== "string" || !payload.tenant_access_token) {
      throw new Error(`飞书拒绝签发机器人令牌：code=${payload?.code} ${String(payload?.msg ?? "").slice(0, 160)}`);
    }
    const seconds = Number.isSafeInteger(payload.expire) && payload.expire > 0 ? Math.min(payload.expire, 7200) : 7200;
    this.held = { value: payload.tenant_access_token, expiresAt: this.now() + seconds * 1000 };
    return this.held.value;
  }

  // One person, addressed by open id. A chat id would also be accepted by
  // Feishu; it is refused here so that no caller can turn a private result into
  // a group post by passing a different-looking string.
  async sendText({ openId, text }) {
    if (!this.feishu.ids.user(openId)) return { sent: false, reason: "not_an_open_id" };
    if (typeof text !== "string" || !text) return { sent: false, reason: "empty_text" };
    const body = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
    try {
      const token = await this.token();
      const response = await this.fetch(this.feishu.openApi.messageUrl, { method: "POST", redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ receive_id: openId, msg_type: "text", content: JSON.stringify({ text: body }), uuid: randomUUID() }) });
      let payload; try { payload = await response.json(); } catch { payload = null; }
      if (payload?.code === 0) {
        this.audit(Object.freeze({ kind: "bot_message_sent", at: this.now(), recipientHash: digest(openId), bytes: body.length }));
        return { sent: true, messageId: payload?.data?.message_id ?? null };
      }
      // Feishu's own words. 99991672 is the one an operator will actually meet:
      // the application has not been granted im:message:send_as_bot.
      const reason = `${response.status} code=${payload?.code ?? "?"} ${String(payload?.msg ?? "").slice(0, 160)}`;
      this.audit(Object.freeze({ kind: "bot_message_refused", at: this.now(), recipientHash: digest(openId), code: payload?.code ?? null }));
      return { sent: false, reason: payload?.code === 99991672
        ? `${reason}（应用缺少 im:message:send_as_bot 权限，请在飞书开放平台给本应用开通并发布）` : reason };
    } catch (error) {
      return { sent: false, reason: `unavailable: ${String(error?.message ?? error).slice(0, 200)}` };
    }
  }
}
