import { validateServerUrl } from "../control-plane/client-session.js";
import { wikiDigest, wikiUuid, wikiHash, wikiManifest, wikiExact } from "./manifest.js";

// Native-only client; credentials never enter a renderer or a Drive artifact.
export class WikiCoordinatorClient {
  constructor({ getSession, fetchImpl = fetch, now = Date.now }) { Object.assign(this, { getSession, fetch: fetchImpl, now }); this.cached = null; }
  async session() {
    const value = await this.getSession();
    if (validateServerUrl(value.serverUrl) !== value.serverUrl || !/^[A-Za-z0-9_-]{43}$/.test(value.token) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= this.now()) throw new Error("请先连接有效的企业服务端。");
    return value;
  }
  async unchanged(session) { const current = await this.session(); if (current.token !== session.token || current.serverUrl !== session.serverUrl) throw new Error("知识节点账号或服务端已变化，未接受旧结果。"); }
  async post(session, route, token, body) {
    let response;
    try {
      response = await this.fetch(`${session.serverUrl}${route}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok || !response.body || response.headers.get("content-type")?.split(";")[0] !== "application/json") { await response.body?.cancel(); throw new Error(); }
      let size = 0; const chunks = [], reader = response.body.getReader();
      try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 16384) { await reader.cancel(); throw new Error(); } chunks.push(Buffer.from(value)); } } finally { reader.releaseLock(); }
      return JSON.parse(Buffer.concat(chunks));
    } catch { throw new Error(`知识节点协调失败${response ? `（HTTP ${response.status}）` : ""}。操作结果可能未知；未自动重试。`); }
  }
  async call(action, body) {
    const session = await this.session();
    if (!this.cached || this.cached.parent !== session.token || this.cached.origin !== session.serverUrl || this.cached.expiresAt <= this.now() + 10000) {
      const lease = await this.post(session, "/auth/wiki-token", session.token, {});
      if (lease.audience !== "wiki-coordinator" || !/^[A-Za-z0-9_-]{43}$/.test(lease.token) || !Number.isSafeInteger(lease.expiresAt) || lease.expiresAt <= this.now() || lease.expiresAt > Math.min(session.expiresAt, this.now() + 300000)) throw new Error("知识节点授权响应无效。");
      await this.unchanged(session); this.cached = { ...lease, parent: session.token, origin: session.serverUrl };
    }
    const result = await this.post(session, `/v1/wiki/${action}`, this.cached.token, body); await this.unchanged(session); return result;
  }
  async status() {
    const result = await this.call("status", {});
    if (!wikiDigest(result.nodeId) || !wikiDigest(result.policy?.policyDigest) || !Number.isSafeInteger(result.policy.remainingBytes) || result.policy.remainingBytes < 0 || result.limits?.leaseMs !== 120000) throw new Error("知识节点状态响应无效。");
    return result;
  }
  publication(value) {
    if (!Number.isSafeInteger(value?.generation) || value.generation < 1 || !Number.isSafeInteger(value.fence) || value.fence < 1 || !wikiDigest(value.nodeId) || value.clientReported !== true || !["published", "tombstone"].includes(value.state)) throw new Error("知识发布记录无效。");
    const manifest = value.state === "tombstone" && value.manifest === null ? null : wikiManifest(value.manifest);
    if (value.state !== (manifest ? "published" : "tombstone") || wikiHash(manifest) !== value.manifestHash) throw new Error("知识发布摘要不匹配。");
    return value;
  }
  async head(shardKey) {
    if (!wikiDigest(shardKey)) throw new Error("知识分片标识无效。");
    const result = await this.call("head", { shardKey });
    if (result.shardKey !== shardKey) throw new Error("知识分片响应不匹配。");
    if (result.publication !== null) this.publication(result.publication); return result;
  }
  async lease(action, input) {
    wikiExact(input, action === "renew" ? ["shardKey", "leaseId", "fence"] : ["shardKey", "expectedGeneration", "requestId"]);
    if (!wikiDigest(input.shardKey) || (action === "renew" ? !wikiUuid(input.leaseId) || !Number.isSafeInteger(input.fence) || input.fence < 1 : !wikiUuid(input.requestId) || !Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0)) throw new Error("知识分片请求无效。");
    const result = await this.call(action, input);
    if (!wikiUuid(result.id) || result.shardKey !== input.shardKey || !wikiDigest(result.nodeId) || !Number.isSafeInteger(result.fence) || result.fence < 1 ||
      !Number.isSafeInteger(result.expiresAt) || !Number.isSafeInteger(result.expectedGeneration) || result.expectedGeneration < 0 || !["active", "expired", "committed"].includes(result.state) ||
      action === "renew" && (result.id !== input.leaseId || result.fence !== input.fence) || action === "acquire" && result.expectedGeneration !== input.expectedGeneration) throw new Error("知识分片租约响应不匹配。");
    if ((result.state === "committed") !== (result.publication !== null) || result.state === "active" && result.expiresAt <= this.now()) throw new Error("知识分片租约已过期或状态不一致。");
    if (result.publication !== null) this.publication(result.publication); return result;
  }
  acquire(input) { return this.lease("acquire", input); }
  renew(input) { return this.lease("renew", input); }
  async publish(input) {
    wikiExact(input, ["shardKey", "leaseId", "fence", "expectedGeneration", "manifest"]);
    if (!wikiDigest(input.shardKey) || !wikiUuid(input.leaseId) || !Number.isSafeInteger(input.fence) || input.fence < 1 || !Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0) throw new Error("知识发布请求无效。");
    if (input.manifest !== null) wikiManifest(input.manifest);
    const value = this.publication(await this.call("publish", input));
    if (value.generation !== input.expectedGeneration + 1 || value.fence !== input.fence || value.manifestHash !== wikiHash(input.manifest === null ? null : wikiManifest(input.manifest))) throw new Error("知识发布回执与请求不一致。");
    return value;
  }
}
