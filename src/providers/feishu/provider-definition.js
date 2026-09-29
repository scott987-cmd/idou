import { OPENAPI_IDS, OPENAPI_PATHS, OPENAPI_PROTOCOL, openApiPath } from "./openapi.js";
import { readWikiDocx, wikiOriginalOrigins } from "./wiki-source-format.js";
import { readWikiDriveBundle } from "./wiki-bundle-reader.js";
import { hostWithin } from "./saas-deployment.js";

export { hostWithin };

// What one kind of Feishu deployment is, as the rest of the product may know it.
//
// AGENTS.md has long said private-cloud Feishu is "another provider, not
// conditionals in application code", and nothing made that possible: the
// configuration's `feishu.provider` was never read, the desktop and the server
// each built the SaaS classes by name, and the control plane compared records
// with the literal "saas-cli" and fetched from open.feishu.cn directly.
//
// A definition answers everything code outside the adapter used to assume: its
// id, what it can do, the origins it is reached at, what its identifiers look
// like, which links name its resources, which pages the embedded browser may
// stay on, which binary it runs, and how to build the client that talks to it.
// Business code asks the definition, and never asks which definition it has.
//
// What a deployment cannot do is refused by the definition itself, with a
// reason a person can read: an adapter it lacks is replaced by one whose every
// call says so, so nothing quietly falls back to another deployment's service.

export const FEISHU_CAPABILITIES = Object.freeze({
  documents: "读取飞书文档",
  documentSearch: "搜索飞书文档",
  documentWrites: "修改和新建飞书文档",
  sheets: "电子表格",
  base: "多维表格",
  chat: "读取飞书消息",
  messages: "发送飞书消息",
  drive: "飞书云盘",
  wiki: "知识库",
  botMessages: "应用机器人通知",
  webPages: "内嵌飞书网页",
});

export class FeishuCapabilityUnavailable extends Error {
  constructor(definition, capability) {
    super(`当前飞书部署（${definition.label}）不提供「${FEISHU_CAPABILITIES[capability] ?? capability}」`);
    this.name = "FeishuCapabilityUnavailable";
    this.code = "feishu_capability_unavailable";
    this.capability = capability;
    this.providerId = definition.id;
  }
}

// Which parts of a client each capability is. A deployment without the
// capability gets those parts replaced, whatever its factory built.
const CLIENT_PARTS = Object.freeze({
  documents: ["readDocument"],
  documentSearch: ["searchDocuments"],
  documentWrites: ["documentEdits", "documentAuthoring"],
  sheets: ["sheets", "sheetEdits"],
  base: ["baseRecords", "baseEdits"],
  chat: ["chatReader"],
  messages: ["messages"],
  drive: ["drive"],
});
// Which capability each resource reference belongs to.
const REFERENCE_CAPABILITY = Object.freeze({
  document: "documents", sheet: "sheets", base: "base", driveFolder: "drive", driveFile: "drive", resource: "webPages",
  tenantOrigin: "wiki",
  // A link that names a Wiki node rather than the resource behind it. Reading
  // one is navigation; what it points at is decided by the deployment, as the
  // person, before anything durable is bound to it.
  wikiNode: "wiki",
});

// Which parser reads back each link a definition builds, and under which name
// that parser returns the identifier the link was built from.
const LINK_REFERENCE = Object.freeze({
  document: { reference: "document", id: "token", subId: null },
  sheet: { reference: "sheet", id: "token", subId: "sheetId" },
  base: { reference: "base", id: "appToken", subId: "tableId" },
  driveFolder: { reference: "driveFolder", id: "token", subId: null },
  driveFile: { reference: "driveFile", id: "token", subId: null },
});

// What any deployment's worksheet or table identifier may look like in a link.
const SUB_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ID = /^[a-z][a-z0-9-]{1,39}$/;
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function httpsOrigin(value, label) {
  let url = null; try { url = new URL(value); } catch { /* refused below */ }
  if (!url || url.protocol !== "https:" || url.origin !== value || url.username || url.password) throw new Error(`飞书部署的${label}必须是不带路径的 HTTPS 源`);
  return url.origin;
}
function hostList(value, label) {
  if (!Array.isArray(value) || !value.length || value.length > 16 || value.some((host) => typeof host !== "string" || !HOST.test(host)) || new Set(value).size !== value.length) {
    throw new Error(`飞书部署的${label}必须是 1–16 个不重复的域名`);
  }
  return Object.freeze([...value]);
}
function pattern(value, label) {
  if (!(value instanceof RegExp) || value.global || value.sticky || !value.source.startsWith("^") || !value.source.endsWith("$")) throw new Error(`飞书部署的${label}规则必须是首尾锚定的正则表达式`);
  return new RegExp(value.source, value.flags);
}

