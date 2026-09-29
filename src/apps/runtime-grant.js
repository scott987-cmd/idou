import { appDigest, appId, appManifest } from "./manifest.js";
import { MAX_APP_PACKAGE_BYTES } from "./archive.js";

export function runtimePolicy(value) {
  if (value === undefined || value === null) return null;
  if (typeof value.nodeId !== "string" || typeof value.imageId !== "string") throw new Error("Invalid runtime node identity");
  if (!value || Object.keys(value).some(k => !["operators", "nodeId", "imageId"].includes(k)) || !Array.isArray(value.operators) || !value.operators.length || value.operators.length > 1000 || value.operators.some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(id)) || new Set(value.operators).size !== value.operators.length || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.nodeId) || !/^sha256:[a-f0-9]{64}$/.test(value.imageId)) throw new Error("Invalid application runtime policy");
  return { operators: [...value.operators], nodeId: value.nodeId, imageId: value.imageId };
}
export function runtimeBinding(value) {
  if (typeof value?.nodeId !== "string" || typeof value?.imageId !== "string") throw new Error("Invalid runtime binding node identity");
  if (!value || Object.keys(value).some(k => !["appId", "digest", "archiveId", "reviewId", "sha256", "bytes", "nodeId", "imageId"].includes(k)) || !appId(value.appId) || !appDigest(value.digest) || !appId(value.archiveId) || !appId(value.reviewId) || !appDigest(value.sha256) || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > MAX_APP_PACKAGE_BYTES || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.nodeId) || !/^sha256:[a-f0-9]{64}$/.test(value.imageId)) throw new Error("Invalid application runtime binding");
  return { appId: value.appId, digest: value.digest, archiveId: value.archiveId, reviewId: value.reviewId, sha256: value.sha256, bytes: value.bytes, nodeId: value.nodeId, imageId: value.imageId };
}
export function runtimeReceipt(value) {
  if (!value || Object.keys(value).some(k => !["binding", "manifest", "expiresAt", "deployed"].includes(k)) || value.deployed !== false || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now() || value.expiresAt > Date.now() + 300000) throw new Error("Invalid runtime authorization receipt");
  const binding = runtimeBinding(value.binding), manifest = appManifest(value.manifest);
  if (binding.digest !== manifest.digest) throw new Error("Runtime manifest does not match authorization");
  return { binding, manifest: manifest.manifest, expiresAt: value.expiresAt, deployed: false };
}
export function runtimeDetail(value) {
  if (!value || Object.keys(value).some(k => !["binding", "manifest", "title", "createdAt"].includes(k)) || typeof value.title !== "string" || !value.title.trim() || value.title.length > 80 || /[\x00-\x1f\x7f]/.test(value.title) || !Number.isSafeInteger(value.createdAt) || value.createdAt < 1) throw new Error("运行版本详情无效");
  const binding = runtimeBinding(value.binding), checked = appManifest(value.manifest);
  if (checked.digest !== binding.digest) throw new Error("运行版本清单与许可目标不一致");
  return { binding, manifest: checked.manifest, title: value.title, createdAt: value.createdAt };
}
