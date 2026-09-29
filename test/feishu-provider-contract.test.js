import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";
import { resolveFeishuProvider, FEISHU_PROVIDER_IDS } from "../src/providers/feishu/provider-registry.js";
import { FEISHU_CAPABILITIES, FeishuCapabilityUnavailable } from "../src/providers/feishu/provider-definition.js";
import { docxViewPermissionPath } from "../src/providers/feishu/openapi.js";
import { FeishuSourceAccess } from "../src/control-plane/feishu-source-access.js";
import { FeishuOAuthProvider } from "../src/control-plane/feishu-oauth-provider.js";
import { FeishuLoginService } from "../src/control-plane/feishu-login.js";
import { FeishuCliProxyService } from "../src/control-plane/feishu-cli-proxy.js";
import { FeishuBot } from "../src/control-plane/feishu-bot.js";
import { SchedulePush } from "../src/control-plane/schedule-push.js";
import { SandboxEgressService } from "../src/control-plane/sandbox-egress.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { drivePolicies } from "../src/control-plane/drive-budget.js";
import { loadFeishuLoginConfig } from "../src/control-plane/server-config.js";
import { FeishuLoginClient } from "../src/application/feishu-login-client.js";
import { DocumentService } from "../src/application/document-service.js";
import { FileDelivery } from "../src/application/file-delivery.js";
import { LocalWiki } from "../src/knowledge/local-wiki.js";
import { knowledgeSourceReader, sheetKnowledgeSource } from "../src/knowledge/sheet-source.js";
import { fixtureCipher } from "../scripts/fixtures/wiki-cipher.js";
import { PRIVATE_APP_ID, PRIVATE_DEPLOYMENT, PRIVATE_DOMAIN, PRIVATE_ID, PRIVATE_TENANT, privateFeishu, privateToken, privateUser } from "../scripts/fixtures/private-feishu.js";

// One set of business contracts, run against two Feishu deployments: the SaaS
// one this build ships, and a private one that does not exist -- its own
// domains, identifier rules and link shapes, and several capabilities missing
// (scripts/fixtures/private-feishu.js). Nothing below branches on which one it
// has. A test that needed to would be a SaaS assumption left in business code.
//
// Passing against the private fixture says the business code asks the
// deployment for everything it needs. It says nothing about a real private
// Feishu, whose CLI does not exist yet.

const SAAS_HOSTS = ["feishu.cn", "larksuite.com", "doubao.com", "feishu.net"];
const saasHost = (hostname) => SAAS_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));

// The Feishu a side's client and control plane talk to: people, documents,
// folders, and who may read or write what.
function feishuState({ user }) {
  return { user, signedIn: user, documents: new Map(), folders: new Map(), uploads: [], commands: [], readable: true };
}

// The SaaS adapter's CLI, answered from `state`. Only what the contracts below
// send is known; anything else fails the test.
function saasCli(state, tenant) {
  const ok = (data) => ({ code: 0, stderr: "", stdout: JSON.stringify({ ok: true, identity: "user", data }) });
  const refused = (message) => ({ code: 1, stdout: "", stderr: JSON.stringify({ ok: false, error: { type: "permission", message } }) });
  const token = (url) => new URL(url).pathname.split("/").filter(Boolean).pop();
  return async (_binary, args) => {
    state.commands.push(args.slice(0, 2).join(" "));
    if (args[0] === "api" && args[2] === "/open-apis/authen/v1/user_info") return ok({ open_id: state.signedIn, tenant_key: tenant, user_id: "alice" });
    if (args[0] === "docs" && args[1] === "+fetch") {
      const id = token(args[args.indexOf("--doc") + 1]), document = state.documents.get(id);
      if (!document || !document.readers.includes(state.signedIn)) return refused("permission denied");
      return ok({ document: { document_id: id, revision_id: document.revision, content: `<title>${document.title}</title><p>${document.text}</p>` } });
    }
    if (args[0] === "drive" && args[1] === "+search") {
      return ok({ has_more: false, results: [...state.documents.entries()].map(([id, document]) => ({ entity_type: "DOC", title_highlighted: document.title,
        result_meta: { url: `https://contract.feishu.cn/docx/${id}`, token: id, doc_types: "DOCX", owner_name: "合成", update_time_iso: "2026-09-01T10:00:00+08:00", is_cross_tenant: false } })) });
    }
    if (args[0] === "drive" && args[1] === "+inspect") {
      const url = args[args.indexOf("--url") + 1], type = args[args.indexOf("--type") + 1], id = token(url);
      if (type === "folder") {
        const folder = state.folders.get(id);
        return ok(folder?.writers.includes(state.signedIn) ? { type, title: folder.title, token: id } : { type, title: "", token: id });
      }
      const file = state.uploads.find((row) => row.fileToken === id);
      return ok(file ? { type, title: file.name, token: id } : { type, title: "", token: id });
    }
    if (args[0] === "drive" && args[1] === "+upload") {
      const folder = args[args.indexOf("--folder-token") + 1], name = args[args.indexOf("--name") + 1];
      const fileToken = `ContractFile${state.uploads.length + 1}x`;
      state.uploads.push({ folder, name, fileToken });
      return ok({ file_token: fileToken });
    }
    throw new Error(`the contract did not expect: ${args.join(" ")}`);
  };
}

