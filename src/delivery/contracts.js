import { createHash, randomUUID } from "node:crypto";

export const deliveryKinds = Object.freeze(["link", "snapshot", "media"]);
export const permissionPolicies = Object.freeze(["keep", "grant-view", "grant-edit"]);

export function createDeliveryIntent(input) {
  if (!input || !deliveryKinds.includes(input.kind)) throw new Error("invalid delivery kind");
  if (!permissionPolicies.includes(input.permissionPolicy || "keep")) {
    throw new Error("invalid permission policy");
  }
  if (!Array.isArray(input.recipients) || input.recipients.length === 0) {
    throw new Error("at least one delivery recipient is required");
  }
  if (!input.resource?.url && !input.resource?.localPath) {
    throw new Error("delivery requires a resource URL or local path");
  }

  const id = input.id || randomUUID();
  const idempotencyKey = createHash("sha256").update(id).digest("hex").slice(0, 40);
  return {
    id,
    idempotencyKey,
    permissionPolicy: "keep",
    ...input,
  };
}