// Every call refused, whatever it is. `then` is left alone so an accidental
// `await part` does not turn the refusal into a hang.
function unavailablePart(definition, capability) {
  const refuse = () => { throw new FeishuCapabilityUnavailable(definition, capability); };
  return new Proxy({}, { get: (_target, key) => typeof key === "symbol" || key === "then" ? undefined : refuse });
}
const unavailableMethod = (definition, capability) => async () => { throw new FeishuCapabilityUnavailable(definition, capability); };

function openApiFor(definition, spec) {
  if (spec.protocol !== OPENAPI_PROTOCOL) throw new Error("不支持的飞书接口协议");
  const origin = httpsOrigin(spec.origin, "OpenAPI 源"), accountsOrigin = httpsOrigin(spec.accountsOrigin, "登录授权源");
  const url = (path) => {
    if (!openApiPath(path)) throw new Error("飞书接口路径不合法");
    return `${origin}${path}`;
  };
  return Object.freeze({
    protocol: OPENAPI_PROTOCOL, origin, accountsOrigin, url,
    authorizeUrl: `${accountsOrigin}${OPENAPI_PATHS.authorize}`,
    tokenUrl: url(OPENAPI_PATHS.token),
    userInfoUrl: url(OPENAPI_PATHS.userInfo),
    tenantTokenUrl: url(OPENAPI_PATHS.tenantToken),
    messageUrl: url(OPENAPI_PATHS.message),
    // The plain-text projection and the Wiki bundle read, on this deployment's
    // origins and under its id.
    readDocument: (args) => readWikiDocx({ ...args, providerId: definition.id, tenantOrigin: definition.references.tenantOrigin, documentLink: definition.links.document }),
    readDriveBundle: (args) => readWikiDriveBundle({ ...args, url }),
  });
}

