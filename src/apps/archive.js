import { appManifest, appDigest, appHash, appId } from "./manifest.js";

export const MAX_APP_PACKAGE_BYTES = 15 * 1024 * 1024;
const opaque = (s) => typeof s === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(s);
function exact(value, keys) { if (!value || Array.isArray(value) || typeof value !== "object" || Object.keys(value).some((key) => !keys.includes(key))) throw new Error("应用归档字段无效"); }
function url(value) { const u = new URL(value); if (typeof value !== "string" || value.length > 2048 || /[\\\x00-\x20]/.test(value) || u.protocol !== "https:" || u.username || u.password) throw new Error("应用归档链接无效"); return value; }
// A portable container, never an executable or an extraction instruction. Its
// byte digest differs from the canonical manifest digest shown in the catalog.
export function appPackage(bytes, digest) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_APP_PACKAGE_BYTES || !appDigest(digest)) throw new Error("应用版本包大小或标识无效");
  let value; try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("应用版本包 JSON 无效"); } exact(value, ["manifest", "blobs"]);
  const checked = appManifest(value.manifest);
  if (checked.digest !== digest || !Array.isArray(value.blobs) || value.blobs.length !== checked.manifest.files.length) throw new Error("应用版本包与清单不一致");
  const blobs = checked.manifest.files.map((file, i) => {
    const blob = value.blobs[i]; exact(blob, ["path", "base64"]);
    if (blob.path !== file.path || typeof blob.base64 !== "string" || blob.base64.length !== 4 * Math.ceil(file.bytes / 3)) throw new Error("应用版本包文件不一致");
    const decoded = Buffer.from(blob.base64, "base64");
    if (decoded.toString("base64") !== blob.base64 || decoded.length !== file.bytes || appHash(decoded) !== file.sha256) throw new Error("应用版本包内容校验失败");
    return { path: file.path, base64: blob.base64 };
  });
  const canonical = Buffer.from(JSON.stringify({ manifest: checked.manifest, blobs }));
  if (!canonical.equals(bytes)) throw new Error("应用版本包不是规范格式");
  return { ...checked, blobs, bytes: canonical, sha256: appHash(canonical) };
}
export function archiveInput(value) {
  exact(value, ["folder", "bytes", "sha256", "policyDigest"]);
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > MAX_APP_PACKAGE_BYTES || !appDigest(value.sha256) || !appDigest(value.policyDigest)) throw new Error("应用归档包信息无效");
  const f = value.folder; exact(f, ["providerId", "token", "url", "title", "identity"]); exact(f.identity, ["principal", "tenantKey", "verifiedAt"]);
  if (!opaque(f.providerId) || !opaque(f.token) || !opaque(f.identity.tenantKey) || !appDigest(f.identity.principal) || !Number.isFinite(f.identity.verifiedAt) || typeof f.title !== "string" || !f.title || f.title.length > 300 || /[\x00-\x1f\x7f]/.test(f.title)) throw new Error("应用归档目标无效");
  return { folder: { providerId: f.providerId, token: f.token, url: url(f.url), title: f.title, identity: { principal: f.identity.principal, tenantKey: f.identity.tenantKey, verifiedAt: f.identity.verifiedAt } }, bytes: value.bytes, sha256: value.sha256, policyDigest: value.policyDigest };
}
export const archiveInputKey = (value) => { const v = archiveInput(value); return appHash(JSON.stringify({ ...v, folder: { ...v.folder, identity: { ...v.folder.identity, verifiedAt: 0 } } })); };
export function archiveRecord(value) {
  exact(value, ["id", "state", "input", "fileToken"]);
  if (!appId(value.id) || !["prepared", "uploading", "recorded", "listed"].includes(value.state) || (value.fileToken !== null && !opaque(value.fileToken)) || (["recorded", "listed"].includes(value.state) !== (value.fileToken !== null))) throw new Error("应用归档记录无效");
  return { id: value.id, state: value.state, input: archiveInput(value.input), fileToken: value.fileToken };
}
