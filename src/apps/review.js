import { appId, appDigest, appManifest } from "./manifest.js";

export function reviewInput(value) {
  if (!value || Object.keys(value).some(key => !["appId", "digest", "decision", "note"].includes(key)) || !appId(value.appId) || !appDigest(value.digest) || !["approved", "rejected"].includes(value.decision) || typeof value.note !== "string" || !value.note.trim() || value.note.length > 1000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.note)) throw new Error("请填写有效的版本审核结论与说明（最多 1000 字）");
  return { appId: value.appId, digest: value.digest, decision: value.decision, note: value.note.trim() };
}
export function reviewRecord(value) {
  if (value === null || value === undefined) return null;
  if (!value || Object.keys(value).some(key => !["id", "decision", "note", "reviewedAt"].includes(key)) || !appId(value.id) || !["approved", "rejected"].includes(value.decision) || typeof value.note !== "string" || !value.note.trim() || value.note.length > 1000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.note) || !Number.isSafeInteger(value.reviewedAt) || value.reviewedAt < 1) throw new Error("应用审核记录无效");
  return { id: value.id, decision: value.decision, note: value.note, reviewedAt: value.reviewedAt };
}
export function reviewCandidate(value) {
  if (!value || Object.keys(value).some(key => !["appId", "digest", "title", "manifest", "state", "deployed", "createdAt", "review"].includes(key)) || !appId(value.appId) || !appDigest(value.digest) || typeof value.title !== "string" || !value.title.trim() || value.title.length > 80 || /[\x00-\x1f\x7f]/.test(value.title) || !["submitted", "withdrawn"].includes(value.state) || value.deployed !== false || !Number.isSafeInteger(value.createdAt) || value.createdAt < 1) throw new Error("待审核应用版本无效");
  const checked = appManifest(value.manifest);
  if (checked.digest !== value.digest) throw new Error("审核清单与版本哈希不一致");
  return { appId: value.appId, digest: checked.digest, title: value.title, manifest: checked.manifest, state: value.state, deployed: false, createdAt: value.createdAt, review: reviewRecord(value.review) };
}
export function reviewCursor(value) {
  if (value !== null && (typeof value !== "string" || !/^[a-f0-9-]{36}:[a-f0-9]{64}$/.test(value) || !appId(value.slice(0, 36)))) throw new Error("应用审核分页标识无效");
  return value;
}