// Each side says how to name things in its own deployment, and nothing else.
const SIDES = {
  SaaS: () => {
    const tenant = "tenant_contract", state = feishuState({ user: "ou_contract_alice" });
    const client = SAAS_FEISHU.client.create({ binary: process.execPath, profile: null, environment: () => ({}) }, saasCli(state, tenant));
    return { name: "SaaS", feishu: SAAS_FEISHU, client, state, tenant, appId: "cli_contract_fixture",
      stranger: "ou_contract_mallory", tenantOrigin: "https://contract.feishu.cn", token: (name) => `Contract${name}Token1` };
  },
  private: () => {
    const state = feishuState({ user: privateUser("alice") });
    const feishu = privateFeishu(PRIVATE_DEPLOYMENT, { documents: state.documents, folders: state.folders, user: () => state.signedIn });
    const client = feishu.client.create({});
    // The fixture keeps its uploads on the client; the contract reads them here.
    state.uploads = client.uploads;
    return { name: "私有化替身", feishu, client, state, tenant: PRIVATE_TENANT, appId: PRIVATE_APP_ID,
      stranger: privateUser("mallory"), tenantOrigin: `https://docs.${PRIVATE_DOMAIN}`, token: (name) => privateToken(name) };
  },
};
const other = { SaaS: "private", private: "SaaS" };

function eachSide(title, body) {
  for (const key of Object.keys(SIDES)) test(`[${key}] ${title}`, (t) => body(t, SIDES[key](), SIDES[other[key]]()));
}

// ---- Resource resolution ---------------------------------------------------

eachSide("a deployment reads back the links it builds, and refuses every other deployment's", (_t, side, foreign) => {
  const token = side.token("Doc");
  const document = side.feishu.links.document(side.tenantOrigin, token);
  assert.equal(side.feishu.references.document(document).token, token);
  const folder = side.feishu.links.driveFolder(side.tenantOrigin, side.token("Folder"));
  assert.equal(side.feishu.references.driveFolder(folder).token, side.token("Folder"));
  const file = side.feishu.links.driveFile(side.tenantOrigin, side.token("File"));
  assert.equal(side.feishu.references.driveFile(file).token, side.token("File"));

  // Another deployment's links, and a host that only looks like this one's.
  const theirs = foreign.feishu.links.document(foreign.tenantOrigin, foreign.token("Doc"));
  assert.throws(() => side.feishu.references.document(theirs));
  assert.throws(() => side.feishu.references.driveFolder(foreign.feishu.links.driveFolder(foreign.tenantOrigin, foreign.token("Folder"))));
  const lookalike = new URL(document); lookalike.hostname = `${lookalike.hostname}.attacker.example`;
  assert.throws(() => side.feishu.references.document(lookalike.href));
  // A link that names one sheet or table inside a resource must read back as
  // that sheet or table: a builder that dropped it would widen an authorization.
  if (side.feishu.supports("sheets")) {
    const sheet = side.feishu.links.sheet(side.tenantOrigin, side.token("Sheet"), "sheet1abc");
    assert.equal(side.feishu.references.sheet(sheet).sheetId, "sheet1abc");
    assert.equal(side.feishu.references.sheet(side.feishu.links.sheet(side.tenantOrigin, side.token("Sheet"))).sheetId, null);
  }
  assert.throws(() => side.feishu.links.document(side.tenantOrigin, token, "no-sub-resource-here"), /子资源/);

  // A navigation link is the deployment's own shape too, and it is never read
  // as the resource it points at.
  if (side.feishu.supports("wiki")) {
    const node = side.name === "SaaS" ? `${side.tenantOrigin}/wiki/ContractNodeToken1` : `${side.tenantOrigin}/w/${side.token("Node")}`;
    assert.ok(side.feishu.references.wikiNode(node).token);
    // Every deployment answers "does this link name one worksheet or table"
    // explicitly. A missing answer would read as "no" at the one call site that
    // uses it, and quietly authorize the whole workbook or Base.
    const read = side.feishu.references.wikiNode(node);
    assert.ok("hint" in read, side.name);
    assert.ok(read.hint === null || (typeof read.hint.kind === "string" && typeof read.hint.subId === "string"), side.name);
    assert.throws(() => side.feishu.references.wikiNode(document), /知识库|不是/);
    assert.throws(() => side.feishu.references.wikiNode(foreign.name === "SaaS" ? `${foreign.tenantOrigin}/wiki/ContractNodeToken1` : `${foreign.tenantOrigin}/w/${foreign.token("Node")}`));
  }
  assert.equal(side.feishu.references.resource(theirs), null);
  assert.equal(side.feishu.web.pageUrl(theirs), false);
  assert.equal(side.feishu.web.pageUrl(document), true);
  assert.throws(() => side.feishu.references.tenantOrigin(foreign.tenantOrigin));
  // A link a deployment built for a token its own parser would not accept is not used.
  assert.throws(() => side.feishu.links.document(side.tenantOrigin, "not a token"));
});

