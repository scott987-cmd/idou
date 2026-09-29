import { createHash } from "node:crypto";

export const ACCOUNT_IDENTITY_SCOPE = "contact:user.employee_id:readonly";
export const accountOpaque = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);
// Feishu permits custom tenant user IDs (not just ASCII opaque tokens).
export const tenantUserId = value => typeof value === "string" && value.length > 0 && [...value].length <= 64 && !/[\s\p{C}]/u.test(value);
export function accountCandidate(value) {
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(",") !== "tenantKey,tenantUserId" || !accountOpaque(value.tenantKey) || !tenantUserId(value.tenantUserId)) throw new Error("Invalid Feishu account candidate");
  return { tenantKey: value.tenantKey, tenantUserId: value.tenantUserId };
}
export const accountCandidateHash = value => createHash("sha256").update(JSON.stringify(accountCandidate(value))).digest("hex");
