// A private Feishu deployment that does not exist, for tests only.
//
// Its domains, identifier shapes and link shapes are all different from SaaS,
// and it lacks several capabilities, so business code that still assumed SaaS
// anywhere fails against it. It is not a private-cloud adapter: no private CLI
// exists to write one against, and passing tests with this says nothing about
// one. Production code never imports it and the registry does not list it.
import { createHash } from "node:crypto";
import { defineFeishuProvider, hostWithin } from "../../src/providers/feishu/provider-definition.js";
import { OPENAPI_PROTOCOL } from "../../src/providers/feishu/openapi.js";
import { FeishuCliSidecar } from "../../src/providers/feishu/cli-sidecar.js";

export const PRIVATE_ID = "private-fixture";
export const PRIVATE_DOMAIN = "feishu.corp-fixture.invalid";
// What an administrator would approve: every origin under the one domain.
export const PRIVATE_DEPLOYMENT = Object.freeze({
  apiOrigin: `https://gateway.${PRIVATE_DOMAIN}`,
  accountsOrigin: `https://passport.${PRIVATE_DOMAIN}`,
  webHost: PRIVATE_DOMAIN,
});
export const PRIVATE_APP_ID = "pa-7f3a9c2e41b8";
export const PRIVATE_TENANT = "corp-fixture";
// People and chats are named the way the OpenAPI protocol names them, but by a
// narrower rule than SaaS uses: sixteen hex digits, nothing else.
export const privateUser = (name) => `ou_${createHash("sha256").update(`${name}`).digest("hex").slice(0, 16)}`;
export const privateChat = (name) => `oc_${createHash("sha256").update(`chat:${name}`).digest("hex").slice(0, 16)}`;
export const privateToken = (name) => `prv${createHash("sha256").update(`${name}`).digest("hex").slice(0, 20)}`;

const TOKEN = /^prv[a-z0-9]{10,60}$/;
const sha = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");

// Links here are https://docs.<domain>/d/<token> and https://docs.<domain>/space/<kind>/<token>.
function linkOn(webHost) {
  return (value, shape, message) => {
    let url = null;
    try { url = new URL(value); } catch { /* refused below */ }
    const match = url && shape.exec(url.pathname);
    if (typeof value !== "string" || value.length > 2048 || !url || url.protocol !== "https:" || url.port || url.username || url.password ||
      !hostWithin(url.hostname, [webHost]) || !match || !TOKEN.test(match[1])) throw new Error(message);
    url.search = ""; url.hash = "";
    return { token: match[1], url: url.href };
  };
}

// `faultyWikiNodeHint` builds a deployment that is wrong on purpose: its node
// parser answers the "which worksheet or table" question with something no link
// could carry. It exists so a test can show the definition refuses such a
// deployment instead of letting it narrow -- or widen -- an authorization.
export function privateFeishu(deployment = PRIVATE_DEPLOYMENT, { documents = new Map(), folders = new Map(), user = () => privateUser("alice"), faultyWikiNodeHint } = {}) {
  const { apiOrigin, accountsOrigin, webHost } = deployment;
  if (typeof webHost !== "string" || !/^[a-z0-9.-]+$/.test(webHost)) throw new Error("私有化部署需要管理员批准的域名");
  for (const origin of [apiOrigin, accountsOrigin]) {
    let host = null; try { host = new URL(origin).hostname; } catch { /* refused below */ }
    if (!hostWithin(host, [webHost])) throw new Error("私有化部署地址不在管理员批准的域名内");
  }
  const link = linkOn(webHost);
  const references = {
    document: (value) => ({ kind: "doc", ...link(value, /^\/d\/([^/]+)$/, "不是这个私有化部署的文档链接"), partial: false }),
    driveFolder: (value) => link(value, /^\/space\/folder\/([^/]+)$/, "不是这个私有化部署的云盘文件夹链接"),
    driveFile: (value) => link(value, /^\/space\/file\/([^/]+)$/, "不是这个私有化部署的云盘文件链接"),
    resource: (value) => { try { const parsed = link(value, /^\/d\/([^/]+)$/, "x"); return { kind: "doc", token: parsed.token, url: parsed.url, label: "文档" }; } catch { return null; } },
    // This deployment's navigation links live at /w/<token>; what they point at
    // is the deployment's to resolve, not the client's to claim. It has no
    // spelling for "one worksheet or table of it", so its node links never carry
    // one, and `hint: null` says that rather than leaving the field missing.
    wikiNode: (value) => ({ ...link(value, /^\/w\/([^/]+)$/, "不是这个私有化部署的知识库链接"), hint: faultyWikiNodeHint ?? null }),
    tenantOrigin: (value) => {
      let url = null; try { url = new URL(value); } catch { /* refused below */ }
      if (!url || url.origin !== value || url.protocol !== "https:" || !url.hostname.endsWith(`.${webHost}`)) throw new Error("不是这个私有化部署的租户域名");
      return url.origin;
    },
  };
  const definition = defineFeishuProvider({
    id: PRIVATE_ID,
    label: "私有化飞书（测试替身）",
    capabilities: {
      documents: true, documentSearch: false, documentWrites: false, sheets: false, base: false,
      chat: false, messages: true, drive: true, wiki: true, botMessages: false, webPages: true,
    },
    openApi: { protocol: OPENAPI_PROTOCOL, origin: apiOrigin, accountsOrigin },
    ids: { app: /^pa-[a-f0-9]{12}$/, user: /^ou_[a-f0-9]{16}$/, chat: /^oc_[a-f0-9]{16}$/, appHint: "应为 pa- 加 12 位十六进制" },
    web: { resourceHosts: [webHost], pageHosts: [webHost], cookieHosts: [webHost], sections: { home: "/", messenger: "/im/", drive: "/space/" } },
    references,
    links: {
      document: (origin, token) => `${origin}/d/${token}`,
      driveFolder: (origin, token) => `${origin}/space/folder/${token}`,
      driveFile: (origin, token) => `${origin}/space/file/${token}`,
    },
    runtime: { name: "private-fixture-cli", lock: "feishu", resolve: async () => { throw new Error("测试替身没有可执行文件"); } },
    client: {
      create: () => new PrivateFixtureClient({ references, documents, folders, user }),
      wikiSourceReader: (client) => client,
      baseReader: () => { throw new Error("测试替身没有多维表格"); },
      sidecar: (options) => new FeishuCliSidecar(options),
    },
  });
  return definition;
}

