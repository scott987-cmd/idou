import test from "node:test";
import assert from "node:assert/strict";
import { FeishuBot } from "../src/control-plane/feishu-bot.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";

const APP = "cli_fixture", SECRET = "synthetic-app-secret";
const OWNER = "ou_1f2e3d4c5b6a7988";

function upstream({ expire = 7200, sendCode = 0, sendMsg = "ok", tokenCode = 0 } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), headers: options.headers, body: JSON.parse(options.body) });
    if (String(url).includes("tenant_access_token")) {
      return { status: 200, json: async () => (tokenCode === 0
        ? { code: 0, tenant_access_token: `bot-token-${calls.length}`, expire }
        : { code: tokenCode, msg: "app not found" }) };
    }
    return { status: 200, json: async () => (sendCode === 0
      ? { code: 0, data: { message_id: "om_fixture", chat_id: "oc_fixturefixture" } }
      : { code: sendCode, msg: sendMsg }) };
  };
  return { calls, fetchImpl };
}

const bot = (io, extra = {}) => new FeishuBot({ feishu: SAAS_FEISHU, appId: APP, appSecret: SECRET, fetch: io.fetchImpl, ...extra });

test("a message goes out as the application, to the one person it was given", async () => {
  const io = upstream();
  const audits = [];
  const sent = await bot(io, { audit: (event) => audits.push(event) }).sendText({ openId: OWNER, text: "定时任务「早报」已完成" });

  assert.deepEqual(sent, { sent: true, messageId: "om_fixture" });
  const [minted, message] = io.calls;
  assert.match(minted.url, /tenant_access_token/);
  assert.equal(message.headers.authorization, "Bearer bot-token-1", "the application's own credential, not a person's");
  assert.match(message.url, /receive_id_type=open_id/);
  assert.equal(message.body.receive_id, OWNER);
  assert.equal(JSON.parse(message.body.content).text.includes("早报"), true);
  assert.doesNotMatch(JSON.stringify(audits), new RegExp(`${SECRET}|${OWNER}|bot-token`), "the audit carries hashes, not secrets");
});

test("a chat id is refused, so a private result cannot become a group post", async () => {
  // The bot credential can reach anyone in the tenant. What bounds this is the
  // caller, so the caller is bounded here rather than trusted.
  const io = upstream();
  const refused = await bot(io).sendText({ openId: "oc_1234567890abcdef", text: "x" });
  assert.deepEqual(refused, { sent: false, reason: "not_an_open_id" });
  assert.deepEqual(io.calls, [], "nothing was asked of Feishu");
});

test("the token is minted once and reused until it is nearly spent", async () => {
  const io = upstream({ expire: 7200 });
  let clock = Date.now();
  const it = bot(io, { now: () => clock });
  await it.sendText({ openId: OWNER, text: "one" });
  await it.sendText({ openId: OWNER, text: "two" });
  assert.equal(io.calls.filter((call) => call.url.includes("tenant_access_token")).length, 1);

  clock += 7200_000;                                   // past its life
  await it.sendText({ openId: OWNER, text: "three" });
  assert.equal(io.calls.filter((call) => call.url.includes("tenant_access_token")).length, 2);
});

test("schedules finishing together mint one token between them", async () => {
  const io = upstream();
  const it = bot(io);
  await Promise.all([it.sendText({ openId: OWNER, text: "a" }), it.sendText({ openId: OWNER, text: "b" })]);
  assert.equal(io.calls.filter((call) => call.url.includes("tenant_access_token")).length, 1);
});

test("the missing permission is named, because it is the one an operator will meet", async () => {
  const io = upstream({ sendCode: 99991672, sendMsg: "no permission" });
  const refused = await bot(io).sendText({ openId: OWNER, text: "x" });
  assert.equal(refused.sent, false);
  assert.match(refused.reason, /im:message:send_as_bot/);
  assert.match(refused.reason, /飞书开放平台/);
});

test("any other refusal reports Feishu's own code rather than a guess", async () => {
  const io = upstream({ sendCode: 230002, sendMsg: "user not in tenant" });
  const refused = await bot(io).sendText({ openId: OWNER, text: "x" });
  assert.equal(refused.sent, false);
  assert.match(refused.reason, /230002/);
  assert.doesNotMatch(refused.reason, /send_as_bot/);
});

test("a refused token is an answer, not a throw into the run that asked", async () => {
  const io = upstream({ tokenCode: 10003 });
  const refused = await bot(io).sendText({ openId: OWNER, text: "x" });
  assert.equal(refused.sent, false);
  assert.match(refused.reason, /unavailable: 飞书拒绝签发机器人令牌/);
});

test("an unreachable Feishu is an answer too", async () => {
  const refused = await new FeishuBot({ feishu: SAAS_FEISHU, appId: APP, appSecret: SECRET, fetch: async () => { throw new Error("connect ECONNREFUSED"); } })
    .sendText({ openId: OWNER, text: "x" });
  assert.equal(refused.sent, false);
  assert.match(refused.reason, /ECONNREFUSED/);
});

test("the application identity is checked before anything is attempted", () => {
  assert.throws(() => new FeishuBot({ feishu: SAAS_FEISHU, appId: "not-an-app", appSecret: SECRET }), /应用 ID/);
  assert.throws(() => new FeishuBot({ feishu: SAAS_FEISHU, appId: APP, appSecret: "" }), /应用密钥/);
});
