import { WikiCoordinatorClient } from "./coordinator-client.js";
import { sourceAccessInput } from "./source-access-contract.js";
import { wikiOpaque } from "./manifest.js";

// Native-only permission probe. A positive result is NOT a key grant, a CLI
// identity binding, or proof that these are all the sources in a package.
export class FeishuSourceAccessClient {
  constructor(options) { this.transport = new WikiCoordinatorClient(options); }
  async check(input) {
    const { sources, sourceSetHash } = sourceAccessInput(input), session = structuredClone(await this.transport.session());
    const result = await this.transport.post(session, "/v1/feishu/source-access", session.token, { sources });
    await this.transport.unchanged(session);
    if (result?.authorized !== true || result.pointInTime !== true || result.sourceSetHash !== sourceSetHash || !Number.isSafeInteger(result.checkedAt) || result.checkedAt < 0 ||
      ![result.identity?.appId, result.identity?.tenantId, result.identity?.userId, result.identity?.deviceId].every(wikiOpaque)) throw new Error("服务端原文权限核验响应无效。");
    // Return only the documented metadata, never arbitrary upstream fields.
    const { appId, tenantId, userId, deviceId } = result.identity;
    return { authorized: true, pointInTime: true, sourceSetHash, checkedAt: result.checkedAt, identity: { appId, tenantId, userId, deviceId } };
  }
}
