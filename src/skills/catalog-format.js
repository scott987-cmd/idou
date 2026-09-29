import { createHash, createPublicKey, verify } from "node:crypto";
import { validateServerUrl } from "../control-plane/client-session.js";

export const MAX_CATALOG_BYTES = 1024 * 1024;
const VERSION = /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/;
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const signingMessage = (bytes) => Buffer.concat([Buffer.from("mydoubao-skill-catalog-v1\0"), bytes]);
function fields(value, names) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== names.length || Object.keys(value).some((key) => !names.includes(key))) throw new Error("Invalid skill catalog fields");
}
function text(value, max) { if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw new Error("Invalid skill catalog text"); return value; }
function list(value, validate, max = 16) {
  if (!Array.isArray(value) || value.length > max || new Set(value).size !== value.length || value.some((item) => typeof item !== "string" || !validate(item))) throw new Error("Invalid skill catalog list");
  return [...value];
}
export function normalizeSkill(value) {
  fields(value, ["id", "version", "title", "description", "publisher", "requiredTools", "runtimeVersions", "files"]);
  // Two provenances share this shape: "enterprise-" comes from the signed server
  // catalog, "local-" from a folder this person imported themselves. The catalog
  // path below refuses local ids, so a server can never ship one.
  if (typeof value.id !== "string" || typeof value.version !== "string" || !/^(?:enterprise|local)-[a-z0-9][a-z0-9-]{0,63}$/.test(value.id) || !VERSION.test(value.version)) throw new Error("Invalid skill identity");
  fields(value.runtimeVersions, ["codex", "feishu"]);
  const runtimeVersions = Object.fromEntries(["codex", "feishu"].map((key) => [key, list(value.runtimeVersions[key], (item) => VERSION.test(item))]));
  if (!Array.isArray(value.files) || !value.files.length || value.files.length > 16) throw new Error("Invalid skill files");
  let total = 0;
  const paths = new Set(), files = value.files.map((file) => {
    fields(file, ["path", "text"]);
    if (typeof file.path !== "string" || file.path.length > 160 || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.(?:md|txt|json|js|py|sh)$/.test(file.path) || paths.has(file.path.toLowerCase())) throw new Error("Invalid or duplicate skill path");
    paths.add(file.path.toLowerCase()); text(file.text, 65536); total += Buffer.byteLength(file.text);
    return { path: file.path, text: file.text };
  });
  if (!files.some((file) => file.path === "SKILL.md") || total > 131072) throw new Error("Skill requires SKILL.md within size limits");
  return { id: value.id, version: value.version, title: text(value.title, 160), description: text(value.description, 600), publisher: text(value.publisher, 120),
    requiredTools: list(value.requiredTools, (item) => /^[a-z][a-z0-9:._/-]{0,79}$/.test(item) || /^mcp:[a-z][a-z0-9_-]{0,39}:[A-Za-z0-9_.-]{1,100}$/.test(item)), runtimeVersions, files };
}
export function normalizeSkills(skills) {
  if (!Array.isArray(skills) || skills.length > 100) throw new Error("Invalid skill count");
  const normalized = skills.map(normalizeSkill);
  // A signed catalog may only carry enterprise skills; locally imported ones are
  // admitted by the person's own confirmation, never by a server signature.
  if (normalized.some((skill) => !skill.id.startsWith("enterprise-"))) throw new Error("Enterprise catalog accepts only enterprise skills");
  if (new Set(normalized.map((skill) => skill.id)).size !== normalized.length || Buffer.byteLength(JSON.stringify(normalized)) > MAX_CATALOG_BYTES) throw new Error("Duplicate or oversized skill catalog");
  return normalized;
}
export const skillDigest = (skill) => sha256(JSON.stringify(normalizeSkill(skill)));
export function publicSigningKey(pem) {
  if (typeof pem !== "string" || !pem.startsWith("-----BEGIN PUBLIC KEY-----") || pem.includes("PRIVATE KEY")) throw new Error("Only a public verification key is accepted");
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Ed25519 skill verification key required");
  return { key, keyId: sha256(key.export({ format: "der", type: "spki" })) };
}
export function verifyCatalog(envelope, { publicKey, serverUrl, tenantId, appId, nonce, now = Date.now() }) {
  fields(envelope, ["keyId", "payload", "signature"]);
  const pinned = publicSigningKey(publicKey);
  if (envelope.keyId !== pinned.keyId || typeof envelope.payload !== "string" || envelope.payload.length > 2 * MAX_CATALOG_BYTES || !/^[A-Za-z0-9_-]+$/.test(envelope.payload) || typeof envelope.signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(envelope.signature)) throw new Error("Untrusted skill catalog signature");
  const bytes = Buffer.from(envelope.payload, "base64url");
  if (bytes.length > MAX_CATALOG_BYTES || bytes.toString("base64url") !== envelope.payload || !verify(null, signingMessage(bytes), pinned.key, Buffer.from(envelope.signature, "base64url"))) throw new Error("Invalid skill catalog signature");
  const payload = JSON.parse(bytes.toString("utf8"));
  fields(payload, ["schemaVersion", "revision", "serverUrl", "tenantId", "appId", "nonce", "issuedAt", "expiresAt", "skills"]);
  if (payload.schemaVersion !== 1 || !Number.isSafeInteger(payload.revision) || payload.revision < 1 || payload.serverUrl !== validateServerUrl(serverUrl) || payload.tenantId !== tenantId || payload.appId !== appId || payload.nonce !== nonce ||
      !Number.isSafeInteger(payload.issuedAt) || payload.issuedAt > now + 5000 || !Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= now || payload.expiresAt - payload.issuedAt > 60000 || payload.expiresAt <= payload.issuedAt) throw new Error("Skill catalog identity or freshness mismatch");
  return { ...payload, skills: normalizeSkills(payload.skills) };
}
