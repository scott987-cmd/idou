import { wikiExact, wikiHash } from "../knowledge/manifest.js";
import { sourceAccessInput } from "../knowledge/source-access-contract.js";

// Permission checks cover the immutable DECLARED set; no key/content access is
// granted by these routes. Actual package completeness needs separate proof.
export class WikiSourceRegistryService {
  constructor({ sessions, coordinator, sourceAccess }) {
    if (!sourceAccess?.feishu) throw new Error("Wiki source registration needs the Feishu deployment its source access belongs to");
    Object.assign(this, { sessions, coordinator, sourceAccess });
  }
  async handle(req, res) {
    const action = /^\/v1\/wiki\/sources\/(register|check)$/.exec(req.url)?.[1]; if (!action) return false;
    const send = (status, body) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
    try {
      if (req.method !== "POST" || req.headers.origin || req.headers["content-type"]?.split(";")[0] !== "application/json" || req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") throw new Error();
      const token = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
      const who = this.sessions.verify(token);
      const current = () => {
        if (!who || this.sessions.verify(token) !== who || who.authProvider !== "feishu" || who.audience !== "codex-model-gateway") throw new Error();
        const policy = this.coordinator.authorize(who);
        // The tenant is registered for a deployment, and it has to be the one
        // these credentials belong to and one that has a Wiki at all. The tenant,
        // source, ACL and revision checks below still apply to it unchanged.
        const feishu = this.sourceAccess.feishu;
        if (!feishu.supports("wiki") || policy.providerId !== feishu.id || policy.driveTenantKey !== who.tenantId) throw new Error();
      };
      current();
      let length = 0; const chunks = [];
      for await (const chunk of req.iterator({ destroyOnReturn: false })) { length += chunk.length; if (length > 100000) throw new Error(); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks)); current();
      let declaration, previous;
      if (action === "register") ({ declaration } = this.coordinator.declarationTarget(who, body));
      else { wikiExact(body, ["shardKey"]); declaration = this.coordinator.publishedSources(who, body.shardKey); previous = wikiHash(declaration.publication); }
      for (let offset = 0; offset < declaration.sources.length; offset += 20) {
        current(); const input = { sources: declaration.sources.slice(offset, offset + 20).map(row => ({ resourceType: "docx", resourceId: row.resourceId })) };
        const result = await this.sourceAccess.check(token, input); current();
        if (result.authorized !== true || result.pointInTime !== true || result.sourceSetHash !== sourceAccessInput(input).sourceSetHash ||
          result.identity?.appId !== who.appId || result.identity?.tenantId !== who.tenantId || result.identity?.userId !== who.userId || result.identity?.deviceId !== who.deviceId) throw new Error();
      }
      current();
      if (action === "register") send(200, this.coordinator.registerSources(who, body));
      else {
        const latest = this.coordinator.publishedSources(who, body.shardKey);
        if (wikiHash(latest.publication) !== previous) throw new Error();
        send(200, { shardKey: body.shardKey, generation: latest.publication.generation, manifestHash: latest.publication.manifestHash,
          sourceSetHash: latest.sourceSetHash, sourceCount: latest.sourceCount, declaredSourcesReadable: true, pointInTime: true, provenance: "publisher-declared", contentVerified: false });
      }
    } catch { send(403, { error: "wiki_source_registration_or_access_not_verified" }); req.resume(); }
    return true;
  }
}