// An in-memory Feishu that answers the same semantic calls the SaaS adapter
// does, with none of its commands. `user()` is who is signed in right now.
class PrivateFixtureClient {
  constructor({ references, documents, folders, user }) {
    Object.assign(this, { id: PRIVATE_ID, references, documents, folders, user, uploads: [] });
    this.drive = new PrivateDrive(this);
    // Present so the definition has something to replace: a search the
    // deployment does not offer must never answer from here.
    this.searchDocuments = async () => ({ documents: [{ url: "https://www.feishu.cn/docx/ShouldNeverAppear1" }], next: null });
  }
  async documentIdentity() {
    const user = this.user();
    if (!user) throw new Error("私有化飞书尚未登录");
    return { principal: sha([PRIVATE_ID, PRIVATE_TENANT, user]), tenantKey: PRIVATE_TENANT, verifiedAt: Date.now() };
  }
  async documentConnection() {
    try { await this.documentIdentity(); return { connected: true, message: "私有化飞书测试替身" }; }
    catch (error) { return { connected: false, message: error.message }; }
  }
  async readDocument(reference) {
    const parsed = this.references.document(reference), identity = await this.documentIdentity();
    const document = this.documents.get(parsed.token);
    if (!document) throw new Error("私有化飞书里没有这篇文档");
    if (!document.readers.includes(this.user())) throw new Error("没有这篇文档的阅读权限");
    return { kind: "feishu-document", providerId: PRIVATE_ID, resourceId: parsed.token, sourceUrl: parsed.url, sourceRevision: String(document.revision),
      title: document.title, text: document.text, resources: [], warnings: [], partial: false, contentHash: sha(document.text), identity };
  }
  async invoke() { throw new Error("测试替身不运行命令行"); }
}

class PrivateDrive {
  constructor(client) { this.client = client; }
  async identity() { return this.client.documentIdentity(); }
  async unchanged(expected) {
    const current = await this.identity();
    if (current.principal !== expected.principal || current.tenantKey !== expected.tenantKey) throw new Error("私有化飞书身份已变化");
    return current;
  }
  async resolveFolder(reference) {
    const parsed = this.client.references.driveFolder(reference), identity = await this.identity();
    const folder = this.client.folders.get(parsed.token);
    if (!folder || !folder.writers.includes(this.client.user())) throw new Error("无法核验目标云盘文件夹");
    return { providerId: PRIVATE_ID, token: parsed.token, url: parsed.url, title: folder.title, identity };
  }
  async upload({ bytes, name, folder, confirmed, onDispatched, onUploaded }) {
    if (confirmed !== true || folder?.providerId !== PRIVATE_ID) throw new Error("云盘目标不属于当前适配器");
    const current = await this.resolveFolder(folder.url);
    if (current.token !== folder.token || current.identity.principal !== folder.identity.principal) throw new Error("确认后目标文件夹或身份已变化，请重新确认");
    await onDispatched();
    const fileToken = privateToken(`${folder.token}/${name}`);
    this.client.uploads.push({ folder: folder.token, name, bytes: bytes.length, fileToken });
    await onUploaded(fileToken);
    return this.verify({ folder, name, fileToken });
  }
  async verify({ folder, name, fileToken }) {
    await this.unchanged(folder.identity);
    if (!this.client.uploads.some((row) => row.fileToken === fileToken && row.name === name && row.folder === folder.token)) throw new Error("尚未在云盘核验到这个文件");
    const link = this.client.references.driveFile(`${new URL(folder.url).origin}/space/file/${fileToken}`);
    return { fileToken, url: link.url, name, providerId: PRIVATE_ID, verifiedAt: Date.now() };
  }
}
