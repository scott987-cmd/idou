import "../adopt-legacy-env.js";
import { app, BrowserWindow, WebContentsView, clipboard, dialog, ipcMain, Menu, nativeTheme, Notification, safeStorage, session as electronSession, shell, systemPreferences } from "electron";

// The desktop is usually a child of a launcher, and its stdout/stderr are pipes
// to that launcher. If the launcher goes away, the next write to either — which
// Electron itself does when an IPC handler throws — raises EPIPE, and an
// unhandled stream error takes the whole main process down with it. A broken
// log pipe is not a reason to lose the application; the writes are just dropped.
for (const stream of [process.stdout, process.stderr]) {
  stream?.on?.("error", (error) => { if (error?.code !== "EPIPE") throw error; });
}

import { mkdir, readFile, writeFile, stat, mkdtemp, rm, rename, realpath } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { loadConfig } from "../config.js";
import { listPermissions } from "../modes.js";
import { TaskStore } from "../application/task-store.js";
import { TaskUiStore } from "../application/task-ui-store.js";
import { TaskService } from "../application/task-service.js";
import { TaskQueue, taskQueueConfigRevision } from "../application/task-queue.js";
import { createTaskRuntime } from "../application/task-runtime.js";
import { readClientSession } from "../control-plane/client-session.js";
import { listWorkspaceFiles, readWorkspaceFile, inspectWorkspaceFile, createArtifactServer, workspacePath } from "../application/workspace-files.js";
import { PreviewServers } from "../application/preview-servers.js";
import { loginShellPath } from "./login-path.js";
import { unreadReporter, watchFeishuUnread } from "./feishu-unread.js";
import { rememberedServerFile } from "./remembered-server.js";
import { adoptAccountData, previousAccountNames } from "./account-migration.js";
import { ApprovalNotices, confirmationNoticeText, shouldAnnounceConfirmation } from "./confirmation-notice.js";
import { accountRelocator } from "../application/account-paths.js";
import { relinkThreadIndex } from "../providers/codex/thread-index.js";
import { TaskTerminals } from "./task-terminals.js";
import { ScheduleClient } from "../application/schedule-client.js";
import { ScheduleMirror } from "../application/schedule-mirror.js";
import { ScheduleNotifier } from "../application/schedule-notifier.js";
import { codexRuntimeHome } from "../providers/codex/gateway-config.js";
import { chatModelLabel, chatModelVendor, isChatModel } from "../providers/codex/chat-models.js";
import { MODEL_UNCONFIRMED, ServerModel, modelFields, modelProblem, turnSessionUnknown } from "../providers/codex/server-model.js";
import { resolveFeishuProvider } from "../providers/feishu/provider-registry.js";
import { productSkillCatalog, isProductSkill } from "../application/skill-policy.js";
import { DocumentService } from "../application/document-service.js";
import { knowledgeEvidence, knowledgeQuery } from "../knowledge/task-scope.js";
import { LocalSkillStore } from "../skills/local-skill-store.js";
import { sitePublishProblems, snapshotApp } from "../application/app-candidates.js";
import { describeProjectDirectory, initGitRepository } from "../application/project-directory.js";
import { TableSites } from "../application/table-sites.js";
import { readContract, writeContract } from "../application/table-contract.js";
import { readBaseSlice } from "../application/table-snapshot.js";
import { SAMPLE_SLICE, SAMPLE_TITLE, SAMPLE_READ_AT, sampleRecords } from "../application/site-sample.js";
import { baseCellText } from "../providers/feishu/base-reader.js";
import { SiteStore } from "../application/site-store.js";
import { SITE_TEMPLATES, SITE_STYLES, DEFAULT_STYLE, siteTemplate, siteStyle, templatePreview, writeTemplate, restyleSite, styleOf } from "../application/site-templates.js";
import { describeSlice, parseSlice } from "../application/table-slice.js";
import { listProjectFiles, matchFiles, reviewTargets, taskProjectDiff } from "../application/project-files.js";
import { imageFolder, readPastedImage, removePastedImages, savePastedImages } from "./pasted-images.js";
import { listProjectCommands, PRODUCT_COMMANDS, projectCommand } from "../application/project-commands.js";
import { ApprovalRules } from "../application/approval-rules.js";
import { takeCheckpoint, checkpointChanges, releaseCheckpoint, restoreCheckpoint } from "../application/checkpoints.js";
import { CodexExtensions, marketplaceSource, pluginId } from "../skills/codex-extensions.js";
import { attachFiles, listTaskFiles, removeTaskFile } from "../application/task-files.js";
import { MediaDownloader } from "../application/media-download.js";
import { FileDelivery, uploadableTypes } from "../application/file-delivery.js";
import { bundleStaticApp } from "../apps/single-file.js";
import { SheetService } from "../application/sheet-service.js";
import { BaseService } from "../application/base-service.js";
import { DocumentEdits } from "../application/document-edit.js";
import { SheetEdits } from "../application/sheet-edit.js";
import { BaseEdits } from "../application/base-edit.js";
import { DocumentDelivery } from "../application/document-delivery.js";
import { ChatReader } from "../application/chat-reader.js";
import { ChatReply } from "../application/chat-reply.js";
import { DocumentProposalModel } from "../application/document-proposal-model.js";
import { prepareTaskContext } from "../application/task-context.js";
import { LocalWiki, confirmedSynthesizer } from "../knowledge/local-wiki.js";
import { MessageDiscovery } from "../knowledge/message-discovery.js";
import { WikiCoordinatorClient } from "../knowledge/coordinator-client.js";
import { DesktopWikiPublication } from "../knowledge/desktop-publication.js";
import { DesktopWikiReception } from "../knowledge/desktop-reception.js";
import { WikiCloudWork } from "../knowledge/cloud-work.js";
import { runWikiRenewalCheckpoint } from "../knowledge/renewal-checkpoint.js";
import { GatewayWikiSynthesizer } from "../knowledge/synthesis.js";
import { DesktopAuth, SESSION_UNKNOWN } from "../application/desktop-auth.js";
import { FeishuLoginClient } from "../application/feishu-login-client.js";
import { DeviceIdentityStore } from "../application/device-identity.js";
import { ResumeStore } from "../application/resume-store.js";
import { FeishuAccountVerifier, AccountCheckBlocked } from "../application/feishu-account-verifier.js";
import { EnterpriseSkillsClient } from "../application/enterprise-skills.js";
import { readCatalogConfigFile } from "../control-plane/skill-catalog.js";
import { publicSigningKey } from "../skills/catalog-format.js";
import { TaskSkillRunner, requireUsableSkill, skillMcpRequirements, skillMcpConnections } from "../application/task-skill.js";
import { McpConnections, readMcpImport, mcpReference } from "../application/mcp-connections.js";
import { BuiltinConnectors } from "../application/builtin-connectors.js";
import { EnterpriseMcpClient } from "../application/enterprise-mcp.js";
import { MediaWorkspace, mediaInput } from "../application/media-workspace.js";
import { MediaPreview } from "./media-preview.js";
import { MediaDelivery } from "../application/media-delivery.js";
import { AppCandidates } from "../application/app-candidates.js";
import { AppArchive } from "../application/app-archive.js";
import { AppReviews } from "../application/app-reviews.js";
import { AppRuntimeExports } from "../application/app-runtime-exports.js";
import { createPackagePreview } from "../apps/package-preview.js";
import { promoteToEnterprise } from "../skills/local-skills.js";
import { AgentBridge, agentRequestContext } from "../application/agent-bridge.js";
import { agentFeishuActions } from "../application/agent-feishu-actions.js";
import { agentKnowledgeActions } from "../application/agent-knowledge-actions.js";
import { AGENT_READS } from "../application/agent-reads.js";
import { sheetKnowledgeSource, baseKnowledgeSource, knowledgeSourceReader } from "../knowledge/sheet-source.js";
import { agentMediaActions, describeMedia } from "../application/agent-media-actions.js";
import { agentDeliveryActions } from "../application/agent-delivery-actions.js";
import { permitsUnattendedActions } from "../permissions.js";
import { agentScheduleActions } from "../application/agent-schedule-actions.js";
import { agentSkillActions } from "../application/agent-skill-actions.js";
import { deliveryConfirmation } from "../application/delivery-confirmation.js";
import { WEB_IDENTITY, WebIdentityCheck, rememberedVerdict, verdictRecord } from "../application/web-identity.js";
import { NativeViewGroup } from "./native-view-group.js";
import { stalledRedirect } from "./feishu-view-revival.js";
import { divertsFromMessenger, routeFeishuLink } from "./feishu-link-routing.js";
import { openWorkspaceItem } from "./workspace-open.js";
import { DockedChat } from "./docked-chat.js";
import { chatContext, documentDockContext } from "./feishu-chat-context.js";
import { documentName } from "./feishu-document-name.js";
import { desktopProfileName, taskFolderRoot } from "../install-names.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const entryUrl = pathToFileURL(path.join(here, "renderer/index.html")).href;
// The name on screen and the name this installation is known by are two
// different things, and Electron's application name is the second one. It
// decides where userData lives, and -- this is the part that bites -- the name
// of the macOS Keychain item safeStorage encrypts everything with
// ("<name> Safe Storage"). Renaming the product to i豆 here moved both: the
// data directory, and the key that the device identity, the sessions and the
// knowledge copy were all encrypted under. Measured on this machine: a second
// Keychain item appeared and the device identity could no longer be read.
// Nothing was lost, because a decrypt that fails is not a missing file and the
// store refuses to rotate over one -- but nothing worked either.
//
// So an installation keeps the identity name it was made with, one constant for
// both, and the directory and the Keychain item go on agreeing: an installation
// from before the rename is 我的豆包, a new one i豆 (install-names.js). What
// people see comes from the bundle (CFBundleName / CFBundleDisplayName), the
// window title and the strings in this application, all of which say i豆.
const IDENTITY_NAME = desktopProfileName({ appData: app.getPath("appData") });
app.setName(IDENTITY_NAME);
if (process.env.IDOU_DESKTOP_DATA_DIR) app.setPath("userData", path.resolve(process.env.IDOU_DESKTOP_DATA_DIR));
else app.setPath("userData", path.join(app.getPath("appData"), IDENTITY_NAME));
if (!app.requestSingleInstanceLock()) app.quit();
else start().catch((error) => { dialog.showErrorBox("启动失败", error.message); app.exit(1); });

