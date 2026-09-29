import { appId } from "../apps/manifest.js";
import { runtimeBinding } from "../apps/runtime-grant.js";

class RuntimeError extends Error { constructor(status, code) { super(code); this.status = status; } }
const fail = (status, code) => { throw new RuntimeError(status, code); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export class AppRuntimeService {
  constructor({ sessions, catalog, allowDevelopment = false }) {
    Object.assign(this, { sessions, catalog, allowDevelopment }); this.claims = new Map();
    this.onRevoked = id => this.claims.delete(id); sessions.on("revoked", this.onRevoked);
  }
  close() { this.sessions.removeListener("revoked", this.onRevoked); this.claims.clear(); }
  async handle(req, res) {
    const route = req.url, issue = route === "/auth/app-runtime-token", operatorIssue = route === "/auth/app-runtime-operator-token";
    const browse = ["/v1/apps/runtime-list", "/v1/apps/runtime-get"].includes(route);
    if (!issue && !operatorIssue && !browse && !["/v1/apps/runtime-claim", "/v1/apps/runtime-check", "/v1/apps/runtime-stop", "/v1/apps/runtime-revoke"].includes(route)) return false;
    const send = (status, value) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)); };
    try {
      this.sessions.prune();
      if (req.headers.origin) fail(403, "browser_origin_not_allowed"); if (req.method !== "POST") fail(405, "method_not_allowed");
      const token = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
      const who = this.sessions.verify(token); if (!who) fail(401, "session_expired_or_invalid");
      if (who.authProvider !== "feishu" && !this.allowDevelopment) fail(403, "verified_login_required");
      const audience = issue || operatorIssue ? "codex-model-gateway" : browse ? "app-runtime-operator" : "app-runtime";
      if (who.audience !== audience || browse && !who.scopes.includes("apps:runtime-options") || !issue && !operatorIssue && !browse && !who.scopes.includes("apps:runtime")) fail(403, "app_runtime_scope_required");
      if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json" || req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") fail(415, "json_required");
      const chunks = []; let length = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) { length += chunk.length; if (length > 4096) fail(413, "runtime_request_too_large"); chunks.push(chunk); }
      let body; try { body = JSON.parse(Buffer.concat(chunks)); } catch { fail(400, "invalid_json"); }
      if (!this.sessions.verify(token)) fail(401, "session_expired_or_invalid");
      if (operatorIssue || route === "/v1/apps/runtime-revoke") {
        if (!body || Array.isArray(body) || typeof body !== "object" || Object.keys(body).length) fail(400, "empty_body_required");
        if (!operatorIssue) { this.sessions.revoke(token); send(200, { revoked: true }); return true; }
        this.catalog.runtimePolicy(who); const lease = this.sessions.issueForAppRuntimeOperator(token);
        send(200, { token: lease.token, audience: lease.audience, expiresAt: lease.expiresAt }); return true;
      }
      if (browse) { send(200, route === "/v1/apps/runtime-list" ? this.catalog.runtimeList(who, body) : this.catalog.runtimeDetail(who, body)); return true; }
      if (issue) {
        if (!body || Object.keys(body).some(k => !["appId", "digest", "expectedBinding"].includes(k))) fail(400, "invalid_runtime_candidate");
        const candidate = this.catalog.runtimeCandidate(who, { appId: body.appId, digest: body.digest });
        if (body.expectedBinding !== undefined) {
          let expected; try { expected = runtimeBinding(body.expectedBinding); } catch { fail(400, "invalid_expected_runtime_binding"); }
          if (!same(candidate.binding, expected)) fail(409, "confirmed_runtime_binding_changed");
        }
        const lease = this.sessions.issueForAppRuntime(token, candidate.binding);
        send(200, { token: lease.token, expiresAt: lease.expiresAt, audience: lease.audience, binding: candidate.binding, deployed: false }); return true;
      }
      if (!body || Object.keys(body).some(k => !["claimId", "nodeId", "imageId"].includes(k)) || !appId(body.claimId) || body.nodeId !== who.runtimeBinding.nodeId || body.imageId !== who.runtimeBinding.imageId) fail(403, "runtime_node_mismatch");
      if (route === "/v1/apps/runtime-stop") {
        if (this.claims.get(who.id) !== body.claimId) fail(409, "runtime_claim_mismatch");
        this.sessions.revoke(token); send(200, { stopped: true }); return true;
      }
      const candidate = this.catalog.runtimeCandidate(who, { appId: who.runtimeBinding.appId, digest: who.runtimeBinding.digest });
      if (!same(candidate.binding, who.runtimeBinding)) fail(409, "runtime_binding_changed");
      if (route === "/v1/apps/runtime-claim") {
        if (this.claims.has(who.id)) fail(409, "runtime_already_claimed");
        this.claims.set(who.id, body.claimId);
      } else if (this.claims.get(who.id) !== body.claimId) fail(409, "runtime_claim_mismatch");
      send(200, { ...candidate, expiresAt: who.expiresAt, deployed: false }); return true;
    } catch (error) {
      const status = error instanceof RuntimeError || Number.isInteger(error.status) ? error.status : 503;
      send(status, { error: { code: status === 503 ? "app_runtime_unavailable" : error.message } }); req.resume(); return true;
    }
  }
}
