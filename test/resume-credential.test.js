import test from "node:test";
import assert from "node:assert/strict";
import { sealResume, openResume, resumeSealingKey, resumeProofMessage, resumeDigest } from "../src/control-plane/resume-credential.js";

const record = () => ({ appId: "cli_app", tenantId: "tenant", userId: "ou_user", deviceId: "device-1",
  devicePublicKey: "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n", refreshToken: "refresh-secret", notAfter: 1_800_000_000_000 });

test("封装后的凭据里看不到 refresh token，解封后原样取回", () => {
  const key = resumeSealingKey("app-secret", "cli_app");
  const sealed = sealResume(key, record());
  // The client holds this string. If the refresh token were readable from it,
  // the whole point of sealing would be gone.
  assert.ok(!Buffer.from(sealed, "base64url").toString("utf8").includes("refresh-secret"));
  assert.ok(!sealed.includes("refresh-secret"));
  assert.deepEqual(openResume(key, sealed), record());
});

test("换一个应用密钥或换一个 App ID 都打不开", () => {
  const sealed = sealResume(resumeSealingKey("app-secret", "cli_app"), record());
  assert.throws(() => openResume(resumeSealingKey("other-secret", "cli_app"), sealed), /Invalid resume credential/);
  assert.throws(() => openResume(resumeSealingKey("app-secret", "cli_other"), sealed), /Invalid resume credential/);
});

test("改一个字节就作废，而且不会走到解析", () => {
  const key = resumeSealingKey("app-secret", "cli_app");
  const blob = Buffer.from(sealResume(key, record()), "base64url");
  for (const index of [0, Math.floor(blob.length / 2), blob.length - 1]) {
    const tampered = Buffer.from(blob); tampered[index] ^= 0xff;
    assert.throws(() => openResume(key, tampered.toString("base64url")), /Invalid resume credential/);
  }
});

test("同样的内容每次封装都不同，重复的密文不会泄露相等性", () => {
  const key = resumeSealingKey("app-secret", "cli_app");
  assert.notEqual(sealResume(key, record()), sealResume(key, record()));
});

test("残缺或超长的输入被拒绝，不会抛出解析细节", () => {
  const key = resumeSealingKey("app-secret", "cli_app");
  for (const value of ["", "!!!", "a".repeat(40), "x".repeat(20000), null, 7]) {
    assert.throws(() => openResume(key, value), /Invalid resume credential/);
  }
  assert.throws(() => sealResume(key, { ...record(), refreshToken: "" }), /Invalid resume refresh token/);
  assert.throws(() => sealResume(key, { ...record(), notAfter: 0 }), /Invalid resume expiry/);
  assert.throws(() => sealResume(Buffer.alloc(8), record()), /Invalid resume sealing key/);
});

test("证明消息把来源、随机数和凭据摘要绑在一起", () => {
  const a = resumeProofMessage("http://127.0.0.1:3041", "nonce-1", resumeDigest("blob"));
  assert.notDeepEqual(a, resumeProofMessage("http://127.0.0.1:3042", "nonce-1", resumeDigest("blob")));
  assert.notDeepEqual(a, resumeProofMessage("http://127.0.0.1:3041", "nonce-2", resumeDigest("blob")));
  // A signature over one credential must not carry over to a different one.
  assert.notDeepEqual(a, resumeProofMessage("http://127.0.0.1:3041", "nonce-1", resumeDigest("other")));
  assert.match(a.toString("utf8"), /mydoubao-feishu-resume-v1/);
});
