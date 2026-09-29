import test from "node:test";
import assert from "node:assert/strict";
import { SaasFeishuCliProvider } from "../src/providers/feishu/saas-cli-provider.js";
import { FeishuCliSidecar } from "../src/providers/feishu/cli-sidecar.js";
import { SaasDriveFiles } from "../src/providers/feishu/drive-files.js";

// 一次提问要重读最多十份来源，每读一份都前后各核一次用户：真机上一问 19 次 user_info，每次都是一个
// CLI 进程。登录桥接下，用户就是应用会话的用户，同一会话里刚核过的结果可以共用；换了会话（重新登录、
// 续期换令牌）就重新核，写入永远现核。
function bridged({ reuseMs = 30_000 } = {}) {
  const state = { key: "session-1", now: 1_000, userInfo: 0, user: "ou_alice", failNext: false, onUserInfo: null };
  const provider = new SaasFeishuCliProvider(
    { binary: process.execPath, profile: null, environment: () => ({}), identityKey: async () => state.key },
    async (_binary, args) => {
      if (args[0] !== "api" || args[2] !== "/open-apis/authen/v1/user_info") throw new Error(`fixture refuses ${args.join(" ")}`);
      state.userInfo += 1;
      state.onUserInfo?.(state);
      if (state.failNext) { state.failNext = false; return { code: 1, stdout: "", stderr: "network" }; }
      return { code: 0, stdout: JSON.stringify({ ok: true, identity: "user", data: { open_id: state.user, tenant_key: "tenant_a" } }), stderr: "" };
    },
    { now: () => state.now, identityReuseMs: reuseMs });
  return { provider, state };
}

test("同一会话、刚核过：一问里的多次读取共用一次用户核验", async () => {
  const { provider, state } = bridged();
  const first = await provider.documentIdentity();
  for (let index = 0; index < 18; index += 1) assert.deepEqual(await provider.documentIdentity(), first);
  assert.equal(state.userInfo, 1);
});

test("会话换了就重新核：新登录的用户不会被当成旧用户", async () => {
  const { provider, state } = bridged();
  const alice = await provider.documentIdentity();
  state.key = "session-2"; state.user = "ou_bob";
  const bob = await provider.documentIdentity();
  assert.equal(state.userInfo, 2);
  assert.notEqual(bob.principal, alice.principal);
});

test("超过共用时限就重新核", async () => {
  const { provider, state } = bridged({ reuseMs: 30_000 });
  await provider.documentIdentity();
  state.now += 29_999; await provider.documentIdentity();
  assert.equal(state.userInfo, 1);
  state.now += 2; await provider.documentIdentity();
  assert.equal(state.userInfo, 2);
});

test("写入要求现核：fresh 每次都真的去问飞书", async () => {
  const { provider, state } = bridged();
  await provider.documentIdentity();
  await provider.documentIdentity({ fresh: true });
  await provider.documentIdentity({ fresh: true });
  assert.equal(state.userInfo, 3);
});

test("核验途中会话变了：这次的结果不留给后面的读取", async () => {
  const { provider, state } = bridged();
  state.onUserInfo = (current) => { current.key = "session-2"; current.onUserInfo = null; };
  await provider.documentIdentity();
  await provider.documentIdentity();
  assert.equal(state.userInfo, 2, "途中换了会话的核验结果不能被沿用");
});

test("核验失败不留结果；没有会话摘要时每次都核", async () => {
  const { provider, state } = bridged();
  state.failNext = true;
  await assert.rejects(provider.documentIdentity());
  await provider.documentIdentity();
  await provider.documentIdentity();
  assert.equal(state.userInfo, 2);

  let calls = 0;
  const unkeyed = new SaasFeishuCliProvider({ binary: process.execPath, profile: null, environment: () => ({}) }, async () => {
    calls += 1;
    return { code: 0, stdout: JSON.stringify({ ok: true, identity: "user", data: { open_id: "ou_alice", tenant_key: "tenant_a" } }), stderr: "" };
  });
  await unkeyed.documentIdentity(); await unkeyed.documentIdentity();
  assert.equal(calls, 2);
});

test("会话摘要：令牌一变就不同，不含令牌原文；会话不可用时不给摘要", async () => {
  let session = { serverUrl: "https://mydoubao.example", token: "SECRET-token-1", expiresAt: 10_000, identity: { appId: "cli_test", cliBridge: true } };
  const sidecar = new FeishuCliSidecar({ appId: "cli_test", getSession: async () => session, now: () => 1_000 });
  const first = await sidecar.sessionFingerprint();
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(await sidecar.sessionFingerprint(), first);
  session = { ...session, token: "SECRET-token-2" };
  assert.notEqual(await sidecar.sessionFingerprint(), first);
  session = { ...session, expiresAt: 500 };
  await assert.rejects(sidecar.sessionFingerprint(), /unavailable/);
});

test("云盘写入前的身份检查要求现核", async () => {
  const seen = [];
  const drive = new SaasDriveFiles({ id: "saas-cli", documentIdentity: async (options) => { seen.push(options); return { principal: "p", tenantKey: "t", verifiedAt: 1 }; } });
  await drive.identity();
  assert.deepEqual(seen, [{ fresh: true }]);
});