// The worksheet or table a node link names is used to narrow an authorization,
// so a deployment that answers it wrongly is a fault the definition refuses --
// not something the one call site has to defend itself against.
test("a deployment whose node parser names a sub-resource no link could carry is refused", () => {
  for (const hint of [{ kind: "base", subId: "tbl bad" }, { kind: "document", subId: "anything" },
                      { kind: "base", subId: "" }, { kind: "nope", subId: "tblAbc" }, { subId: "tblAbc" }]) {
    const feishu = privateFeishu(PRIVATE_DEPLOYMENT, { faultyWikiNodeHint: hint });
    assert.throws(() => feishu.references.wikiNode(`https://docs.${PRIVATE_DOMAIN}/w/${privateToken("Node")}`),
      /知识库节点解析结果无效/, JSON.stringify(hint));
  }
  // The same deployment, answering the question properly, is accepted.
  const ok = privateFeishu(PRIVATE_DEPLOYMENT, { faultyWikiNodeHint: null });
  assert.equal(ok.references.wikiNode(`https://docs.${PRIVATE_DOMAIN}/w/${privateToken("Node")}`).hint, null);
});

// ---- Capabilities -----------------------------------------------------------

eachSide("every capability is declared, and a missing one is refused with its reason, never answered from elsewhere", async (_t, side) => {
  const described = side.feishu.describe();
  assert.deepEqual(Object.keys(described.capabilities).sort(), Object.keys(FEISHU_CAPABILITIES).sort());
  for (const [capability, supported] of Object.entries(described.capabilities)) {
    assert.equal(side.feishu.supports(capability), supported);
    if (supported) { assert.equal(described.unavailable[capability], undefined); continue; }
    assert.match(described.unavailable[capability], new RegExp(`不提供「${FEISHU_CAPABILITIES[capability]}」`));
    assert.throws(() => side.feishu.require(capability), (error) => error instanceof FeishuCapabilityUnavailable && error.capability === capability && error.providerId === side.feishu.id);
  }
  const documents = new DocumentService({ provider: side.client, getTask: () => ({}) });
  if (side.feishu.supports("documentSearch")) {
    const found = await documents.search("task", "合同", "document");
    assert.ok(Array.isArray(found.documents));
  } else {
    // The fixture's own search would answer with a SaaS link; it must never be reached.
    await assert.rejects(documents.search("task", "合同", "document"), { code: "feishu_capability_unavailable", capability: "documentSearch" });
  }
  for (const [capability, part] of [["sheets", "sheets"], ["base", "baseRecords"], ["chat", "chatReader"], ["documentWrites", "documentEdits"]]) {
    if (side.feishu.supports(capability)) continue;
    assert.throws(() => side.client[part].read("x"), { code: "feishu_capability_unavailable", capability });
  }
  if (!side.feishu.supports("sheets")) {
    // The knowledge copy asks the deployment which links are spreadsheets; one
    // without spreadsheets has none, and the link goes to the document reader.
    const sheets = sheetKnowledgeSource(side.client.sheets, { reference: side.feishu.references.sheet });
    assert.equal(sheets.matches("https://contract.feishu.cn/sheets/ContractSheet1"), false);
  }
});