export function defineFeishuProvider(spec) {
  if (!spec || typeof spec !== "object") throw new Error("飞书部署定义无效");
  if (typeof spec.id !== "string" || !ID.test(spec.id)) throw new Error("飞书部署 ID 无效");
  if (typeof spec.label !== "string" || !spec.label.trim() || spec.label.length > 40) throw new Error("飞书部署名称无效");
  const given = spec.capabilities ?? {};
  if (Object.keys(given).some((key) => !Object.hasOwn(FEISHU_CAPABILITIES, key)) || Object.keys(FEISHU_CAPABILITIES).some((key) => typeof given[key] !== "boolean")) {
    throw new Error(`飞书部署必须逐项声明能力：${Object.keys(FEISHU_CAPABILITIES).join("、")}`);
  }
  const capabilities = Object.freeze(Object.fromEntries(Object.keys(FEISHU_CAPABILITIES).map((key) => [key, given[key]])));
  const appId = pattern(spec.ids?.app, "应用 ID"), userId = pattern(spec.ids?.user, "用户 ID"), chatId = pattern(spec.ids?.chat, "会话 ID");
  // A deployment that speaks the OpenAPI protocol addresses people and chats the
  // way the protocol does; its own rules can only be narrower.
  const protocolIds = spec.openApi ? OPENAPI_IDS : null;
  if (typeof spec.ids?.appHint !== "string" || !spec.ids.appHint) throw new Error("飞书部署需要说明应用 ID 的格式");
  // The web client's own layout: where each section this app shows lives on a
  // tenant origin, and which of its chrome repeats this app's navigation.
  const SECTIONS = ["home", "messenger", "drive"];
  if (capabilities.webPages && (!spec.web?.sections || SECTIONS.some((key) => typeof spec.web.sections[key] !== "string" || !/^\/[A-Za-z0-9/_-]*$/.test(spec.web.sections[key])))) {
    throw new Error(`飞书部署必须给出内嵌网页各区的路径：${SECTIONS.join("、")}`);
  }
  // Where the web client names the conversation it has open, if this product
  // knows: a path fragment of the messenger page and a CSS selector for its
  // header. Read by the embedded page's own preload, nowhere else.
  const chat = spec.web?.chat;
  if (chat !== undefined && (typeof chat?.page !== "string" || !/^\/[A-Za-z0-9/_-]{1,64}$/.test(chat.page) ||
    typeof chat.title !== "string" || !chat.title || chat.title.length > 300 || /[<>{}\n\r\\]/.test(chat.title))) throw new Error("飞书部署的会话名读取方式无效");
  const chatReader = chat ? Object.freeze({ chatPage: chat.page, chatTitle: chat.title }) : null;
  const chromeCss = Object.freeze(Object.fromEntries(Object.entries(spec.web?.chromeCss ?? {}).filter(([key, value]) => SECTIONS.includes(key) && typeof value === "string" && value.length <= 2000 && !/[<>]|@import|url\(/i.test(value))));
  const resourceHosts = hostList(spec.web?.resourceHosts, "资源链接域名");
  const pageHosts = hostList(spec.web?.pageHosts, "内嵌网页域名");
  const cookieHosts = hostList(spec.web?.cookieHosts, "网页登录 Cookie 域名");
  for (const key of Object.keys(REFERENCE_CAPABILITY)) {
    if (capabilities[REFERENCE_CAPABILITY[key]] && typeof spec.references?.[key] !== "function") throw new Error(`飞书部署缺少资源解析：${key}`);
  }
  for (const [key, link] of Object.entries(LINK_REFERENCE)) {
    if (capabilities[REFERENCE_CAPABILITY[link.reference]] && typeof spec.links?.[key] !== "function") throw new Error(`飞书部署缺少链接构造：${key}`);
  }
  for (const key of ["create", "wikiSourceReader", "baseReader", "sidecar"]) {
    if (typeof spec.client?.[key] !== "function") throw new Error(`飞书部署缺少客户端构造：${key}`);
  }
  if (typeof spec.runtime?.name !== "string" || typeof spec.runtime?.lock !== "string" || typeof spec.runtime?.resolve !== "function") throw new Error("飞书部署缺少运行时清单");

  const definition = { id: spec.id, label: spec.label.trim(), capabilities };
  definition.supports = (capability) => capabilities[capability] === true;
  definition.require = (capability) => { if (!definition.supports(capability)) throw new FeishuCapabilityUnavailable(definition, capability); };
  // What the interface is told: plain data, reasons included.
  definition.describe = () => ({
    id: definition.id, label: definition.label, capabilities: { ...capabilities },
    unavailable: Object.fromEntries(Object.keys(capabilities).filter((key) => !capabilities[key]).map((key) => [key, new FeishuCapabilityUnavailable(definition, key).message])),
  });
  definition.ids = Object.freeze({
    app: (value) => typeof value === "string" && appId.test(value),
    user: (value) => typeof value === "string" && userId.test(value) && (!protocolIds || protocolIds.user.test(value)),
    chat: (value) => typeof value === "string" && chatId.test(value) && (!protocolIds || protocolIds.chat.test(value)),
    appHint: spec.ids.appHint,
  });
  const within = (value, hosts) => {
    let url = null; try { url = new URL(value); } catch { return false; }
    return url.protocol === "https:" && !url.username && !url.password && hostWithin(url.hostname, hosts);
  };
  definition.web = Object.freeze({
    resourceHosts, pageHosts, cookieHosts,
    // A page the embedded Feishu browser may show or pass through.
    pageUrl: (value) => definition.supports("webPages") && within(value, pageHosts),
    // A cookie domain the pages' sign-in lives under, leading dot or not.
    cookieDomain: (domain) => typeof domain === "string" && hostWithin(domain.replace(/^\./, ""), cookieHosts),
    // Where a section is on a tenant origin the pages already use, or null.
    sectionUrl: (section, origin) => {
      if (!definition.supports("webPages") || !SECTIONS.includes(section) || !within(origin, pageHosts)) return null;
      return `${new URL(origin).origin}${spec.web.sections[section]}`;
    },
    // Style that hides the client's own navigation in a section, if any.
    chromeCss: (section) => chromeCss[section] ?? null,
    chatReader: definition.supports("webPages") ? chatReader : null,
  });
  const references = {};
  for (const [key, capability] of Object.entries(REFERENCE_CAPABILITY)) {
    if (!definition.supports(capability)) {
      // "Which resource is this page" has always answered null for anything it
      // does not know; a deployment without pages knows none.
      references[key] = key === "resource" ? () => null : () => { throw new FeishuCapabilityUnavailable(definition, capability); };
      continue;
    }
    references[key] = spec.references[key];
  }
  // A node link may name one worksheet or table inside whatever it points at.
  // What a deployment returns there is used to narrow an authorization, so its
  // shape is checked here rather than trusted at the call site: a hint naming a
  // kind that has no sub-resource, or an identifier no link could carry, is a
  // fault in the deployment and is refused as one.
  if (definition.supports("wiki")) {
    const readNode = references.wikiNode;
    references.wikiNode = (value) => {
      const node = readNode(value);
      const hint = node?.hint ?? null;
      if (!node || typeof node.token !== "string" || !node.token || typeof node.url !== "string" ||
        !("hint" in node) || (hint !== null && (!LINK_REFERENCE[hint.kind]?.subId || !SUB_ID.test(String(hint.subId ?? ""))))) {
        throw new Error("飞书部署的知识库节点解析结果无效");
      }
      return node;
    };
  }
  references.tenantOrigins = (value) => { definition.require("wiki"); return wikiOriginalOrigins(value, references.tenantOrigin); };
  definition.references = Object.freeze(references);
  // The canonical link to a resource on a tenant origin. Whatever the deployment
  // builds has to read back as the same resource, or it is not used.
  const links = {};
  for (const [key, link] of Object.entries(LINK_REFERENCE)) {
    // `subId` is the worksheet or table the link names, when the kind has one.
    // It is part of what the link must read back as: a link that quietly lost it
    // would widen an authorization from one sheet to a whole workbook.
    links[key] = (origin, token, subId = null) => {
      definition.require(REFERENCE_CAPABILITY[link.reference]);
      if (subId !== null && !link.subId) throw new Error("这种飞书资源的链接没有子资源");
      const url = spec.links[key](origin, token, subId);
      const parsed = typeof url === "string" ? references[link.reference](url) : null;
      if (!parsed || new URL(url).origin !== origin || parsed[link.id] !== token ||
        (link.subId ? (parsed[link.subId] ?? null) !== subId : false)) throw new Error("飞书部署构造的链接与资源不一致");
      return url;
    };
  }
  definition.links = Object.freeze(links);
  // A link this product itself once wrote in a form the deployment does not
  // open, given back in the form it does; any other link unchanged. Never to
  // another origin: a repair cannot move a link somewhere else.
  definition.repairedLink = (value) => {
    if (typeof value !== "string" || typeof spec.repairedLink !== "function") return value;
    try {
      const repaired = spec.repairedLink(value);
      return typeof repaired === "string" && new URL(repaired).origin === new URL(value).origin ? repaired : value;
    } catch { return value; }
  };
  definition.openApi = spec.openApi ? openApiFor(definition, spec.openApi) : null;
  if (definition.openApi && definition.supports("webPages") && !hostWithin(new URL(definition.openApi.accountsOrigin).hostname, pageHosts)) {
    // The pages' own account is checked by sending them through the authorize
    // page; a deployment whose authorize page they may not visit cannot be checked.
    throw new Error("飞书部署的登录授权源不在内嵌网页允许的域名内");
  }
  definition.runtime = Object.freeze({ name: spec.runtime.name, lock: spec.runtime.lock, resolve: spec.runtime.resolve });
  definition.client = Object.freeze({
    create(config, runner, options) {
      const client = spec.client.create(config, runner, options);
      if (!client || client.id !== definition.id) throw new Error("飞书客户端与部署定义不一致");
      for (const [capability, parts] of Object.entries(CLIENT_PARTS)) {
        if (definition.supports(capability)) continue;
        for (const part of parts) client[part] = typeof client[part] === "function" ? unavailableMethod(definition, capability) : unavailablePart(definition, capability);
      }
      return client;
    },
    wikiSourceReader: (client, options) => definition.supports("wiki") && definition.supports("documents") ? spec.client.wikiSourceReader(client, options) : unavailablePart(definition, "wiki"),
    baseReader: (client) => definition.supports("base") ? spec.client.baseReader(client) : unavailablePart(definition, "base"),
    // The CLI's bridge to the control plane, on this deployment's origin and
    // app id rule.
    sidecar: (options) => {
      if (!definition.openApi) throw new Error("该飞书部署没有可桥接的 OpenAPI");
      return spec.client.sidecar({ ...options, apiOrigin: definition.openApi.origin, appIdPattern: appId });
    },
  });
  return Object.freeze(definition);
}