async function start() {
  await app.whenReady();
  // Started from Finder, a packaged app has launchd's bare PATH; see login-path.js.
  if (app.isPackaged) process.env.PATH = await loginShellPath();
  const initialConfig = await loadConfig();
  // The Feishu deployment this installation talks to, chosen once by name. Every
  // Feishu fact below -- which links are documents, which pages the embedded
  // browser may show, how its client is built -- is asked of it.
  const feishuProvider = resolveFeishuProvider(initialConfig.feishu.provider);
  let skillPublicKey, skillKeyError;
  if (initialConfig.skillCenter.publicKeyFile) {
    try { skillPublicKey = await readCatalogConfigFile(initialConfig.skillCenter.publicKeyFile, 8192); publicSigningKey(skillPublicKey); }
    catch { skillKeyError = "企业技能验签公钥配置无效，请联系管理员。"; }
  }
  const pins = JSON.parse(await readFile(path.join(here, "../../upstreams.lock.json"), "utf8"));
  const dataRoot = app.getPath("userData");
  const nativeCipher = {
    available: () => safeStorage.isEncryptionAvailable() && (process.platform !== "linux" || ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"].includes(safeStorage.getSelectedStorageBackend())),
    encrypt: text => safeStorage.encryptString(text), decrypt: bytes => safeStorage.decryptString(bytes),
  };
  const deviceIdentity = new DeviceIdentityStore({ directory: path.join(dataRoot, "device-identity"), cipher: nativeCipher });
  // The durable half of a login, encrypted by the OS keystore like the device
  // key beside it, plus a plain pointer to the account it belongs to so a
  // restart knows which one to try.
  const resumeStore = new ResumeStore({ directory: path.join(dataRoot, "resume"), cipher: nativeCipher });
  const lastAccountFile = path.join(dataRoot, "last-account.json");
  // Opened from Finder there is no environment and no working directory to read a
  // configuration from, so a packaged app had no control plane and skipped the
  // sign-in it could have resumed. The address the last account signed in to is
  // already beside it; an explicit setting still wins. See remembered-server.js.
  // A build made for one organisation carries its control plane's address
  // (scripts/package-mac.js, IDOU_PACKAGE_SERVER_URL), so a machine that
  // has never signed in, opened from Finder, reaches the sign-in without anyone
  // setting anything. After an explicit setting, and before the last sign-in's
  // address, so that a new build can move everyone to a new one.
  if (!initialConfig.controlPlane.baseUrl) initialConfig.controlPlane.baseUrl = await rememberedServerFile(fileURLToPath(new URL("../../deployment.json", import.meta.url)));
  if (!initialConfig.controlPlane.baseUrl) initialConfig.controlPlane.baseUrl = await rememberedServerFile(lastAccountFile);
  // App-owned MCP capabilities (web fetch, …) the coding agent can use. Enabled
  // in 技能中心 and, when enabled, prepended to every coding task's MCP
  // connections so they ride along with the same per-call approval as any MCP.
  const builtinConnectors = await new BuiltinConnectors({ file: path.join(dataRoot, "builtin-connectors.json") }).load();
  let scope, scopeEpoch = 0, scopeOperations = 0, switching = false, quitting = false;
  const inFlight = new Set();
  // Not being signed in and being signed in without the capability are different
  // situations with different fixes. Reporting the second for the first sent the
  // person to their administrator when all they had to do was log in.
  const businessAccess = () => {
    if (!scope?.enterprise) return;
    if (!auth.status().connected) throw new Error("请先在「设置 → 飞书账号」使用飞书登录，再使用飞书功能。");
    if (!scope.feishuBusinessLinked) throw new Error("当前登录尚未获得飞书 CLI 业务访问能力，请联系管理员启用安全桥接或完成独立 CLI 身份核验。");
  };
  // One process-lifetime channel shared by every task. Actions read `scope`
  // when they run, so an account switch is picked up without rebuilding it.
  let agentBridge = null;
  // The desktop's own services read the root session token from memory (via the
  // auth manager below), never the lease on disk — that now holds a
  // mint-incapable turn token the coding agent may read. Shared across scopes
  // because only the current scope's services are live; null until the auth
  // manager binds it, and for a dev connection, falls back to the lease file
  // (whose own token mints in those cases).
  let operatorRoot = () => null;
  let checkSession = async () => {};
  let recoverSession = async () => false;
  const buildScope = async (root, controlPlane = initialConfig.controlPlane, enterprise = false, loginIdentity = null) => {
    const bridged = enterprise && loginIdentity?.cliBridge === true;
    // Reading over the bridge does not imply writing over it. A bridged login
    // must additionally carry the server-side write capability.
    const documentWriteAccess = () => { businessAccess(); if (bridged && loginIdentity?.cliDocumentWrites !== true) throw new Error("当前企业策略尚未启用登录桥接下的飞书文档写入，请联系管理员。"); };
    const messageWriteAccess = () => { businessAccess(); if (bridged && loginIdentity?.cliMessageWrites !== true) throw new Error("当前企业策略尚未启用登录桥接下的飞书消息发送，请联系管理员。"); };
    // Deleting and clearing is enabled on its own, by the administrator adding
    // cli.delete; a login without it keeps every other write it has.
    const destructiveWriteAccess = () => { documentWriteAccess(); if (bridged && loginIdentity?.cliDestructiveWrites !== true) throw new Error("当前企业策略没有开启删除类操作（删除日程、任务、记录，清空或删除表格内容等），请联系管理员在服务端开启 cli.delete。"); };
    const driveWriteAccess = () => { businessAccess(); if (bridged && loginIdentity?.cliDriveWrites !== true) throw new Error("当前企业策略尚未启用登录桥接下的飞书云盘上传，请联系管理员。"); };
    const cliSidecar = bridged ? feishuProvider.client.sidecar({ appId: loginIdentity.appId, getSession: async () => ({ ...(operatorRoot() ?? await readClientSession(controlPlane.sessionFile, controlPlane.baseUrl)), identity: loginIdentity }) }) : null;
    const feishuConfig = { ...initialConfig.feishu, ...(cliSidecar ? { profile: null, environment: intent => cliSidecar.environment(intent), identityKey: () => cliSidecar.sessionFingerprint() } : {}) };
    const config = { ...initialConfig, feishu: feishuConfig, agentFeishuEnvironment: taskId => agentBridge?.environment(taskId) ?? null, codex: { ...initialConfig.codex, expectedVersion: pins.codex.version, dataDir: path.join(root, "codex") }, controlPlane: { ...controlPlane }, feishuBusinessLinked: !enterprise || bridged || loginIdentity?.cliIdentityChecks === true };
    // Codex's index of this account's conversations, brought along if the
    // account's directory was renamed (account-paths.js), before any task can
    // start Codex on it. Failing to is reported, not fatal: only continuing an
    // earlier conversation depends on it.
    try {
      const relinked = await relinkThreadIndex(config.codex.dataDir, await accountRelocator(root));
      if (relinked) process.stderr.write(`idou-desktop: 已把 ${relinked} 个对话的位置改到账户的新目录\n`);
    } catch (error) { process.stderr.write(`idou-desktop: 对话索引没能改到账户的新目录：${error?.message ?? error}\n`); }
    // One place where "there is no session yet" becomes a sentence the person can
    // act on. Without it an unauthenticated click surfaces the control plane's
    // internal configuration message instead of telling them to sign in.
    const clientSession = () => {
      // A Feishu login keeps its root token in memory; the lease file holds a
      // mint-incapable turn token, so every service reads the root from here.
      const root = operatorRoot();
      if (root) return Promise.resolve(root);
      if (!config.controlPlane.sessionFile) {
        throw new Error(enterprise
          ? "请先在「设置 → 飞书账号」使用飞书登录，再使用这个功能。"
          : "尚未连接模型服务：请在「设置 → 模型服务连接」选择开发连接文件，或使用飞书登录。");
      }
      return readClientSession(config.controlPlane.sessionFile, config.controlPlane.baseUrl);
    };
    // The server enforces one chat model and names it on /healthz; Codex, the
    // proposal and synthesis clients and every label or consent naming a model
    // follow it. Asked when the scope starts and when its connection changes,
    // without holding up either; while the server has named no model this build
    // ships, asked again on use (at most every 10 s) and at once after the
    // gateway refuses one. ServerModel carries the live finding behind this.
    // Which model this person's work uses is the server's to say
    // (control-plane/model-choice.js): it keeps their pick, and it knows which
    // models can answer. The file here is what an older server falls back to,
    // and what is moved to the server once -- a pick of the default is not, or
    // it would pin the person to today's default. The file is kept, marked, so
    // a rollback still finds the pick.
    const modelChoiceFile = path.join(root, "model-choice.json");
    const savedChoiceFile = await readFile(modelChoiceFile, "utf8").then((text) => JSON.parse(text)).catch(() => null);
    const savedModelChoice = typeof savedChoiceFile?.model === "string" ? savedChoiceFile.model : null;
    const modelChoiceRequest = async (route, body, again = true) => {
      let session; try { session = await clientSession(); } catch { return null; }
      if (!session?.token || !session?.serverUrl) return null;
      const response = await fetch(`${session.serverUrl}${route}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(5_000),
        headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      // A server from before it kept choices: the desktop's own choice applies.
      if (response.status === 404) { await response.body?.cancel(); return null; }
      const value = await response.json().catch(() => null);
      // A server that restarted knows no session; it refuses before changing
      // anything, so after signing back in the same request is asked once more.
      if (response.status === 401 && value?.error === SESSION_UNKNOWN) {
        if (again && await recoverSession(session.token)) return modelChoiceRequest(route, body, false);
        throw new Error("登录已失效：服务端不认这次登录了（多半是服务端刚重启过），自动重连还没有成功。可以稍后再试；一直这样的话，请到「设置 → 飞书账号」重新登录。");
      }
      if (!response.ok) throw new Error(typeof value?.error === "string" ? value.error : `模型设置请求失败（HTTP ${response.status}）`);
      return value;
    };
    const serverModel = new ServerModel({ serverUrl: async () => {
      if (!config.controlPlane.sessionFile) return config.controlPlane.baseUrl;
      try { return (await clientSession()).serverUrl; } catch { return config.controlPlane.baseUrl; /* no usable session: the configured server, if any */ }
    }, choice: savedModelChoice, persist: async (model) => { await writeFile(modelChoiceFile, JSON.stringify({ model }), { mode: 0o600 }); },
    remote: { options: () => modelChoiceRequest("/v1/models/options", {}), choose: (model) => modelChoiceRequest("/v1/models/choose", { model }) } });
    serverModel.learn();
    if (savedModelChoice && savedChoiceFile?.movedToServer !== true) void (async () => {
      const held = await modelChoiceRequest("/v1/models/options", {}).catch(() => null);
      if (!held || held.choice !== null || !held.available?.includes(savedModelChoice)) return;
      if (savedModelChoice !== held.default) await modelChoiceRequest("/v1/models/choose", { model: savedModelChoice });
      await writeFile(modelChoiceFile, JSON.stringify({ model: savedModelChoice, movedToServer: true }), { mode: 0o600 });
    })().catch(() => { /* tried again at the next start */ });
    // The proposal and synthesis clients' requests, so a model_not_allowed from
    // the gateway has the server asked again at once (Codex turns: below).
    const modelFetch = serverModel.watching();
    const accountVerifier = enterprise && !bridged ? new FeishuAccountVerifier({ requestIntervalMs: 600, getSession: async () => {
      const status = auth.status(); if (!status.connected) throw new AccountCheckBlocked("请先在「设置 → 飞书账号」完成飞书登录，再使用飞书功能。");
      return { ...await clientSession(), identity: status.identity };
    } }) : null;
    // Each account scope owns its provider. Never let a new login rebind an old
    // task's asynchronous reader. Raw Agent CLI access remains unlinked below.
    const feishu = feishuProvider.client.create(feishuConfig, undefined, { accountVerifier });
    const documentProvider = initialConfig.feishu.wikiOrigin ? feishuProvider.client.wikiSourceReader(feishu, { origin: initialConfig.feishu.wikiOrigin }) : feishu;
    // Spreadsheets reach the knowledge copy through their own reader: a stored
    // sheet is re-read and re-verified by the same route it was stored from.
    const sheetKnowledge = sheetKnowledgeSource(feishu.sheets, { reference: feishuProvider.references.sheet });
    const baseKnowledge = baseKnowledgeSource(feishuProvider.client.baseReader(feishu), { reference: feishuProvider.references.base });
    const wikiProvider = knowledgeSourceReader(documentProvider, sheetKnowledge, baseKnowledge);
    // The binding names the model in force, so a change between consent and a
    // paid call switches synthesis off rather than spending it on a model nobody
    // agreed to; with no model the server confirmed there is nothing to agree
    // to. The call itself is made for the model agreed to.
    const wiki = new LocalWiki({ filename: path.join(root, "knowledge", "local-wiki.enc"), provider: wikiProvider,
      synthesizer: confirmedSynthesizer(serverModel, model => new GatewayWikiSynthesizer({ getSession: () => clientSession(), model, fetchImpl: modelFetch })),
      cipher: nativeCipher });
    const documents = new DocumentService({ provider: feishu, getTask: (id) => service.get(id) });
    const sheets = new SheetService({ provider: feishu.sheets, getTask: id => service.get(id), businessAccess });
    const bases = new BaseService({ provider: feishu.baseRecords, getTask: id => service.get(id), businessAccess });
    // Tables a coding task builds a site on. Structure and one slice at a
    // time, through the deployment's own parts (docs/table-driven-sites.md).
    const tableSites = new TableSites({ baseRecords: feishu.baseRecords, sheets: feishu.sheets, references: feishuProvider.references, links: feishuProvider.links,
      identity: (options) => feishu.documentIdentity(options), renderCell: (value) => baseCellText(value) });
    // 文档网站: a site outlives the conversation that made it, so it has its own
    // list and its own folder rather than living inside a coding task. A site
    // built on a table carries a slice; one that is only files does not.
    const siteStore = await SiteStore.open(path.join(root, "sites.json"), path.join(root, "sites"));
    documents.on("read", (document) => { void wiki.observe(document); });
    // Opening a spreadsheet shows the person a preview range; what is kept is
    // the bounded projection of that same worksheet, read once more for the
    // purpose and labelled with what it leaves out.
    sheets.on("read", (sheet) => {
      void (async () => {
        try { await wiki.observe(await sheetKnowledge.readDocument(sheet.sourceUrl)); }
        catch { /* reported through wiki.status(); reading the sheet is unaffected */ }
      })();
    });
    const localSkills = new LocalSkillStore({ filename: path.join(root, "local-skills.json") });
    const mcp = new McpConnections(path.join(root, "mcp-connections.json"));
    const enterpriseMcp = new EnterpriseMcpClient({ getSession: async () => {
      const status = auth.status(); if (!status.connected || !status.identity) throw new Error("请先完成飞书登录，再获取企业 MCP");
      return { ...await clientSession(), identity: status.identity };
    } });
    // A connection check starts Codex but sends no model request, so a model
    // this build does not ship is no reason to refuse it.
    // One artifact server per coding task for the agent's browser_preview, while
    // 浏览器操作 is enabled -- preview-servers.js says why its origin matters.
    const previews = new PreviewServers({ enabled: () => builtinConnectors.list().some((entry) => entry.key === "browser" && entry.enabled) });
    const runtimeFactory = async (task, skillLease, { sending = true } = {}) => {
      const connections = await mcp.resolve(task.mcpConnection);
      if (task.enterpriseSkill && task.mcpConnection && !skillLease?.mcpConnections) throw new Error("技能 MCP 依赖尚未核验");
      const ownConnections = skillLease?.mcpConnections ?? connections;
      // A coding task also gets the enabled built-in connectors (web fetch, …),
      // skipping any id it already binds itself, so they ride along every turn.
      const builtinRows = task.mode === "coding" ? builtinConnectors.enabledRows({ previewBase: await previews.baseFor(task) }).filter((row) => !ownConnections.some((existing) => existing.id === row.id)) : [];
      // A coding task opened on one of this account's sites (用编程任务修改 hands
      // it the site's folder) is told what publishing that folder will take.
      const site = task.mode === "coding" ? siteStore.list().find((item) => path.resolve(item.folder) === path.resolve(task.cwd)) : null;
      const runtime = await createTaskRuntime({ ...config, chatModel: await serverModel.requestModel({ sending }), mcpConnections: [...builtinRows, ...ownConnections], acquireEnterpriseMcp: (row) => enterpriseMcp.acquire(row),
        builtinConnections: builtinRows.map((row) => ({ id: row.id, title: row.title })),
        ...(site ? { site: { name: site.name } } : {}) }, task);
      serverModel.watchTurns(runtime.client);
      runtime.client.on("notification", (message) => { if (turnSessionUnknown(message)) void checkSession().catch(() => {}); });
      if (runtime.prepare) { const prepare = runtime.prepare; runtime.prepare = async (...args) => { await mcp.resolve(task.mcpConnection); return prepare(...args); }; }
      return runtime;
    };
    // Commands a coding project may run without asking again, kept per account.
    const approvalRules = await ApprovalRules.open(path.join(root, "approval-rules.json"));
    const taskQueue = new TaskQueue(path.join(root, "task-queue.json"));
    const service = new TaskService({ store: new TaskStore(path.join(root, "tasks")), runtimeFactory, approvalRules, queue: taskQueue,
      writesSettled: (taskId) => agentBridge?.settled(taskId) ?? Promise.resolve(),
      queueConfigRevision: async task => { await serverModel.current(); await serverModel.settled({ fresh: true }); return taskQueueConfigRevision(task, serverModel.options().current); },
      canDispatchQueued: task => documentEdits.active.has(task.id) || sheetEdits.active.has(task.id) || baseEdits.active.has(task.id) || documentDelivery.active.has(task.id)
        ? "飞书文档操作仍在处理；下一轮队列已暂停" : true,
      // A folder that is not a repository keeps its snapshots in this account's own data (checkpoints.js).
      checkpoints: { take: (cwd) => takeCheckpoint(cwd, { shadowRoot: path.join(root, "checkpoints") }),
        changes: (cwd, commit) => checkpointChanges(cwd, commit, { shadowRoot: path.join(root, "checkpoints") }),
        restore: (cwd, commit) => restoreCheckpoint(cwd, commit, { shadowRoot: path.join(root, "checkpoints") }),
        release: (cwd, commit) => releaseCheckpoint(cwd, commit, { shadowRoot: path.join(root, "checkpoints") }) },
      proposalGenerator: async (prompt, signal, context) => new DocumentProposalModel({ getSession: () => clientSession(), model: await serverModel.requestModel(), fetchImpl: modelFetch }).generate(prompt, signal, context),
      // Enterprise and local skills stage through the same runner; only where
      // the content is read from differs, so a locally imported skill gets the
      // same digest re-check and per-turn re-verification as a signed one.
      skillResolver: (reference, signal, binding) => new TaskSkillRunner(
        { read: (ref) => String(ref.id).startsWith("local-") ? localSkills.read(ref) : skills.read(ref) },
        (ref) => mcp.resolve(ref)).prepare(reference, signal, binding),
      // Retrieval runs against the same search a person uses, so every document
      // is re-read and its permission re-checked before it can answer anything.
      // A failure here must not take the question down with it: the turn simply
      // proceeds without knowledge, and the person is told in the activity log.
      knowledgeResolver: async (scopeValue, question, options) => {
        businessAccess();
        const result = await wiki.search(knowledgeQuery(question), { ids: scopeValue.mode === "selected" ? scopeValue.ids : null, signal: options?.signal ?? null });
        return { evidence: knowledgeEvidence(result.hits), unavailable: result.unavailable ?? 0 };
      },
      contextResolver: (task, input, options) => input?.kind === "feishu-document" ? documents.prepareContext(task.id, input) : input?.kind === "feishu-sheet" ? sheets.prepareContext(task.id, input, options) : input?.kind === "feishu-base" ? bases.prepareContext(task.id, input, options) : prepareTaskContext(task.cwd, input) });
    await service.init();
    // Human-operated terminals are deliberately separate from the Agent
    // runtime: one PTY per coding task, owned by this account scope. The
    // renderer never chooses a shell, environment or process id.
    const terminals = new TaskTerminals({ getTask: id => service.get(id), environment: process.env });
    // Drafts and navigation preferences belong to this account but not to the
    // task protocol. Keep them in a separate, OS-keychain-encrypted store so a
    // renderer reload or account switch cannot leak one account's unfinished
    // text into another account or change the durable task record format.
    const taskUi = await TaskUiStore.open(path.join(root, "task-ui-state.enc"), nativeCipher);
    const skills = new EnterpriseSkillsClient({ publicKey: skillPublicKey, runtimeVersions: { codex: pins.codex.version, feishu: pins.feishu.version }, getSession: async () => {
      if (skillKeyError) throw new Error(skillKeyError);
      const status = auth.status();
      if (!status.connected || !status.identity) throw new Error("请先完成飞书登录并确认账号，再查看企业技能。");
      return { ...await clientSession(), identity: status.identity };
    } });
    const media = new MediaWorkspace({ filename: path.join(root, "media-jobs.json"), getTask: (id) => service.get(id), getSession: async () => {
      const session = await clientSession();
      if (!enterprise) return session;
      const status = auth.status(); if (!status.connected || !status.identity) throw new Error("请重新登录以查看媒体任务");
      return { ...session, identity: status.identity };
    } });
    // The same allow-list as the preview. Without it the escape hatch only
    // half works: a generated image could be previewed and then refused on the
    // way to Drive, with a message telling the person to configure something
    // they had already configured.
    const mediaDelivery = new MediaDelivery({ media, provider: feishu.drive, businessAccess: driveWriteAccess,
      downloader: new MediaDownloader({ allow: config.media?.allowedAddressRanges ?? [] }) });
    const appCandidates = new AppCandidates({ directory: path.join(root, "application-candidates"), getTask: (id) => service.get(id), getSession: async () => {
      if (enterprise && !auth.status().connected) throw new Error("请重新登录以访问应用目录");
      return clientSession();
    } });
    const appArchive = new AppArchive({ candidates: appCandidates, provider: feishu.drive, businessAccess: driveWriteAccess });
    const fileDelivery = new FileDelivery({ media, provider: feishu.drive, businessAccess: driveWriteAccess });
    const appReviews = new AppReviews({ candidates: appCandidates });
    const appRuntimeExports = new AppRuntimeExports({ candidates: appCandidates });
    const documentEdits = new DocumentEdits({ documents, getTask: id => service.get(id), provider: feishu.documentEdits, businessAccess: documentWriteAccess, saveTask: async task => { await service.store.save(task); service.changed(); } });
    const sheetEdits = new SheetEdits({ sheets, getTask: id => service.get(id), provider: feishu.sheetEdits, businessAccess: documentWriteAccess, saveTask: async task => { await service.store.save(task); service.changed(); } });
    const baseEdits = new BaseEdits({ bases, getTask: id => service.get(id), provider: feishu.baseEdits, businessAccess: documentWriteAccess, saveTask: async task => { await service.store.save(task); service.changed(); } });
    const documentDelivery = new DocumentDelivery({ documents, provider: feishu.messages, getTask: id => service.get(id), businessAccess,
      editing: id => documentEdits.active.has(id) || sheetEdits.active.has(id) || baseEdits.active.has(id), saveTask: async task => { await service.store.save(task); service.changed(); } });
    const chatReader = new ChatReader({ provider: feishu.chatReader, businessAccess });
    // Resource selection has its own five-minute chat-list session. Opening the
    // full 飞书消息 page must not invalidate handles in an in-progress schedule
    // dialog, and closing that dialog must not disturb the message reader.
    const scheduleChatReader = new ChatReader({ provider: feishu.chatReader, businessAccess });
    // Which conversation the docked Agent may treat as the one on screen, decided
    // here rather than by the renderer (docked-chat.js). Its own reads of the
    // chat list go straight to the provider, so they never disturb a reading
    // session the person has open.
    const confirmations = path.join(root, "feishu-chat-confirmations.json");
    const dockedChat = new DockedChat({
      listChats: async (token, identity) => { businessAccess(); return feishu.chatReader.list(token, identity); },
      isChat: (id) => feishuProvider.ids.chat(id),
      load: async () => JSON.parse(await readFile(confirmations, "utf8")),
      save: async (value) => {
        await mkdir(root, { recursive: true, mode: 0o700 });
        const staging = `${confirmations}.${randomUUID()}.tmp`;
        await writeFile(staging, JSON.stringify(value), { mode: 0o600, flag: "wx" });
        await rename(staging, confirmations);
      },
    });
    const wikiCoordinator = new WikiCoordinatorClient({ getSession: () => clientSession() });
    const chatReply = new ChatReply({ reader: chatReader, provider: feishu.chatReader, filename: path.join(root, "chat", "reply-receipts.enc"), cipher: wiki.cipher });
    const discovery = new MessageDiscovery({ provider: feishu, wiki, reader: chatReader, businessAccess });
    const cloudWork = new WikiCloudWork();
    const cloudOptions = { wiki, drive: feishu.drive, cloudWork, feishu: feishuProvider,
      configureSource: origin => { wiki.provider = feishuProvider.client.wikiSourceReader(feishu, { origin }); },
      getSession: () => clientSession(),
      businessAccess: () => { businessAccess(); if (!enterprise || quitting || scope?.root !== root) throw new Error("自动同步需要当前企业登录作用域。"); } };
    const wikiPublication = new DesktopWikiPublication({ ...cloudOptions, filename: path.join(root, "knowledge", "publication-journal.enc") });
    const wikiReception = new DesktopWikiReception(cloudOptions);
    await cliSidecar?.start();
    return { root, webVerdictFile: path.join(root, "web-identity.json"), config, serverModel, clientSession, feishu, feishuProvider, sheetEdits, bases, baseEdits, tableSites, siteStore, taskUi, cliSidecar, localSkills, feishuBusinessLinked: config.feishuBusinessLinked, documentWriteAccess, destructiveWriteAccess, messageWriteAccess, driveWriteAccess, wiki, knowledgeSources: wikiProvider, wikiCoordinator, wikiPublication, wikiReception, cloudWork, documents, sheets, documentEdits, documentDelivery, chatReader, scheduleChatReader, chatReply, dockedChat, discovery, service, terminals, skills, mcp, runtimeFactory, previews, enterprise, enterpriseMcp, media, mediaDelivery, fileDelivery, appCandidates, appArchive, appReviews, appRuntimeExports };
  };
  const loginRequired = Boolean(initialConfig.controlPlane.baseUrl && !initialConfig.controlPlane.sessionFile);
  scope = await buildScope(loginRequired ? path.join(dataRoot, "signed-out") : dataRoot, initialConfig.controlPlane, loginRequired);
  const workspaces = new Map();
  // The app's own mark, so it is recognisable in the dock and the task switcher
  // instead of carrying the runtime's default icon.
  const brandIcon = path.join(here, "..", "..", "assets", "icon.png");
  if (process.platform === "darwin") { try { app.dock?.setIcon(brandIcon); } catch { /* a packaged build carries its own icon */ } }
  // A native view is painted by the compositor before the page it holds has
  // any colour of its own, so without this a dark-mode window flashes white
  // every time one opens. These are the same surface tokens the interface uses.
  const surfaceColor = () => (nativeTheme.shouldUseDarkColors ? "#252525" : "#ffffff");
  // The interface's own light/dark choice, applied at the process level so it
  // reaches every embedded page's `prefers-color-scheme` and the window itself,
  // not only the renderer's own stylesheet. A page that keeps its own theme —
  // Feishu's web app does — is unaffected; that setting lives in Feishu.
  ipcMain.handle("idou:set-theme", (_event, id) => {
    if (!["system", "light", "dark"].includes(id)) throw new Error("未知的配色选项");
    nativeTheme.themeSource = id;
    win?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? "#1a1a1a" : "#f5f6f7");
    return id;
  });
  const surfaces = new Set();
  const paintSurface = (view) => { view.setBackgroundColor(surfaceColor()); surfaces.add(view); return view; };
  nativeTheme.on("updated", () => { for (const view of surfaces) { try { view.setBackgroundColor(surfaceColor()); } catch { surfaces.delete(view); } } });
  // An acceptance run opens and closes this window dozens of times over ten
  // minutes. Left alone it takes the screen each time, which makes the machine
  // unusable while the suite runs. With this set the window comes up without
  // taking focus and the app stays out of the Dock; everything else about it is
  // the same, and nothing about the product changes when it is unset.
  const background = process.env.IDOU_DESKTOP_BACKGROUND === "1";
  if (background) app.dock?.hide();
  const win = new BrowserWindow({ width: 1250, height: 840, minWidth: 760, minHeight: 620, title: "i豆", backgroundColor: "#f5f6f7", icon: brandIcon,
    show: !background,
    webPreferences: { preload: path.join(here, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false } });
  const mediaPreview = new MediaPreview({ WebContentsView, window: win, allowedAddressRanges: initialConfig.media?.allowedAddressRanges ?? [] });
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: "i豆", submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }] },
    { label: "编辑", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] }]));
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  // Permit only reloading our exact entry after an account switch, so the old
  // renderer's drafts/context are discarded. Every other navigation stays denied.
  win.webContents.on("will-navigate", (event, url) => { if (url !== entryUrl) event.preventDefault(); });
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  win.webContents.session.setPermissionCheckHandler(() => false);
  win.webContents.session.on("will-download", (event) => event.preventDefault());
  let preview, previewRevision = 0;
  const retiringPreviews = new Set();
  const hidePreview = () => {
    scope.appReviews.close();
    scope.appRuntimeExports.close();
    previewRevision += 1;
    if (!preview) return Promise.all([...retiringPreviews].map((entry) => entry.closed));
    const current = preview; preview = null;
    win.contentView.removeChildView(current.view); current.server.close();
    // Keep the native view alive, and wait for actual destruction before a new
    // preview is created. close() requests teardown; it does not await it.
    current.closed = new Promise((resolve) => {
      if (current.view.webContents.isDestroyed()) { resolve(); return; }
      retiringPreviews.add(current);
      current.view.webContents.once("destroyed", () => { retiringPreviews.delete(current); resolve(); });
      current.view.webContents.close({ waitForBeforeUnload: false });
    });
    return current.closed;
  };
  // A reloaded/crashed application renderer loses its preview ownership state.
  // Retire the native child and invalidate any in-flight preview request too.
  win.webContents.on("did-start-navigation", (details) => { if (details.isMainFrame && !details.isSameDocument) {
    settleConfirm(pendingConfirm?.cancelId ?? 0, "reloaded");
    scope.chatReader.close(); scope.scheduleChatReader.close(); void scope.discovery.stop().catch(() => {}); void hidePreview().catch(() => {});
  } });
  win.webContents.on("render-process-gone", () => { scope.chatReader.close(); scope.scheduleChatReader.close(); void scope.discovery.stop().catch(() => {}); void hidePreview().catch(() => {}); });
  // `kind`: true for an account operation itself; "read" for a status question
  // with nothing to undo, which an account switch need not wait for (its answer
  // is still dropped if the account changed meanwhile) -- a settings page that
  // asked the server something on opening held 退出此账号 until it answered.
  const bind = (name, handler, kind = false) => ipcMain.handle(`idou:${name}`, async (event, ...args) => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== entryUrl) throw new Error("Untrusted application frame");
    const accountOperation = kind === true, counted = kind !== true && kind !== "read";
    if (quitting || (switching && !accountOperation)) throw new Error("正在切换账号或退出，请稍后操作");
    const epoch = scopeEpoch;
    if (counted) scopeOperations++;
    const pending = Promise.resolve().then(() => handler(...args)); inFlight.add(pending);
    try { const result = await pending; if (!accountOperation && epoch !== scopeEpoch) throw new Error("账号已切换，未使用旧结果"); return result; }
    finally { inFlight.delete(pending); if (counted) scopeOperations--; }
  });
  // A task's own cards -- commands, file changes, connectors, questions -- are
  // announced like the application's when the window is not in front. Set with
  // the rest of the announcing further down (ApprovalNotices in
  // confirmation-notice.js); a card raised before then is simply not announced.
  let noticeTaskCards = () => {};
  const watchScope = () => {
    const current = scope;
    current.documents.on("invalidated", (event) => { if (scope === current && !win.webContents.isDestroyed()) win.webContents.send("idou:document-invalidated", event); });
    current.sheets.on("invalidated", event => { if (scope === current && !win.webContents.isDestroyed()) win.webContents.send("idou:sheet-invalidated", event); });
    current.bases.on("invalidated", event => { if (scope === current && !win.webContents.isDestroyed()) win.webContents.send("idou:base-invalidated", event); });
    current.service.on("changed", (snapshot) => {
      if (scope !== current) return;
      // This runs inside the task service's own emit: announcing must never throw into it.
      try { noticeTaskCards(snapshot?.approvals); } catch { /* the cards are on screen regardless */ }
      if (!win.webContents.isDestroyed()) win.webContents.send("idou:changed", snapshot);
    });
    current.terminals.on("data", (value) => { if (scope === current && !win.webContents.isDestroyed()) win.webContents.send("idou:terminal-data", value); });
    current.terminals.on("exit", (value) => { if (scope === current && !win.webContents.isDestroyed()) win.webContents.send("idou:terminal-exit", value); });
    current.discovery.on("changed", (status) => { if (scope === current && !win.webContents.isDestroyed()) win.webContents.send("idou:discovery-changed", status); });
    current.wikiPublication.on("changed", status => { if (scope === current && !win.webContents.isDestroyed()) win.webContents.send("idou:publication-changed", status); });
    current.wikiReception.on("changed", status => { if (scope === current && !win.webContents.isDestroyed()) win.webContents.send("idou:reception-changed", status); });
  };
  watchScope();
  const switchScope = async (root, controlPlane, enterprise, loginIdentity = null) => {
    if (switching || scopeOperations || scope.service.active.size) throw new Error("请先停止任务并等待当前操作结束，再切换账号");
    // A card belongs to the account epoch that created it. Even when a future
    // account flow can switch while a read-only card is open, that old card can
    // never authorize work in the new scope.
    settleConfirm(pendingConfirm?.cancelId ?? 0, "account-changed");
    try { noticeTaskCards([]); } catch { /* nothing was announced */ }
    switching = true;
    let next;
    try {
      next = await buildScope(root, controlPlane, enterprise, loginIdentity);
      await Promise.all([scope.wikiPublication.close(), scope.wikiReception.close()]);
      await scope.discovery.close();
      // A site preview shows one account's data; it does not survive a switch.
      closeSitePreview();
      await hidePreview(); await mediaPreview.close(); await scope.media.close(); scope.wiki.disableSynthesis();
      scope.chatReader.close();
      scope.scheduleChatReader.close();
      scope.previews.closeAll();
      scope.terminals.closeAll();
      for (const id of scope.service.tasks.keys()) scope.documents.close(id);
      scope.sheets.dispose(); scope.bases.dispose();
      await scope.taskUi.flush(); await scope.service.close(); await scope.wiki.close(); await scope.cliSidecar?.close();
      scope.service.removeAllListeners(); scope.documents.removeAllListeners(); scope.discovery.removeAllListeners();
      // The embedded Feishu views belong to the account: its partition, its
      // tenant domain, its web session. Carrying them across would show one
      // account another's Feishu client.
      destroyFeishuViews(); feishuOrigin = null; feishuPartitionName = null; feishuPartitionScope = null;
      forgetWebIdentity();
      scope = next; scopeEpoch++; workspaces.clear(); watchScope();
    } catch (error) { if (next && scope !== next) { next.terminals.closeAll(); next.chatReader.close(); next.scheduleChatReader.close(); next.sheets.dispose(); next.bases.dispose(); await Promise.all([next.wikiPublication.close(), next.wikiReception.close()]); await next.discovery.close(); await next.taskUi.flush(); await next.service.close(); await next.wiki.close(); await next.cliSidecar?.close(); } throw error; }
    finally { switching = false; }
  };
  const auth = new DesktopAuth({ serverUrl: initialConfig.controlPlane.baseUrl,
    // The browser half is done once the authorizing browser is back on this
    // machine's loopback address; the renderer then finishes the sign-in.
    client: new FeishuLoginClient({ getDeviceKey: origin => deviceIdentity.key(origin),
      onReturn: () => { if (!win.webContents.isDestroyed()) win.webContents.send("idou:login-callback"); } }),
    // Authorization happens in the app's own window. If that view cannot be
    // created for any reason, the system browser is still the way in rather
    // than a login that simply does not start.
    openBrowser: async (url) => { try { await openLoginView(url); } catch { await shell.openExternal(url); } },
    resumeStore,
    activate: async ({ namespace, previous, sessionFile, serverUrl, identity }) => {
      // An account whose data is still under the name it had when names carried
      // the control plane's address gets it back here, once (account-migration.js).
      // A failed move fails the sign-in, leaving the data where it was for the
      // next attempt instead of opening an empty account in its place.
      let pointer = null;
      try { pointer = JSON.parse(await readFile(lastAccountFile, "utf8")); } catch { /* first sign-in on this machine */ }
      const moved = await adoptAccountData({ dataRoot, to: namespace, from: previousAccountNames({ serverUrl, identity, pointer, previous }), active: scope?.root ?? null, resumeStore });
      if (moved) process.stderr.write(`idou-desktop: 账户数据已迁到新的目录名（${moved.slice(0, 12)}… → ${namespace.slice(0, 12)}…）\n`);
      const result = await switchScope(path.join(dataRoot, "accounts", namespace), { sessionFile, baseUrl: serverUrl }, true, identity);
      // Not a credential: only which account the stored credential belongs to.
      try { await writeFile(lastAccountFile, JSON.stringify({ namespace, serverUrl }), { mode: 0o600 }); } catch { /* a convenience */ }
      // Signing in is the moment the Feishu sections become reachable, so that
      // is when they start loading rather than when someone clicks them.
      void warmFeishuViews().catch(() => {});
      return result;
    },
    deactivate: () => switchScope(path.join(dataRoot, "signed-out"), { sessionFile: null, baseUrl: initialConfig.controlPlane.baseUrl }, true),
    withRenewal: operation => {
      const current = scope;
      return runWikiRenewalCheckpoint({ cloudWork: current.cloudWork, wiki: current.wiki, publication: current.wikiPublication,
        reception: current.wikiReception, isCurrent: () => { if (quitting || switching || scope !== current) throw new Error("登录作用域已关闭"); } }, operation);
    },
  });
  // Now that the auth manager exists, the desktop's services read the root
  // session token from it (in memory) rather than the lease on disk.
  operatorRoot = () => auth.operatorSession();
  recoverSession = (token) => auth.recover(token);
  // Asked when a turn comes back refused for a session the gateway does not
  // know: does the server still know this account's session? One that
  // restarted knows none, and the account then signs back in with the stored
  // credential (DesktopAuth.recover). Asked with the root token, on a read that
  // changes nothing; only a definite "unknown" is acted on, so a token Codex
  // held on to past a renewal costs one request. One question at a time.
  let checking = null;
  checkSession = () => checking ??= (async () => {
    const root = auth.operatorSession(); if (!root) return;
    let response;
    try {
      response = await fetch(`${root.serverUrl}/v1/models/options`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(5_000),
        headers: { authorization: `Bearer ${root.token}`, "content-type": "application/json" }, body: "{}" });
    } catch { return; }
    if (response.status !== 401) { await response.body?.cancel(); return; }
    if ((await response.json().catch(() => null))?.error === SESSION_UNKNOWN) await auth.recover(root.token);
  })().finally(() => { checking = null; });
  // Learning started with the scope, so this rarely waits; while the server has
  // confirmed no model, reading it is what has the server asked again.
  const connection = async () => {
    const status = auth.status(), current = scope, model = modelFields(await current.serverModel.current());
    if (status.identity) return { ...status, ...model, identity: status.identity.displayName || status.identity.userId, provider: "feishu" };
    try {
      const session = await readClientSession(current.config.controlPlane.sessionFile, current.config.controlPlane.baseUrl);
      return { connected: true, expiresAt: session.expiresAt, serverUrl: session.serverUrl, ...model, identity: "本地开发测试" };
    } catch { return { connected: false, identity: "未登录", ...model }; }
  };
  bind("auth-status", () => auth.status(), true);
  bind("auth-begin", () => auth.begin(), true);
  bind("auth-poll", () => auth.poll(), true);
  bind("auth-confirm", async () => {
    await closeLoginView(); const result = await auth.confirm(); if (result.identity?.cliIdentityChecks === true || result.identity?.cliBridge === true) { const current = scope; await current.wikiPublication.start(); await current.wikiReception.start(); } return result; }, true);
  bind("auth-cancel", async () => { await closeLoginView(); return auth.cancel(); }, true);
  // The embedded pages' own Feishu sign-in belongs to the account, and the
  // settings page says it goes when the account does. It never did: the
  // partition kept its cookies, so the next person to sign in on this machine
  // found the last one's Feishu client still signed in. Cleared only after the
  // logout itself succeeded -- a refused logout leaves everything as it was.
  bind("auth-logout", async () => {
    const leaving = scope?.enterprise && /^[0-9a-f]{64}$/.test(path.basename(scope.root)) ? await feishuPartition() : null;
    const result = await auth.logout();
    if (leaving) await electronSession.fromPartition(`persist:${leaving}`).clearStorageData().catch(() => {});
    return result;
  }, true);
  // App-owned built-in MCP capabilities, shown in 技能中心. Enabling one is the
  // person's own UI action; the tool calls it later makes are still gated by the
  // MCP approval card, per call or per grant as the task's permission says
  // (mcp-approval-policy.js).
  // macOS lists an application under Privacy & Security only once it has asked
  // for the permission: an app that never asks never appears, so there is
  // nothing for the person to grant. Asking is what registers it.
  // isTrustedAccessibilityClient(true) shows the prompt and adds the entry;
  // screen recording reports its status and registers on the first capture.
  bind("request-computer-permissions", () => process.platform !== "darwin"
    ? { supported: false, accessibility: false, screen: "unknown" }
    : { supported: true, accessibility: systemPreferences.isTrustedAccessibilityClient(true), screen: systemPreferences.getMediaAccessStatus("screen") });
  bind("list-builtin-connectors", () => builtinConnectors.list());
  bind("set-builtin-connector-enabled", (key, on) => builtinConnectors.setEnabled(key, on === true));
  bind("snapshot", () => scope.service.snapshot());
  bind("task-ui-state", (id) => scope.taskUi.get(id), "read");
  bind("task-ui-navigation", async () => ({ items: await scope.taskUi.metadata(), warnings: [...scope.taskUi.warnings] }), "read");
  bind("save-task-ui-state", (id, value, revision) => {
    if (!/^draft:(coding|cowork)$/.test(id)) scope.service.get(id);
    return scope.taskUi.save(id, value, revision);
  });
  bind("set-task-ui-metadata", async (id, patch = {}) => {
    const task = scope.service.get(id);
    if (patch.archived === true && ["running", "awaiting_approval", "stopping"].includes(task.status)) throw new Error("请先停止任务，再归档");
    return scope.taskUi.setMetadata(id, { pinned: patch.pinned === true, archived: patch.archived === true });
  });
  bind("connection", connection);
  // The models this connection offers and which one is chosen; selecting one is
  // the person's own UI action and takes effect on the next task turn.
  bind("model-options", async () => { await scope.serverModel.current(); await scope.serverModel.settled({ fresh: true }); return scope.serverModel.options(); }, "read");
  bind("select-model", async (slug) => {
    await scope.service.pauseQueues("模型已变化；请核对排队内容后继续");
    return scope.serverModel.choose(slug);
  });
  bind("connect", async () => {
    if (auth.status().identity || auth.status().stage !== "idle") throw new Error("请先退出飞书账号或取消登录，再选择开发连接");
    const selected = await dialog.showOpenDialog(win, { title: "选择服务端生成的短期连接文件（不是模型密钥）", properties: ["openFile"], filters: [{ name: "连接文件", extensions: ["json"] }] });
    if (selected.canceled) return connection();
    const filename = selected.filePaths[0];
    await readClientSession(filename);
    if (scope.service.active.size) throw new Error("请先停止正在执行的任务，再切换服务端连接");
    await scope.discovery.stop();
    await hidePreview(); await mediaPreview.close(); await scope.media.close();
    scope.wiki.disableSynthesis();
    scope.config.controlPlane.sessionFile = filename; scope.config.controlPlane.baseUrl = null;
    // Another connection file may name another server, and so another model.
    scope.serverModel.learn();
    return connection();
  });
  // The last directory a person picked is remembered per account, so a coding
  // task does not start with the same file dialog every launch. Only the path is
  // stored, it is re-checked before use, and choosing a directory is still the
  // only way one is ever granted.
  // A work task is a folder the person can open in Finder, not a UUID buried in
  // application data: the files they attach and the results the Agent writes
  // both live there, so it is named after the day and numbered within it.
  const newWorkTaskFolder = async () => {
    const root = taskFolderRoot();
    const day = new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).replace(/\//g, "-");
    await mkdir(root, { recursive: true, mode: 0o700 });
    for (let index = 1; index <= 999; index += 1) {
      const cwd = path.join(root, index === 1 ? day : `${day}-${index}`);
      // `recursive: false` fails on an existing directory, so two tasks started
      // in the same second cannot land in the same folder.
      try { await mkdir(cwd, { mode: 0o700 }); return cwd; } catch (error) { if (error?.code !== "EEXIST") throw error; }
    }
    throw new Error(`今天的任务文件夹太多了，请先整理 ~/${path.basename(root)}`);
  };
  const recentWorkspacesFile = () => path.join(scope.root, "recent-workspaces.json");
  const readRecent = async () => {
    try { const list = JSON.parse(await readFile(recentWorkspacesFile(), "utf8")); return Array.isArray(list) ? list.filter((item) => typeof item === "string" && path.isAbsolute(item)) : []; }
    catch { return []; }
  };
  const rememberWorkspace = async cwd => {
    try { await writeFile(recentWorkspacesFile(), JSON.stringify([cwd, ...(await readRecent()).filter((item) => item !== cwd)].slice(0, 8)), { mode: 0o600 }); }
    catch { /* a convenience, never a failure */ }
  };
  bind("pick-workspace", async () => {
    // `createDirectory` is why there is no separate "new project" step: a new
    // folder is made here, and its name is the project's name — there is never
    // a second name to keep in step with it.
    const selected = await dialog.showOpenDialog(win, { title: "选择此任务可访问的工作目录", properties: ["openDirectory", "createDirectory"], buttonLabel: "打开" });
    if (selected.canceled) return null;
    const id = randomUUID(), cwd = selected.filePaths[0]; workspaces.set(id, cwd);
    await rememberWorkspace(cwd);
    return { id, path: cwd, ...(await describeProjectDirectory(cwd)) };
  });
  // A directory that has been moved, renamed or deleted since last time is
  // dropped rather than offered, so nothing on the list is unusable when clicked.
  bind("recent-workspaces", async () => {
    const rows = await Promise.all((await readRecent()).map(async (cwd) => {
      try { if (!(await stat(cwd)).isDirectory()) return null; } catch { return null; }
      const id = randomUUID(); workspaces.set(id, cwd);
      return { id, ...(await describeProjectDirectory(cwd)) };
    }));
    return rows.filter(Boolean);
  });
  // Initialising the repository is the application's job, not the Agent's:
  // Codex's sandbox refuses every write under `.git` unless this process names
  // it, so an Agent told to run `git init` can only fail or ask to escalate.
  // Offered where its absence is felt -- 查看改动 and /review, which need a
  // baseline -- so it takes a task as readily as a folder chosen but not opened.
  bind("init-git", async (target) => {
    const cwd = typeof target === "string" ? workspaces.get(target) : projectFolder(target);
    if (!cwd) throw new Error("请先选择项目目录");
    const result = await initGitRepository(cwd);
    if (result.reason === "nested") throw new Error(`这个目录已经在仓库「${path.basename(result.parent)}」里了，不需要再初始化`);
    return { ...result, ...(await describeProjectDirectory(cwd)) };
  });
  // @ in a coding task names a file of its project (docs/coding-task-parity.md,
  // C6), and 查看改动 shows the working tree's changes (C8, Codex's /diff).
  // Both only read, so neither holds an account switch.
  const projectFileCache = new Map();
  const projectFolder = ({ taskId, workspaceId } = {}) => {
    const cwd = taskId ? scope.service.get(taskId).cwd : workspaces.get(workspaceId);
    if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new Error("请先选择项目目录");
    return cwd;
  };
  bind("search-project-files", async ({ taskId, workspaceId, query } = {}) => {
    const cwd = projectFolder({ taskId, workspaceId });
    let cached = projectFileCache.get(cwd);
    if (!cached || Date.now() - cached.at > 20_000) { cached = { at: Date.now(), files: await listProjectFiles(cwd) }; projectFileCache.set(cwd, cached); }
    return matchFiles(cached.files, typeof query === "string" ? query.slice(0, 200) : "", 20);
  }, "read");
  bind("project-diff", async (input) => {
    const request = typeof input === "string" ? { taskId: input, scope: "working" } : input ?? {};
    const task = scope.service.get(request.taskId), cwd = projectFolder({ taskId: task.id });
    const root = await realpath(cwd);
    return taskProjectDiff(task, { scope: request.scope, turnKey: request.turnKey }, { readText: async (file) => {
      const target = await realpath(path.join(cwd, file));
      if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("outside the project");
      return readFile(target);
    } });
  }, "read");
  // A project's own slash commands (.claude/commands, .codex/prompts): which
  // there are, and one filled in with what followed it. Both only read.
  bind("project-commands", ({ taskId, workspaceId } = {}) => listProjectCommands(projectFolder({ taskId, workspaceId }), { reserved: PRODUCT_COMMANDS }), "read");
  bind("project-command", ({ taskId, workspaceId, name, args } = {}) => projectCommand(projectFolder({ taskId, workspaceId }), typeof name === "string" ? name : "",
    typeof args === "string" ? args.slice(0, 10_000) : "", { reserved: PRODUCT_COMMANDS }), "read");
  // Commands a coding project may run without asking again, for 设置 to list
  // and to forget. Forgetting only ever takes a permission away.
  bind("approval-rules", () => scope.service.approvalRules?.list() ?? [], "read");
  bind("forget-approval-rule", ({ folder, prefix } = {}) => scope.service.approvalRules?.forget(folder, prefix));
  // 文档网站. A site is a folder of static files that may also carry one slice
  // of a Feishu table (docs/table-driven-sites.md). Describing a table reads
  // structure only -- names and types -- so it is a read; anything that takes a
  // slice out of Feishu goes through the confirmation card first.
  bind("table-describe", ({ url, tableId, sheetId } = {}) => scope.tableSites.describe(typeof url === "string" ? url.slice(0, 2000) : "", { tableId, sheetId }), "read");
  bind("sites", async () => Promise.all(scope.siteStore.list().map(async (site) => {
    // A one-use handle, as the folder picker mints them: the renderer never
    // names a directory, it names a handle this process resolved.
    const workspaceId = randomUUID();
    workspaces.set(workspaceId, site.folder);
    return { id: site.id, name: site.name, workspaceId, path: site.folder, kind: site.slice ? "table" : "files", createdAt: site.createdAt,
      lastReadAt: site.lastReadAt, rowCount: site.rowCount, truncated: site.truncated,
      published: Boolean(site.publishedId), offline: site.publishedOffline === true, url: site.url ?? null, publishedScope: site.publishedScope ?? null,
      publishedInherit: site.publishedInherit === true, publishedAt: site.publishedAt ?? null,
      fields: site.slice ? (site.slice.kind === "base" ? site.slice.fields.length : site.slice.columns.length) : 0,
      refreshSeconds: site.slice?.refreshSeconds ?? null,
      // Read from the folder rather than remembered: the person may have
      // rewritten site.css in a coding task, and then it is theirs, not a style.
      style: await styleOf(site.folder).catch(() => null),
      // What in the folder 发布 would refuse, named now rather than by the refusal.
      problems: await sitePublishProblems(site.folder).catch(() => []) };
  })), "read");
  // The ready-made sites. Static files that ship with the application, so the
  // list is the same for everybody and cannot be swapped out next to a site.
  // Each template with a picture of itself: the template, actually rendered
  // (scripts/build-template-previews.js). 妙搭's case centre, Kimi 网页 and
  // ChatGPT Sites all show the thing rather than describe it, and a person
  // choosing between three pages should be able to see all three.
  // Both axes, and the pictures for the style being looked at. A style nobody
  // can see is not a choice anybody can make, so the picker asks again with a
  // different style rather than describing one.
  bind("site-templates", async (styleId = DEFAULT_STYLE) => ({
    style: siteStyle(styleId) ? styleId : DEFAULT_STYLE,
    styles: SITE_STYLES.map((style) => ({ ...style })),
    templates: await Promise.all(SITE_TEMPLATES.map(async (template) => ({ ...template, preview: await templatePreview(template.id, styleId) }))),
  }), "read");
  bind("site-create", async ({ name, slice, title, names, template, style } = {}) => {
    const chosen = template ? siteTemplate(template) : null;
    if (style !== undefined && style !== null && !siteStyle(style)) throw new Error("没有这个风格");
    if (template && !chosen) throw new Error("没有这个模版");
    if (chosen?.table && !slice) throw new Error("这个模版要接一张表格");
    if (!slice) {
      // Files only: a folder in this person's own data, nothing read and
      // nothing disclosed, so nothing to confirm.
      const made = await scope.siteStore.create({ name, title });
      return { ...made, ...(chosen ? await writeTemplate(made.folder, chosen.id, style ?? DEFAULT_STYLE) : {}) };
    }
    const parsed = parseSlice(slice);
    const card = describeSlice(parsed, { tableName: typeof title === "string" ? title.slice(0, 120) : "", fieldNames: new Map(Array.isArray(names) ? names.slice(0, 200) : []) });
    const choice = await confirmInApp({ type: "warning", title: "确认把表格接进这个网站",
      message: `${card.source} · ${card.fields.length} 个字段 · 最多 ${card.rows} 行`,
      detail: `字段：${card.fields.join("、")}\n最多行数：${card.rows}\n刷新：${card.refresh}\n可写字段：${card.writable.length ? card.writable.join("、") : "无（只读）"}\n\n`
        + "以你本人的飞书身份读取，读到的就是你现在能看到的内容。只读取上面这些字段，其他字段不会离开这台电脑。\n"
        + "把这个网站发布出去，就等于把这份数据交给能打开它的人。",
      buttons: ["取消", "读取并建站"], defaultId: 0, cancelId: 0 });
    if (choice.response !== 1) return null;
    const site = await scope.siteStore.create({ name, slice: parsed, title });
    // The page first, then its data: a folder with a template in it and no
    // contract yet is a page that says it is loading, which is the truth.
    const files = chosen ? await writeTemplate(site.folder, chosen.id, style ?? DEFAULT_STYLE) : { written: [] };
    const built = await scope.tableSites.build(site.folder, parsed, { title: site.name });
    return { ...await scope.siteStore.recordRead(site.id, built), paths: built.paths, written: files.written };
  });
  // Reading the same slice again is not a new disclosure: it was confirmed once
  // and nothing about what may be shown has changed.
  const refreshSite = async (id) => {
    const site = scope.siteStore.get(id);
    if (!site.slice) throw new Error("这个网站没有接表格，没有可刷新的数据");
    const built = await scope.tableSites.build(site.folder, site.slice, { title: site.name });
    const recorded = await scope.siteStore.recordRead(site.id, built);
    // A published site shows what it was last given, so a refresh here is only
    // half the job until the server has the same numbers.
    if (site.publishedId) {
      const data = await readContract(site.folder);
      if (data) await siteRequest("/v1/sites/data", { siteId: site.publishedId, ...data }).catch((error) => {
        throw new Error(`本机已更新，但推送到线上失败：${error.message}`);
      });
    }
    return recorded;
  };
  bind("site-refresh", refreshSite);
  // The clock the whole feature rests on.
  //
  // "数值会跟着表格走" was, until this existed, only true when somebody pressed
  // 重新读取: the refresh interval was stored on the slice and printed in the
  // list, and nothing read it. Everything downstream was already built and
  // tested -- the server pushes `changed`, the page re-fetches -- so what was
  // missing was the thing that notices.
  //
  // It reads with the signed-in person's own Feishu identity, which lives in
  // this process, so it runs while the application is open and stops when it is
  // closed. The list says so rather than implying a server does it.
  let refreshing = false;
  const dueSites = (now) => scope.siteStore.list().filter((site) =>
    // Only what somebody can actually open: an unpublished or withdrawn site has
    // no reader to tell, and reading it anyway spends the person's Feishu quota.
    site.slice && site.publishedId && site.publishedOffline !== true
    && now - (site.lastReadAt ?? 0) >= site.slice.refreshSeconds * 1000);
  const refreshDueSites = async () => {
    if (refreshing || quitting) return;
    refreshing = true;
    const owner = scope;
    try {
      for (const site of dueSites(Date.now())) {
        if (scope !== owner || quitting) return;   // account switch: not this account's tables any more
        // One site's failure is its own: a table somebody lost access to must
        // not stop the others from following theirs.
        await refreshSite(site.id).then(() => win.webContents.isDestroyed() || win.webContents.send("idou:sites-changed"),
          (error) => process.stderr.write(`idou-desktop: 网站「${site.name}」自动刷新失败：${String(error.message).slice(0, 200)}\n`));
      }
    } finally { refreshing = false; }
  };
  // Every 15 seconds, which is also the shortest interval a slice may ask for.
  setInterval(() => { void refreshDueSites(); }, 15_000).unref?.();
  bind("site-rename", (id, name) => scope.siteStore.rename(id, typeof name === "string" ? name : ""));
  // Change the look of a site that already exists. One file, because a style is
  // one file -- see restyleSite. A stylesheet somebody wrote themselves is
  // refused rather than overwritten, unless they answer the card.
  bind("site-restyle", async ({ id, style } = {}) => {
    const site = scope.siteStore.get(id);
    const chosen = siteStyle(style);
    if (!chosen) throw new Error("没有这个风格");
    const was = await styleOf(site.folder);
    let force = false;
    if (was === null) {
      const choice = await confirmInApp({ type: "warning", title: "覆盖你自己写的样式",
        message: `「${site.name}」的 site.css 被改过`,
        detail: `换成「${chosen.name}」会把 site.css 整个换掉，你写在里面的样式会没有。\n`
          + "页面的结构和行为（index.html、site.js）不动。\n\n改动只在本机；已经发布出去的版本不受影响，除非你再发布一次。",
        buttons: ["取消", "覆盖并换风格"], defaultId: 0, cancelId: 0 });
      if (choice.response !== 1) return null;
      force = true;
    }
    const done = await restyleSite(site.folder, chosen.id, { force });
    return { ...done, name: chosen.name, published: Boolean(site.publishedId) && site.publishedOffline !== true };
  });
  // A page written in a coding task becomes a site in 文档网站, on its own
  // folder. Without this the two halves never met: somebody would ask for a
  // website, watch it get built and previewed, and then find nothing anywhere
  // to publish or change -- the list only ever held sites started from 新建网站.
  //
  // Nothing is published here. It joins the list; who may open it is still the
  // sharing panel's question, answered later and separately.
  bind("site-from-task", async (taskId) => {
    const task = scope.service.get(taskId);
    if (task.mode !== "coding") throw new Error("只有编程任务的成果可以收进文档网站");
    const folder = await realpath(task.cwd);
    const existing = scope.siteStore.list().find((site) => site.folder === folder);
    if (existing) return { id: existing.id, name: existing.name, already: true };
    if (!await stat(path.join(folder, "index.html")).then((info) => info.isFile(), () => false)) {
      throw new Error("这个目录里还没有 index.html，网站要有一个入口页面。");
    }
    const made = await scope.siteStore.create({ name: task.title, at: folder });
    return { id: made.id, name: made.name, already: false };
  });
  // Look at it before deciding who may. Without this the first question after
  // making a site is "谁可以打开" -- a permission decision about a page nobody
  // has seen. Kimi 网页 and ChatGPT Sites both show the page immediately and
  // keep publishing as a separate, later step; this is that step.
  //
  // Its own window, not a view over the list: a site is a whole page, and a
  // window is the only one of the two a test can actually read back. The
  // hardening is the coding task's 成果预览 hardening -- a one-use path on a
  // loopback server, the same CSP the published page gets, its own partition,
  // and nothing that leaves the origin.
  let sitePreview = null;
  const closeSitePreview = () => {
    const current = sitePreview; sitePreview = null;
    if (!current) return;
    current.server.close();
    if (!current.window.isDestroyed()) current.window.destroy();
    if (current.sweep) void rm(current.sweep, { recursive: true, force: true }).catch(() => {});
  };
  const openSitePreview = async (folder, title, { siteId = null, sweep = null } = {}) => {
    closeSitePreview();
    const server = await createArtifactServer(folder);
    const window = new BrowserWindow({ width: 1180, height: 820, minWidth: 380, backgroundColor: surfaceColor(), icon: brandIcon,
      title, show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: `site-preview-${randomUUID()}` } });
    // The page is written by people here, but it is still a page: it gets no
    // permissions, opens nothing, downloads nothing and cannot leave its origin.
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    // The page does not get to name the window. What the title has to say is
    // that this is a local preview and nobody else can see it yet; a <title>
    // that replaced it would read exactly like the published thing.
    window.on("page-title-updated", (event) => event.preventDefault());
    window.webContents.on("will-navigate", (event, url) => { if (!url.startsWith(`${server.origin}/`)) event.preventDefault(); });
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.webContents.session.on("will-download", (event) => event.preventDefault());
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(`${server.origin}/`) }));
    // Whoever closes it -- the person, an account switch, quitting -- the
    // server goes with it, and so does a demo's scratch copy. A loopback
    // listener outliving its window is a hole.
    window.on("closed", () => {
      if (sitePreview?.window !== window) return;
      sitePreview = null; server.close();
      if (sweep) void rm(sweep, { recursive: true, force: true }).catch(() => {});
    });
    sitePreview = { window, server, siteId, sweep };
    try { await window.loadURL(server.url("index.html")); }
    catch { closeSitePreview(); throw new Error("预览没能打开这个页面"); }
    if (window.isDestroyed()) throw new Error("预览已关闭");
    if (background) window.showInactive(); else window.show();
    return { title: window.getTitle() };
  };
  bind("site-preview", async (id) => {
    const site = scope.siteStore.get(id);
    // A blank site is a directory until a coding task writes the page. Say that,
    // rather than opening a window onto a 404.
    if (!await stat(path.join(site.folder, "index.html")).then((info) => info.isFile(), () => false)) {
      throw new Error("这个网站还没有 index.html，先用编程任务做出页面再预览。");
    }
    return openSitePreview(site.folder, `${site.name} · 本地预览（还没有发布）`, { siteId: site.id });
  });
  // A demo of one combination, live rather than photographed: the same files a
  // new site would get, filled with the sample table (site-sample.js), opened in
  // the same hardened window. You can sort it, filter it and play the game --
  // which is the thing a picture cannot tell you, and the reason the section's
  // front page leads with these rather than with a list of names.
  //
  // Nothing here touches the account: no site is made, nothing is read from
  // Feishu, and the scratch copy is swept when the window closes.
  bind("site-demo", async ({ template, style } = {}) => {
    const chosen = siteTemplate(template);
    if (!chosen) throw new Error("没有这个模版");
    if (style !== undefined && style !== null && !siteStyle(style)) throw new Error("没有这个风格");
    const folder = await mkdtemp(path.join(os.tmpdir(), "idou-site-demo-"));
    try {
      await writeTemplate(folder, chosen.id, style ?? DEFAULT_STYLE);
      if (chosen.table) {
        const { schema, snapshot } = await readBaseSlice(SAMPLE_SLICE, sampleRecords(),
          { renderCell: (value) => baseCellText(value), title: SAMPLE_TITLE, now: () => SAMPLE_READ_AT });
        await writeContract(folder, { schema, snapshot });
      }
    } catch (error) { await rm(folder, { recursive: true, force: true }).catch(() => {}); throw error; }
    const styleName = chosen.styled ? siteStyle(style ?? DEFAULT_STYLE).name : null;
    const title = `${chosen.name}${styleName ? ` · ${styleName}` : ""} · 样例（用的是示例数据）`;
    const opened = await openSitePreview(folder, title, { sweep: folder });
    return { template: chosen.id, style: chosen.styled ? (style ?? DEFAULT_STYLE) : null, ...opened };
  });
  // Copying goes through here, not through navigator.clipboard: this window
  // denies every web permission on purpose (setPermissionRequestHandler), so
  // the page asking the browser to write the clipboard is refused. The main
  // process needs no permission and the page never gets one.
  bind("copy-text", (value) => {
    const text = String(value ?? "").slice(0, 4096);
    if (!text) return false;
    clipboard.writeText(text);
    return true;
  }, "read");

  // Publishing: the one action here that other people can see the result of, so
  // it is the one that always stops at a card. What the card names is what the
  // visitor will be able to open, in the words the sharing panel uses.
  const siteRequest = async (route, body) => {
    // The account's own session, from the scope that owns it: `clientSession`
    // lives inside buildScope, and this runs out here where only `scope` does.
    const session = await scope.clientSession();
    if (!session?.token || !session?.serverUrl) throw new Error("请先登录后再发布网站");
    const response = await fetch(`${session.serverUrl}${route}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(60_000),
      headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    if (response.status === 404) { await response.body?.cancel(); throw new Error("这个服务端还没有开启「文档网站」的发布功能，请联系管理员。"); }
    const value = await response.json().catch(() => null);
    if (!response.ok) throw new Error(typeof value?.error === "string" ? value.error : `发布请求失败（HTTP ${response.status}）`);
    return value;
  };
  const SCOPE_WORDS = { invited: "仅邀请的人可访问", tenant: "组织内获得链接的人可阅读", anyone: "互联网上获得链接的人可阅读" };
  bind("site-published", () => siteRequest("/v1/sites/list", {}), "read");
  bind("site-publish", async ({ id, share } = {}) => {
    const site = scope.siteStore.get(id);
    const snapshot = await snapshotApp(site.folder, "index.html");
    // Updating what is already online is not a sharing decision: who may open
    // it stays exactly as it is, members and all, so the current sharing is
    // taken from the server rather than rebuilt from what this window knows.
    const updating = !share && Boolean(site.publishedId);
    if (updating) {
      const current = (await siteRequest("/v1/sites/list", {})).sites?.find((row) => row.id === site.publishedId);
      if (!current) throw new Error("服务端找不到这个网站，先取消发布再重新发布");
      share = { scope: current.share.scope, inherit: current.share.inherit, members: current.share.members ?? [] };
    }
    const scopeWord = SCOPE_WORDS[share?.scope] ?? SCOPE_WORDS.invited;
    const following = share?.inherit === true && Boolean(site.slice);
    const choice = await confirmInApp({ type: "warning", title: updating ? "确认更新线上版本" : "确认发布这个网站",
      message: `「${site.name}」· ${snapshot.manifest.files.length} 个文件 · ${Math.max(1, Math.round(snapshot.totalBytes / 1024))} KB`,
      detail: `谁能打开：${scopeWord}${Array.isArray(share?.members) && share.members.length ? `，另加 ${share.members.length} 位协作者` : ""}${updating ? "（不变）" : ""}\n`
        + `${following ? "访问权限跟随这张表格：在飞书里能读这张表的人就能打开，在飞书里移除就立刻打不开。\n" : ""}`
        + `${site.slice ? "页面上会显示你选定的那些字段的数据；发布出去就等于把这份数据交给能打开它的人。\n" : ""}`
        + `${updating ? "\n这会把线上的页面换成当前目录里的文件。已经打开着的人刷新之后看到新的；旧版本还留着。"
          : "\n发布的是当前目录里的静态文件，发出去之后不会因为你改了本机文件而变——要更新就再发布一次。已经发出去的内容不会因为以后收回权限而消失。"}`,
      buttons: ["取消", updating ? "更新" : "发布"], defaultId: 0, cancelId: 0 });
    if (choice.response !== 1) return null;
    const published = await siteRequest("/v1/sites/publish", {
      siteId: site.publishedId ?? undefined, name: site.name, manifest: snapshot.manifest, blobs: snapshot.blobs,
      share: share ?? { scope: "invited" },
      source: site.slice ? { kind: site.slice.kind, token: site.slice.token, tableId: site.slice.tableId ?? null, sheetId: site.slice.sheetId ?? null } : null,
      data: site.slice ? await readContract(site.folder) : null,
    });
    await scope.siteStore.recordPublish(site.id, { publishedId: published.id, url: published.url, scope: published.share.scope, inherit: published.share.inherit });
    return published;
  });
  // Back online: the same version, without sending the bytes again.
  bind("site-republish", async (id) => {
    const site = scope.siteStore.get(id);
    if (!site.publishedId) throw new Error("这个网站还没有发布过");
    const back = await siteRequest("/v1/sites/republish", { siteId: site.publishedId });
    await scope.siteStore.recordPublish(site.id, { publishedId: back.id, url: back.url, scope: back.share.scope, inherit: back.share.inherit, offline: false });
    return back;
  });
  bind("site-share-set", async ({ id, share } = {}) => {
    const site = scope.siteStore.get(id);
    if (!site.publishedId) throw new Error("这个网站还没有发布");
    const changed = await siteRequest("/v1/sites/share", { siteId: site.publishedId, share });
    await scope.siteStore.recordPublish(site.id, { publishedId: changed.id, url: changed.url, scope: changed.share.scope, inherit: changed.share.inherit });
    return changed;
  });
  bind("site-unpublish", async (id) => {
    const site = scope.siteStore.get(id);
    if (!site.publishedId) return null;
    const choice = await confirmInApp({ type: "warning", title: "确认取消发布",
      message: `「${site.name}」的链接将立刻失效`,
      detail: `${site.url ?? ""}\n\n别人立刻打不开了，已经打开的页面刷新后也打不开。\n`
        + "服务端上的这个版本和它的数据会保留，随时可以「重新发布」，不用再传一次。\n"
        + "已经被别人下载或截图的内容收不回来。",
      buttons: ["取消", "取消发布"], defaultId: 0, cancelId: 0, destructive: true });
    if (choice.response !== 1) return null;
    await siteRequest("/v1/sites/withdraw", { siteId: site.publishedId });
    await scope.siteStore.recordPublish(site.id, { publishedId: site.publishedId, url: site.url, scope: site.publishedScope, inherit: site.publishedInherit, offline: true });
    return { withdrawn: true, kept: true };
  });
  bind("site-forget", async (id) => {
    const site = scope.siteStore.get(id);
    const choice = await confirmInApp({ type: "warning", title: "确认移出列表",
      message: `把「${site.name}」从文档网站列表里移出`,
      detail: `目录：${site.folder}\n\n只从列表里移出，目录和里面的文件都保留；已经发布出去的内容不会被收回。`,
      buttons: ["取消", "移出列表"], defaultId: 0, cancelId: 0, destructive: true });
    if (choice.response !== 1) return null;
    await scope.siteStore.forget(id);
    return { forgotten: true };
  });
  // What /review can be pointed at: the other branches and the latest commits.
  bind("review-targets", ({ taskId, workspaceId } = {}) => reviewTargets(projectFolder({ taskId, workspaceId })), "read");
  bind("permission-modes", () => listPermissions().map(({ id, label, summary }) => ({ id, label, summary })));
  // Choosing 完全访问 from this menu is the person's authorization for the one
  // task: its line in the menu says what it covers (modes.js), and from then on
  // what the Agent does outward runs without a card (permissions.js).
  bind("set-task-permission", (id, permission) => scope.service.setPermission(id, permission));
  bind("set-task-knowledge-scope", (id, value) => scope.service.setKnowledgeScope(id, value));
  bind("create-task", async ({ mode, workspaceId, fromTaskId, permission } = {}) => {
    if (workspaceId && fromTaskId) throw new Error("新任务目录来源无效");
    let cwd = workspaces.get(workspaceId);
    if (fromTaskId) {
      const source = scope.service.get(fromTaskId);
      if (mode !== "coding" || source.mode !== "coding") throw new Error("只能从编程任务继承项目目录");
      cwd = source.cwd;
    }
    if (!cwd && mode === "cowork" && !workspaceId) {
      cwd = await newWorkTaskFolder();
    }
    if (!cwd) throw new Error("请先选择工作目录");
    // Enabling a skill in 技能中心 is what binds it; a task records the exact
    // version and digest it was created with, so a later edit to the skill can
    // never silently change an existing conversation.
    //
    // A skill only binds to the kinds of task it was enabled for. Without this
    // an enabled 周报摘要助手 attached itself to coding tasks too and answered
    // as that skill instead of writing code -- two live "write a game" tasks
    // produced no files at all. Within its own kind of task it is only offered
    // (task-service.js): the model sees its name and description among the
    // skills it may open, and opens it for a request it describes, so an
    // unrelated message gets a plain answer.
    const enabled = await scope.localSkills.enabled(mode);
    return scope.service.create({ mode, cwd, ...(permission ? { permission } : {}),
      ...(enabled ? { enterpriseSkill: { id: enabled.id, version: enabled.version, digest: enabled.digest, title: enabled.title } } : {}) });
  });
  const prepareTurnInput = async (id, text, context, options, { queueing = false } = {}) => {
    if (!queueing && (scope.documentEdits.active.has(id) || scope.sheetEdits.active.has(id) || scope.baseEdits.active.has(id) || scope.documentDelivery.active.has(id))) throw new Error("文档操作仍在处理，请等待结果后再发送");
    if (["feishu-document", "feishu-sheet", "feishu-base"].includes(context?.kind)) businessAccess();
    // Which page the person is standing beside is the renderer's to say; what
    // that page is, and whether the Agent may have its chat id, is not. Both are
    // read here from what the page itself reported and what this process
    // decided about it.
    const { dock, images, ...rest } = options && typeof options === "object" ? options : {};
    // Images pasted with the message come as the images themselves; this
    // process decides where they are kept (pasted-images.js).
    if (images !== undefined) {
      await scope.serverModel.current(); await scope.serverModel.settled({ fresh: true });
      const models = scope.serverModel.options(), selected = models.available?.find(model => model.slug === models.current);
      if (images.length && selected?.images === false) throw new Error(`当前模型 ${selected.label || selected.slug} 不支持图片；图片和文字都未发送`);
      rest.images = await savePastedImages(imageFolder(scope.root, scope.service.get(id).id), images);
    }
    const said = dock === "messenger" ? messengerDockContext(await dockedChatState())
      : dock === "drive" ? documentDockText("drive") : "";
    return { text: typeof text === "string" && said ? `${text}\n\n${said}` : text, context, options: rest };
  };
  bind("send", async (id, text, context, options) => {
    const prepared = await prepareTurnInput(id, text, context, options);
    return scope.service.send(id, prepared.text, prepared.context, prepared.options);
  });
  bind("enqueue-task-message", async (id, request = {}) => {
    if (typeof request.clientRequestId !== "string") throw new Error("下一轮请求身份无效");
    // An in-flight office action is exactly when a person needs the next-turn
    // queue. Enqueue only freezes the intent; canDispatchQueued and the task's
    // write receipts still gate the later send.
    const prepared = await prepareTurnInput(id, request.text, request.context, request.options, { queueing: true });
    return scope.service.enqueue(id, { clientRequestId: request.clientRequestId, ...prepared });
  });
  bind("update-queued-message", (id, queueId, expectedRevision, value) => scope.service.updateQueued(id, queueId, expectedRevision, value));
  bind("remove-queued-message", (id, queueId, expectedRevision) => scope.service.removeQueued(id, queueId, expectedRevision));
  bind("set-task-queue-paused", (id, paused) => scope.service.setQueuePaused(id, paused));
  bind("stop", (id) => scope.service.stop(id));
  bind("terminal-open", (taskId, size) => scope.terminals.open(taskId, size));
  bind("terminal-reopen", (taskId, terminalId, size) => scope.terminals.reopen(taskId, terminalId, size));
  bind("terminal-write", (taskId, terminalId, data) => scope.terminals.write(taskId, terminalId, data));
  bind("terminal-resize", (taskId, terminalId, size) => scope.terminals.resize(taskId, terminalId, size));
  bind("terminal-close", async (taskId, terminalId) => {
    const terminal = scope.terminals.inspect(taskId, terminalId);
    if (terminal.state !== "running") return scope.terminals.close(taskId, terminalId);
    const task = scope.service.get(taskId);
    const choice = await confirmInApp({ type: "warning", title: "关闭任务终端", taskId,
      message: `结束「${task.title}」的终端会话`,
      detail: "终端前台正在运行的命令也会结束。任务文件不会删除，Agent 的执行状态和权限不会改变。",
      buttons: ["继续使用", "结束终端"], defaultId: 0, cancelId: 0 });
    if (choice.response !== 1) return null;
    return scope.terminals.close(taskId, terminalId);
  });
  // 开始做. Ends the read-only planning stage and sends the turn that builds.
  bind("start-building", (id) => scope.service.startBuilding(id));
  // Adding to a turn that is already running rather than stopping it and losing
  // what it has done.
  bind("steer", (id, text) => scope.service.steer(id, text));
  bind("rename-task", (id, title) => scope.service.rename(id, title));
  bind("delete-task", async (id) => {
    const task = scope.service.get(id);
    const choice = await confirmInApp({ type: "warning", title: "确认删除任务", taskId: id,
      message: `删除「${task.title}」这段对话`,
      detail: `工作目录 ${task.cwd} 不会被删除：里面是你放进去的文件和已经产出的结果。\n删除的只是这段对话记录，删掉之后无法恢复。`,
      buttons: ["取消", "删除对话"], defaultId: 0, cancelId: 0 });
    if (choice.response !== 1) return null;
    scope.previews.close(id);
    scope.terminals.closeTask(id);
    const removed = await scope.service.remove(id);
    await scope.taskUi.remove(id);
    await removePastedImages(imageFolder(scope.root, task.id)).catch(() => {});
    return removed;
  });
  // A pasted image, for the conversation to show: only one of this task's own.
  bind("task-image", (taskId, imageId) => {
    const task = scope.service.get(taskId);
    const image = task.messages.flatMap((message) => message.images ?? []).find((row) => row.id === imageId);
    if (!image) throw new Error("找不到这张图片");
    return readPastedImage(imageFolder(scope.root, task.id), image);
  }, "read");
  bind("compact-task", async (id) => {
    const choice = await confirmInApp({ type: "info", title: "确认压缩对话", taskId: id,
      message: "让模型把这段对话总结成更短的上下文",
      detail: "屏幕上的记录不会变；变的是下一次发送时模型看到的内容。对话很长时这样更省上下文，但被概括掉的细节模型就记不清了。",
      buttons: ["取消", "压缩"], defaultId: 0, cancelId: 0 });
    if (choice.response !== 1) return null;
    return scope.service.compact(id);
  });
  // Codex's /undo and Claude Code's rewind put the code back too. The files a
  // turn changed are named here, on the main process's card, before anything
  // is overwritten -- including changes the person made by hand since.
  bind("rollback-task", async (id, turns) => {
    const preview = await scope.service.undoPreview(id, turns).catch((error) => ({ restorable: false, reason: "error", error: error.message }));
    const files = preview.restorable ? preview.files : [];
    const named = files.slice(0, 12).map((file) => `  ${file.action === "remove" ? "删除" : "恢复"} ${file.path}`);
    const restoring = preview.restorable && files.length > 0;
    const choice = await confirmInApp({ type: "warning", title: "确认撤回", taskId: id,
      message: `撤回最近 ${turns} 轮`,
      detail: [
        "这几轮的问答会从对话里移除，模型也不再记得它们。",
        restoring ? `工作目录里的文件会恢复到这几轮之前（${files.length} 个文件）：` : preview.restorable ? "这几轮之后工作目录里的文件没有变化。"
          : preview.reason === "work" ? "工作任务只撤回对话；本地成果、飞书修改、已发送消息和已经发生的媒体生成都不会撤销。"
            : preview.reason === "error" ? `无法确定要恢复哪些文件（${preview.error}），文件不会跟着还原。`
              : "这几轮之前没有文件快照（目录太大，或快照没拍成），文件不会跟着还原。",
        ...named, ...(files.length > 12 ? [`  …还有 ${files.length - 12} 个`] : []),
        ...(restoring ? ["注意：这之后你手动改过的这些文件，也会一起恢复。选「只撤回对话」则文件保持现在的样子。"] : []),
      ].join("\n"),
      // As in Claude Code's rewind: the conversation alone, or with the files.
      buttons: restoring ? ["取消", "只撤回对话", "撤回并恢复文件"] : ["取消", "撤回"], defaultId: 0, cancelId: 0, destructive: restoring });
    if (choice.response !== 1 && !(restoring && choice.response === 2)) return null;
    return scope.service.rollback(id, turns, { restoreFiles: restoring && choice.response === 2 });
  });
  bind("approve", (id, decision) => scope.service.approve(id, decision));
  bind("answer", (id, answers) => scope.service.answer(id, answers));
  // Attaching a file to a task is copying it into the task's folder. Nothing is
  // uploaded, and the original on disk is never touched.
  bind("task-files", (id) => listTaskFiles(scope.service.get(id).cwd));
  bind("attach-task-files", async (id) => {
    const cwd = scope.service.get(id).cwd;
    const selected = await dialog.showOpenDialog(win, { title: "选择要交给这个任务的文件",
      properties: ["openFile", "multiSelections"], buttonLabel: "添加到任务" });
    if (selected.canceled || !selected.filePaths?.length) return listTaskFiles(cwd);
    await attachFiles(cwd, selected.filePaths);
    return listTaskFiles(cwd);
  });
  bind("remove-task-file", async (id, name) => {
    const cwd = scope.service.get(id).cwd;
    const choice = await confirmInApp({ type: "warning", title: "确认从任务中删除", taskId: id,
      message: `删除「${String(name ?? "").slice(0, 80)}」`,
      detail: "这个文件会从任务文件夹里删掉，自动生成的读取版副本也一起删。放进来之前的原始文件不受影响。",
      buttons: ["取消", "删除"], defaultId: 0, cancelId: 0 });
    if (choice.response !== 1) return listTaskFiles(cwd);
    return removeTaskFile(cwd, name);
  });
  // Sending one finished file to Feishu Drive. Same chain as a generated image:
  // the folder is resolved and re-checked, the bytes are charged against the
  // tenant quota, and the CLI runs under a single-use grant bound to this exact
  // folder, name, length and content. Nothing leaves the machine before the
  // person has read all four in the confirmation.
  bind("upload-to-drive", async ({ folderUrl } = {}) => {
    const current = scope;
    const selected = await dialog.showOpenDialog(win, { title: "选择要上传到飞书云盘的文件", properties: ["openFile"],
      filters: [{ name: "可上传的文件", extensions: uploadableTypes() }] });
    if (selected.canceled || !selected.filePaths?.[0]) return null;
    const draft = await current.fileDelivery.prepare(selected.filePaths[0], folderUrl);
    if (scope !== current) throw new Error("账号已切换，未上传");
    const megabytes = (draft.byteLength / 1048576).toFixed(1);
    const choice = await confirmInApp({ type: "warning", title: "确认上传到飞书云盘",
      message: `把「${draft.originalName}」上传到云盘文件夹「${draft.folder.title}」`,
      detail: `大小：${megabytes} MB\n云盘上的文件名：${draft.name}\n内容摘要：${draft.sha256.slice(0, 16)}…\n目标文件夹：${draft.folder.url}\n\n`
        + `这是一次真实的对外写入，会占用企业云盘配额（本次上传后剩余约 ${Math.max(0, Math.floor((draft.policy.remainingBytes - draft.byteLength) / 1048576))} MB）。\n`
        + "服务端会为这一次上传签发绑定以上目标与内容的一次性许可，用后即失效；只新建文件，不覆盖同名文件。",
      buttons: ["取消", "上传"], defaultId: 0, cancelId: 0 });
    if (choice.response !== 1) return null;
    if (scope !== current) throw new Error("账号已切换，未上传");
    return current.fileDelivery.send(draft);
  });
  // Only a Feishu Drive file link, parsed by the same reference validator the
  // upload used, ever reaches the operating system's URL handler.
  bind("open-drive-file", async (url) => {
    const link = feishuProvider.references.driveFile(String(url ?? ""));
    await shell.openExternal(link.url);
    return { opened: true };
  });
  // A link someone clicked in an Agent reply. Only an https address without
  // credentials in it reaches the system browser; the renderer never navigates.
  bind("open-external-link", async (url) => {
    let target; try { target = new URL(String(url ?? "")); } catch { throw new Error("链接地址无效"); }
    if (target.protocol !== "https:" || target.username || target.password || !target.hostname) throw new Error("只能在浏览器里打开 https 链接");
    // A report link a server wrote before 2026-09-29 opens the file it names.
    await shell.openExternal(feishuProvider.repairedLink(target.href));
    return { opened: true };
  });
  bind("reveal-task-folder", async (id) => {
    const cwd = scope.service.get(id).cwd, failure = await shell.openPath(cwd);
    if (failure) throw new Error(`系统未能打开任务文件夹：${String(failure).slice(0, 200)}`);
    return cwd;
  });
  bind("list-files", (id, relative) => listWorkspaceFiles(scope.service.get(id).cwd, relative));
  bind("read-file", async (id, relative) => {
    const task = scope.service.get(id), file = await inspectWorkspaceFile(task.cwd, relative);
    if (file.kind !== "office" || relative.includes("/")) return file;
    const row = (await listTaskFiles(task.cwd)).find(item => item.name === relative);
    return { ...file, ...(row?.readableCopy ? { readableCopy: row.readableCopy } : {}) };
  });
  bind("open-task-file", ({ taskId, path: relative, action } = {}) => openWorkspaceItem(scope.service.get(taskId).cwd, relative, action, shell));
  bind("list-media", (id) => scope.media.list(id));
  // Confirmations belong beside the work they are about, in the same place as
  // command approvals, rather than in an operating-system alert thrown over the
  // window. Only this process can raise one, only one is outstanding at a time,
  // and anything that ends the conversation — the view going away, a reload, a
  // long silence — resolves it as the cancelling answer, never as consent.
  let confirmSeq = 0, pendingConfirm = null;
  const configuredConfirmTimeout = !app.isPackaged ? Number(process.env.IDOU_CONFIRM_TIMEOUT_MS) : NaN;
  const CONFIRM_TIMEOUT_MS = Number.isFinite(configuredConfirmTimeout) && configuredConfirmTimeout >= 50
    ? Math.min(configuredConfirmTimeout, 5 * 60_000) : 5 * 60_000;
  // `reason` says why a confirmation ended. Anything but a person's answer --
  // the five-minute timeout, the Agent that asked going away, the window going
  // away -- also takes the card off the screen. It used to stay there, dead:
  // clicking it did nothing, and the person was left believing they had
  // confirmed something that was never going to happen.
  // Set once the notification preferences are read, further down; a card
  // raised before then is simply not announced (confirmation-notice.js).
  let announceConfirmation = () => null;
  const settleConfirm = (response, reason = "answered") => {
    const current = pendingConfirm; pendingConfirm = null;
    if (!current) return;
    clearTimeout(current.timer); current.detach?.();
    // Answered, lapsed or withdrawn, the announcement goes with it.
    try { current.announcement?.close(); } catch { /* already gone */ }
    if (reason !== "answered" && !win.webContents.isDestroyed()) win.webContents.send("idou:confirm-withdrawn", { id: current.id, reason });
    // `destructive: true` is the only thing that can approve a deletion
    // (approveDeletion), and it is set in exactly one case: this card was drawn
    // as a deletion and the person clicked its confirming button.
    const approvedDeletion = current.destructive === true && reason === "answered" && response !== current.cancelId;
    current.resolve({ response, reason, ...(approvedDeletion ? { destructive: true } : {}) });
  };
  // `detail` is the specifics of this one operation and can be arbitrarily long,
  // so it scrolls. `boundary` is the fixed statement of what the confirmation
  // authorises; it must stay visible no matter how much content is above it.
  const confirmInApp = ({ title, message, detail = "", technical = "", boundary = "", buttons, defaultId = 0, cancelId = 0, destructive = false,
    taskId = null, turnKey = null, itemId = null, actionId = null }) => {
    if (win.webContents.isDestroyed() || quitting) return Promise.resolve({ response: cancelId });
    if (pendingConfirm) return Promise.reject(new Error("请先回应当前的确认"));
    const id = `confirm-${++confirmSeq}`;
    // A confirmation raised on the Agent's behalf lives only as long as the
    // Agent's request does: once it has gone, nobody is waiting for the answer.
    const context = agentRequestContext.getStore(), signal = context?.signal;
    if (signal?.aborted) return Promise.resolve({ response: cancelId, reason: "withdrawn" });
    const relatedTaskId = typeof taskId === "string" && taskId ? taskId : typeof context?.taskId === "string" ? context.taskId : null;
    let relatedTurnKey = typeof turnKey === "string" && turnKey ? turnKey : null;
    if (relatedTaskId && !relatedTurnKey) {
      try { relatedTurnKey = scope.service.get(relatedTaskId).messages.findLast((row) => row.role === "user" && !row.steered)?.id ?? null; } catch {}
    }
    const relatedActionId = typeof actionId === "string" && actionId ? actionId : typeof context?.actionId === "string" ? context.actionId : null;
    const issuedAt = Date.now(), expiresAt = issuedAt + CONFIRM_TIMEOUT_MS;
    return new Promise((resolve) => {
      const timer = setTimeout(() => settleConfirm(cancelId, "timeout"), CONFIRM_TIMEOUT_MS);
      timer.unref?.();
      const onAbort = () => { if (pendingConfirm?.id === id) settleConfirm(cancelId, "withdrawn"); };
      signal?.addEventListener("abort", onAbort, { once: true });
      pendingConfirm = { id, resolve, cancelId, timer, destructive: destructive === true, buttonCount: Array.isArray(buttons) ? buttons.length : 0,
        scopeEpoch, detach: () => signal?.removeEventListener("abort", onAbort) };
      win.webContents.send("idou:confirm", { id, title, message, detail, technical, boundary, buttons, defaultId, cancelId, danger: destructive === true,
        issuedAt, expiresAt, ...(relatedTaskId ? { taskId: relatedTaskId } : {}), ...(relatedTurnKey ? { turnKey: relatedTurnKey } : {}),
        ...(typeof itemId === "string" && itemId ? { itemId } : {}), ...(relatedActionId ? { actionId: relatedActionId } : {}) });
      try { pendingConfirm.announcement = announceConfirmation({ title, validForMs: CONFIRM_TIMEOUT_MS, taskId: relatedTaskId }); } catch { /* the card itself is up */ }
    });
  };
  // Document editor actions originate in a concrete task, so their write
  // policy follows that task instead of a global application preference. Full
  // access skips the extra card; all target/content-bound provider checks still
  // run. A send the person starts from the page keeps its card: it is their own
  // review of who receives what, not a question the Agent is waiting on.
  const confirmDocumentWrite = (taskId, request) => {
    const task = scope.service.get(taskId);
    if (permitsUnattendedActions(task)) {
      return Promise.resolve({ response: 1, reason: "full-access", ...(request.destructive === true ? { destructive: true } : {}) });
    }
    return confirmInApp({ ...request, taskId });
  };
  // Started once the confirmation channel exists, because every action it
  // exposes can end in a confirmation. A failure here leaves the application
  // fully usable and only costs the Agent its Feishu write route.
  // One channel for everything the Agent does outside its sandbox: Feishu
  // writes and media generation both end in the same in-app confirmation --
  // or, from a task on 完全访问, in none (permissions.js).
  agentBridge = new AgentBridge({ actions: { ...agentFeishuActions({ getScope: () => scope, confirm: confirmInApp }),
    ...agentKnowledgeActions({ getScope: () => scope, businessAccess: () => businessAccess() }),
    ...agentMediaActions({ getScope: () => scope, confirm: confirmInApp, openPreview: (taskId, id) => openMediaPreview(taskId, id),
      changed: (taskId) => { if (!win.webContents.isDestroyed()) win.webContents.send("idou:media-changed", { taskId }); } }),
    ...agentDeliveryActions({ getScope: () => scope, confirm: confirmInApp }),
    // 定时任务 from a conversation (G5). The client, the removal card and the
    // draft channel are set up further down; these reach them when an Agent
    // asks, which is after start() has finished -- and if one ever asked
    // sooner, it would be told scheduled tasks are not available yet.
    ...agentScheduleActions({ getSchedules: () => { try { return schedules; } catch { return null; } }, confirm: confirmInApp,
      confirmRemoval: (ids) => confirmScheduleRemoval(ids), openDraft: (draft) => openScheduleDraft(draft),
      unattended: (taskId) => permitsUnattendedActions(scope.service.get(taskId)),
      changed: () => { if (!win.webContents.isDestroyed()) win.webContents.send("idou:schedules-changed"); } }),
    ...agentSkillActions({ getScope: () => scope, confirm: confirmInApp }) },
    // Searching the knowledge copy changes nothing, so a task may search while
    // another search -- or a write awaiting its card -- is still out.
    readOnly: [...AGENT_READS] });
  try { await agentBridge.start(); }
  catch (error) {
    agentBridge = null;
    process.stderr.write(`idou-desktop: Agent 飞书写入通道未启动（${String(error?.message ?? error).slice(0, 120)}）\n`);
  }

  bind("confirm-response", ({ id, response } = {}) => {
    if (!pendingConfirm || pendingConfirm.id !== id) return { accepted: false };
    if (pendingConfirm.scopeEpoch !== scopeEpoch) {
      settleConfirm(pendingConfirm.cancelId, "account-changed"); return { accepted: false };
    }
    const index = Number(response);
    // Renderer input is untrusted. An index outside the exact offered buttons
    // cancels and is reported rejected; for a destructive card it must never
    // become a non-cancel response merely because it differs from cancelId.
    if (!Number.isInteger(index) || index < 0 || index >= pendingConfirm.buttonCount) {
      settleConfirm(pendingConfirm.cancelId); return { accepted: false };
    }
    settleConfirm(index);
    return { accepted: true };
  });
  win.webContents.on("render-process-gone", () => settleConfirm(pendingConfirm?.cancelId ?? 0, "withdrawn"));
  bind("create-media", async (id, input) => {
    const current = scope, request = mediaInput(input), draft = await current.media.prepare(id, request), shown = describeMedia(request, draft.lease.offer);
    const choice = await confirmInApp({ type: "warning", title: "确认媒体生成", taskId: id, message: shown.message,
      detail: `${shown.model}\n服务端：${draft.session.serverUrl}\n\n${request.prompt}\n\n描述将发送给企业服务端及${shown.provider}，可能产生模型费用。取消或断线不保证停止上游计费。成果目前为临时预览，尚未保存到飞书云盘。`, buttons: ["取消", "确认生成"], defaultId: 0, cancelId: 0 });
    if (choice.response !== 1) return null;
    if (scope !== current || quitting) throw new Error("应用状态已变化，未提交生成");
    return current.media.create(draft);
  });
  bind("refresh-media", (taskId, id) => scope.media.refresh(taskId, id));
  bind("cancel-media", async (taskId, id) => {
    const choice = await confirmInApp({ type: "warning", title: "停止此媒体任务", taskId, message: "停止等待并丢弃临时成果？", detail: "不会删除飞书文档；上游生成可能继续执行和计费。", buttons: ["返回", "停止并丢弃"], defaultId: 0, cancelId: 0 });
    return choice.response === 1 ? scope.media.refresh(taskId, id, true) : null;
  });
  const openMediaPreview = async (taskId, id) => {
    const current = scope, result = await current.media.result(taskId, id);
    await mediaPreview.open(result, async () => { if (scope !== current || quitting) throw new Error("账号或应用状态变化"); await current.media.unchanged(result.session); });
    // The view is a native layer the renderer positions, so it has to be told
    // to make room for it.
    if (!win.webContents.isDestroyed()) win.webContents.send("idou:media-preview", { taskId });
    return { opened: true };
  };
  bind("preview-media", (taskId, id) => openMediaPreview(taskId, id));
  bind("save-media-drive", async (taskId, id, reference) => {
    businessAccess(); const current = scope, draft = await current.mediaDelivery.prepare(taskId, id, reference);
    const choice = await confirmInApp({ type: "warning", title: "确认保存到飞书云盘", message: `保存到「${draft.folder.title}」`,
      detail: `文件夹：${draft.folder.url}\nCLI 企业：${draft.folder.identity.tenantKey}\n账号指纹：${draft.folder.identity.principal.slice(0, 12)}\n文件：${draft.name}\n大小：${draft.bytes.length} 字节\nSHA-256：${draft.sha256}\n托管上传预算：${draft.policy.maxBytes} 字节\n当前剩余：${draft.policy.remainingBytes} 字节（上传前原子预留）\n\n以当前 CLI 用户身份新建文件，不覆盖、不修改权限。文件夹的协作者可能看到此成果；请确认保存范围。预算由服务端管理，只约束本应用托管上传，不代表飞书总容量。结果未知时保留额度，不自动重传。`, buttons: ["取消", "确认上传"], defaultId: 0, cancelId: 0 });
    if (choice.response !== 1) return null;
    if (scope !== current || quitting) throw new Error("应用状态变化，未上传");
    return current.mediaDelivery.save(draft);
  });
  bind("open-media-drive", async (taskId, id) => { businessAccess(); const receipt = await scope.mediaDelivery.verify(taskId, id); await shell.openExternal(receipt.url); return { opened: true }; });
  bind("check-media-drive-folder", async (taskId, id) => { businessAccess(); const url = await scope.mediaDelivery.folder(taskId, id); await shell.openExternal(url); return { opened: true }; });
  bind("document-connection", () => scope.feishu.documentConnection());
  bind("list-chats", next => scope.chatReader.list(next));
  bind("read-chat", (handle, next) => scope.chatReader.read(handle, next));
  bind("resolve-chat-document", handle => scope.chatReader.document(handle));
  bind("close-chat-reader", () => scope.chatReader.close());
  bind("reply-chat-message", (handle, text, inThread) => { scope.messageWriteAccess(); return scope.chatReply.send(handle, text, inThread, async draft => {
    const clean = value => value.replace(/[\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, " ");
    const choice = await confirmInApp({ type: "warning", title: "确认发送飞书回复", message: `回复「${draft.chat.name}」中的消息？`,
      detail: `会话属性：${draft.chat.external === false ? "列表显示为内部会话" : draft.chat.external === true ? "外部会话" : "外部属性未知"}（名称与属性为阅读时快照）\n发送身份：当前 CLI 用户（非机器人）\n目标消息：${draft.message.id}\n原发送者：${draft.message.sender} (${draft.message.senderId})\n原文摘要：${clean(draft.message.text).slice(0, 800)}${draft.message.text.length > 800 ? "…（摘要截断）" : ""}\n\n位置：${draft.inThread ? "话题内回复" : "主会话引用回复"}\n回复全文：\n${draft.text}\n\n回复对该会话有权限的成员可见，不是仅发给原发送者。纯文本，不执行卡片、不自动 @ 人、不修改文档权限。回执未知时不自动重发。`,
      // Identifiers are for checking, folded away from what a person reads, shares and records.
      technical: `会话 ID：${draft.chat.id}\nCLI 租户：${draft.identity.tenantKey}\n账号指纹：${draft.identity.principal.slice(0, 12)}`,
      buttons: ["取消", "确认发送回复"], defaultId: 0, cancelId: 0 });
    return choice.response === 1 && !quitting && !switching;
  }); });
  bind("discovery-status", () => { businessAccess(); return scope.discovery.status(); });
  bind("stop-discovery", () => scope.discovery.stop());
  bind("watch-knowledge-chat", handle => { const current = scope; return current.discovery.add(handle, async draft => {
    // Synthesis already on names the model it was agreed for; otherwise the one
    // in force, and with none confirmed the consent says so rather than name one.
    const agreed = current.wiki.status().synthesis.model, known = agreed ? { model: agreed } : await current.serverModel.current();
    const synthesisScope = known.model ? `若已开启自动模型归纳，后续文档正文可经当前服务端发送给 ${chatModelLabel(known.model)} · ${chatModelVendor(known.model)}，沿用其次数、来源核验与费用限制。`
      : `${MODEL_UNCONFIRMED}：${modelProblem(known)}。确认前不能开启自动模型归纳，文档正文不会发送给任何模型。`;
    const choice = await confirmInApp({ type: "warning", title: "确认自动整理范围", message: `自动整理「${draft.chat.name}」中的文档？`,
      technical: `会话：${draft.chat.id}\nCLI 租户：${draft.identity.tenantKey}\n账号指纹：${draft.identity.principal.slice(0, 12)}`,
      detail: `本次启动最多 5 个选定会话；每轮检查最近 24 小时消息及其已展开话题回复，最多 3 页/会话、5 篇文档。每轮结束约 2 分钟后继续，最多运行 8 小时。离开消息页面仍继续；在企业知识库中可停止，退出、页面重载或切换账号时停止。\n\n会自动读取文档正文并加密整理到本机 Wiki，不保存聊天正文、不下载附件、不发送消息、不修改飞书原文或权限、不上传云盘。局部链接不扩大为全文。${synthesisScope}\n\n只代表本次开发会话的范围确认，不替代企业管理员的数据策略。`, buttons: ["取消", "开启自动整理"], defaultId: 0, cancelId: 0 });
    return choice.response === 1 && !quitting && !switching;
  }); });
  bind("knowledge-status", () => { businessAccess(); return scope.wiki.status(); });
  // Seeing and managing what is stored. The listing makes no network call and
  // returns no excerpt text; removing takes only this machine's copy.
  bind("knowledge-list", () => { businessAccess(); return scope.wiki.inventory(); });
  bind("knowledge-remove", (id) => { businessAccess(); return scope.wiki.forget(id); });
  bind("knowledge-publication-status", () => scope.wikiPublication.status());
  bind("knowledge-reception-status", () => scope.wikiReception.status());
  bind("start-knowledge-reception", () => scope.wikiReception.start());
  bind("stop-knowledge-reception", () => scope.wikiReception.stop());
  bind("start-knowledge-publication", () => scope.wikiPublication.start());
  bind("stop-knowledge-publication", () => scope.wikiPublication.stop());
  bind("knowledge-node-status", () => scope.wikiCoordinator.status());
  // The person's own search box wants a readable list of documents, not the
  // dozen passages a model is happy to read: one or two excerpts per document.
  bind("search-knowledge", (query) => { businessAccess(); return scope.wiki.search(query, { perDocument: 2, maxRows: 12, maxChars: 8000 }); });
  // Adding a source on purpose, instead of only as a side effect of having read
  // one in a task. The link decides which reader answers for it — a document, a
  // worksheet or a Base table — and each reads under this login's own
  // permission, so nothing can be added that the person cannot open themselves.
  bind("add-knowledge", async (link) => {
    businessAccess();
    if (typeof link !== "string" || !link.trim() || link.length > 2048) throw new Error("请粘贴一个完整的飞书链接。");
    const source = await scope.knowledgeSources.readDocument(link.trim());
    const kept = await scope.wiki.observe(source);
    if (!kept) throw new Error(scope.wiki.status().message || "这个来源没有被保留。");
    return { title: source.title, kind: source.kind ?? "feishu-document", sourceUrl: source.sourceUrl, warnings: source.warnings ?? [] };
  });
  bind("knowledge-graph", () => { businessAccess(); return scope.wiki.graph(); });
  bind("knowledge-graph-snapshot", () => { businessAccess(); return scope.wiki.graphSnapshot(); });
  // Switching on carries the model the consent on screen named: the server can
  // move between that page's last look and the click, and content must never go
  // to a model other than the one the person read.
  bind("set-knowledge-synthesis", (enabled, model) => {
    if (typeof enabled !== "boolean" || (enabled && !isChatModel(model))) throw new Error("Invalid synthesis setting");
    businessAccess(); return enabled ? scope.wiki.enableSynthesis({ model }) : scope.wiki.disableSynthesis();
  });
  // Which Feishu deployment this is and what it cannot do, with the reasons, so
  // the interface can say so before anyone tries.
  bind("feishu-deployment", () => feishuProvider.describe(), true);
  bind("search-documents", (id, query, kind, pageToken) => { businessAccess(); return scope.documents.search(id, query, kind, pageToken ?? null); });
  bind("open-document", (id, reference) => {
    businessAccess(); scope.sheets.close(id); scope.bases.close(id);
    try { void rememberFeishuOrigin(feishuProvider.references.document(reference).url); } catch { /* the reader reports an unusable link */ }
    return scope.documents.open(id, reference);
  });
  bind("close-document", (id) => { scope.service.get(id); scope.documents.close(id); });
  bind("open-sheet", (id, reference, options) => { businessAccess(); scope.documents.close(id); scope.bases.close(id); return scope.sheets.open(id, reference, options); });
  bind("close-sheet", id => { scope.service.get(id); scope.sheets.close(id); });
  bind("open-base", (id, reference, options) => { businessAccess(); scope.documents.close(id); scope.sheets.close(id); return scope.bases.open(id, reference, options); });
  bind("close-base", id => { scope.service.get(id); scope.bases.close(id); });
  // The people and groups offered when someone types @ in the composer. A
  // read of the signed-in person's own directory through the same lookup a
  // send uses; only what is shown to pick from comes back -- names, department
  // and email, never an id -- because the pick guides the Agent and the send
  // resolves the recipient again through its own handles.
  bind("search-people", async (query) => {
    businessAccess();
    const text = typeof query === "string" ? query.trim() : "";
    if (!text || [...text].length > 50 || /[\n\t]/.test(text)) return { users: [], groups: [] };
    const current = scope;
    const [users, groups] = await Promise.allSettled([current.feishu.messages.search(text), current.feishu.messages.searchGroups(text)]);
    if (users.status === "rejected" && groups.status === "rejected") throw users.reason;
    if (scope !== current) throw new Error("账号已切换，请重新搜索");
    return {
      users: users.status === "fulfilled" ? users.value.users.slice(0, 8).map(({ name, department, email }) => ({ name, department, email })) : [],
      groups: groups.status === "fulfilled" ? groups.value.groups.slice(0, 5).map(({ name, memberCount }) => ({ name, ...(Number.isSafeInteger(memberCount) ? { memberCount } : {}) })) : [],
    };
  });
  bind("search-document-recipients", (id, handle, query, kind) => scope.documentDelivery.search(id, handle, query, kind));
  bind("document-recipient-members", (id, handle, recipient) => scope.documentDelivery.members(id, handle, recipient));
  bind("prepare-document-delivery", (id, handle, recipient, note, mentions) => { scope.messageWriteAccess(); return scope.documentDelivery.prepare(id, handle, recipient, note, mentions); });
  bind("discard-document-delivery", (id) => { scope.service.get(id); scope.documentDelivery.discard(id); });
  bind("send-document-delivery", async (id, previewId) => {
    scope.messageWriteAccess(); const current = scope;
    return current.documentDelivery.send(id, previewId, async draft => {
      const shown = deliveryConfirmation(draft);
      const choice = await confirmInApp({ type: "warning", title: shown.title, taskId: id, message: shown.message,
        detail: shown.detail, technical: shown.technical, boundary: shown.boundary, buttons: ["取消", shown.verb], defaultId: 0, cancelId: 0 });
      if (scope !== current || quitting) throw new Error("账号或应用状态已变化，未发送");
      return choice.response === 1;
    });
  });
  bind("apply-document-edit", async (id, messageId) => {
    if (scope.documentDelivery.active.has(id)) throw new Error("文档消息正在发送，请等待结果后再修改");
    if (scope.sheetEdits.active.has(id) || scope.baseEdits.active.has(id)) throw new Error("表格写入仍在执行，请等待结果后再修改文档");
    scope.documentWriteAccess(); const current = scope, draft = await current.documentEdits.prepare(id, messageId);
    const choice = await confirmDocumentWrite(id, { type: "warning", title: "确认修改飞书文档", message: `修改「${draft.title}」的一处文字？`,
      detail: `文档：${draft.sourceUrl}\n读到的版本：${draft.revision}\n\n原文：\n${draft.pattern}\n\n替换为：\n${draft.replacement || "（删除这段文字）"}`,
      boundary: "以当前飞书 CLI 用户身份写入原文档，不创建副本；其他协作者可以看到修改。本次确认只授权这一处修改：服务端据此签发一次性写入许可，绑定该文档、该版本和上面这段文字，用后立即失效。写入前会再读一次全文核对，期间被别人改动就会中止，不会落笔。结果不确定时不会自动重试或回滚。",
      buttons: ["取消", "确认修改原文档"], defaultId: 0, cancelId: 0 });
    if (choice.response !== 1) return null;
    if (scope !== current || quitting) throw new Error("账号或应用状态已变化，未修改文档");
    if (current.documentDelivery.active.has(id)) throw new Error("确认期间开始了消息发送，请等待结果后再修改文档");
    return current.documentEdits.apply(draft);
  });
  // Reviewed cell values written into the Feishu spreadsheet they were proposed
  // for, and undone. The card lists every cell with its type on both sides,
  // because a person approving "00123" -> "00456" needs to see it stays text.
  const sheetValue = value => value === null ? "空单元格" : `${typeof value === "string" ? "文本" : typeof value === "number" ? "数字" : "布尔"} ${JSON.stringify(value)}`;
  const sheetEditDetail = draft => `表格：${draft.title}（工作表 ${draft.sheetId}）\n链接：${draft.sourceUrl}\n写入范围：${draft.range}（只改下面这些格子，范围内其他格子保持原样）\n${draft.kind === "undo" ? "写入后的版本" : "建议基于的版本"}：${draft.revision}\n\n`
    + draft.changes.map(change => `${change.address}  ${sheetValue(change.before)}  →  ${sheetValue(change.after)}`).join("\n")
    + (retyped(draft).length ? `\n\n注意：${retyped(draft).join("、")} 的类型会改变。飞书按单元格格式存值，文本格式的格子写入数字后仍是文本；写入后会逐格读回，如实报告存下的值。` : "");
  const retyped = draft => draft.changes.filter(change => change.before !== null && change.after !== null && typeof change.before !== typeof change.after).map(change => change.address);
  const sheetEditIdle = (current, id) => {
    if (current.documentDelivery.active.has(id)) throw new Error("文档消息正在发送，请等待结果后再写入表格");
    if (current.documentEdits.active.has(id)) throw new Error("文档修改仍在执行，请等待结果后再写入表格");
    if (current.baseEdits.active.has(id)) throw new Error("多维表格写入仍在执行，请等待结果后再写入表格");
  };
  const SHEET_EDIT_BOUNDARY = "以当前飞书 CLI 用户身份直接写入原表，不创建副本；协作者可以看到修改。本次确认只授权这一次写入：服务端签发一次性许可，绑定这张表、这个范围和上面这些值，用后立即失效。写入前会重新读取这个范围，只要这些格子已经不是左边的值就中止，不会落笔；写入后逐格读回核对，版本号若不是恰好加一，会标记为期间有他人修改。结果不确定时不会自动重试。";
  bind("apply-sheet-edit", async (id, messageId) => {
    sheetEditIdle(scope, id); scope.documentWriteAccess(); const current = scope, draft = await current.sheetEdits.prepare(id, messageId);
    const choice = await confirmDocumentWrite(id, { type: "warning", title: "确认写入飞书表格", message: `把 ${draft.changes.length} 处修改写入「${draft.title}」？`,
      detail: sheetEditDetail(draft), boundary: `${SHEET_EDIT_BOUNDARY}写入核验通过后可以在这里撤销：只有这些格子仍是写入后的值时，才会写回原值。`,
      buttons: ["取消", "确认写入原表"], defaultId: 0, cancelId: 0 });
    if (choice.response !== 1) return null;
    if (scope !== current || quitting) throw new Error("账号或应用状态已变化，未写入表格");
    sheetEditIdle(current, id); return current.sheetEdits.apply(draft);
  });
  bind("undo-sheet-edit", async (id, messageId) => {
    sheetEditIdle(scope, id); scope.documentWriteAccess(); const current = scope, draft = await current.sheetEdits.prepareUndo(id, messageId);
    const choice = await confirmDocumentWrite(id, { type: "warning", title: "确认撤销表格写入", message: `把「${draft.title}」里的 ${draft.changes.length} 处改回写入前的值？`,
      detail: sheetEditDetail(draft), boundary: SHEET_EDIT_BOUNDARY, buttons: ["取消", "确认撤销"], defaultId: 0, cancelId: 0 });
    if (choice.response !== 1) return null;
    if (scope !== current || quitting) throw new Error("账号或应用状态已变化，未撤销");
    sheetEditIdle(current, id); return current.sheetEdits.apply(draft);
  });
  // Reviewed Base values written into the table they were proposed for, and
  // undone. Each change names the record, the field and both typed values, and
  // the boundary states what a Base cannot promise.
  const baseValue = value => value === null || value === undefined ? "空" : `${typeof value === "string" ? "文本" : "数字"} ${JSON.stringify(value)}`;
  const baseEditDetail = draft => `多维表格：${draft.title}（数据表 ${draft.tableId}）\n链接：${draft.sourceUrl}\n\n`
    + draft.changes.map(change => `${change.record}${change.label ? `（${change.label}）` : ""} ·「${change.field}」  ${baseValue(change.before)}  →  ${baseValue(change.after)}`).join("\n");
  const BASE_EDIT_BOUNDARY = "以当前飞书 CLI 用户身份直接写入原多维表格，不创建副本；协作者可以看到修改。本次确认只授权这一次写入：服务端签发一次性许可，绑定这张数据表和上面这些记录、字段与值，用后立即失效。写入前会重新读取这些记录，只要这些字段已经不是左边的值就中止，不会落笔；写入后逐条读回核对。多维表格没有可用的版本号：确认之后、写入之前那一两秒里，如果有人恰好改了同一个字段，这次写入会覆盖它，事后也无法发现。结果不确定时不会自动重试。";
  const baseEditIdle = (current, id) => {
    if (current.documentDelivery.active.has(id)) throw new Error("文档消息正在发送，请等待结果后再写入多维表格");
    if (current.documentEdits.active.has(id) || current.sheetEdits.active.has(id)) throw new Error("另一项写入仍在执行，请等待结果后再写入多维表格");
  };
  bind("apply-base-edit", async (id, messageId) => {
    baseEditIdle(scope, id); scope.documentWriteAccess(); const current = scope, draft = await current.baseEdits.prepare(id, messageId);
    const choice = await confirmDocumentWrite(id, { type: "warning", title: "确认写入飞书多维表格", message: `把 ${draft.changes.length} 处修改写入「${draft.title}」？`,
      detail: baseEditDetail(draft), boundary: `${BASE_EDIT_BOUNDARY}写入核验通过后可以在这里撤销：只有这些字段仍是写入后的值时，才会写回原值。`,
      buttons: ["取消", "确认写入多维表格"], defaultId: 0, cancelId: 0 });
    if (choice.response !== 1) return null;
    if (scope !== current || quitting) throw new Error("账号或应用状态已变化，未写入多维表格");
    baseEditIdle(current, id); return current.baseEdits.apply(draft);
  });
  bind("undo-base-edit", async (id, messageId) => {
    baseEditIdle(scope, id); scope.documentWriteAccess(); const current = scope, draft = await current.baseEdits.prepareUndo(id, messageId);
    const choice = await confirmDocumentWrite(id, { type: "warning", title: "确认撤销多维表格写入", message: `把「${draft.title}」里的 ${draft.changes.length} 处改回写入前的值？`,
      detail: baseEditDetail(draft), boundary: BASE_EDIT_BOUNDARY, buttons: ["取消", "确认撤销"], defaultId: 0, cancelId: 0 });
    if (choice.response !== 1) return null;
    if (scope !== current || quitting) throw new Error("账号或应用状态已变化，未撤销");
    baseEditIdle(current, id); return current.baseEdits.apply(draft);
  });
  // A write's fields read again when the person asks: Feishu can go on serving a
  // Base's old values for a while after a write. Nothing is written, so no card.
  bind("recheck-base-edit", async (id, messageId) => { baseEditIdle(scope, id); return scope.baseEdits.recheck(id, messageId); });
  bind("list-skills", async () => productSkillCatalog(await scope.feishu.listSkills()));
  // Both are read when 技能中心's 连接器 page opens, so they are status questions
  // that never hold up signing out (desktop-reads-must-not-hold-logout).
  bind("list-mcp", async () => (await scope.mcp.list()).map((row) => ({ ...row, ...mcpReference(row) })), "read");
  // What the administrator opened to this account. Listed on arrival rather than
  // behind a button, so signed out -- or on a server that offers no enterprise
  // connections at all, where the route does not exist -- there is nothing to
  // list, not an error to show. Any other failure is still reported.
  bind("list-enterprise-mcp", async () => {
    if (!auth.status().identity) return [];
    try { return await scope.enterpriseMcp.list(); }
    catch (error) { if (error.status === 404) return []; throw error; }
  }, "read");
  bind("import-enterprise-mcp", async (reference) => {
    const current = scope; if (current.service.active.size) throw new Error("请先停止任务，再修改 MCP 连接");
    const row = await current.enterpriseMcp.read(reference);
    const result = await confirmInApp({ type: "warning", title: "确认企业 MCP 连接", message: row.title,
      detail: `连接：${row.id}\n工具：${row.enabledTools.join("、")}\n策略指纹：${row.policyDigest}\n\n此连接通过已登录的企业服务端代理。服务凭据不会下发；工具参数和结果经过企业服务端及目标服务。导入不执行工具；任务仍需逐次确认。同 ID 会替换已有连接。`, buttons: ["取消", "确认导入"], defaultId: 0, cancelId: 0 });
    if (result.response !== 1) return null;
    const fresh = await current.enterpriseMcp.read(row); if (current.service.active.size) throw new Error("任务已开始，请停止后重新导入");
    await current.mcp.put(fresh); return mcpReference(fresh);
  });
  bind("import-mcp", async () => {
    if (scope.service.active.size) throw new Error("请先停止任务，再修改 MCP 连接");
    const current = scope;
    const picked = await dialog.showOpenDialog(win, { title: "导入不含密钥的 MCP 连接 JSON", properties: ["openFile"], filters: [{ name: "JSON", extensions: ["json"] }] });
    if (picked.canceled) return null;
    const row = await readMcpImport(picked.filePaths[0]);
    const result = await confirmInApp({ type: "warning", title: "确认 MCP 连接配置", message: row.title,
      detail: `${JSON.stringify(row, null, 2)}\n\n请确认配置中没有密钥。连接会启动本机程序或访问远程服务；stdio 程序以当前系统用户运行，不受任务文件沙箱隔离。远程服务可接收工具参数。只能导入你信任的配置；同 ID 将替换旧连接并使旧任务绑定失效。导入本身不会连接或调用模型。`, buttons: ["取消", "确认导入"], defaultId: 0, cancelId: 0 });
    if (result.response !== 1) return null;
    if (current.service.active.size) throw new Error("任务已开始，请停止后重新导入");
    await current.mcp.put(row); return mcpReference(row);
  });
  bind("remove-mcp", async (reference) => {
    const current = scope; if (current.service.active.size) throw new Error("请先停止任务，再移除 MCP 连接");
    const [row] = await current.mcp.resolve(reference); if (!row) throw new Error("请选择 MCP 连接");
    const result = await confirmInApp({ type: "warning", message: `移除 ${row.title}？`, detail: "绑定此连接的任务将不能继续发送。不会删除任务记录或远程服务。", buttons: ["取消", "移除连接"], defaultId: 0, cancelId: 0 });
    if (result.response !== 1) return;
    if (current.service.active.size) throw new Error("任务已开始，请停止后重试");
    await current.mcp.remove(reference);
  });
  bind("use-mcp", async (reference, mode, probe = false) => {
    if (!["cowork", "coding"].includes(mode) || typeof probe !== "boolean") throw new Error("无效的 MCP 任务操作");
    const current = scope, [row] = await current.mcp.resolve(reference); if (!row) throw new Error("请选择 MCP 连接");
    const result = await confirmInApp({ type: "warning", message: `${probe ? "检查连接" : "新任务使用"}：${row.title}`,
      detail: `${JSON.stringify(row, null, 2)}\n\n${probe ? "将启动连接并读取工具目录，检查后关闭；不发送模型请求。" : "发送任务时才连接；工具参数会交给该服务。调用按任务的权限确认：逐步确认每次都问，标准和自动每轮问一次，完全访问不再询问。"}stdio 服务以当前系统用户权限运行，不是隔离容器。请仅连接可信服务。`, buttons: ["取消", "确认"], defaultId: 0, cancelId: 0 });
    if (result.response !== 1) return null;
    await current.mcp.resolve(reference);
    const binding = mcpReference(row);
    if (probe) {
      const cwd = await mkdtemp(path.join(os.tmpdir(), "idou-mcp-probe-")); let runtime;
      try {
        runtime = await current.runtimeFactory({ mode, cwd, mcpConnection: binding }, undefined, { sending: false });
        runtime.client.on("serverRequest", (request) => runtime.client.respondError(request.id, -32601, "Connection checks do not authorize tool calls or elicitation"));
        await runtime.client.start(); const thread = await runtime.client.request("thread/start", { ...runtime.params, ephemeral: true });
        return await runtime.prepare(runtime.client, thread.thread.id);
      } finally { await runtime?.client.stop(); await rm(cwd, { recursive: true, force: true }); }
    }
    let cwd;
    if (mode === "coding") { const picked = await dialog.showOpenDialog(win, { title: "选择 MCP 编程任务目录", properties: ["openDirectory"] }); if (picked.canceled) return null; cwd = picked.filePaths[0]; }
    await current.mcp.resolve(reference);
    if (!cwd) cwd = await newWorkTaskFolder();
    return current.service.create({ mode, cwd, mcpConnection: binding });
  });
  bind("list-enterprise-skills", () => { if (skillKeyError) throw new Error(skillKeyError); return scope.skills.list(); });
  bind("read-enterprise-skill", (reference) => scope.skills.read(reference));
  // The enterprise shelf, as something an administrator can change. Reading who
  // may publish comes from the server, never from the client asking nicely.
  // A read of the server's shelf, and whether this person administers it. The
  // settings page asks it on every open (to show an administrator their
  // identifiers), so it must never hold up signing out: counted, a slow answer
  // refused 退出此账号 until it came (2026-09-23; see desktop-reads-must-not-hold-logout).
  bind("skill-shelf", () => { if (skillKeyError) throw new Error(skillKeyError); return scope.skills.shelf(); }, "read");
  bind("publish-skill", async (id) => {
    const rows = await scope.localSkills.list(), row = rows.find(item => item.id === id);
    if (!row) throw new Error("找不到这个本机技能");
    const local = await scope.localSkills.read({ id: row.id, version: row.version, digest: row.digest });
    const shelf = await scope.skills.shelf();
    const bundle = promoteToEnterprise(local, { publisher: auth.status().identity?.displayName || "企业管理员" });
    const existing = (shelf.skills || []).find(item => item.id === bundle.id);
    const choice = await confirmInApp({ type: "warning", title: "确认上架到企业技能货架",
      message: existing ? `用「${bundle.title}」替换货架上的同名技能？` : `把「${bundle.title}」上架给全企业？`,
      detail: `标识：${bundle.id}（由本机技能 ${local.id} 转换而来）\n版本：${bundle.version}\n发布者：${bundle.publisher}\n文件：${bundle.files.length} 个\n摘要：${bundle.digest.slice(0, 16)}…${existing ? `\n\n将替换：${existing.id} · 版本 ${existing.version}` : ""}\n\n说明：\n${bundle.description}`,
      boundary: "上架后本企业所有人在技能中心都能看到并启用它。技能的说明会作为指令进入模型上下文，可能改变 Agent 的行为——这份内容没有经过任何自动审查，由你为它背书。工具声明不会随之上架。随时可以下架，但已经绑定了它的任务不受影响。",
      buttons: ["取消", existing ? "确认替换" : "确认上架"], defaultId: 0, cancelId: 0 });
    if (choice.response !== 1) return null;
    return scope.skills.publish(bundle);
  });
  bind("unpublish-skill", async (id) => {
    const shelf = await scope.skills.shelf();
    const existing = (shelf.skills || []).find(item => item.id === id);
    if (!existing) throw new Error("货架上没有这个技能");
    const choice = await confirmInApp({ type: "warning", title: "确认从企业货架下架",
      message: `把「${existing.title}」从企业技能货架撤下？`,
      detail: `标识：${existing.id}\n版本：${existing.version}\n发布者：${existing.publisher}`,
      boundary: "下架后新任务不再能启用它；已经绑定了它的任务保持不变，因为那些任务记录的是当时的版本和摘要。",
      buttons: ["取消", "确认下架"], defaultId: 0, cancelId: 0 });
    if (choice.response !== 1) return null;
    return scope.skills.unpublish(id);
  });
  bind("enterprise-skill-connections", async (reference) => {
    const current = scope, skill = await current.skills.read(reference), requirements = skillMcpRequirements(skill);
    const connections = requirements.length ? (await current.mcp.list()).filter((row) => {
      try { skillMcpConnections(skill, [row]); return true; } catch { return false; }
    }).map((row) => ({ ...mcpReference(row), transport: row.transport, enabledTools: requirements[0].enabledTools })) : [];
    return { requirements, connections };
  });
  bind("use-enterprise-skill", async (reference, mode, mcpSelection) => {
    if (!["coding", "cowork"].includes(mode)) throw new Error("请选择工作任务或编程任务");
    const current = scope, connections = await current.mcp.resolve(mcpSelection), skill = requireUsableSkill(await current.skills.read(reference), connections);
    const effective = skillMcpConnections(skill, connections);
    const binding = connections.length ? { ...mcpReference(connections[0]), enabledTools: effective[0].enabledTools } : undefined;
    const mcpDetail = binding ? `\n\nMCP 连接配置：\n${JSON.stringify(connections[0], null, 2)}\n连接指纹：${binding.digest}\n本任务仅开放：${binding.enabledTools.join("、")}\n每次工具调用需确认；stdio 程序以当前系统用户运行，不受任务文件沙箱隔离。远程服务可接收参数。请仅使用可信连接。` : "";
    const selected = await confirmInApp({ type: "question", title: "确认将企业技能用于新任务", message: `${skill.title} · ${skill.version}`,
      detail: `发布者：${skill.publisher}\n声明工具：${skill.requiredTools.join("、") || "无"}\n内容指纹：${skill.digest}${mcpDetail}\n\n继续后，技能说明会随你发送的任务进入模型上下文，Agent 可能在任务沙箱内读取或修改文件。不会放宽沙箱或审批规则。版本绑定到新任务；每次发送前重新核验，不能在原对话中假定已遗忘旧技能。发送任务可能产生模型费用。`,
      buttons: ["取消", "确认用于新任务"], defaultId: 0, cancelId: 0, noLink: true });
    if (selected.response !== 1) return null;
    let cwd;
    if (mode === "coding") {
      const workspace = await dialog.showOpenDialog(win, { title: "选择技能任务可访问的编程目录", properties: ["openDirectory"] });
      if (workspace.canceled) return null; cwd = workspace.filePaths[0];
    }
    requireUsableSkill(await current.skills.read(skill), await current.mcp.resolve(binding));
    if (!cwd) cwd = await newWorkTaskFolder();
    return current.service.create({ mode, cwd, enterpriseSkill: skill, mcpConnection: binding });
  });
  bind("list-local-skills", () => scope.localSkills.list());
  bind("import-local-skill", async () => {
    const selected = await dialog.showOpenDialog(win, { title: "选择技能文件夹（需要包含 SKILL.md）", properties: ["openDirectory"] });
    if (selected.canceled || !selected.filePaths?.[0]) return null;
    const current = scope, skill = await current.localSkills.importDirectory(selected.filePaths[0]);
    if (scope !== current) throw new Error("账号已切换，未导入技能");
    return skill;
  });
  bind("set-local-skill-enabled", async (id, enabled, modes = ["cowork"]) => {
    if (enabled) {
      // Enabling is the moment the person grants this skill influence over every
      // new task, so it is the moment they see what it is and confirm it.
      const skill = await scope.localSkills.read(await scope.localSkills.list().then(rows => {
        const row = rows.find(item => item.id === id);
        if (!row) throw new Error("找不到这个本机技能");
        return { id: row.id, version: row.version, digest: row.digest };
      }));
      const kinds = ["cowork", "coding"].filter(mode => Array.isArray(modes) && modes.includes(mode));
      if (!kinds.length) throw new Error("请至少选择一种任务类型");
      const named = kinds.map(mode => mode === "cowork" ? "工作任务" : "编程任务").join("和");
      const choice = await confirmInApp({ type: "warning", title: "确认启用本机技能",
        message: `新建的${named}会使用「${skill.title}」`,
        detail: `来源：本机导入（未经服务端签名审核）\n标识：${skill.id} · 版本 ${skill.version}\n摘要：${skill.digest.slice(0, 16)}…\n\n${skill.description}\n\nAgent 会在可用技能里看到它的名称和描述，遇到符合描述的请求时打开它的说明照着做——这会改变 Agent 的行为，所以描述要写清楚它管什么。只有你勾选的任务类型会用到它；停用后新任务不再使用它。`,
        buttons: ["取消", "启用"], defaultId: 0, cancelId: 0 });
      if (choice.response !== 1) return scope.localSkills.list();
    }
    await scope.localSkills.setEnabled(id, enabled, modes);
    return scope.localSkills.list();
  });
  bind("rollback-local-skill", async (id, digest) => {
    const rows = await scope.localSkills.list();
    const row = rows.find((item) => item.id === id);
    const target = row?.history.find((item) => item.digest === digest);
    if (!row || !target) throw new Error("找不到这个历史版本");
    // Rolling back changes what every new task will be given, so it is confirmed
    // the same way enabling is.
    const choice = await confirmInApp({ type: "warning", title: "确认回滚本机技能",
      message: `把「${row.title}」换回 ${new Date(target.importedAt).toLocaleString("zh-CN")} 导入的那一版`,
      detail: `当前：版本 ${row.version} · 摘要 ${row.digest.slice(0, 16)}…\n回滚到：版本 ${target.version} · 摘要 ${target.digest.slice(0, 16)}…\n\n`
        + `${row.enabled ? "这个技能正在启用，回滚后新建的任务会改用回滚后的这一版。" : "这个技能未启用，回滚只改变以后启用时使用的内容。"}\n`
        + "已经存在的任务不受影响：它们记录的是绑定时那一版的摘要。当前这一版会进入历史，可以再换回来。",
      buttons: ["取消", "回滚"], defaultId: 0, cancelId: 0 });
    if (choice.response !== 1) return scope.localSkills.list();
    await scope.localSkills.rollback(id, digest);
    return scope.localSkills.list();
  });
  bind("remove-local-skill", (id) => scope.localSkills.remove(id));
  // Skills, MCP servers and plugin marketplaces are Codex's own, so the product
  // manages Codex's copies of them rather than keeping a second catalogue. What
  // the product adds is the confirmation: each of these hands something the
  // right to run on this machine, and none of it happens without being read and
  // agreed to first.
  const extensions = async () => new CodexExtensions({ binary: scope.config.codex.binary, ...(await codexRuntimeHome(scope.config)) });
  // 定时任务. Everything lives on the control plane -- the rules, the clock and
  // the identity a run acts as -- so the desktop only asks and shows.
  // A server that no longer knows the session (it restarted) signs the account
  // back in with the stored credential, and the refused request is sent again.
  const schedules = new ScheduleClient({ session: async () => scope.clientSession(), recover: (token) => recoverSession(token) });
  // …with one exception: what a run produced belongs in 工作任务, beside the rest
  // of a person's work, and a task record can only be born here. It needs a cwd
  // that exists on this machine and it lives under the signed-in account's own
  // directory -- neither of which the control plane has or, once deployed,
  // could have. So the desktop pulls.
  const scheduleMirror = new ScheduleMirror({ schedules, folder: newWorkTaskFolder,
    // Read through `scope` on every call: signing in or switching accounts
    // replaces the whole service, and a closure over the old one would write
    // this account's results into the previous account's files.
    listTasks: () => [...scope.service.tasks.values()],
    getTask: (id) => scope.service.get(id),
    createTask: async ({ mode, cwd, title }) => {
      const made = await scope.service.create({ mode, cwd });
      if (title) await scope.service.rename(made.id, title);
      return scope.service.get(made.id);
    },
    saveTask: async (task) => { await scope.service.store.save(task); scope.service.changed(); },
    log: (message) => process.stderr.write(`idou: ${message}\n`) });
  // Asked for when a person opens either section -- that is the moment it
  // matters -- with an interval for an app left open all day and a schedule due
  // at noon. Unref'd, so it never holds the process open by itself.
  // Which Feishu conversation a docked Agent conversation belongs to. Written on
  // the record because the renderer's memory of it is what leaving the section
  // discards -- the record itself was never the thing that got lost.
  //
  // Which chat that is comes from this process's own record of the page and its
  // decision about it (docked-chat.js); whatever the renderer believes is not
  // consulted. Before, any string it sent became the binding.
  bind("bind-feishu-chat", async (id) => {
    const task = scope.service.get(id);
    const current = await dockedChatState();
    if (!current.name) return { bound: false };
    const label = current.name.slice(0, 40);
    task.feishuChat = { key: current.key, name: label };
    await scope.service.store.save(task); scope.service.changed();
    // Named after the conversation it is about, so the list is readable once
    // several of them exist.
    await scope.service.rename(id, label);
    return { bound: true, key: current.key };
  });
  bind("sync-schedule-tasks", async () => scheduleMirror.sync());
  setInterval(() => { void scheduleMirror.sync(); }, 5 * 60_000).unref?.();
  // And once at start: what ran overnight is the first thing a person opens the
  // application to see, and waiting out an interval for it reads as the feature
  // not working. Deferred a little so it does not race the sign-in that gives
  // it a session, and silent when there is none -- `sync` swallows and logs.
  setTimeout(() => { void scheduleMirror.sync(); }, 5_000).unref?.();
  // A system notification when one of the person's scheduled tasks finishes,
  // while this app is open (schedule-notifier.js says what it will and will not
  // tell). The switch is this machine's, beside the other app-wide files, and on
  // unless turned off -- the way the reference products ship theirs.
  const noticePreferencesFile = path.join(dataRoot, "notification-preferences.json");
  const noticePreferences = { desktop: true };
  try { const saved = JSON.parse(await readFile(noticePreferencesFile, "utf8")); if (typeof saved?.desktop === "boolean") noticePreferences.desktop = saved.desktop; }
  catch { /* never set: the default */ }
  const showNotice = ({ title, body, runId = null }) => {
    if (!Notification.isSupported()) return false;
    const notice = new Notification({ title, body });
    // A run's notice opens where its answer is: 定时任务 → 运行记录.
    notice.on("click", () => {
      if (win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show(); win.focus();
      if (runId && !win.webContents.isDestroyed()) win.webContents.send("idou:open-schedule-runs", { runId });
    });
    notice.show();
    return true;
  };
  // A card waiting while this window is not the one in front: a notification
  // that brings the window forward, and one bounce of the Dock icon. Withdrawn
  // with the card (settleConfirm). The notification follows the same switch as
  // the other desktop notifications; the bounce always happens.
  // Clicked, the notice leads to the card: the task it waits in is opened. It
  // used to only bring the window forward, and a card in another task stayed
  // out of sight until the person went looking for it (2026-09-25).
  announceConfirmation = ({ title, validForMs, text = confirmationNoticeText(title, validForMs), taskId = null }) => {
    if (win.isDestroyed() || !shouldAnnounceConfirmation({ focused: win.isFocused(), minimized: win.isMinimized(), visible: win.isVisible() })) return null;
    const bounce = app.dock?.bounce?.("informational");
    let notice = null;
    if (noticePreferences.desktop && Notification.isSupported()) {
      notice = new Notification(text);
      notice.on("click", () => {
        if (win.isDestroyed()) return;
        if (win.isMinimized()) win.restore();
        win.show(); win.focus();
        if (typeof taskId === "string" && taskId && !win.webContents.isDestroyed()) win.webContents.send("idou:open-task", { taskId });
      });
      notice.show();
    }
    return { close: () => { notice?.close(); if (Number.isInteger(bounce)) app.dock?.cancelBounce?.(bounce); } };
  };
  const taskCardNotices = new ApprovalNotices((text, item) => announceConfirmation({ text, taskId: item?.taskId ?? null }));
  noticeTaskCards = (approvals) => taskCardNotices.update(approvals);
  const scheduleNotifier = new ScheduleNotifier({
    runs: (limit) => schedules.runs(undefined, limit),
    // Whose runs these are is the account scope; a new sign-in starts over.
    identity: () => scope?.root ?? null,
    enabled: () => noticePreferences.desktop,
    notify: showNotice,
    // A new result should not wait five minutes to appear in 工作任务 either.
    onFinished: () => scheduleMirror.sync(),
    log: (message) => process.stderr.write(`idou: ${message}\n`) });
  setInterval(() => { void scheduleNotifier.poll(); }, 30_000).unref?.();
  setTimeout(() => { void scheduleNotifier.poll(); }, 6_000).unref?.();
  const noticeState = () => ({ ...noticePreferences, supported: Notification.isSupported(), platform: process.platform });
  bind("notification-preferences", () => noticeState());
  bind("set-notification-preferences", async (value) => {
    if (typeof value?.desktop !== "boolean") throw new Error("通知设置无效");
    noticePreferences.desktop = value.desktop;
    await writeFile(noticePreferencesFile, JSON.stringify(noticePreferences), { mode: 0o600 });
    if (value.desktop) void scheduleNotifier.poll();
    return noticeState();
  });
  // So a person can see, now, whether the system lets these through -- rather
  // than finding out from a notification that never came.
  bind("test-notification", () => ({ shown: showNotice({ title: "i豆测试通知", body: "看到这条，定时任务跑完时也会这样提醒你。" }) }));
  // WorkBuddy's 去授权: macOS decides whether an app's notifications appear, and
  // only its own settings can change that. Opened for the person, not changed.
  bind("open-notification-settings", async () => {
    if (process.platform !== "darwin") return { opened: false };
    await shell.openExternal("x-apple.systempreferences:com.apple.Notifications-Settings.extension");
    return { opened: true };
  });
  bind("list-schedules", async (state) => schedules.list(state));
  bind("create-schedule", async (definition) => schedules.create(definition));
  bind("update-schedule-resources", async (id, resources, expectedRevision) => schedules.updateResources(id, resources, expectedRevision));
  bind("update-schedule", async (id, definition, expectedUpdatedAt) => schedules.update(id, definition, expectedUpdatedAt));
  bind("run-schedule-now", async (id) => schedules.runNow(id));
  bind("schedule-resource-recents", async () => {
    businessAccess();
    const inventory = await scope.wiki.inventory();
    const kinds = { "feishu-document": "document", "feishu-sheet": "sheet", "feishu-base": "base" };
    return { resources: inventory.sources.map(row => ({ kind: kinds[row.kind], reference: row.sourceUrl, label: row.title,
      usedAt: row.usedAt ?? row.readAt ?? row.observedAt })).filter(row => row.kind && typeof row.reference === "string").slice(0, 24) };
  });
  bind("search-schedule-resources", async (query, kind, pageToken) => {
    businessAccess();
    if (!["document", "sheet", "base"].includes(kind)) throw new Error("不支持的定时任务资源类型");
    return scope.feishu.searchDocuments({ query, kind, pageToken: pageToken ?? null });
  });
  bind("list-schedule-chats", next => scope.scheduleChatReader.list(next));
  bind("close-schedule-resources", () => scope.scheduleChatReader.close());
  bind("set-schedule-state", async (id, state) => schedules.setState(id, state));
  // Deleting a task takes its whole run history with it, so it is asked here, on
  // the in-app card, the way deleting a work task is: the page asks, this
  // process decides, and nothing is deleted without the person's click. One
  // card for a selection, naming what it holds. The words are WorkBuddy's, plus
  // the one thing that differs here: the run records go too.
  // A deleted task's runs stay in 运行记录 (G11) until the control plane lets
  // them go -- 90 days after they finished (ORPHAN_RUN_DAYS there).
  const ORPHAN_NOTE = "结束 90 天后自动清除";
  // Answers with the card's choice, so an Agent that asked can be told a
  // timeout apart from a no.
  const confirmScheduleRemoval = async (ids) => {
    const listed = await schedules.list();
    const chosen = ids.map((id) => (listed?.schedules ?? []).find((row) => row.id === id));
    if (chosen.some((row) => !row)) throw new Error("找不到要删除的定时任务，请刷新列表后再试");
    const single = chosen.length === 1;
    const names = chosen.slice(0, 8).map((row) => `「${row.title}」`).join("、") + (chosen.length > 8 ? ` 等 ${chosen.length} 个` : "");
    return confirmInApp({ type: "warning", title: single ? `删除「${chosen[0].title}」？` : `删除选中的 ${chosen.length} 个任务？`,
      message: single ? "此操作将永久删除该定时任务并停止所有后续运行。" : "此操作将永久删除选中的定时任务并停止其所有后续运行。",
      detail: `${single ? "" : `${names}。\n`}${single ? "它的" : "它们的"}运行记录会留在「运行记录」里，可以在那里单独删除，${ORPHAN_NOTE}。已经同步到工作任务里的结果和飞书云盘上的报告不受影响。`,
      buttons: ["取消", single ? "删除定时任务" : "删除"], defaultId: 0, cancelId: 0, destructive: true });
  };
  bind("remove-schedule", async (id) => ((await confirmScheduleRemoval([id])).response === 1 ? schedules.remove(id) : null));
  bind("remove-schedules", async (ids) => {
    if (!Array.isArray(ids) || !ids.length || ids.length > 50 || ids.some((id) => typeof id !== "string")) throw new Error("没有选中要删除的定时任务");
    if ((await confirmScheduleRemoval(ids)).response !== 1) return null;
    let removed = 0;
    for (const id of ids) if ((await schedules.remove(id))?.removed) removed += 1;
    return { removed };
  });
  bind("schedule-runs", async (id, limit, filter) => schedules.runs(id, limit, filter));
  // One run record at a time, in WorkBuddy's words, and asked on the in-app
  // card the way deleting a task is: the renderer asks, this decides, and
  // nothing is deleted or moved without the person's click. Bringing a record
  // back from 已归档 undoes nothing anyone chose, so it is not asked.
  // An Agent's draft of a task (G5), shown to the person in the ordinary
  // 添加定时任务 dialog. Nothing is created here: the dialog creates the task,
  // through the same call the page always makes, when the person presses 确定.
  // One draft at a time, withdrawn when the Agent's request ends or after nine
  // minutes (the Agent's own channel gives up at ten).
  const DRAFT_TIMEOUT_MS = 9 * 60_000;
  let pendingDraft = null, draftSeq = 0;
  const openScheduleDraft = (draft) => {
    if (win.webContents.isDestroyed() || quitting) return Promise.resolve({ cancelled: true, reason: "withdrawn" });
    if (pendingDraft) return Promise.reject(new Error("已经有一个定时任务草稿在等用户确认，先等它有结果"));
    const id = `draft-${++draftSeq}`;
    const signal = agentRequestContext.getStore()?.signal;
    if (signal?.aborted) return Promise.resolve({ cancelled: true, reason: "withdrawn" });
    return new Promise((resolve) => {
      const withdraw = (reason) => {
        if (pendingDraft?.id !== id) return;
        pendingDraft.finish({ cancelled: true, reason });
        if (!win.webContents.isDestroyed()) win.webContents.send("idou:schedule-draft-withdrawn", { id });
      };
      const timer = setTimeout(() => withdraw("timeout"), DRAFT_TIMEOUT_MS);
      timer.unref?.();
      const onAbort = () => withdraw("withdrawn");
      signal?.addEventListener("abort", onAbort, { once: true });
      pendingDraft = { id, finish: (result) => {
        clearTimeout(timer); signal?.removeEventListener("abort", onAbort); pendingDraft = null; resolve(result);
      } };
      win.webContents.send("idou:schedule-draft", { id, draft });
      if (win.isMinimized()) win.restore();
      win.focus();
    });
  };
  // The page's word that the dialog closed. "Created" is checked against the
  // person's own list before the Agent hears it: the page reports, the server
  // decides what exists.
  bind("settle-schedule-draft", async (id, outcome) => {
    if (!pendingDraft || pendingDraft.id !== id) return { settled: false };
    const settling = pendingDraft;
    if (outcome?.busy === true) { settling.finish({ cancelled: true, reason: "busy" }); return { settled: true }; }
    const createdId = typeof outcome?.createdId === "string" ? outcome.createdId : null;
    const row = createdId ? ((await schedules.list())?.schedules ?? []).find((item) => item.id === createdId) : null;
    if (pendingDraft !== settling) return { settled: false };
    settling.finish(row ? { created: true, schedule: { id: row.id, title: row.title, rule: row.schedule,
      nextAt: Number.isSafeInteger(row.nextAt) ? new Date(row.nextAt).toISOString() : null } } : { cancelled: true });
    return { settled: true };
  });
  bind("shelve-schedule-run", async (runId, shelved) => {
    if (shelved === true) {
      const choice = await confirmInApp({ type: "info", title: "归档该运行记录？",
        message: "归档后该记录将移入已归档列表，可在运行记录中查看。",
        buttons: ["取消", "归档"], defaultId: 0, cancelId: 0 });
      if (choice.response !== 1) return null;
    }
    return schedules.shelveRun(runId, shelved === true);
  });
  bind("delete-schedule-run", async (runId) => {
    const choice = await confirmInApp({ type: "warning", title: "删除该运行记录？",
      message: "此操作仅删除这一条运行记录，不会影响定时任务本身。",
      detail: "删除之后无法恢复。已经同步到工作任务里的结果，和保存在飞书云盘上的报告，都不会被删除。",
      buttons: ["取消", "删除"], defaultId: 0, cancelId: 0, destructive: true });
    if (choice.response !== 1) return null;
    return schedules.deleteRun(runId);
  });
  bind("schedule-consent", async () => schedules.consent());
  bind("authorize-schedules", async () => schedules.authorize());
  bind("revoke-schedules", async () => schedules.revoke());
  bind("schedule-unattended", async () => schedules.unattended());
  // 测试通知 in 设置 (G9). The person's own press, sending one fixed line to
  // themselves; the server takes the recipient from their session.
  bind("test-schedule-notify", async () => schedules.testNotify());
  // Confirmed here rather than in the renderer, the way everything that hands
  // out standing power is. What is being agreed to is a real enlargement: the
  // server keeps a credential of yours and acts as you while you are not there,
  // so the card says the date it ends, what it can do until then, and the one
  // thing revoking here does NOT undo.
  bind("authorize-unattended-schedules", async () => {
    const current = await schedules.unattended().catch(() => null);
    if (current && current.available === false) throw new Error("这台服务端没有开启无人值守运行，请联系管理员开启后再试。");
    // The date the server would actually run until, from the server's own
    // window. Guessing one and printing it would be the single most misleading
    // thing this card could do.
    const days = Number.isSafeInteger(current?.windowDays) && current.windowDays > 0 ? current.windowDays : null;
    const until = days ? new Date(Date.now() + days * 86400_000).toLocaleDateString("zh-CN") : null;
    const choice = await confirmInApp({
      title: "允许定时任务在你不在时运行",
      message: "让定时任务以你的飞书身份运行，即使你退出应用、关闭这台电脑",
      detail: [
        "服务端会保存一份你的飞书长效凭据，加密存放在服务器上，应用本身读不到它。",
        "",
        until ? `· 有效期 ${days} 天，到 ${until} 为止。到期后任务会先暂停，需要你重新授权。`
          : "· 有效期由服务端设置决定。到期后任务会先暂停，需要你重新授权。",
        "· 在这期间，你创建的定时任务到点就会执行，读写飞书的权限与你本人一致。",
        "· 每次执行都记录在「运行记录」里，结果通过飞书发给你本人；你给任务指定了文档或会话的，也以你的身份写到那里，不会写到别处。",
        "· 可以随时在这里撤销。撤销后服务端立即删除这份凭据，正在执行的任务会被中断。",
        "· 撤销不会取消你在飞书里对本应用的授权；要一并取消，请到飞书的「设置 - 应用授权」里移除本应用。",
      ].join("\n"),
      boundary: "这份授权允许服务端在你不在时以你的飞书身份运行你创建的定时任务，直到到期或你撤销为止。",
      buttons: ["取消", "允许"], defaultId: 0, cancelId: 0,
    });
    if (choice.response !== 1) throw new Error("已取消，没有开启无人值守运行。");
    return dedicatedAuthorization(await schedules.authorizeUnattended(), (flowId) => schedules.unattendedAuthorizeStatus(flowId));
  });
  bind("revoke-unattended-schedules", async () => {
    const choice = await confirmInApp({
      title: "撤销无人值守运行",
      message: "服务端将删除保存的长效凭据",
      detail: "正在执行的定时任务会被中断，之后的任务只在你登录时才会执行。\n撤销不会取消你在飞书里对本应用的授权。",
      boundary: "撤销后，服务端不再能在你不在时以你的身份运行任何任务。",
      buttons: ["取消", "撤销"], defaultId: 0, cancelId: 0, destructive: true,
    });
    if (choice.response !== 1) throw new Error("已取消，无人值守运行仍然开启。");
    return schedules.revokeUnattended();
  });
  bind("list-mcp-servers", async () => (await extensions()).listMcp());
  bind("add-mcp-server", async ({ name, kind, command, args, url } = {}) => {
    const ext = await extensions();
    const what = kind === "url"
      ? { detail: `远程服务：${String(url ?? "").slice(0, 300)}`, run: () => ext.addMcpUrl(name, url) }
      : { detail: `本机命令：${[command, ...(Array.isArray(args) ? args : [])].join(" ").slice(0, 300)}`, run: () => ext.addMcpCommand(name, command, Array.isArray(args) ? args : []) };
    const choice = await confirmInApp({ type: "warning", title: "确认添加 MCP 服务",
      message: `任务将可以调用「${String(name ?? "").slice(0, 60)}」提供的工具`,
      detail: `${what.detail}\n\n${kind === "url" ? "远程 MCP 会收到你发给它的请求内容。" : "本机 MCP 会以你的身份在这台电脑上启动这个程序。"}\n工具由服务端自己声明，可能随对方更新而变化。可以随时删除。`,
      buttons: ["取消", "添加"], defaultId: 0, cancelId: 0 });
    if (choice.response !== 1) return ext.listMcp();
    return what.run();
  });
  bind("remove-mcp-server", async (name) => (await extensions()).removeMcp(name));
  bind("login-mcp-server", async (name) => (await extensions()).loginMcp(name));
  bind("logout-mcp-server", async (name) => (await extensions()).logoutMcp(name));
  bind("list-marketplaces", async () => (await extensions()).listMarketplaces());
  bind("add-marketplace", async ({ source, ref } = {}) => {
    const ext = await extensions();
    const { kind, source: resolved } = marketplaceSource(source);
    const choice = await confirmInApp({ type: "warning", title: "确认添加技能市场",
      message: kind === "local" ? "从这个本机文件夹读取技能清单" : "从这个 Git 仓库下载技能清单",
      detail: `${resolved}${ref ? `\n分支或标签：${ref}` : ""}\n\n`
        + (kind === "local" ? "本机市场读取的是这个文件夹的当前内容，你改了就会生效——这也是自建技能的方式。" : "会把这个仓库的快照下载到本机。仓库的作者以后推送的内容，在你点「刷新市场」时才会被取下来。")
        + "\n添加市场本身不安装任何东西；每个插件仍要单独确认。",
      buttons: ["取消", "添加"], defaultId: 0, cancelId: 0 });
    if (choice.response !== 1) return ext.listMarketplaces();
    return ext.addMarketplace(source, { ref });
  });
  bind("remove-marketplace", async (name) => (await extensions()).removeMarketplace(name));
  bind("upgrade-marketplaces", async () => (await extensions()).upgradeMarketplaces());
  bind("list-plugins", async () => (await extensions()).listPlugins());
  bind("install-plugin", async (id) => {
    const ext = await extensions();
    const row = (await ext.listPlugins()).find((item) => item.id === pluginId(id));
    if (!row) throw new Error("找不到这个插件");
    const choice = await confirmInApp({ type: "warning", title: "确认安装插件",
      message: `安装「${row.name}」（来自市场 ${row.marketplace}）`,
      detail: `${row.description || "这个插件没有写说明。"}\n\n`
        + "插件可以带来技能说明、MCP 服务和钩子。技能说明会作为指令进入模型上下文，MCP 服务会以你的身份运行。\n"
        + `来源：${row.marketplaceKind === "local" ? "本机文件夹" : "Git 仓库"} · ${row.marketplace}\n安装后默认启用，可以随时停用或卸载。`,
      buttons: ["取消", "安装"], defaultId: 0, cancelId: 0 });
    if (choice.response !== 1) return ext.listPlugins();
    return ext.installPlugin(id);
  });
  bind("remove-plugin", async (id) => (await extensions()).removePlugin(id));
  bind("set-plugin-enabled", async (id, enabled) => {
    const ext = await extensions();
    // Turning a plugin back on re-grants everything installing it did -- skill
    // instructions, MCP servers running as this person, hooks -- and a market
    // refresh may have changed it since it was last on. So it is confirmed the
    // way installing is. Switching one off takes nothing away from anyone and
    // stays a single click.
    if (enabled === true) {
      const row = (await ext.listPlugins()).find((item) => item.id === pluginId(id));
      if (!row) throw new Error("找不到这个插件");
      const choice = await confirmInApp({ type: "warning", title: "确认启用插件",
        message: `重新启用「${row.name}」（来自市场 ${row.marketplace}）`,
        detail: `${row.description || "这个插件没有写说明。"}\n\n`
          + "启用后它带来的技能说明会作为指令进入模型上下文，MCP 服务会以你的身份运行，钩子会生效。\n"
          + `来源：${row.marketplaceKind === "local" ? "本机文件夹" : "Git 仓库"} · ${row.marketplace}${row.version ? ` · 版本 ${row.version}` : ""}\n`
          + "如果市场刷新过，内容可能已经和你上次启用时不同。",
        buttons: ["取消", "启用"], defaultId: 0, cancelId: 0 });
      if (choice.response !== 1) return ext.listPlugins();
    }
    return ext.setPluginEnabled(id, enabled);
  });
  bind("read-skill", (name) => { if (!isProductSkill(name)) throw new Error("本产品不提供这个平台技能"); return scope.feishu.readSkill(name); });
  // A control plane without an application catalogue is a configuration state,
  // not an error to report over and over — so it comes back as an answer the
  // panel can render instead of an exception the person has to interpret.
  bind("list-app-candidates", async (id) => {
    try { return { rows: await scope.appCandidates.list(id) }; }
    catch (error) { if (!error?.unconfigured) throw error; return { rows: [], unconfigured: true, reason: error.message }; }
  });
  bind("list-app-reviews", cursor => scope.appReviews.list(cursor));
  bind("list-app-runtimes", cursor => scope.appRuntimeExports.list(cursor));
  bind("read-app-runtime", (id, digest) => scope.appRuntimeExports.read(id, digest));
  bind("close-app-runtime", () => scope.appRuntimeExports.close());
  bind("export-app-runtime", async handle => {
    const current = scope, draft = await current.appRuntimeExports.prepare(handle), detail = draft.detail, binding = detail.binding;
    const target = await dialog.showOpenDialog(win, { title: "选择短期运行许可的导出目录", properties: ["openDirectory"] });
    if (target.canceled) return null;
    const confirmation = await confirmInApp({ type: "warning", title: "导出短期运行验收许可",
      message: `允许指定节点临时运行「${detail.title}」？`,
      detail: `应用：${binding.appId}\n版本：${binding.digest}\n包摘要：${binding.sha256}\n节点：${binding.nodeId}\n镜像：${binding.imageId}\n导出位置：${target.filePaths[0]}（新建私有子目录）\n\n许可最长 5 分钟，不超过当前登录期限。仅交给受信任节点，文件持有者可使用此权限；不包含模型密钥或父登录令牌。签发将撤销本次登录会话的旧运行许可，可能停止此前验收。此操作不下载源码、不启动节点、不正式发布或授予飞书数据权限。`,
      buttons: ["取消", "确认签发并导出"], defaultId: 0, cancelId: 0 });
    if (confirmation.response !== 1) return null;
    if (scope !== current || quitting) throw new Error("账号或应用状态已变化");
    return current.appRuntimeExports.export(draft, target.filePaths[0]);
  });
  bind("read-app-review", (id, digest) => scope.appReviews.read(id, digest));
  bind("close-app-review", () => scope.appReviews.close());
  bind("decide-app-review", async (handle, decision, note) => {
    const current = scope, draft = await current.appReviews.prepare(handle, decision, note);
    const confirmation = await confirmInApp({ type: "question", title: "确认应用清单审核",
      message: `${decision === "approved" ? "清单通过" : "退回修改"}：${draft.candidate.title}`,
      detail: `应用：${draft.candidate.appId}\n版本：${draft.candidate.digest}\n入口：${draft.candidate.manifest.entry}\n\n审核说明：${draft.input.note}\n\n仅审核这个静态版本的文件清单与声明。未读取源码、未执行安全扫描、未独立校验云盘包，不授予运行或数据访问权限，不部署。结论不可覆盖；修改后须提交新版本。`,
      buttons: ["取消", "确认提交清单结论"], defaultId: 0, cancelId: 0 });
    if (confirmation.response !== 1) return null;
    if (current !== scope || quitting) throw new Error("账号或应用状态已变化");
    return current.appReviews.decide(draft);
  });
  bind("archive-app-candidate", async (id, digest, reference) => {
    const current = scope, draft = await current.appArchive.prepare(id, digest, reference);
    const choice = await confirmInApp({ type: "warning", title: "归档应用版本到飞书云盘", message: `上传「${draft.title}」的已确认版本包？`,
      detail: `服务端：${draft.session.serverUrl}\n版本：${digest}\n目标文件夹：${draft.input.folder.title}\n${draft.input.folder.url}\nCLI 企业：${draft.input.folder.identity.tenantKey}\n上传包：${draft.input.bytes} 字节\n包 SHA-256：${draft.input.sha256}\n\n将上传已保存版本的全部源码与资源，不包含后来改动的工作目录。文件夹可访问者可能读取这些内容，请确认无敏感信息。会占用企业云盘预算；不覆盖文件、不修改权限、不部署、不调用妙搭。上传结果未知时不自动重传。完成后只核验目录位置与文件名，尚不校验远端内容哈希。`, buttons: ["取消", "确认上传版本包"], defaultId: 0, cancelId: 0 });
    if (choice.response !== 1) return null;
    if (scope !== current || quitting) throw new Error("应用状态变化，未归档版本");
    return current.appArchive.save(draft);
  });
  bind("verify-app-archive", (id, digest) => scope.appArchive.verify(id, digest));
  bind("retrieve-app-archive", (id, digest) => scope.appArchive.retrieve(id, digest));
  // Publishing a pure front-end app means making it portable: there is no
  // hosting platform here, so the deliverable is one self-contained file that
  // opens anywhere with nothing running behind it.
  bind("publish-static-app", async (id, entry) => {
    const current = scope, task = current.service.get(id);
    if (task.mode !== "coding") throw new Error("应用发布属于编程任务");
    const snapshot = await snapshotApp(task.cwd, entry);
    const files = snapshot.blobs.map((blob) => ({ path: blob.path, bytes: Buffer.from(blob.base64, "base64") }));
    const bundle = bundleStaticApp({ entry: snapshot.manifest.entry, files });
    if (scope !== current || quitting) throw new Error("应用状态已变化，未发布");
    const outside = bundle.external.length, absent = bundle.missing.length;
    const choice = await confirmInApp({ type: "warning", title: "确认发布为单文件网页",
      message: `把「${snapshot.manifest.entry}」打包成一个可独立打开的 HTML`,
      detail: `已内联 ${bundle.inlined.length} 个文件 · 成品 ${(bundle.bytes / 1024).toFixed(0)} KiB\n`
        + `${outside ? `仍指向外部地址 ${outside} 处：${bundle.external.slice(0, 5).join("、")}${outside > 5 ? " 等" : ""}\n` : ""}`
        + `${absent ? `引用了包里没有的文件 ${absent} 处：${bundle.missing.slice(0, 5).join("、")}${absent > 5 ? " 等" : ""}\n` : ""}`
        + `${bundle.unused.length ? `未被引用、不会进包：${bundle.unused.slice(0, 5).join("、")}${bundle.unused.length > 5 ? " 等" : ""}\n` : ""}`
        + `\n这是纯前端成品：没有服务端，任何需要后端的功能都不会工作。${outside ? "指向外部地址的部分打开时仍需要联网。" : ""}`,
      buttons: ["取消", "选择保存位置"], defaultId: 0, cancelId: 0 });
    if (choice.response !== 1) return null;
    const suggested = `${path.basename(task.cwd)}-${snapshot.digest.slice(0, 8)}.html`;
    const saved = await dialog.showSaveDialog(win, { title: "保存单文件网页", defaultPath: suggested, filters: [{ name: "网页", extensions: ["html"] }] });
    if (saved.canceled || !saved.filePath) return null;
    await writeFile(saved.filePath, bundle.html, { mode: 0o600 });
    return { path: saved.filePath, bytes: bundle.bytes, entry: snapshot.manifest.entry, digest: snapshot.digest,
      inlined: bundle.inlined.length, external: bundle.external, missing: bundle.missing, unused: bundle.unused };
  });
  bind("submit-app-candidate", async (id, entry) => {
    const current = scope, draft = await current.appCandidates.prepare(id, entry);
    const choice = await confirmInApp({ type: "warning", title: "提交应用待审版本", message: `保存「${draft.title}」的静态版本`,
      detail: `服务端：${draft.session.serverUrl}\n产物目录：${draft.snapshot.root}\n入口：${draft.snapshot.manifest.entry}\n版本 SHA-256：${draft.snapshot.digest}\n${draft.snapshot.manifest.files.length} 个文件，共 ${draft.snapshot.totalBytes} 字节\n\n${draft.snapshot.manifest.files.map((file) => `${file.path} · ${file.bytes} 字节`).join("\n")}\n\n源码包仅保存在本机；将标题、文件名、大小和哈希提交到企业服务端目录，企业配置的审核人可查看这些元数据。未执行构建或安全审查，不上传源码、不部署、不开通应用使用权限，不调用妙搭。隐藏文件和依赖目录不包含在版本中。`, buttons: ["取消", "保存并提交清单"], defaultId: 0, cancelId: 0 });
    if (choice.response !== 1) return null;
    if (scope !== current || quitting) throw new Error("应用状态变化，未提交版本");
    return current.appCandidates.submit(draft);
  });
  bind("withdraw-app-candidate", async (id, digest) => {
    const current = scope, session = await current.appCandidates.session();
    const candidate = (await current.appCandidates.list(id)).find((row) => row.digest === digest && row.state === "submitted");
    if (!candidate) throw new Error("找不到当前账号的待审应用版本");
    await current.appCandidates.unchanged(session);
    const choice = await confirmInApp({ type: "warning", title: "撤回待审应用版本", message: `撤回「${candidate.title}」的版本清单？`, detail: `版本：${digest}\n保留服务端历史和本机源码包；不删除飞书文件，不影响任何已部署服务。`, buttons: ["返回", "确认撤回"], defaultId: 0, cancelId: 0 });
    if (choice.response !== 1) return null;
    if (scope !== current || quitting) throw new Error("应用状态变化，未撤回版本");
    return current.appCandidates.withdraw(id, digest, session);
  });
  bind("hide-preview", hidePreview);
  const previewNavigation = async (target = preview) => {
    if (!target || preview !== target || target.id !== previewRevision || target.view.webContents.isDestroyed()) return null;
    const contents = target.view.webContents, relative = target.server.relative?.(contents.getURL()) ?? target.relative;
    let revision = target.sourceRevision;
    if (target.local && relative) {
      const task = scope.service.get(target.taskId), file = await readWorkspaceFile(task.cwd, relative);
      if (!file.canPreview) return null;
      revision = file.revision;
    }
    const result = { taskId: target.taskId, previewId: target.id, title: String(contents.getTitle() || relative || "网页预览").slice(0, 500),
      address: target.local ? `/${relative}` : `归档快照 /${relative ?? target.relative}`, ...(target.local ? { path: relative, revision } : {}), local: target.local,
      canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward() };
    if (preview === target && !win.webContents.isDestroyed()) win.webContents.send("idou:preview-navigation", result);
    return result;
  };
  const mountPreview = async (server, relative, revision, owner = {}) => {
    if (revision !== previewRevision) { server.close(); throw new Error("预览已切换"); }
    const view = paintSurface(new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: `preview-${randomUUID()}` } }));
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    view.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    view.webContents.session.setPermissionCheckHandler(() => false);
    view.webContents.session.on("will-download", (event) => event.preventDefault());
    view.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: server.allows ? !server.allows(details.url) : !details.url.startsWith(`${server.origin}/`) });
    });
    view.webContents.on("will-navigate", (event, url) => { if (!url.startsWith(`${server.origin}/`)) event.preventDefault(); });
    preview = { id: revision, view, server, relative, taskId: owner.taskId ?? null, sourceRevision: owner.sourceRevision ?? null, local: owner.local === true };
    const mounted = preview, reportNavigation = () => { void previewNavigation(mounted).catch(() => {}); };
    view.webContents.on("did-navigate", reportNavigation); view.webContents.on("did-navigate-in-page", reportNavigation);
    view.webContents.on("page-title-updated", reportNavigation); view.webContents.on("did-stop-loading", reportNavigation);
    win.contentView.addChildView(view); view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    let loadTimer;
    try { await Promise.race([view.webContents.loadURL(server.url(relative)), new Promise((_resolve, reject) => { loadTimer = setTimeout(() => reject(new Error("preview load timeout")), 15000); })]); }
    catch { if (preview?.view === view) await hidePreview(); throw new Error("成果预览加载失败"); }
    finally { clearTimeout(loadTimer); }
    if (revision !== previewRevision) throw new Error("预览已切换");
    return await previewNavigation(mounted) ?? { title: relative, address: `/${relative}`, previewId: revision, taskId: owner.taskId ?? null, local: owner.local === true };
  };
  bind("preview-file", async (id, relative) => {
    const task = scope.service.get(id);
    if (task.mode !== "coding" || typeof relative !== "string" || !/\.html?$/i.test(relative)) throw new Error("请选择编程任务中的 HTML 成果");
    const closing = hidePreview(), revision = previewRevision; await closing;
    const file = await readWorkspaceFile(task.cwd, relative);
    if (!file.canPreview) throw new Error("请选择编程任务中的 HTML 成果");
    if (revision !== previewRevision) throw new Error("预览已切换");
    return mountPreview(await createArtifactServer(task.cwd), relative, revision, { taskId: task.id, sourceRevision: file.revision, local: true });
  });
  bind("preview-navigate", async ({ taskId, previewId, direction } = {}) => {
    const target = preview;
    if (!target || target.taskId !== taskId || target.id !== previewId) throw new Error("这个网页预览已经关闭或切换");
    const history = target.view.webContents.navigationHistory;
    if (direction === "back" && history.canGoBack()) history.goBack();
    else if (direction === "forward" && history.canGoForward()) history.goForward();
    else if (direction !== "back" && direction !== "forward") throw new Error("未知的网页导航操作");
    return previewNavigation(target);
  });
  bind("preview-app-archive", async (id, digest) => {
    const current = scope, closing = hidePreview(), revision = previewRevision; await closing;
    const result = await current.appArchive.preview(id, digest);
    if (scope !== current || quitting || revision !== previewRevision) throw new Error("归档预览已切换");
    await current.appCandidates.unchanged(result.session);
    const server = await createPackagePreview({ bytes: result.pkg.bytes, digest, expiresAt: result.expiresAt, onExpired: () => {
      if (revision !== previewRevision) return;
      void hidePreview().catch(() => {});
      if (!win.webContents.isDestroyed()) win.webContents.send("idou:preview-expired", { previewId: revision });
    } });
    const view = await mountPreview(server, server.entry, revision, { taskId: id, local: false });
    return { ...view, digest, expiresAt: result.expiresAt };
  });
  // Embedded Feishu web view. This is the person's own Feishu client rendered
  // inside the app so a document keeps its real formatting and a chat behaves
  // like Feishu. It is deliberately separate from everything the agent does:
  // the agent still reads through the text projection and still writes only
  // through a one-shot server grant with an audit record. Nothing done inside
  // this view is attributed to the agent, and this view never sees the
  // application secret, the server-held OAuth token or the sidecar key.
  //
  // Which pages those are is the deployment's to say (`feishuProvider.web`).
  const feishuPage = (value) => feishuProvider.web.pageUrl(value);
  let feishuOrigin = null;
  // The messenger lives on the tenant's own Feishu domain, not on www, so the
  // app has to know which domain this account uses. It is learned from the first
  // document link it sees and remembered per account across restarts.
  const feishuOriginFile = () => path.join(scope.root, "last-feishu-origin.json");
  const rememberFeishuOrigin = async value => {
    let origin; try { origin = new URL(value).origin; } catch { return; }
    if (origin === feishuOrigin) return;
    feishuOrigin = origin;
    try { await writeFile(feishuOriginFile(), JSON.stringify({ origin }), { mode: 0o600 }); } catch { /* a convenience, never a failure */ }
  };
  const knownFeishuOrigin = async () => {
    if (feishuOrigin) return feishuOrigin;
    const requestedScope = scope;
    let stored; try { stored = JSON.parse(await readFile(feishuOriginFile(), "utf8"))?.origin; } catch { return null; }
    if (scope !== requestedScope) return null;
    if (typeof stored !== "string" || !feishuPage(stored)) return null;
    feishuOrigin = stored; return stored;
  };
  // The embedded Feishu session is keyed by account. An earlier build keyed it by
  // a field the scope never had, so every account shared one partition named
  // "feishu-web-local". Simply renaming it would sign the person out of a Feishu
  // web client they had already signed in to, so the first real account to look
  // claims that partition and keeps using it; every other account gets its own.
  // Nothing is copied, moved or deleted, and the claim is recorded once.
  const LEGACY_FEISHU_PARTITION = "feishu-web-local";
  const legacyFeishuClaimFile = path.join(dataRoot, "feishu-web-legacy.json");
  const exists = target => stat(target).then(() => true, () => false);
  let feishuPartitionName = null, feishuPartitionScope = null;
  const feishuPartition = async () => {
    const namespace = path.basename(scope.root);
    if (feishuPartitionScope === namespace && feishuPartitionName) return feishuPartitionName;
    // Only a signed-in account may claim it; the signed-out scope keeps its own.
    const claimable = /^[0-9a-f]{64}$/.test(namespace);
    let claim; try { claim = JSON.parse(await readFile(legacyFeishuClaimFile, "utf8"))?.namespace; } catch { /* never claimed */ }
    let claimed = typeof claim === "string" ? claim === namespace : false;
    if (typeof claim !== "string" && claimable && await exists(path.join(dataRoot, "Partitions", LEGACY_FEISHU_PARTITION))) {
      // "wx" so two scopes racing for the claim cannot both win it.
      claimed = await writeFile(legacyFeishuClaimFile, JSON.stringify({ namespace }), { mode: 0o600, flag: "wx" }).then(() => true, () => false);
    }
    feishuPartitionScope = namespace;
    return (feishuPartitionName = claimed ? LEGACY_FEISHU_PARTITION : `feishu-web-${namespace}`);
  };
  // A view that has been closed may no longer expose its webContents at all, so
  // every access is guarded: tearing one down must never throw into the caller.
  const liveContents = view => { const contents = view?.webContents; return contents && !contents.isDestroyed() ? contents : null; };
  // Building a Feishu web client takes seconds, and the old code built one on
  // every visit and destroyed it on the way out, so every click on the tab paid
  // that cost again. A view is now built once, warmed as soon as the account can
  // reach Feishu, and afterwards only shown or hidden. One view per kind.
  const feishuViewGroup = new NativeViewGroup({
    attach: view => win.contentView.addChildView(view),
    detach: view => win.contentView.removeChildView(view),
  });
  const feishuViews = feishuViewGroup.entries;
  // Feishu's own unread count, from the messenger view that is warmed at start
  // and only hidden afterwards. It goes to the sidebar tab, so 飞书消息 reads like
  // Feishu's own, and to the Dock, so it is visible with the app in the
  // background. The renderer can also ask, because it reloads and the view does not.
  const unread = unreadReporter({
    send: (value) => { if (!win.webContents.isDestroyed()) win.webContents.send("idou:feishu-unread", value); },
    badge: (count) => { try { app.setBadgeCount(count); } catch { /* not every platform has one */ } },
  });
  bind("feishu-unread", () => unread.current());
  const sectionUrl = (kind, origin) => feishuProvider.web.sectionUrl(kind, origin);
  // Feishu's own navigation repeats what this app already has in its sidebar,
  // so a section opens on its content. Cosmetic only: it hides chrome and
  // changes no behaviour, and if the client renames the element the navigation
  // simply comes back rather than the view breaking. Which chrome that is
  // belongs to the deployment's web client (`feishuProvider.web.chromeCss`).
  let feishuRailHidden = true;
  // One change at a time per page. Two at once each started from "nothing
  // inserted", and the first one's sheet was never removed: the rail could not
  // be shown again. Opening the section while its page was still loading was
  // enough -- dom-ready and the section's own call landed together.
  const applyFeishuRail = (entry) => {
    entry.railChange = (entry.railChange ?? Promise.resolve()).then(() => changeFeishuRail(entry)).catch(() => {});
    return entry.railChange;
  };
  const changeFeishuRail = async (entry) => {
    const contents = liveContents(entry.view);
    const css = feishuProvider.web.chromeCss(entry.kind);
    if (!contents || !css) return;
    const previous = entry.railKey; entry.railKey = null;
    if (previous) await contents.removeInsertedCSS(previous).catch(() => {});
    if (feishuRailHidden) entry.railKey = await contents.insertCSS(css).catch(() => null);
    // The messenger sizes its conversation list and its conversation in script,
    // from the width it measures when the window is resized -- and a sheet coming
    // or going is not a resize. Hiding the rail left its 156 px as an empty strip
    // down the right with the list folded away; showing it pushed the
    // conversation past the edge (measured on Feishu's own page, 2026-09-24). So
    // the page is told, the way a resize would tell it. Not awaited: a page that
    // is busy must not hold the toggle.
    void contents.executeJavaScript("window.dispatchEvent(new Event('resize'))").catch(() => {});
  };
  const clampBounds = (rect) => {
    const [width, height] = win.getContentSize();
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return null;
    const x = Math.max(0, Math.min(width, Math.round(rect.x))), y = Math.max(0, Math.min(height, Math.round(rect.y)));
    return { x, y, width: Math.max(0, Math.min(width - x, Math.round(rect.width))), height: Math.max(0, Math.min(height - y, Math.round(rect.height))) };
  };
  const destroyFeishuViews = () => {
    feishuViewGroup.reset();
    // Another account's unread count, or a count with no view behind it any more,
    // would sit there being wrong until something else happened to change it.
    unread.clear();
    // What the closed pages said is no longer about anything on screen.
    feishuChat.clear(); feishuSelection.clear();
    closeProbeView();
  };
  // What the person has selected inside Feishu's own page, reported by the
  // view's preload. Kept per view and dropped whenever that view navigates, so
  // a selection can never be attributed to a different document.
  const feishuSelection = new Map();
  // Which conversation the messenger has open, as its own header names it. Kept
  // the same way and dropped on the same events, so a name can never outlive the
  // page that showed it.
  const feishuChat = new Map();
  // ---- Who the embedded pages are signed in as (see web-identity.js) --------
  //
  // The pages keep their own Feishu web session, which nothing ever compared
  // with the account signed in to this application. A hidden view in the same
  // partition is sent through the control plane's launch URL; Feishu answers
  // for whoever is signed in there, and the control plane says whether that is
  // this account. Only a verdict comes back.
  let webCheck = null, webCheckScope = null, lastAutoProbe = 0;
  let probe = null, probeRevision = 0;
  const probeNavigationAllowed = (target) => {
    let url; try { url = new URL(target); } catch { return false; }
    if (url.username || url.password) return false;
    const operator = auth.operatorSession();
    if (operator && ["http:", "https:"].includes(url.protocol) && url.origin === new URL(operator.serverUrl).origin) return true;
    return feishuPage(target);
  };
  const isControlPlaneCallback = (target) => {
    let url; try { url = new URL(target); } catch { return false; }
    const operator = auth.operatorSession();
    return Boolean(operator) && url.origin === new URL(operator.serverUrl).origin && url.pathname === "/auth/feishu/callback";
  };
  const closeProbeView = () => {
    probeRevision++;
    const current = probe; probe = null;
    if (!current) return;
    try { win.contentView.removeChildView(current.view); } catch { /* already detached */ }
    liveContents(current.view)?.close();
  };
  // Shown only when Feishu put a page in front of the person, and only over a
  // Feishu section they are looking at -- never over anything else.
  const placeProbeView = () => {
    if (!probe) return;
    const under = feishuViews.get(feishuViewGroup.visible);
    if (!probe.revealed || !under) { probe.view.setVisible(false); return; }
    probe.view.setBounds(under.view.getBounds());
    try { win.contentView.addChildView(probe.view); } catch { /* re-adding only raises it */ }
    probe.view.setVisible(true);
  };
  // A hidden browser in the account's own Feishu partition, sent to one of the
  // control plane's launch URLs. Redirects included: the whole trip is control
  // plane -> Feishu -> control plane, and a hop anywhere else is refused.
  const openAccountBrowser = async (launchUrl) => {
    if (!probeNavigationAllowed(launchUrl)) throw new Error("授权入口地址无效");
    const generation = feishuViewGroup.generation;
    const partition = await feishuPartition();
    if (generation !== feishuViewGroup.generation || quitting || switching) throw new Error("网页账号已切换");
    const view = paintSurface(new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: `persist:${partition}` } }));
    const contents = view.webContents;
    contents.setUserAgent(contents.getUserAgent().replace(/\s*(Electron|MyDouBao|我的豆包|i豆)\/[^\s]+/g, ""));
    contents.setWindowOpenHandler(({ url: target }) => { if (/^https:/.test(target)) void shell.openExternal(target).catch(() => {}); return { action: "deny" }; });
    for (const name of ["will-navigate", "will-redirect"]) contents.on(name, (event, target) => { if (!probeNavigationAllowed(target)) event.preventDefault(); });
    watchWebSession(contents.session);
    win.contentView.addChildView(view);
    view.setVisible(false);
    const [width, height] = win.getContentSize();
    view.setBounds({ x: 0, y: 0, width, height });
    void contents.loadURL(launchUrl).catch(() => {});
    return view;
  };
  const closeAccountBrowser = (view) => {
    try { win.contentView.removeChildView(view); } catch { /* already detached */ }
    liveContents(view)?.close();
  };
  // The same stall in the browser the web-account check puts in front of the
  // person: loaded hidden, redirected to Feishu's sign-in page, never started
  // (feishu-view-revival.js). Reloaded once, a moment after it is revealed.
  const reviveStalledProbe = (current) => {
    const timer = setTimeout(async () => {
      const contents = liveContents(current.view);
      if (!contents || current.revived || probe !== current || !current.revealed) return;
      const title = await contents.executeJavaScript("document.title", true).catch(() => null);
      if (!stalledRedirect({ requested: current.launchUrl, landed: contents.getURL(), title, settled: current.settled || !contents.isLoading() })) return;
      current.revived = true;
      contents.reload();
    }, 4000);
    timer.unref?.();
  };
  const openProbeView = async (launchUrl) => {
    closeProbeView();
    const revision = probeRevision;
    const view = await openAccountBrowser(launchUrl);
    if (revision !== probeRevision) { closeAccountBrowser(view); throw new Error("网页账号核对已切换"); }
    const current = { view, revealed: false, launchUrl, revived: false, settled: false };
    view.webContents.on("did-finish-load", () => { current.settled = true; });
    // The trip ends on the control plane's callback, a page written for a tab in
    // the person's own browser ("可以关闭这个页面"). Once the probe heads there,
    // Feishu needs nothing more from the person, so it leaves the section at once
    // instead of showing that page over the messenger until the next status poll
    // closes it -- seen 2026-09-24 after a restart. Only hidden, not closed: the
    // callback request still has to finish for there to be a verdict.
    const leavesForCallback = (details) => {
      if (!details.isMainFrame || probe !== current || !current.revealed) return;
      if (!isControlPlaneCallback(details.url)) return;
      current.revealed = false;
      placeProbeView();
    };
    view.webContents.on("did-start-navigation", leavesForCallback);
    view.webContents.on("did-redirect-navigation", leavesForCallback);
    probe = current;
    return {
      reveal: () => { if (probe === current) { current.revealed = true; placeProbeView(); reviveStalledProbe(current); } },
      close: () => { if (probe === current) closeProbeView(); },
    };
  };
  const signedInWebIdentity = () => ({ state: WEB_IDENTITY.UNVERIFIED, cause: "unavailable",
    reason: scope?.enterprise ? "请先登录飞书账号" : "开发模式没有飞书登录，网页账号无从核对", checkedAt: null, needsAttention: false });
  const webIdentity = () => {
    if (webCheck && webCheckScope === scope) return webCheck;
    const operator = auth.operatorSession();
    if (!scope?.enterprise || !operator) return null;
    const request = async (route, value) => {
      const current = auth.operatorSession();
      if (!current) throw new Error("请先登录飞书账号");
      return auth.client.request(current.serverUrl, route, value, current.token);
    };
    webCheckScope = scope;
    const verdictFile = scope.webVerdictFile;
    webCheck = new WebIdentityCheck({
      launchPrefix: `${operator.serverUrl}/auth/feishu/launch?flow=`,
      begin: () => request("/auth/feishu/web-identity/begin", {}),
      status: (flowId) => request("/auth/feishu/web-identity/status", { flowId }),
      open: (url) => openProbeView(url),
      onChange: (value) => {
        // A conflict or a fresh verdict changes what every name on the page may
        // be matched to, so the chat decisions start over.
        if (value.state !== WEB_IDENTITY.CHECKING) scope?.dockedChat.reset();
        keepWebVerdict(value, verdictFile);
        if (!win.webContents.isDestroyed()) win.webContents.send("idou:web-identity", value);
      },
    });
    return webCheck;
  };
  const webIdentityState = () => webIdentity()?.snapshot() ?? signedInWebIdentity();
  const forgetWebIdentity = () => {
    webCheck?.reset("reset"); webCheck = null; webCheckScope = null; lastAutoProbe = 0;
    closeProbeView();
  };
  // Asked when a Feishu section is warmed or opened, and after the pages sign in
  // again. Not in a loop: at most once every two minutes on its own, and never
  // again by itself after the person declined -- only when they ask.
  // Whether the pages are signed in to Feishu at all: their `session` cookie on a
  // Feishu domain. Without it there is nothing to verify, and a check only lays
  // Feishu's sign-in page over the one the person should be scanning -- measured
  // 2026-09-22, it did exactly that for minutes, every two minutes.
  const feishuWebSignedIn = async () => {
    const partition = await feishuPartition().catch(() => null);
    if (!partition) return false;
    const found = await electronSession.fromPartition(`persist:${partition}`).cookies.get({ name: SESSION_COOKIE }).catch(() => []);
    return found.some((cookie) => feishuCookieDomain(cookie.domain));
  };
  // The verdict kept across restarts, bound to the pages' session
  // (web-identity.js: rememberedVerdict). Written when a check concludes
  // "verified", removed on anything else it concludes -- a conflict, the pages
  // signing out or in again, the application signing out.
  let verdictWrites = Promise.resolve();
  const feishuSessionDigest = async () => {
    const partition = await feishuPartition().catch(() => null);
    if (!partition) return null;
    const found = await electronSession.fromPartition(`persist:${partition}`).cookies.get({ name: SESSION_COOKIE }).catch(() => []);
    const cookie = found.find((entry) => feishuCookieDomain(entry.domain));
    return cookie ? digestOf(cookie.value) : null;
  };
  const keepWebVerdict = (value, file) => {
    if (!file) return;
    verdictWrites = verdictWrites.then(async () => {
      if (value.state === WEB_IDENTITY.VERIFIED) {
        const session = await feishuSessionDigest();
        if (!session || !Number.isFinite(value.checkedAt)) return;
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        const staging = `${file}.${randomUUID()}.tmp`;
        await writeFile(staging, JSON.stringify(verdictRecord(session, value.checkedAt)), { mode: 0o600, flag: "wx" });
        await rename(staging, file);
      } else if (value.state !== WEB_IDENTITY.CHECKING) {
        await rm(file, { force: true });
      }
    }).catch(() => {});
  };
  const restoreWebVerdict = async (check, file) => {
    if (!file) return false;
    await verdictWrites;
    const stored = await readFile(file, "utf8").then(JSON.parse).catch(() => null);
    const checkedAt = rememberedVerdict(stored, { session: await feishuSessionDigest(), now: Date.now() });
    return checkedAt !== null && check.restore(checkedAt);
  };
  const ensureWebIdentity = (why = "auto") => {
    const check = webIdentity();
    if (!check || quitting || switching) return;
    const current = check.snapshot();
    if (check.busy || current.state === WEB_IDENTITY.VERIFIED || current.state === WEB_IDENTITY.CONFLICT) return;
    if (why === "auto" && (Date.now() - lastAutoProbe < 120_000 || current.cause === "declined" || current.cause === "unavailable")) return;
    lastAutoProbe = Date.now();
    void (async () => {
      // The sign-in itself resets and restarts this (webSessionChanged).
      if (!(await feishuWebSignedIn())) { if (!check.busy) check.reset("signed_out"); return; }
      if (why === "auto" && await restoreWebVerdict(check, scope?.webVerdictFile)) return;
      await check.check();
    })().catch(() => {});
  };
  // The pages signing in or out is noticed by their `session` cookie changing
  // value. Only a digest of it is kept, only to tell a change from a re-set of
  // the same one. Changes while a probe is running are the probe's own trip
  // through Feishu's sign-in and are not a new login.
  const watchedSessions = new WeakSet();
  const SESSION_COOKIE = "session";
  const feishuCookieDomain = (domain) => feishuProvider.web.cookieDomain(String(domain ?? ""));
  const digestOf = (value) => createHash("sha256").update(String(value ?? "")).digest("hex");
  const watchWebSession = (webSession) => {
    if (!webSession || watchedSessions.has(webSession)) return;
    watchedSessions.add(webSession);
    let known = null, timer = null;
    void webSession.cookies.get({ name: SESSION_COOKIE }).then((found) => {
      const cookie = found.find((entry) => feishuCookieDomain(entry.domain));
      known = cookie ? digestOf(cookie.value) : null;
    }).catch(() => {});
    webSession.cookies.on("changed", (_event, cookie, cause, removed) => {
      if (cookie?.name !== SESSION_COOKIE || !feishuCookieDomain(cookie.domain)) return;
      if (removed && cause === "overwrite") return; // the other half of a replacement
      const next = removed ? null : digestOf(cookie.value);
      if (next === known) return;
      known = next;
      if (webCheck?.busy) return;
      clearTimeout(timer);
      timer = setTimeout(() => void webSessionChanged(webSession), 3000);
      timer.unref?.();
    });
  };
  const webSessionChanged = async (webSession) => {
    const partition = await feishuPartition().catch(() => null);
    if (!partition || quitting || electronSession.fromPartition(`persist:${partition}`) !== webSession) return;
    webCheck?.reset("reset");
    scope?.dockedChat.reset();
    feishuChat.clear(); feishuSelection.clear();
    lastAutoProbe = 0;
    // Signed in from one view, the others are still parked on the sign-in page
    // they were redirected to: send each back to the page it was opened for.
    if (await feishuWebSignedIn()) {
      for (const entry of feishuViews.values()) {
        const contents = liveContents(entry.view);
        let parked = false;
        try { parked = Boolean(contents) && new URL(contents.getURL()).host !== new URL(entry.url).host; } catch { /* not a page yet */ }
        if (!parked) continue;
        entry.settled = false; entry.revived = false;
        void contents.loadURL(entry.url).catch(() => {});
      }
    }
    ensureWebIdentity("auto");
  };
  // The messenger's current name as its page last reported it, and the decision
  // about which chat, if any, that name may be taken to mean.
  const dockedChatState = async () => {
    const identity = webIdentityState();
    const reported = feishuChat.get("messenger");
    const state = await scope.dockedChat.state({ name: reported?.name ?? "", at: reported?.at, identity });
    return { ...state, selection: state.name ? feishuSelection.get("messenger") ?? null : null, web: identity };
  };
  const messengerDockContext = (state) => chatContext({ name: state.name, binding: state.binding, id: state.chat?.id, reason: state.reason }, state.selection, { isChat: feishuProvider.ids.chat });
  const documentDockText = (kind) => {
    const contents = liveContents(feishuViews.get(kind)?.view);
    const reference = contents && feishuProvider.references.resource(contents.getURL());
    if (!reference) return "";
    return documentDockContext({ url: reference.url, label: reference.label, name: documentName(contents.getTitle()) },
      feishuSelection.get(kind) ?? null, webIdentityState().state);
  };
  // The unattended credential's own Feishu authorization. Tried first in the
  // pages' browser, where the person is usually signed in to Feishu already and
  // an authorization they have given before passes straight through; if Feishu
  // wants a person, the same link goes to the system browser for them to finish.
  // Whoever authorizes, the control plane keeps the credential only if it is
  // this account's person.
  const dedicatedAuthorization = async (begun, status) => {
    const operator = auth.operatorSession();
    if (!operator || !/^[A-Za-z0-9_-]{43}$/.test(begun?.flowId ?? "") || begun.launchUrl !== `${operator.serverUrl}/auth/feishu/launch?flow=${begun.flowId}`) {
      throw new Error("服务端返回了无效的授权入口");
    }
    const deadline = Number.isFinite(begun.expiresAt) ? Math.min(begun.expiresAt, Date.now() + 300_000) : Date.now() + 300_000;
    const started = Date.now();
    let silent = await openAccountBrowser(begun.launchUrl).catch(() => null), handedOver = !silent;
    if (handedOver) await shell.openExternal(begun.launchUrl);
    try {
      while (Date.now() < deadline && !quitting) {
        const seen = await status(begun.flowId);
        if (seen.status === "granted") return seen;
        if (seen.status === "conflict") throw new Error("授权时登录的飞书账号不是当前应用登录的账号，没有开启。");
        if (seen.status === "declined") throw new Error("飞书页面上的授权没有完成，没有开启。");
        if (seen.status === "no_refresh") throw new Error("飞书没有签发长效凭据，没有开启。请联系管理员确认应用已开通 offline_access，服务端已开启 FEISHU_SESSION_RENEWAL_ENABLED 与 FEISHU_LONG_SESSION_DAYS。");
        if (seen.status !== "pending") throw new Error("授权没有保存下来，请重试。");
        if (!handedOver && Date.now() - started >= 6000) {
          closeAccountBrowser(silent); silent = null; handedOver = true;
          if (!win.webContents.isDestroyed()) win.webContents.send("idou:schedule-authorization", { handedOver: true });
          await shell.openExternal(begun.launchUrl);
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      throw new Error("授权超时，没有开启。");
    } finally { if (silent) closeAccountBrowser(silent); }
  };
  bind("web-identity", () => webIdentityState());
  bind("verify-web-identity", async () => {
    const check = webIdentity();
    if (!check) return signedInWebIdentity();
    // Asked for by the person: past answers and the automatic pause do not apply.
    // Not while the pages are signed out, though -- that answer is already known.
    if (!check.busy && !(await feishuWebSignedIn())) { check.reset("signed_out"); return check.snapshot(); }
    if (!check.busy && check.snapshot().state !== WEB_IDENTITY.CHECKING) check.reset("reset");
    lastAutoProbe = Date.now();
    return check.check();
  });
  bind("docked-chat", () => dockedChatState());
  bind("docked-chat-options", () => scope.dockedChat.options());
  bind("confirm-docked-chat", async (chatId) => {
    const reported = feishuChat.get("messenger");
    await scope.dockedChat.confirm({ name: reported?.name ?? "", at: reported?.at, identity: webIdentityState(), chatId });
    return dockedChatState();
  });
  bind("forget-docked-chat", async () => {
    const reported = feishuChat.get("messenger");
    await scope.dockedChat.forget({ name: reported?.name ?? "", at: reported?.at, identity: webIdentityState() });
    return dockedChatState();
  });
  // See feishu-view-revival.js: a page warmed while hidden can finish loading
  // and never start, which left Feishu's sign-in page on its loading picture
  // with no QR code to scan. Looked at a moment after the view is on screen --
  // a page that is starting sets its title within that time, a stalled one
  // never does -- and reloaded once per load, so nothing can loop.
  const reviveStalledView = (kind, entry) => {
    const timer = setTimeout(async () => {
      const contents = liveContents(entry.view);
      if (!contents || entry.revived || feishuViews.get(kind) !== entry || feishuViewGroup.visible !== kind) return;
      const title = await contents.executeJavaScript("document.title", true).catch(() => null);
      if (!stalledRedirect({ requested: entry.url, landed: contents.getURL(), title, settled: entry.settled })) return;
      entry.revived = true;
      process.stderr.write(`idou-desktop: 飞书页面在后台加载后没有启动，显示时重新加载一次（${new URL(contents.getURL()).host}）\n`);
      contents.reload();
    }, 4000);
    timer.unref?.();
  };
  // The Drive file a page address names, or null.
  const driveFileAt = (value) => { try { return feishuProvider.references.driveFile(value); } catch { return null; } };
  const buildFeishuView = async (kind, url, generation = feishuViewGroup.generation) => {
    const partition = await feishuPartition();
    if (generation !== feishuViewGroup.generation || quitting || switching) return null;
    const view = paintSurface(new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
      // Reads the person's selection inside Feishu's page and reports it here.
      // It exposes nothing to the page and writes nothing back.
      preload: fileURLToPath(new URL("./feishu-selection-preload.cjs", import.meta.url)),
      // Where the deployment's messenger names the open conversation.
      additionalArguments: feishuProvider.web.chatReader ? [`--idou-page-reader=${encodeURIComponent(JSON.stringify(feishuProvider.web.chatReader))}`] : [],
      partition: `persist:${partition}` } }));
    const entry = { kind, view, url, railKey: null, settled: false, revived: false };
    const contents = view.webContents;
    watchWebSession(contents.session);
    contents.setUserAgent(contents.getUserAgent().replace(/\s*(Electron|MyDouBao|我的豆包|i豆)\/[^\s]+/g, ""));
    contents.setWindowOpenHandler(({ url: asked }) => {
      // A link out of Feishu belongs in the real browser, not inside the app.
      // One from a conversation opens in 飞书文档 rather than over the
      // conversation (feishu-link-routing.js). A report link this product sent
      // before 2026-09-29 opens the file it names (drive-files.js).
      const target = feishuProvider.repairedLink(asked);
      const route = routeFeishuLink({ kind, target, visible: feishuViewGroup.visible === kind, feishuPage });
      if (route === "here") void contents.loadURL(target).catch(() => {});
      else if (route === "docs") void openInFeishuDocs(target);
      else if (route === "external") void shell.openExternal(target).catch(() => {});
      return { action: "deny" };
    });
    // Feishu's own client raises the new-message notifications, the same ones it
    // raises in a browser and with the same content. That is the only thing a
    // page in this view may ask for, only Feishu's own pages may ask for it, and
    // everything else — camera, microphone, location, the rest — stays refused.
    const notificationsOnly = (permission, origin) => permission === "notifications" && feishuPage(origin);
    contents.session.setPermissionRequestHandler((_requester, permission, callback, details) => callback(notificationsOnly(permission, details?.requestingUrl ?? "")));
    contents.session.setPermissionCheckHandler((_contents, permission, requestingOrigin) => notificationsOnly(permission, requestingOrigin));
    contents.session.on("will-download", event => event.preventDefault());
    // Moving to another document invalidates whatever was selected in the last
    // one, so a stale selection can never be attributed to the new page.
    for (const event of ["did-start-navigation", "did-navigate-in-page"]) contents.on(event, () => {
      if (feishuViews.get(kind) === entry) feishuSelection.delete(kind);
    });
    // A selection cannot survive any navigation; the conversation can. The
    // messenger is one page that navigates inside itself constantly, and dropping
    // the name on each of those emptied the dock for good, because the page only
    // speaks up when the name changes. Only leaving the page really forgets it.
    contents.on("did-start-navigation", (details) => {
      if (feishuViews.get(kind) === entry && details.isMainFrame && !details.isSameDocument) feishuChat.delete(kind);
    });
    // Only top-level navigation is restricted. Feishu's own client pulls scripts,
    // fonts and media from a changing set of CDN hosts, and filtering those by
    // name only produces a blank page; the page itself is first-party and is the
    // same one this person uses in a browser.
    contents.on("will-navigate", (event, asked) => {
      const target = feishuProvider.repairedLink(asked);
      if (!feishuPage(target)) { event.preventDefault(); return; }
      // A document or Drive file followed in place from a conversation: the
      // same as one opened as a new window, so the conversation is never
      // navigated away.
      if (divertsFromMessenger({ kind, target, feishuPage, resource: (value) => feishuProvider.references.resource(value) ?? driveFileAt(value) })) {
        event.preventDefault();
        if (feishuViewGroup.visible === kind) void openInFeishuDocs(target);
        return;
      }
      // An old report link followed anywhere else goes to the file it names.
      if (target !== asked) { event.preventDefault(); void contents.loadURL(target).catch(() => {}); }
    });
    // A redirect is a navigation too, and it was let through: a Feishu address
    // that answered with a redirect elsewhere put that page inside the section,
    // looking like part of the app. It goes to the real browser instead, as a
    // link out of Feishu does. (Signing in with a company's own identity page
    // was never possible in here -- will-navigate keeps its forms out -- so this
    // takes nothing away; the section's sign-in is Feishu's QR code.)
    contents.on("will-redirect", (details) => {
      if (!details.isMainFrame || feishuPage(details.url)) return;
      details.preventDefault();
      if (/^https:/.test(details.url)) void shell.openExternal(details.url).catch(() => {});
    });
    contents.on("did-fail-load", (_event, code, description, target, isMainFrame) => {
      // -3 is an ordinary abort, usually a redirect superseding the first load.
      if (!isMainFrame || code === -3 || feishuViews.get(kind) !== entry) return;
      process.stderr.write(`idou-desktop: 飞书视图加载失败 ${code} ${description} ${target}\n`);
      if (!win.webContents.isDestroyed()) win.webContents.send("idou:feishu-view-failed", { code, description, url: target });
    });
    // A redirect can replace the first navigation, which rejects the original
    // load even though the view is fine. Treat a view that ended up on a Feishu
    // page as loaded rather than reporting a failure the person cannot act on.
    contents.on("did-finish-load", () => {
      entry.settled = true;
      // A load that finishes on screen gets the same look as one shown later.
      if (feishuViewGroup.visible === kind) reviveStalledView(kind, entry);
    });
    // Every navigation drops the injected sheet, so it is reapplied per document.
    contents.on("dom-ready", () => { entry.railKey = null; void applyFeishuRail(entry); });
    // Only the messenger counts anything; the drive's title is a folder name.
    if (kind === "messenger") watchFeishuUnread(contents, value => {
      if (feishuViews.get(kind) === entry) unread.report(value);
    });
    if (!feishuViewGroup.register(kind, entry, generation)) return null;
    // A warming view still needs a workable viewport, or Feishu lays itself out
    // for a zero-width window and has to reflow the moment it is shown.
    const [width, height] = win.getContentSize();
    view.setBounds({ x: 0, y: 0, width, height });
    // The page load is not awaited inside the serialised section. A Feishu
    // page can take a long time to settle, and one that never settles used to
    // hold the queue: every later open — including the person's own click —
    // waited behind a stuck warm-up with no way out. Failure is still handled,
    // as an event: a real load failure tears the view down, and did-fail-load
    // above has already told the renderer.
    entry.loading = contents.loadURL(url).catch((error) => {
      const landed = liveContents(view)?.getURL() ?? "";
      if (entry.settled || feishuPage(landed)) {
        process.stderr.write(`idou-desktop: 首次导航被重定向取代，视图已停在 ${landed}\n`);
        return;
      }
      if (feishuViews.get(kind) === entry) {
        feishuViewGroup.remove(kind, entry);
      }
      process.stderr.write(`idou-desktop: 飞书页面加载失败 ${String(error?.message ?? error).slice(0, 160)}\n`);
    });
    // A fast page still opens fully drawn: give it a moment, but only a moment.
    await Promise.race([entry.loading, new Promise((resolve) => setTimeout(resolve, 4000))]);
    return entry;
  };
  const hideFeishuView = async () => {
    feishuViewGroup.hide();
    placeProbeView();
  };
  bind("hide-feishu-view", hideFeishuView);
  win.webContents.on("did-start-navigation", details => {
    if (details.isMainFrame && !details.isSameDocument) void hideFeishuView();
  });
  win.webContents.on("render-process-gone", () => { void hideFeishuView(); });
  // Where the person has navigated inside the embedded Feishu view. Only a
  // document reference is ever returned: the renderer gets the same shape the
  // document reader accepts, never an arbitrary page address or query string.
  // Only the page's own top frame, on a Feishu origin, speaks for the page. A
  // frame of some other origin inside it -- or a frame already navigated away --
  // does not.
  const fromFeishuPage = (event) => {
    const entry = [...feishuViews.entries()].find(([, item]) => liveContents(item.view) === event.sender);
    const frame = event.senderFrame;
    if (!entry || !frame || frame !== event.sender.mainFrame || !feishuPage(frame.url ?? "")) return null;
    return entry;
  };
  ipcMain.on("idou:feishu-selection", (event, value) => {
    const entry = fromFeishuPage(event);
    if (!entry || !value || typeof value !== "object") return;
    const text = typeof value.text === "string" ? value.text.slice(0, 2000) : "";
    const label = typeof value.label === "string" ? value.label.slice(0, 60) : "";
    if (!text && !label) { feishuSelection.delete(entry[0]); return; }
    feishuSelection.set(entry[0], { text, label, truncated: value.truncated === true, at: Date.now() });
  });
  ipcMain.on("idou:feishu-chat", (event, value) => {
    const entry = fromFeishuPage(event);
    if (!entry || !value || typeof value !== "object") return;
    const name = typeof value.name === "string" ? value.name.slice(0, 30) : "";
    if (!name) { feishuChat.delete(entry[0]); return; }
    feishuChat.set(entry[0], { name, at: Date.now() });
  });
  // A document view is named by its address; the messenger is not — whichever
  // conversation is open, the address stays the same — so it is named by what its
  // own header says, and the selection rides along with either.
  bind("feishu-view-location", (kind) => {
    const contents = liveContents(feishuViews.get(kind)?.view);
    if (!contents) return null;
    const reference = feishuProvider.references.resource(contents.getURL());
    const selection = feishuSelection.get(kind) ?? null;
    // The page's title comes along: the address identifies the document, but a
    // person reading the dock wants its name, not a token.
    if (reference) return { ...reference, title: contents.getTitle(), selection };
    const chat = feishuChat.get(kind) ?? null;
    return chat && { chat, selection };
  });
  // Opening, warming and switching all move the same set of views, so they are
  // serialised: two of them running at once produced views nobody owned.
  let feishuOpening = Promise.resolve();
  const serialiseFeishuView = (operation) => {
    const previous = feishuOpening;
    let release; feishuOpening = new Promise(resolve => { release = resolve; });
    return previous.catch(() => {}).then(operation).finally(() => release());
  };
  // A Feishu page opened from 飞书消息 goes to 飞书文档's view -- built if it is
  // not yet -- and the window is told to show that section. The view keeps the
  // section's own address as its `url`, so showing the section shows this page
  // rather than reloading the section's home over it.
  const openInFeishuDocs = (target) => serialiseFeishuView(async () => {
    if (quitting || switching || !feishuPage(target)) return;
    const origin = await knownFeishuOrigin();
    const home = origin && sectionUrl("drive", origin);
    if (!home) return;
    let entry = feishuViews.get("drive");
    if (entry && !liveContents(entry.view)) { feishuViewGroup.remove("drive", entry); entry = undefined; }
    if (entry) {
      entry.settled = false; entry.revived = false;
      void liveContents(entry.view)?.loadURL(target).catch(() => {});
    } else {
      entry = await buildFeishuView("drive", target);
      if (entry) entry.url = home;
    }
    if (entry && !win.webContents.isDestroyed()) win.webContents.send("idou:feishu-open-docs");
  });
  bind("open-feishu-view", target => {
    const ticket = feishuViewGroup.beginOpen();
    return serialiseFeishuView(() => openFeishuView(target, ticket));
  });
  const openFeishuView = async (target, ticket) => {
    if (!feishuViewGroup.current(ticket)) return { cancelled: true };
    if (scope?.enterprise && !auth.status().connected) throw new Error("请先在「设置 → 飞书账号」使用飞书登录，再使用飞书原样视图。");
    feishuProvider.require("webPages");
    const kind = target?.kind;
    let url;
    if (kind === "document") {
      // Only a link the reader itself accepts, so this view can never be pointed
      // at an arbitrary page by a task, a document or a model reply.
      url = feishuProvider.references.document(target.url).url;
      await rememberFeishuOrigin(url);
    } else if (kind === "home" || kind === "messenger" || kind === "drive") {
      const origin = await knownFeishuOrigin();
      // Named for what is actually on screen. This used to point at 「文件与协作」,
      // a section that no longer exists — the file surface was folded into the
      // task panel — so the instruction sent people looking for nothing.
      if (!origin) { const error = new Error("还不知道你所在的飞书域名。在工作任务里点「任务文件」→「⋯」→「打开飞书内容」，打开一次飞书文档，之后这里就会记住它。"); error.needsFeishuOrigin = true; throw error; }
      url = sectionUrl(kind, origin);
    } else throw new Error("不支持的飞书视图");
    if (!feishuViewGroup.current(ticket)) return { cancelled: true };
    if (!feishuPage(url)) throw new Error("只允许打开飞书自己的页面");
    let entry = feishuViews.get(kind);
    if (entry && !liveContents(entry.view)) { feishuViewGroup.remove(kind, entry); entry = undefined; }
    if (!entry) entry = await buildFeishuView(kind, url, ticket.generation);
    // A document view is bound to one document, so pointing the section at a
    // different one reloads the view it already has instead of building another.
    // And a messenger found on a document -- left there by a build from before
    // links were routed away from it -- goes back to the conversations.
    else if (entry.url !== url || (kind === "messenger" && feishuProvider.references.resource(liveContents(entry.view)?.getURL() ?? ""))) {
      entry.url = url; entry.settled = false; entry.revived = false;
      // Same rule as the first load: start it, give it a moment, never wait on it.
      entry.loading = liveContents(entry.view)?.loadURL(url).catch(() => {}) ?? Promise.resolve();
      await Promise.race([entry.loading, new Promise((resolve) => setTimeout(resolve, 4000))]);
    }
    // Position before showing: a view revealed at its warm-up size and then
    // moved is a visible jump on every entry.
    const bounds = clampBounds(target?.bounds);
    if (!entry || feishuViews.get(kind) !== entry || !feishuViewGroup.show(kind, ticket, bounds)) return { cancelled: true };
    placeProbeView();
    reviveStalledView(kind, entry);
    ensureWebIdentity("auto");
    return { url, kind };
  };
  // Loading the sections up front is the difference between a tab that is
  // already there and one that spends seconds building itself while watched.
  const warmFeishuViews = () => {
    const generation = feishuViewGroup.generation;
    return serialiseFeishuView(async () => {
      if (quitting || switching || (scope?.enterprise && !auth.status().connected)) return;
      const origin = await knownFeishuOrigin();
      if (!origin || generation !== feishuViewGroup.generation) return;
      for (const kind of ["messenger", "drive"]) {
        if (quitting || switching || generation !== feishuViewGroup.generation) return;
        if (feishuViews.has(kind)) continue;
        // One at a time: two Feishu clients booting together only slow each other
        // down, and a failure to warm one must not stop the other.
        await buildFeishuView(kind, sectionUrl(kind, origin), generation).catch(() => {});
      }
      if (generation === feishuViewGroup.generation) ensureWebIdentity("auto");
    });
  };
  bind("feishu-view-rail", async (hidden) => {
    feishuRailHidden = hidden !== false;
    await Promise.all([...feishuViews.values()].map(entry => applyFeishuRail(entry)));
    return { hidden: feishuRailHidden };
  });
  // The embedded view keeps its own Feishu web session, so the first use needs a
  // sign-in inside it. These move the same view; they never create a second one
  // and never leave Feishu's own domains.
  bind("feishu-view-navigate", async (target) => {
    const entry = feishuViews.get(feishuViewGroup.visible);
    const contents = entry && liveContents(entry.view);
    if (!contents) throw new Error("飞书视图未打开");
    const origin = await knownFeishuOrigin();
    const url = target?.kind === "document" ? feishuProvider.references.document(target.url).url
      : origin && sectionUrl(target?.kind, origin);
    if (!url || !feishuPage(url)) throw new Error("只允许打开飞书自己的页面");
    entry.url = url;
    await contents.loadURL(url);
    return { url };
  });
  bind("feishu-view-bounds", (rect) => {
    const entry = feishuViews.get(feishuViewGroup.visible);
    if (!entry) return;
    const bounds = clampBounds(rect);
    if (!bounds) throw new Error("Invalid view bounds");
    feishuViewGroup.place(bounds);
    placeProbeView();
  });
  // Authorizing in the app's own window rather than in the system browser. The
  // page is Feishu's real consent page and the callback is our loopback control
  // plane, so this view may go to exactly those two places and nowhere else.
  //
  // The same browser session the person already uses for Feishu inside this app.
  // Authorizing is a browser act, and asking them to sign in to Feishu a second
  // time just to approve — in a partition that starts out empty — is how a
  // consent page ends up stuck on a splash screen with nothing to consent to.
  // Only a real signed-in account's partition qualifies; otherwise this falls
  // back to a partition of its own.
  const LOGIN_PARTITION = "feishu-auth";
  const loginPartitionName = async () => {
    const namespace = path.basename(scope.root);
    if (/^[0-9a-f]{64}$/.test(namespace)) return await feishuPartition();
    try {
      const claim = JSON.parse(await readFile(legacyFeishuClaimFile, "utf8"))?.namespace;
      if (typeof claim === "string" && /^[0-9a-f]{64}$/.test(claim)) return LEGACY_FEISHU_PARTITION;
    } catch { /* nothing claimed yet */ }
    return LOGIN_PARTITION;
  };
  let loginView = null, loginBounds = null, loginRevision = 0;
  const loginNavigationAllowed = (target) => {
    let url; try { url = new URL(target); } catch { return false; }
    if (url.username || url.password) return false;
    const origin = initialConfig.controlPlane.baseUrl;
    if (origin && url.protocol === "http:" && url.origin === origin) return true;
    // And back to this machine, with the secret that completes the sign-in:
    // exactly the address this sign-in listens on, nothing else on loopback.
    const returning = auth.loginReturnUrl();
    if (returning && `${url.origin}${url.pathname}` === returning) return true;
    return feishuPage(target);
  };
  const closeLoginView = async () => {
    loginRevision++;
    const current = loginView; loginView = null; loginBounds = null;
    if (!current) return;
    try { win.contentView.removeChildView(current); } catch { /* already detached */ }
    liveContents(current)?.close();
  };
  const openLoginView = async (launchUrl) => {
    if (!loginNavigationAllowed(launchUrl)) throw new Error("授权入口地址无效");
    const closing = closeLoginView(), revision = loginRevision;
    await closing;
    const partition = await loginPartitionName();
    if (revision !== loginRevision || quitting) return { cancelled: true };
    const view = paintSurface(new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: `persist:${partition}` } }));
    const contents = view.webContents;
    contents.setUserAgent(contents.getUserAgent().replace(/\s*(Electron|MyDouBao|我的豆包|i豆)\/[^\s]+/g, ""));
    contents.setWindowOpenHandler(({ url: target }) => {
      // Feishu opens help and account pages in new windows; those belong in the
      // real browser, never as a second view inside the app.
      if (/^https:/.test(target)) void shell.openExternal(target).catch(() => {});
      return { action: "deny" };
    });
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    contents.session.setPermissionCheckHandler(() => false);
    contents.session.on("will-download", event => event.preventDefault());
    contents.on("will-navigate", (event, target) => { if (!loginNavigationAllowed(target)) event.preventDefault(); });
    // Redirects included: the sign-in goes Feishu -> control plane and nowhere else.
    contents.on("will-redirect", (details) => { if (details.isMainFrame && !loginNavigationAllowed(details.url)) details.preventDefault(); });
    // The callback is the end of the browser's part. Tell the view to stand down
    // and let the app's own polling finish the login.
    contents.on("did-navigate", (_event, target) => {
      if (!target.startsWith(`${initialConfig.controlPlane.baseUrl}/auth/feishu/callback`)) return;
      if (!win.webContents.isDestroyed()) win.webContents.send("idou:login-callback");
    });
    loginView = view;
    win.contentView.addChildView(view);
    view.setBounds(loginBounds ?? { x: 0, y: 0, width: 0, height: 0 });
    try { await contents.loadURL(launchUrl); }
    catch (error) {
      // A redirect can supersede the first navigation; that is not a failure.
      if (revision !== loginRevision) return { cancelled: true };
      if (!loginNavigationAllowed(liveContents(view)?.getURL() ?? "")) { await closeLoginView(); throw new Error(`授权页面加载失败：${String(error?.message ?? error).slice(0, 160)}`); }
    }
    return { opened: true };
  };
  bind("close-login-view", closeLoginView);
  bind("login-view-bounds", (rect) => {
    const bounds = clampBounds(rect);
    if (!bounds) throw new Error("Invalid login view bounds");
    loginBounds = bounds;
    if (loginView) loginView.setBounds(bounds);
  });
  bind("open-login-external", () => { if (auth.status().launchUrl) void shell.openExternal(auth.status().launchUrl).catch(() => {}); return { opened: true }; });
  bind("media-preview-bounds", (rect) => mediaPreview.bounds(rect));
  bind("close-media-preview", () => mediaPreview.close());
  bind("preview-bounds", (rect) => {
    if (!preview) return;
    const bounds = clampBounds(rect);
    if (!bounds) throw new Error("Invalid preview bounds");
    preview.view.setBounds(bounds);
    preview.view.setVisible(bounds.width > 0 && bounds.height > 0);
  });
  const beginShutdown = () => {
    if (quitting) return; quitting = true;
    // A card still waiting is answered as the cancelling choice, as it is when
    // the window reloads or the account changes: quitting is not consent. Left
    // waiting, the operation that raised it stayed in flight and the quit below
    // waited out its five-minute timeout -- the app took five minutes to quit
    // (found when the acceptance run first stopped smokes at their cards,
    // 2026-09-25).
    settleConfirm(pendingConfirm?.cancelId ?? 0, "quitting");
    destroyFeishuViews(); closeSitePreview();
    scope.chatReader.close(); scope.terminals.closeAll();
    scope.scheduleChatReader.close();
    scope.sheets.dispose(); scope.bases.dispose();
    const closingDiscovery = scope.discovery.close(), closingPublication = scope.wikiPublication.close(), closingReception = scope.wikiReception.close();
    Promise.allSettled([...inFlight, closingDiscovery, closingPublication, closingReception]).then(() => { scope.previews.closeAll(); return Promise.allSettled([hidePreview(), mediaPreview.close(), scope.media.close(), scope.taskUi.flush(), scope.service.close(), scope.wiki.close(), scope.cliSidecar?.close(), agentBridge?.close(), auth.close()]); }).finally(() => app.quit());
  };
  let quitFlushPending = false;
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    if (quitFlushPending) return;
    quitFlushPending = true;
    let finished = false;
    const finish = () => { if (finished) return; finished = true; clearTimeout(timer); ipcMain.removeListener("idou:task-ui-flushed", received); beginShutdown(); };
    const received = event => { if (event.sender === win.webContents) finish(); };
    const timer = setTimeout(finish, 1_500);
    ipcMain.on("idou:task-ui-flushed", received);
    win.webContents.send("idou:flush-task-ui");
  });
  win.on("close", (event) => { if (!quitting) { event.preventDefault(); app.quit(); } });
  app.on("second-instance", () => { win.show(); win.focus(); });
  await win.loadURL(entryUrl);
  // Shown, but never brought to the front: showInactive is the difference
  // between a suite you can work through and one that owns the screen.
  if (background && !win.isDestroyed()) win.showInactive();
  // Coming back without a browser, when the last account left a credential for
  // this same control plane. A failure here is silent and simply leaves the
  // ordinary sign-in button in place.
  void (async () => {
    const configured = auth.serverUrl;
    if (!configured) { process.stderr.write("idou-desktop: 续用本机登录跳过（未配置企业服务端）\n"); return; }
    let pointer; try { pointer = JSON.parse(await readFile(lastAccountFile, "utf8")); }
    catch { process.stderr.write("idou-desktop: 续用本机登录跳过（本机还没有登录过这个服务端）\n"); return; }
    if (pointer?.serverUrl !== configured || !/^[a-f0-9]{64}$/.test(pointer?.namespace ?? "")) {
      process.stderr.write("idou-desktop: 续用本机登录跳过（上次登录的服务端与当前配置不同）\n"); return;
    }
    const resumed = await auth.resume(pointer.namespace).catch(() => null);
    // One line, so an operator can tell "no stored login" from "the stored login
    // was refused" without opening the settings panel.
    process.stderr.write(`idou-desktop: 续用本机登录${resumed?.connected ? "成功" : `未成功${resumed?.resumeFailure ? `：${resumed.resumeFailure}` : "（本机没有可用的登录凭据）"}`}\n`);
    if (win.webContents.isDestroyed()) return;
    // The view was drawn as signed out; tell it the account is back rather than
    // leaving it that way until its next scheduled check.
    win.webContents.send("idou:auth-changed", auth.status().connected);
    win.webContents.send("idou:changed", scope.service.snapshot());
    void warmFeishuViews().catch(() => {});
  })();
  void warmFeishuViews().catch(() => {});
}