test("only the deployments this build ships can be chosen, and SaaS takes no address settings", () => {
  assert.deepEqual(FEISHU_PROVIDER_IDS, ["saas-cli"]);
  assert.equal(resolveFeishuProvider(), SAAS_FEISHU);
  assert.throws(() => resolveFeishuProvider(PRIVATE_ID), /未知的飞书部署类型/);
  assert.throws(() => resolveFeishuProvider("saas-cli", { deployment: { apiOrigin: "https://open.feishu.example" } }), /不接受部署地址设置/);
  // A test may name a deployment the build does not ship; the registry validates what it builds.
  const definitions = new Map([[PRIVATE_ID, (deployment) => privateFeishu(deployment)]]);
  assert.equal(resolveFeishuProvider(PRIVATE_ID, { deployment: PRIVATE_DEPLOYMENT, definitions }).id, PRIVATE_ID);
  // Origins outside the domain the administrator approved are refused.
  assert.throws(() => resolveFeishuProvider(PRIVATE_ID, { deployment: { ...PRIVATE_DEPLOYMENT, apiOrigin: "https://open.feishu.cn" }, definitions }), /不在管理员批准的域名内/);
  const env = { IDOU_PUBLIC_URL: "https://control.example", FEISHU_APP_ID: "cli_contract", FEISHU_APP_SECRET: "SECRET-app", FEISHU_ALLOWED_TENANTS: "tenant" };
  assert.equal(loadFeishuLoginConfig(env).feishu, SAAS_FEISHU);
  assert.throws(() => loadFeishuLoginConfig({ ...env, FEISHU_PROVIDER: PRIVATE_ID }), /FEISHU_PROVIDER 无效/);
  assert.throws(() => loadFeishuLoginConfig({ ...env, FEISHU_APP_ID: PRIVATE_APP_ID }), /FEISHU_APP_ID 格式不对：应以 cli_ 开头/);
});

// ---- Reading -----------------------------------------------------------------

eachSide("a document is read as the signed-in person and names the deployment it came from", async (_t, side, foreign) => {
  const token = side.token("Doc"), link = side.feishu.links.document(side.tenantOrigin, token);
  side.state.documents.set(token, { title: "回款台账", text: "九月回款 120 万。", revision: 3, readers: [side.state.user] });
  const documents = new DocumentService({ provider: side.client, getTask: () => ({}) });
  const opened = await documents.open("task", link);
  assert.equal(opened.providerId, side.feishu.id);
  assert.equal(opened.resourceId, token);
  assert.equal(side.feishu.references.document(opened.sourceUrl).token, token);
  assert.match(opened.text, /九月回款/);
  const context = await documents.prepareContext("task", { handle: opened.handle });
  assert.equal(context.providerId, side.feishu.id);
  assert.equal(context.tenantKey, side.tenant);

  // Another deployment's link is refused before anything is read.
  const before = side.state.commands.length;
  await assert.rejects(documents.open("task", foreign.feishu.links.document(foreign.tenantOrigin, foreign.token("Doc"))));
  assert.equal(side.state.commands.filter((command) => command.startsWith("docs")).length, side.state.commands.slice(0, before).filter((command) => command.startsWith("docs")).length);

  // Someone else signed in between opening and quoting: the quote is refused.
  const again = await documents.open("task", link);
  side.state.signedIn = side.stranger;
  side.state.documents.get(token).readers.push(side.stranger);
  await assert.rejects(documents.prepareContext("task", { handle: again.handle }), /身份已变化/);
});

eachSide("a person who may not read a document gets nothing from it", async (_t, side) => {
  const token = side.token("Secret");
  side.state.documents.set(token, { title: "薪酬", text: "不该出现", revision: 1, readers: [side.stranger] });
  const documents = new DocumentService({ provider: side.client, getTask: () => ({}) });
  await assert.rejects(documents.open("task", side.feishu.links.document(side.tenantOrigin, token)), (error) => !/不该出现/.test(error.message));
});

