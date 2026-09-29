import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

// A login that survives a restart needs something durable, and the durable
// thing must not be the refresh token sitting on the client. So the server
// seals the refresh token to itself and hands the client an opaque blob: the
// client stores it, cannot read it, and can only ever give it back to the same
// server. The sealing key is derived from the application secret the control
// plane already holds, so nothing new has to be stored to survive a restart.
//
// The blob alone is not an authorization. Redeeming it also requires a
// signature from the device key held in the operating system's keystore, over a
// nonce this server issued. Neither half is enough on its own. This is still a
// bearer credential bound to a device key, not hardware attestation.
const VERSION = 1;
const LABEL = "mydoubao-feishu-resume-v1";
const NONCE_BYTES = 12, TAG_BYTES = 16, KEY_BYTES = 32;
const MAX_SEALED_BYTES = 8192;

export function resumeProofMessage(origin, nonce, digest) {
  return Buffer.from(JSON.stringify([LABEL, origin, nonce, digest]));
}

export function resumeSealingKey(appSecret, appId) {
  if (typeof appSecret !== "string" || !appSecret || typeof appId !== "string" || !appId) throw new Error("Resume sealing needs the application identity");
  return Buffer.from(hkdfSync("sha256", Buffer.from(appSecret, "utf8"), Buffer.from(LABEL, "utf8"), Buffer.from(appId, "utf8"), KEY_BYTES));
}

// The sealed fields are exactly what redemption needs and nothing else: who the
// login belongs to, which device may redeem it, when it stops being valid, and
// the refresh token itself.
function validate(record) {
  const { appId, tenantId, userId, deviceId, devicePublicKey, refreshToken, notAfter } = record ?? {};
  for (const [name, value] of [["appId", appId], ["tenantId", tenantId], ["userId", userId], ["deviceId", deviceId]]) {
    if (typeof value !== "string" || !value || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`Invalid resume ${name}`);
  }
  if (typeof devicePublicKey !== "string" || !devicePublicKey || devicePublicKey.length > 4096) throw new Error("Invalid resume device key");
  if (typeof refreshToken !== "string" || !refreshToken || refreshToken.length > 16384) throw new Error("Invalid resume refresh token");
  if (!Number.isSafeInteger(notAfter) || notAfter <= 0) throw new Error("Invalid resume expiry");
  return { appId, tenantId, userId, deviceId, devicePublicKey, refreshToken, notAfter };
}

export function sealResume(key, record) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new Error("Invalid resume sealing key");
  const payload = Buffer.from(JSON.stringify({ v: VERSION, ...validate(record) }), "utf8");
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const sealed = Buffer.concat([cipher.update(payload), cipher.final()]);
  const blob = Buffer.concat([nonce, sealed, cipher.getAuthTag()]);
  if (blob.length > MAX_SEALED_BYTES) throw new Error("Resume credential too large");
  return blob.toString("base64url");
}

export function openResume(key, value) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new Error("Invalid resume sealing key");
  if (typeof value !== "string" || !value || value.length > MAX_SEALED_BYTES * 2 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid resume credential");
  const blob = Buffer.from(value, "base64url");
  if (blob.length <= NONCE_BYTES + TAG_BYTES || blob.length > MAX_SEALED_BYTES) throw new Error("Invalid resume credential");
  const decipher = createDecipheriv("aes-256-gcm", key, blob.subarray(0, NONCE_BYTES));
  decipher.setAuthTag(blob.subarray(blob.length - TAG_BYTES));
  let payload;
  // A tampered or foreign blob fails authentication here; it must never reach
  // the parser, and the reason it failed must not distinguish the two cases.
  try { payload = Buffer.concat([decipher.update(blob.subarray(NONCE_BYTES, blob.length - TAG_BYTES)), decipher.final()]); }
  catch { throw new Error("Invalid resume credential"); }
  let record; try { record = JSON.parse(payload.toString("utf8")); } catch { throw new Error("Invalid resume credential"); }
  if (record?.v !== VERSION) throw new Error("Invalid resume credential");
  return validate(record);
}

export function resumeDigest(value) {
  return createHash("sha256").update(String(value)).digest("base64url");
}

export function sameDigest(a, b) {
  const left = Buffer.from(String(a)), right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}
