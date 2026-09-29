import { WikiCoordinatorClient } from "./coordinator-client.js";
import { sourceDeclaration } from "./source-declaration.js";
import { wikiDigest, wikiExact, wikiUuid } from "./manifest.js";

export class WikiSourceRegistryClient {
  constructor(options) { this.transport = new WikiCoordinatorClient(options); }
  async call(action, body, signal) {
    signal?.throwIfAborted(); const session = structuredClone(await this.transport.session());
    const result = await this.transport.post(session, `/v1/wiki/sources/${action}`, session.token, body);
    await this.transport.unchanged(session); signal?.throwIfAborted();
    if (result.provenance !== "publisher-declared" || result.contentVerified !== false || result.shardKey !== body.shardKey || !wikiDigest(result.sourceSetHash) ||
      !Number.isSafeInteger(result.sourceCount) || result.sourceCount < 1 || result.sourceCount > 200 || !Number.isSafeInteger(result.generation) || result.generation < 1) throw new Error("来源登记响应无效。");
    return result;
  }
  async register(input, { signal } = {}) {
    const body = structuredClone(input); wikiExact(body, ["shardKey", "leaseId", "fence", "sources"]);
    const declaration = sourceDeclaration(body.sources);
    if (!wikiDigest(body.shardKey) || !wikiUuid(body.leaseId) || !Number.isSafeInteger(body.fence) || body.fence < 1) throw new Error("来源登记请求无效。");
    const result = await this.call("register", { ...body, sources: declaration.sources }, signal);
    if (result.leaseId !== body.leaseId || result.fence !== body.fence || result.sourceSetHash !== declaration.sourceSetHash || result.sourceCount !== declaration.sourceCount) throw new Error("来源登记回执不匹配。");
    return { shardKey: result.shardKey, leaseId: result.leaseId, fence: result.fence, generation: result.generation, sourceSetHash: result.sourceSetHash,
      sourceCount: result.sourceCount, provenance: "publisher-declared", contentVerified: false };
  }
  async checkPublished(shardKey, { signal } = {}) {
    if (!wikiDigest(shardKey)) throw new Error("知识分片无效。");
    const result = await this.call("check", { shardKey }, signal);
    if (result.declaredSourcesReadable !== true || result.pointInTime !== true || !wikiDigest(result.manifestHash)) throw new Error("来源核验响应无效。");
    return { shardKey, generation: result.generation, manifestHash: result.manifestHash, sourceSetHash: result.sourceSetHash, sourceCount: result.sourceCount,
      declaredSourcesReadable: true, pointInTime: true, provenance: "publisher-declared", contentVerified: false };
  }
}