// ---- The Wiki copy -------------------------------------------------------------

eachSide("the local Wiki answers from a document only while its reader still may read it", async (t, side) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "provider-contract-wiki-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const token = side.token("Wiki"), link = side.feishu.links.document(side.tenantOrigin, token);
  side.state.documents.set(token, { title: "回款规则", text: "回款以银行到账日为准。", revision: 5, readers: [side.state.user] });
  const wiki = new LocalWiki({ filename: path.join(directory, "wiki.enc"), cipher: fixtureCipher(),
    provider: knowledgeSourceReader(side.client, sheetKnowledgeSource(side.client.sheets, { reference: side.feishu.references.sheet })) });
  t.after(() => wiki.close());
  const documents = new DocumentService({ provider: side.client, getTask: () => ({}) });
  documents.on("read", (document) => { void wiki.observe(document); });
  await documents.open("task", link); await wiki.queue;
  const found = await wiki.search("银行到账");
  assert.equal(found.hits.length, 1);
  assert.equal(found.hits[0].sourceUrl, side.feishu.references.document(link).url);
  side.state.documents.get(token).readers = [];
  const after = await wiki.search("银行到账");
  assert.equal(after.hits.length, 0, "a withdrawn permission removes the answer at query time");
});

// ---- Drive -------------------------------------------------------------------------

eachSide("a file goes to a folder in the person's own deployment, and nowhere else", async (t, side, foreign) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "provider-contract-drive-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "报表.png");
  await writeFile(file, Buffer.alloc(64, 3));
  const folderToken = side.token("Folder");
  side.state.folders.set(folderToken, { title: "成果", writers: [side.state.user] });
  const session = { token: "t".repeat(43), serverUrl: "https://plane.example", expiresAt: Date.now() + 600_000 };
  const budget = { policy: async () => ({ policyDigest: "a".repeat(64), remainingBytes: 1 << 20 }), reserve: async () => {}, dispatch: async () => {}, report: async () => {} };
  const delivery = new FileDelivery({ media: { session: async () => session, unchanged: async () => {} }, provider: side.client.drive, budget, businessAccess: () => {} });

  const draft = await delivery.prepare(file, side.feishu.links.driveFolder(side.tenantOrigin, folderToken));
  assert.equal(draft.folder.providerId, side.feishu.id);
  assert.equal(draft.folder.identity.tenantKey, side.tenant);
  const receipt = await delivery.send(draft);
  assert.equal(receipt.providerId, side.feishu.id);
  assert.equal(side.feishu.references.driveFile(receipt.url).token, receipt.fileToken);
  assert.equal(side.state.uploads.length, 1);

  // A folder in another deployment, and a folder this person may not write to.
  await assert.rejects(delivery.prepare(file, foreign.feishu.links.driveFolder(foreign.tenantOrigin, foreign.token("Folder"))));
  const closed = side.token("Closed");
  side.state.folders.set(closed, { title: "别人的", writers: [side.stranger] });
  await assert.rejects(delivery.prepare(file, side.feishu.links.driveFolder(side.tenantOrigin, closed)));
  assert.equal(side.state.uploads.length, 1, "nothing else was uploaded");
});

// ---- The control plane: login, permission, notification, Wiki -------------------

// Feishu as the control plane sees it, on the side's own origins only. A request
// anywhere else fails the test on the spot.
function upstream(side, state) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const target = new URL(url);
    calls.push({ url: target.href, method: options.method ?? "GET", body: options.body });
    if (![side.feishu.openApi.origin, side.feishu.openApi.accountsOrigin].includes(target.origin)) throw new Error(`a request left the deployment: ${target.origin}`);
    const route = `${target.pathname}${target.search}`;
    if (route === "/open-apis/authen/v2/oauth/token") return Response.json({ code: 0, token_type: "Bearer", access_token: "SECRET-user-token", expires_in: 3600, scope: state.scope });
    if (route === "/open-apis/authen/v1/user_info") return Response.json({ code: 0, data: { tenant_key: state.tenant, open_id: state.user, name: "合成用户" } });
    if (route.startsWith("/open-apis/drive/v1/permissions/")) return Response.json({ code: 0, data: { auth_result: state.readable } });
    if (route === "/open-apis/auth/v3/tenant_access_token/internal") return Response.json({ code: 0, tenant_access_token: "SECRET-tenant-token", expire: 7200 });
    if (route === "/open-apis/im/v1/messages?receive_id_type=open_id") return Response.json({ code: 0, data: { message_id: "om_contract" } });
    const document = /^\/open-apis\/docx\/v1\/documents\/([A-Za-z0-9_-]+)(\/raw_content\?lang=0)?$/.exec(route);
    if (document) return Response.json(document[2] ? { code: 0, data: { content: "回款以银行到账日为准。" } } : { code: 0, data: { document: { document_id: document[1], revision_id: 3, title: "回款规则" } } });
    return Response.json({ code: 0, data: { route } });
  };
  return { calls, fetchImpl };
}

