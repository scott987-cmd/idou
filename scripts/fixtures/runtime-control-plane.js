import { mkdtemp, rm, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import path from "node:path";
import os from "node:os";
import { AppCatalog, AppCatalogService } from "../../src/control-plane/app-catalog.js";
import { AppRuntimeService } from "../../src/control-plane/app-runtime-service.js";
import { SessionRegistry } from "../../src/control-plane/sessions.js";
import { createModelGateway } from "../../src/control-plane/model-gateway.js";
import { staticAppFixture } from "./static-app-package.js";
import { SAAS_FEISHU } from "../../src/providers/feishu/saas-definition.js";
export async function runtimeControlFixture(imageId = `sha256:${"a".repeat(64)}`) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "idou-runtime-control-"))), pkg = staticAppFixture();
  const sessions = new SessionRegistry(), nodeId = "acceptance-node";
  const identity = { tenantId: "synthetic-tenant", appId: "cli_synthetic", authProvider: "feishu", deviceId: "test-device", deviceProof: "ed25519-login" };
  const issue = (userId, extra = {}) => sessions.issue({ ...identity, userId, ...extra });
  const author = issue("author"), reviewer = issue("reviewer"), operator = issue("operator"), id = randomUUID();
  const catalog = new AppCatalog({ feishu: SAAS_FEISHU, databaseFile: path.join(root, "catalog.sqlite"), tenants: [{ authProvider: identity.authProvider, tenantId: identity.tenantId, appId: identity.appId, publishers: ["author"], reviewers: ["reviewer"], runtime: { operators: ["operator"], nodeId, imageId } }] });
  const service = new AppRuntimeService({ sessions, catalog }), apps = new AppCatalogService({ sessions, catalog }), requests = [];
  const server = createModelGateway({ sessions, apiKey: "synthetic-unused-key", authHandler: async (req, res) => { requests.push(req.url); return await service.handle(req, res) || await apps.handle(req, res); }, fetchImpl: () => { throw new Error("No model calls permitted"); } });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const serverUrl = `http://127.0.0.1:${server.address().port}`;
  catalog.submit(author, { appId: id, title: "合成运行授权应用", manifest: pkg.manifest });
  const selector = { appId: id, digest: pkg.digest };
  const ready = () => {
    catalog.review(reviewer, { ...selector, decision: "approved", note: "合成清单审核，不代表生产发布许可" });
    const input = { bytes: pkg.bytes.length, sha256: pkg.sha256, policyDigest: "a".repeat(64), folder: { providerId: "saas-cli", token: "SyntheticFolder123", title: "合成目录", url: "https://synthetic.feishu.cn/drive/folder/SyntheticFolder123", identity: { principal: "b".repeat(64), tenantKey: "synthetic-tenant", verifiedAt: Date.now() } } };
    const { archive } = catalog.archive(author, "prepare", { ...selector, input });
    catalog.archive(author, "dispatch", { ...selector, id: archive.id }); catalog.archive(author, "receipt", { ...selector, id: archive.id, fileToken: "SyntheticPackage123" }); catalog.archive(author, "verify", { ...selector, id: archive.id, fileToken: "SyntheticPackage123" });
  };
  const post = (route, token, body, headers = {}) => fetch(serverUrl + route, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const grant = async () => { const res = await post("/auth/app-runtime-token", operator.token, selector); if (!res.ok) throw new Error(`Fixture grant failed ${res.status}`); return res.json(); };
  return { root, pkg, sessions, identity, issue, author, reviewer, operator, id, selector, catalog, service, server, serverUrl, post, ready, grant, requests, nodeId, imageId,
    async close() { service.close(); server.close(); server.closeAllConnections(); catalog.close(); await rm(root, { recursive: true, force: true }); } };
}
