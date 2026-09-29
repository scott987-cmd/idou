// How much one server takes on at once, and how much of that one person may
// hold (loadCapacity in control-plane/server-config.js). These were constants:
// 8 model requests and 16 Feishu calls for everybody together, 2 scheduled runs,
// and 50 scheduled tasks for a whole tenant -- a pilot's numbers, and with no
// share per person, one busy account could hold every slot the server had.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadCapacity } from "../src/control-plane/server-config.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { FeishuSourceAccess } from "../src/control-plane/feishu-source-access.js";
import { FeishuCliProxyService } from "../src/control-plane/feishu-cli-proxy.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { ScheduleStore } from "../src/control-plane/schedule-store.js";
import { zonedInstant } from "../src/control-plane/schedule-spec.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";

// The second half were fixed in the code for the pilot, each the whole server's
// (a hundred signed-in sessions, four Feishu reads at once, thirty sign-ins a
// minute...); unset, they are now sized for a hundred thousand people. The
// hourly media caps are spend and stay the pilot's.
const SERVER_WIDE = {
  sourceAccess: { signedIn: 200_000, reads: 128, readsPerMinute: 30_000 },
  renewal: { signedIn: 200_000, renewals: 128 },
  login: { perMinute: 1200 },
  mcp: { sessions: 1024 },
  media: { running: 64, perHour: 20, speechPerHour: 400 },
};

test("unset, every limit is what the server did before, and a person's share is the whole", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(loadCapacity({}))), {
    model: { maxConcurrent: 8, maxConcurrentPerUser: 8, requestsPerMinute: 90 },
    feishuCli: { maxConcurrent: 16, maxConcurrentPerUser: 16 },
    schedules: { maxConcurrentRuns: 2, perUser: 50, perTenant: 100_000 },
    ...SERVER_WIDE,
  });
});

test("set, each limit is read, and a wrong one is refused by its name", () => {
  const capacity = loadCapacity({ IDOU_MODEL_MAX_CONCURRENT: "64", IDOU_MODEL_MAX_CONCURRENT_PER_USER: "6", IDOU_MODEL_REQUESTS_PER_MINUTE: "120",
    IDOU_FEISHU_CLI_MAX_CONCURRENT: "128", IDOU_FEISHU_CLI_MAX_CONCURRENT_PER_USER: "8", IDOU_SCHEDULE_MAX_CONCURRENT: "6",
    IDOU_SCHEDULES_PER_USER: "20", IDOU_SCHEDULES_PER_TENANT: "20000" });
  assert.deepEqual(JSON.parse(JSON.stringify(capacity)), {
    model: { maxConcurrent: 64, maxConcurrentPerUser: 6, requestsPerMinute: 120 },
    feishuCli: { maxConcurrent: 128, maxConcurrentPerUser: 8 },
    schedules: { maxConcurrentRuns: 6, perUser: 20, perTenant: 20_000 },
    ...SERVER_WIDE,
  });
  const sized = loadCapacity({ IDOU_SIGNED_IN_MAX: "500000", IDOU_FEISHU_READS_MAX_CONCURRENT: "256", IDOU_FEISHU_READS_PER_MINUTE: "60000",
    IDOU_RENEWALS_MAX_CONCURRENT: "200", IDOU_LOGINS_PER_MINUTE: "3000", IDOU_MCP_SESSIONS_MAX: "4096", IDOU_MEDIA_JOBS_MAX_CONCURRENT: "100",
    IDOU_MEDIA_PER_HOUR: "2000", IDOU_SPEECH_PER_HOUR: "40000" });
  assert.deepEqual(JSON.parse(JSON.stringify({ sourceAccess: sized.sourceAccess, renewal: sized.renewal, login: sized.login, mcp: sized.mcp, media: sized.media })), {
    sourceAccess: { signedIn: 500_000, reads: 256, readsPerMinute: 60_000 }, renewal: { signedIn: 500_000, renewals: 200 },
    login: { perMinute: 3000 }, mcp: { sessions: 4096 }, media: { running: 100, perHour: 2000, speechPerHour: 40_000 },
  });
  for (const [env, reason] of [
    [{ IDOU_SIGNED_IN_MAX: "0" }, /IDOU_SIGNED_IN_MAX（同时登录的会话/],
    [{ IDOU_LOGINS_PER_MINUTE: "fast" }, /IDOU_LOGINS_PER_MINUTE/],
    [{ IDOU_MODEL_MAX_CONCURRENT: "0" }, /IDOU_MODEL_MAX_CONCURRENT（同时进行的模型请求（整台服务器））只能是 1 到 4096 之间的整数/],
    [{ IDOU_MODEL_MAX_CONCURRENT: "8.5" }, /IDOU_MODEL_MAX_CONCURRENT/],
    [{ IDOU_FEISHU_CLI_MAX_CONCURRENT: "lots" }, /IDOU_FEISHU_CLI_MAX_CONCURRENT/],
    [{ IDOU_SCHEDULE_MAX_CONCURRENT: "257" }, /1 到 256/],
    [{ IDOU_MODEL_MAX_CONCURRENT: "8", IDOU_MODEL_MAX_CONCURRENT_PER_USER: "9" }, /IDOU_MODEL_MAX_CONCURRENT_PER_USER 不能大于 IDOU_MODEL_MAX_CONCURRENT/],
    [{ IDOU_FEISHU_CLI_MAX_CONCURRENT_PER_USER: "17" }, /不能大于 IDOU_FEISHU_CLI_MAX_CONCURRENT/],
    [{ IDOU_SCHEDULES_PER_USER: "10", IDOU_SCHEDULES_PER_TENANT: "5" }, /IDOU_SCHEDULES_PER_USER 不能大于 IDOU_SCHEDULES_PER_TENANT/],
  ]) assert.throws(() => loadCapacity(env), reason, JSON.stringify(env));
});