async function controlPlane(t, side, { allowedTenants = [side.tenant], bridge = false } = {}) {
  const sessions = new SessionRegistry();
  const state = { tenant: side.tenant, user: side.state.user, readable: true, scope: "" };
  const io = upstream(side, state);
  const sourceAccess = new FeishuSourceAccess({ feishu: side.feishu, sessions, appId: side.appId, fetchImpl: io.fetchImpl,
    originalOrigins: { [side.tenant]: side.tenantOrigin },
    ...(bridge ? { cliProxyScopes: ["contract:read", "contract.im:write"], cliWriteActions: ["message.send"] } : {}) });
  state.scope = sourceAccess.requiredScopes.join(" ");
  const provider = new FeishuOAuthProvider({ feishu: side.feishu, appId: side.appId, appSecret: "SECRET-app", fetchImpl: io.fetchImpl, sourceAccess });
  const proxy = bridge ? new FeishuCliProxyService({ sourceAccess, fetchImpl: io.fetchImpl }) : null;
  let login;
  const server = createServer(async (req, res) => {
    if (await login.handle(req, res) || (proxy && await proxy.handle(req, res)) || await sourceAccess.handle(req, res)) return;
    res.writeHead(404); res.end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  login = new FeishuLoginService({ origin, sessions, provider, allowedTenants });
  t.after(() => { login.close(); proxy?.close(); sourceAccess.close(); server.closeAllConnections(); server.close(); });
  const signIn = async () => {
    const client = new FeishuLoginClient(), begun = await client.begin(origin);
    const launched = await fetch(begun.launchUrl, { redirect: "manual" }), authorize = new URL(launched.headers.get("location"));
    const callback = await fetch(`${origin}/auth/feishu/callback?state=${authorize.searchParams.get("state")}&code=ContractCode`,
      { headers: { cookie: launched.headers.get("set-cookie").split(";")[0] } });
    return { client, authorize, callback };
  };
  return { state, io, sessions, sourceAccess, provider, origin, signIn };
}

const withinDeployment = (side, calls) => {
  for (const call of calls) {
    const { origin, hostname } = new URL(call.url);
    assert.ok([side.feishu.openApi.origin, side.feishu.openApi.accountsOrigin].includes(origin), `${side.name} reached ${origin}`);
    if (side.feishu.id !== SAAS_FEISHU.id) assert.equal(saasHost(hostname), false, "a private deployment never reaches Feishu SaaS");
  }
};

eachSide("sign-in goes through the deployment's own authorize page and yields its own person", async (t, side) => {
  const plane = await controlPlane(t, side);
  const { client, authorize, callback } = await plane.signIn();
  assert.equal(authorize.origin, side.feishu.openApi.accountsOrigin);
  assert.equal(authorize.pathname, "/open-apis/authen/v1/authorize");
  assert.equal(authorize.searchParams.get("client_id"), side.appId);
  assert.equal(callback.status, 200);
  const session = await client.complete();
  assert.deepEqual([session.identity.tenantId, session.identity.userId, session.identity.appId], [side.tenant, side.state.user, side.appId]);
  assert.ok(plane.io.calls.some((call) => call.url === side.feishu.openApi.tokenUrl));
  withinDeployment(side, plane.io.calls);
});

eachSide("a tenant the deployment was not set up for cannot sign in", async (t, side) => {
  const plane = await controlPlane(t, side, { allowedTenants: ["some-other-tenant"] });
  const { client, callback } = await plane.signIn();
  assert.notEqual(callback.status, 200);
  await assert.rejects(client.complete());
  assert.equal(plane.sessions.sessions.size, 0);
});

eachSide("another deployment's application id is refused wherever one is configured", (_t, side, foreign) => {
  const sessions = new SessionRegistry();
  assert.throws(() => new FeishuSourceAccess({ feishu: side.feishu, sessions, appId: foreign.appId }), /应用 ID/);
  assert.throws(() => new FeishuOAuthProvider({ feishu: side.feishu, appId: foreign.appId, appSecret: "SECRET-app" }), /credentials/);
  const policy = { authProvider: "feishu", tenantId: side.tenant, appId: side.appId, providerId: side.feishu.id, driveTenantKey: side.tenant, folderToken: side.token("Folder"), maxBytes: 100 };
  assert.equal(drivePolicies([policy], side.feishu).length, 1);
  assert.throws(() => drivePolicies([{ ...policy, appId: foreign.appId }], side.feishu), /Invalid Drive tenant policy/);
  // A tenant registered for another deployment is a configuration this server cannot honour.
  assert.throws(() => drivePolicies([{ ...policy, providerId: foreign.feishu.id }], side.feishu), /Invalid Drive tenant policy/);
  // Nor can a Wiki origin of another deployment be named for a tenant.
  assert.throws(() => new FeishuSourceAccess({ feishu: side.feishu, sessions, appId: side.appId, originalOrigins: { [side.tenant]: foreign.tenantOrigin } }));
});

eachSide("a permission check asks the deployment, as the person, and refuses the wrong tenant", async (t, side) => {
  const plane = await controlPlane(t, side);
  const { client } = await plane.signIn();
  const session = await client.complete();
  const resourceId = side.token("Doc");
  const check = () => fetch(`${plane.origin}/v1/feishu/source-access`, { method: "POST",
    headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
    body: JSON.stringify({ sources: [{ resourceType: "docx", resourceId }] }) });
  const allowed = await check();
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).authorized, true);
  assert.ok(plane.io.calls.some((call) => call.url === side.feishu.openApi.url(docxViewPermissionPath(resourceId))));
  plane.state.readable = false;
  assert.equal((await check()).status, 403);
  plane.state.readable = true;
  // Feishu now says the token belongs to someone in another tenant.
  plane.state.tenant = "another-tenant";
  assert.equal((await check()).status, 403);
  withinDeployment(side, plane.io.calls);
});