// Two people, each signed in with the CLI bridge, through a real proxy on a
// real listener, against an upstream that answers only when told to.
async function proxied(t, options) {
  const sessions = new SessionRegistry();
  const sourceAccess = new FeishuSourceAccess({ feishu: SAAS_FEISHU, sessions, appId: "cli_capacity_fixture", cliProxyScopes: ["fixture:read"] });
  const signIn = (userId) => {
    const identity = { authProvider: "feishu", appId: "cli_capacity_fixture", tenantId: "tenant_fixture", userId, displayName: userId, expiresAt: Date.now() + 600_000, cliBridge: true };
    sourceAccess.remember(identity, `server-only-token-${userId}`);
    const session = sessions.issue({ ...identity, deviceId: `device-${userId}`, deviceProof: "ed25519-login", ttlMs: 300_000 });
    sourceAccess.bind(identity, session);
    return session;
  };
  const held = [];
  const proxy = new FeishuCliProxyService({ sourceAccess, ...options,
    fetchImpl: () => new Promise((resolve) => held.push(() => resolve(Response.json({ code: 0, data: { files: [] } })))) });
  const gateway = createModelGateway({ apiKey: "unused", sessions, authHandler: (req, res) => proxy.handle(req, res), fetchImpl: () => assert.fail("the model gateway is not used") });
  await new Promise((resolve, reject) => { gateway.once("error", reject); gateway.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${gateway.address().port}`;
  t.after(async () => { for (const release of held) release(); proxy.close(); sourceAccess.close(); sessions.sessions.clear(); gateway.closeAllConnections(); await new Promise((resolve) => gateway.close(resolve)); });
  const read = (session) => fetch(`${origin}/v1/feishu/cli-proxy`, { method: "GET", headers: { authorization: `Bearer ${session.token}`,
    "x-mydoubao-feishu-target": SAAS_FEISHU.openApi.origin, "x-mydoubao-feishu-path": "/open-apis/drive/v1/files?folder_token=x" } });
  const until = async (count) => {
    for (const end = Date.now() + 3000; held.length < count;) {
      if (Date.now() > end) throw new Error(`expected ${count} calls at Feishu, saw ${held.length}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  return { proxy, signIn, read, held, until };
}

test("a person's share of the Feishu proxy keeps one account from holding every slot", { timeout: 10_000 }, async (t) => {
  const { proxy, signIn, read, held, until } = await proxied(t, { maxConcurrent: 2, maxConcurrentPerUser: 1 });
  const alice = signIn("ou_alice"), bob = signIn("ou_bob"), carol = signIn("ou_carol");
  const first = read(alice);
  await until(1);
  const refused = await read(alice);
  assert.equal(refused.status, 429);
  assert.deepEqual(await refused.json(), { code: 429, msg: "feishu_cli_proxy_busy" }, "said in the envelope the CLI parses");
  const second = read(bob);
  await until(2);
  assert.equal((await read(carol)).status, 429, "and when the server is full, anybody waits");
  for (const release of held) release();
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  assert.deepEqual(proxy.capacity(), { active: 0, maxConcurrent: 2, maxConcurrentPerUser: 1, people: 0, calls: 4, busy: { server: 1, person: 1 } });
});

test("the proxy's limits cannot be zero, nor a person's share more than the whole", () => {
  const sourceAccess = new FeishuSourceAccess({ feishu: SAAS_FEISHU, sessions: new SessionRegistry(), appId: "cli_capacity_fixture", cliProxyScopes: ["fixture:read"] });
  assert.throws(() => new FeishuCliProxyService({ sourceAccess, maxConcurrent: 0 }), /Invalid Feishu CLI proxy concurrency/);
  assert.throws(() => new FeishuCliProxyService({ sourceAccess, maxConcurrent: 4, maxConcurrentPerUser: 5 }), /Invalid Feishu CLI proxy concurrency/);
  assert.equal(new FeishuCliProxyService({ sourceAccess }).capacity().maxConcurrent, 16, "unset, what it was");
  sourceAccess.close();
});

const ZONE = "Asia/Shanghai";
const daily = () => ({ title: "每天汇总", prompt: "把昨天的群消息汇总成三条要点。", mode: "cowork", schedule: { frequency: "daily", time: "09:00", timeZone: ZONE } });

test("scheduled tasks are counted per person, under a ceiling for the whole tenant", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-capacity-schedules-"));
  const now = zonedInstant({ year: 2026, month: 9, day: 26, hour: 8, minute: 0 }, ZONE);
  const store = new ScheduleStore({ databaseFile: path.join(directory, "schedules.db"), now: () => now, limits: { perUser: 2, perTenant: 3 } });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const person = (userId, tenantId = "tenant-a") => ({ tenantId, userId, familyId: `login-${userId}` });
  store.create(person("a"), daily()); store.create(person("a"), daily());
  assert.throws(() => store.create(person("a"), daily()), /一个人最多 2 个定时任务/);
  store.create(person("b"), daily());
  assert.throws(() => store.create(person("c"), daily()), /这个企业的定时任务已达上限 3 个/, "the tenant's ceiling still holds");
  assert.doesNotThrow(() => store.create(person("a", "tenant-b"), daily()), "another tenant counts on its own");
  // The same person, signed in again after a restart (a new login family), is still the same person.
  assert.throws(() => store.create({ ...person("a"), familyId: "login-a-again" }, daily()), /一个人最多/);
  assert.throws(() => new ScheduleStore({ databaseFile: path.join(directory, "other.db"), limits: { perUser: 5, perTenant: 4 } }), /Invalid schedule limits/);
});