eachSide("the Wiki verifier reads an original from the tenant's own origin, and only for this deployment's records", async (t, side, foreign) => {
  const plane = await controlPlane(t, side);
  const session = await (await plane.signIn()).client.complete();
  const row = { tenantId: side.tenant, providerId: side.feishu.id, resourceId: side.token("Doc"), revision: "3", contentHash: "a".repeat(64), textSha256: "b".repeat(64) };
  const { document } = await plane.sourceAccess.readOriginal(session.token, row);
  assert.equal(document.providerId, side.feishu.id);
  assert.equal(new URL(document.sourceUrl).origin, side.tenantOrigin);
  assert.equal(side.feishu.references.document(document.sourceUrl).token, row.resourceId);
  // A record that names another deployment is not this server's to vouch for.
  await assert.rejects(plane.sourceAccess.readOriginal(session.token, { ...row, providerId: foreign.feishu.id }), { status: 403 });
  withinDeployment(side, plane.io.calls);
});

eachSide("the CLI bridge forwards to the deployment's own origin, and refuses a CLI aimed anywhere else", async (t, side, foreign) => {
  const plane = await controlPlane(t, side, { bridge: true });
  const session = await (await plane.signIn()).client.complete();
  assert.equal(session.identity.cliBridge, true);
  const read = (target) => fetch(`${plane.origin}/v1/feishu/cli-proxy`, { method: "GET",
    headers: { authorization: `Bearer ${session.token}`, "x-mydoubao-feishu-target": target, "x-mydoubao-feishu-path": "/open-apis/drive/v1/files?folder_token=x" } });
  const answered = await read(side.feishu.openApi.origin);
  assert.equal(answered.status, 200);
  assert.ok(plane.io.calls.some((call) => call.url === `${side.feishu.openApi.origin}/open-apis/drive/v1/files?folder_token=x`));
  const refused = await read(foreign.feishu.openApi.origin);
  assert.equal(refused.status, 403);
  // Said in Feishu's own envelope, the only failure shape the CLI's SDK parses.
  assert.deepEqual(await refused.json(), { code: 403, msg: "feishu_cli_target_denied" });
  withinDeployment(side, plane.io.calls);
  // The desktop half says the same before anything reaches the control plane.
  const sidecar = side.feishu.client.sidecar({ appId: side.appId, getSession: async () => { throw new Error("not reached"); } });
  assert.equal(sidecar.apiOrigin, side.feishu.openApi.origin);
  assert.throws(() => side.feishu.client.sidecar({ appId: foreign.appId, getSession: async () => ({}) }), /sidecar configuration/);
});

eachSide("a scheduled result reaches its owner the way the deployment allows, and only its owner", async (t, side) => {
  const schedule = { tenant: side.tenant, id: "s-1", owner: side.state.user, title: "每日汇总" };
  if (side.feishu.supports("botMessages")) {
    const io = upstream(side, { tenant: side.tenant, user: side.state.user });
    const bot = new FeishuBot({ feishu: side.feishu, appId: side.appId, appSecret: "SECRET-app", fetch: io.fetchImpl });
    const push = new SchedulePush({ feishu: side.feishu, origin: "http://127.0.0.1:9", bot });
    const sent = await push.deliver({ schedule, parentToken: "unused", outcome: "completed", detail: "今日无异常" });
    assert.deepEqual(sent, { sent: true, as: "bot" });
    const message = io.calls.find((call) => call.url === side.feishu.openApi.messageUrl);
    assert.equal(JSON.parse(message.body).receive_id, side.state.user);
    withinDeployment(side, io.calls);
  } else {
    assert.throws(() => new FeishuBot({ feishu: side.feishu, appId: side.appId, appSecret: "SECRET-app" }), { code: "feishu_capability_unavailable", capability: "botMessages" });
    assert.throws(() => new SchedulePush({ feishu: side.feishu, origin: "http://127.0.0.1:9", bot: { sendText: async () => ({ sent: true }) } }), /机器人通知/);
    // Without the bot, the owner's own identity sends it -- through the same
    // control plane, the same grant and the same proxy as every other write.
    const plane = await controlPlane(t, side, { bridge: true });
    const session = await (await plane.signIn()).client.complete();
    const push = new SchedulePush({ feishu: side.feishu, origin: plane.origin });
    const sent = await push.deliver({ schedule, parentToken: session.token, outcome: "completed", detail: "今日无异常" });
    assert.deepEqual(sent, { sent: true, as: "self" }, JSON.stringify(sent));
    const message = plane.io.calls.find((call) => call.url === side.feishu.openApi.messageUrl);
    assert.equal(JSON.parse(Buffer.from(message.body).toString()).receive_id, side.state.user);
    withinDeployment(side, plane.io.calls);
  }
  // An owner id this deployment would not issue is never addressed.
  const push = new SchedulePush({ feishu: side.feishu, origin: "http://127.0.0.1:9" });
  const refused = await push.deliver({ schedule: { ...schedule, owner: "ou_Not-This-Deployments.Id" }, parentToken: "x", outcome: "completed", detail: "" });
  assert.deepEqual(refused, { sent: false, reason: "owner_not_feishu" });
});

eachSide("a scheduled run's reads go to the deployment's own origin", async (_t, side) => {
  const io = upstream(side, { tenant: side.tenant, user: side.state.user });
  const who = { tenantId: side.tenant, userId: side.state.user };
  const grant = { token: Buffer.from("SECRET-user-token"), controller: new AbortController() };
  const egress = new SandboxEgressService({ sourceAccess: { feishu: side.feishu, current: () => ({ who, grant }) }, schedules: null, fetchImpl: io.fetchImpl });
  const token = egress.open({ parentToken: "p", schedule: { tenant: side.tenant, owner: side.state.user, id: "s-1" }, runId: "r-1", ttlMs: 60_000 });
  const server = createServer((req, res) => { void egress.handle(req, res); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const answer = await fetch(`http://127.0.0.1:${server.address().port}/v1/sandbox/egress`,
      { headers: { "x-mydoubao-run": token, "x-mydoubao-feishu-path": "/open-apis/authen/v1/user_info" } });
    assert.equal(answer.status, 200);
    assert.deepEqual(io.calls.map((call) => call.url), [side.feishu.openApi.userInfoUrl]);
  } finally { server.closeAllConnections(); server.close(); egress.closeAll(); }
});
