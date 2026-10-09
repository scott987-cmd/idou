#!/usr/bin/env node
import "../src/adopt-legacy-env.js";
import { mkdir, readdir, rm, writeFile, rename, unlink } from "node:fs/promises";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { loadCapacity, loadMetricsPort, loadScheduleExecution, loadWorkerName, loadDataStore, loadCoordinatorLease, loadEgressRemote, loadEgressUpstream, loadChatModelConfigs, loadMediaKey, loadVideoKey, loadFeishuLoginConfig, loadFeishuProvider, loadSitesConfig, loadAdminConsoleConfig, loadAuditRetention, loadUnattendedScheduleConfig, loadScheduleNotifyConfig, loadAdminAlerts, loadBackupDir, loadProcessName, loadRunDetailRetention, loadSchedulePromptRetention, loadSandboxMode, loadSandboxImage, loadSandboxRuntime, loadSandboxGateway, loadSandboxUser, loadSandboxNetwork, withheldFromWorker } from "../src/control-plane/server-config.js";
import { FeishuOAuthProvider } from "../src/control-plane/feishu-oauth-provider.js";
import { FeishuBot } from "../src/control-plane/feishu-bot.js";
import { FeishuLoginService } from "../src/control-plane/feishu-login.js";
import { EnterpriseSkillCatalog } from "../src/control-plane/skill-catalog.js";
import { McpBroker } from "../src/control-plane/mcp-broker.js";
import { MiniMaxMediaProvider } from "../src/control-plane/minimax-media.js";
import { QwenVideoProvider } from "../src/control-plane/qwen-media.js";
import { MediaService, MEDIA_UNAVAILABLE, unconfiguredMedia } from "../src/control-plane/media-service.js";
import { FeishuSourceAccess } from "../src/control-plane/feishu-source-access.js";
import { AppRuntimeService } from "../src/control-plane/app-runtime-service.js";
import { FeishuCliProxyService } from "../src/control-plane/feishu-cli-proxy.js";
import { ScheduleConsent } from "../src/control-plane/schedule-consent.js";
import { ModelHealth } from "../src/control-plane/model-health.js";
import { ModelChoiceService, ModelPreferences, PostgresModelPreferences } from "../src/control-plane/model-choice.js";
import { loadDatabaseConfig, loadWorkerDatabaseConfig, openDatabase, openSharedState, readRunQueueKey, runQueueKey } from "../src/control-plane/database.js";
import { TrafficMeter } from "../src/control-plane/process-status.js";
import { dataHome } from "../src/install-names.js";
import { storePlaces } from "../src/control-plane/person-data.js";

// How long a SIGTERM may take before the process ends regardless (closeAll).
// Shorter than systemd's 90 seconds, so a restart is bounded by this file.
const SHUTDOWN_GRACE_MS = 60_000;

// `--feishu` or `--dev`, optionally followed by a role: `--role api`, a
// replica that serves the model and nothing else (docs/scaling-plan.md §2.3);
// `--role worker`, one that runs scheduled tasks from the queue (step 3).
// Without one, the coordinator: everything, as before.
function parseArguments(args) {
  const [mode, ...rest] = args;
  const role = rest.length === 0 ? "coordinator" : rest.length === 2 && rest[0] === "--role" && ["api", "worker"].includes(rest[1]) ? rest[1] : null;
  if (!["--dev", "--feishu"].includes(mode) || !role) throw new Error("Use --dev for local bootstrap or --feishu for configured OAuth login, optionally followed by --role api or --role worker");
  return { mode, role };
}

// How long a replica that was asked to stop lets the answers it is streaming
// finish. New requests already go to the other replicas; what is still
// streaming after this is cut, and Codex asks again.
const DRAIN_MS = 45_000;

async function main() {
  const { mode, role } = parseArguments(process.argv.slice(2));
  // Read now, so a setting that is wrong stops the start before anything listens.
  if (role !== "worker") loadProcessName(role, null);
  // Only the coordinator checks backups: a wrong path must not stop the model replicas.
  if (role === "coordinator") loadBackupDir();
  // Read first, so a mistyped limit stops the server with its name rather than
  // after half of it has started.
  const capacity = loadCapacity();
  const metricsPort = loadMetricsPort();
  // A worker is given the queue and its key, and none of what the replicas
  // seal their shared state with: it starts apart from all of that.
  if (role === "worker") return serveRuns({ mode, capacity, metricsPort, startedAt: Date.now(), log: (line) => process.stderr.write(`${JSON.stringify(line)}\n`) });
  const databaseConfig = loadDatabaseConfig();
  // A replica is only a replica if the others can see what it sees.
  if (role === "api" && !databaseConfig) throw new Error("API 副本需要共享会话：请设置 IDOU_DATABASE_URL 和 IDOU_STATE_KEY_FILE");
  const execution = role === "coordinator" ? loadScheduleExecution() : "local";
  // Where the durable data lives: this machine's files, or the shared database.
  const dataStore = loadDataStore();
  // These keep ledgers of their own on this machine's disk, and have no place
  // in the shared database yet. With the rest of the data there, a coordinator
  // started on another machine would find them empty -- so the two are not
  // combined until they have one. Asked before anything is opened.
  const unshared = role === "coordinator" && dataStore === "postgres"
    ? ["IDOU_APPS_CONFIG_FILE", "IDOU_WIKI_CONFIG_FILE", "IDOU_WIKI_KEY_CONFIG_FILE"].filter((name) => process.env[name]) : [];
  if (unshared.length) throw new Error(`IDOU_DATA_STORE=postgres 时还不能开启 ${unshared.join("、")}：它们的数据只能放在本机文件里，协调副本换到别的机器会找不到。先不开这几项，或者数据留在本机（不设 IDOU_DATA_STORE）。`);
  const startedAt = Date.now();
  const log = (line) => process.stderr.write(`${JSON.stringify(line)}\n`);
  // With a database, sessions are shared with the other replicas and outlive
  // this process (docs/scaling-plan.md §2.2). Without one, they live in this
  // process only, as they always have.
  const shared = databaseConfig ? await openSharedState(databaseConfig, { log }) : null;
  // The administration data (docs/admin-console.md): in the shared database
  // whenever there is one -- every model replica has to know at once who has
  // been disabled -- else in a file of this machine's, or in memory on a
  // development server. Who may not use the deployment is asked of it before
  // any session is accepted or issued, by every process.
  const { openAdminDatabase } = await import("../src/control-plane/admin-db.js");
  const { AccessList } = await import("../src/control-plane/access-list.js");
  const adminDb = shared ? await openAdminDatabase({ pool: shared.pool, connect: shared.connect, log })
    : await openAdminDatabase({ file: mode === "--dev" ? null : path.join(dataHome(), "admin.sqlite"), log });
  const access = await AccessList.open({ db: adminDb, log });
  const sessions = new SessionRegistry(shared ? { state: shared.state, routeKey: shared.routeKey, access, log } : { access, log });
  // Expired records are invisible to every reader already; this only keeps the
  // table small. Every replica may do it: it removes nothing still alive.
  const sweeper = shared ? setInterval(() => { void shared.state.sweep().catch((error) => log({ component: "state", event: "sweep-failed", message: String(error?.message ?? error).slice(0, 200) })); }, 5 * 60_000) : null;
  sweeper?.unref();
  if (shared) process.stdout.write("Sessions: shared through PostgreSQL (IDOU_DATABASE_URL).\n");
  const loginConfig = mode === "--feishu" ? loadFeishuLoginConfig() : null;
  // The one Feishu deployment this control plane serves, chosen once and handed
  // to everything below that talks to Feishu or checks what Feishu said.
  const feishu = loginConfig?.feishu ?? loadFeishuProvider();
  if (role === "api") return serveModelOnly({ mode, loginConfig, feishu, capacity, metricsPort, startedAt, shared, sessions, sweeper, dataStore, access, adminDb, log });
  // One coordinator at a time on the shared durable data (docs/scaling-plan.md
  // §2.6): this one takes the lease, or stands by -- opening none of the data
  // and binding nothing -- until it is given up or lapses.
  const lease = dataStore === "postgres" ? await coordinatorLease({ shared, log }) : null;
  // The audit trail the console reads, and the directory of everybody who has
  // signed in (people-directory.js) -- filled from the sessions this process
  // issues: a sign-in or resume is written at once, a renewal at most every
  // ten minutes, a scheduled run acting for somebody not at all.
  const { AuditLog } = await import("../src/control-plane/audit-log.js");
  const { PeopleDirectory } = await import("../src/control-plane/people-directory.js");
  const auditLog = await AuditLog.open({ db: adminDb, retentionDays: loadAuditRetention(), log });
  const people = await PeopleDirectory.open({ db: adminDb, log });
  sessions.on("issued", (session, { kind }) => {
    if (session.authProvider !== "feishu" || kind === "unattended") return;
    people.seen({ tenantId: session.tenantId, userId: session.userId, name: session.displayName ?? "", signIn: kind !== "renewal" });
  });
  const pruneAudit = () => { void auditLog.prune().catch((error) => log({ component: "audit", event: "audit-prune-failed", message: String(error?.message ?? error).slice(0, 200) })); };
  pruneAudit();
  const auditPruning = setInterval(pruneAudit, 6 * 3600_000); auditPruning.unref();
  const sourceAccess = loginConfig?.sourceAccessEnabled ? new FeishuSourceAccess({ feishu, sessions, appId: loginConfig.appId, originalOrigins: loginConfig.originalOrigins, bundleReadsEnabled: loginConfig.bundleReadsEnabled, identityChecksEnabled: loginConfig.identityChecksEnabled, cliProxyScopes: loginConfig.cliProxyScopes, cliWriteActions: loginConfig.cliWriteActions, scheduleResourcesEnabled: process.env.IDOU_SCHEDULED_TASKS === "1", capacity: capacity.sourceAccess, state: shared?.state ?? null, log }) : null;
  // Hashed identifiers and outcome class only; never a token, body or document text.
  const { cliWriteTrail, siteTrail, mediaTrail } = await import("../src/control-plane/audit-trail.js");
  // The policy engine is built with the models, a few lines below; the write
  // proxy is made first and asks it through this.
  let policyEngine = null;
  const lazyPolicy = { permits: (who, feature) => policyEngine ? policyEngine.permits(who, feature) : Promise.resolve(true) };
  // Each line to stderr as before; who it was, beside it, into the console's trail.
  const trailed = (component, map) => (event, context) => {
    process.stderr.write(`${JSON.stringify({ component, ...event })}\n`);
    const row = context ? map(event, context) : null;
    if (row) auditLog.record(row);
  };
  const cliProxy = sourceAccess?.cliProxyEnabled ? new FeishuCliProxyService({ sourceAccess, ...capacity.feishuCli, audit: trailed("feishu-cli-write", cliWriteTrail), policy: lazyPolicy }) : null;
  // Hoisted out of the login service: unattended scheduled runs adopt a stored
  // refresh token through this same provider, so it needs a name.
  const provider = loginConfig ? new FeishuOAuthProvider({ ...loginConfig, sessions, sourceAccess, renewalCapacity: capacity.renewal, state: shared?.state ?? null, log, diagnostic: message => process.stderr.write(`idou-server: ${message}\n`) }) : null;
  // A session read from the shared store comes with its grants, so every
  // service takes it and a restart signs nobody out (docs/scaling-plan.md §2.4).
  if (shared && sourceAccess) sessions.addLoader((root) => sourceAccess.load(root.id));
  if (shared && provider?.renewal) sessions.addLoader((root) => provider.renewal.load(root.id));
  const login = loginConfig ? new FeishuLoginService({ ...loginConfig, sessions, provider, capacity: capacity.login, access, audit: (event) => auditLog.record(event),
    seen: (identity, client) => people.seen({ tenantId: identity.tenantId, userId: identity.userId, client }) }) : null;
  // In the shared database when the durable data lives there (§2.5).
  const durable = dataStore === "postgres" ? shared.state : null;
  const skills = loginConfig ? await EnterpriseSkillCatalog.fromConfig({ origin: loginConfig.origin, sessions, state: durable }) : null;
  const mcp = loginConfig ? await McpBroker.fromConfig({ origin: loginConfig.origin, sessions, feishu, capacity: capacity.mcp }) : null;
  const { chat, chatModels, health, visibility, usage, policyBot, groups, policyStore, meter, org } = await modelParts({ mode, loginConfig, feishu, shared, dataStore, adminDb, log });
  // What the organisation decides about its enterprise skills beyond the shelf
  // (docs/enterprise-skill-governance.md): review, versions, who sees which,
  // who used which, who else may publish. In the administration database.
  let skillGovernance = null, skillUsagePruning = null;
  if (skills?.registry && adminDb) {
    const { SkillGovernance } = await import("../src/control-plane/skill-governance.js");
    const { skillTrail } = await import("../src/control-plane/audit-trail.js");
    skillGovernance = await SkillGovernance.open({ db: adminDb, key: skills.usageKey(), log });
    skills.govern({ governance: skillGovernance, departmentsOf: org ? (who) => org.departmentsOf(who) : null, audit: trailed("skills", skillTrail), log });
    // Use kept 400 days, decided submissions 180 (skill-governance.js SKILL_LIMITS).
    const pruneSkills = () => { void skillGovernance.pruneUsage().catch(() => {}); void skillGovernance.pruneSubmissions().catch(() => {}); };
    skillUsagePruning = setInterval(pruneSkills, 24 * 3600_000);
    // And once now: a server restarted more often than daily would otherwise never get there.
    pruneSkills();
    skillUsagePruning.unref();
  }
  // The organisation read from Feishu's address book (org-sync.js), once a day
  // and when an administrator asks; it needs the application's own identity,
  // which reads the application's own tenant only -- so with one tenant
  // allowed, never several, or one tenant's departments could be filed
  // under another's.
  let orgSync = null, orgSyncSoon = null, orgSyncing = null;
  if (policyBot && loginConfig?.allowedTenants?.length === 1) {
    const { OrgSync } = await import("../src/control-plane/org-sync.js");
    orgSync = new OrgSync({ feishu, bot: policyBot, org, people, access, audit: (event) => auditLog.record(event), log });
    const tenant = loginConfig.allowedTenants[0];
    orgSyncSoon = setTimeout(() => { void orgSync.sync(tenant).catch(() => {}); }, 2 * 60_000); orgSyncSoon.unref();
    orgSyncing = setInterval(() => { void orgSync.sync(tenant).catch(() => {}); }, 24 * 3600_000); orgSyncing.unref();
  } else if (policyBot && loginConfig?.allowedTenants?.length > 1) {
    process.stderr.write("idou-server: 允许了多个租户，组织架构不同步：应用身份只读得到它自己那个租户的通讯录。\n");
  }
  policyEngine = visibility;
  const { PolicyService } = await import("../src/control-plane/policy.js");
  const policyService = new PolicyService({ sessions, engine: visibility, meter, allowDevelopment: mode === "--dev" });
  // The server's own checks (health-monitor.js), and, when the operator asked,
  // who is told about them. Asked here so a setting that cannot work stops the
  // start rather than an alert that never arrives.
  const alerts = loadAdminAlerts();
  if (alerts && !policyBot) throw new Error("IDOU_ADMIN_ALERTS=1 需要飞书应用（FEISHU_APP_ID、FEISHU_APP_SECRET）：告警由应用机器人发出。");
  const { EventTally, HealthMonitor, alertAdministrators, coordinatorChecks, readBackupStatus } = await import("../src/control-plane/health-monitor.js");
  // Where bin/backup.js writes, for the 备份 check (docs/service-status.md §4).
  const backupDir = loadBackupDir();
  const tally = new EventTally();
  let monitor = null;
  const modelChoice = new ModelChoiceService({ sessions, models: chatModels, health, visibility, allowDevelopment: mode === "--dev",
    preferences: durable ? await PostgresModelPreferences.open({ state: durable })
      : await ModelPreferences.open({ file: mode === "--dev" ? null : storePlaces().modelPreferences }) });
  // Image and speech keep MiniMax's key on whichever chat route; which key, and
  // when a missing one is fatal, is decided (and tested) in loadMediaKey. Video
  // goes to Qwen when a Token Plan key file is configured (loadVideoKey).
  const { enabled: mediaEnabled, mediaKey } = await loadMediaKey(chat.default);
  const videoKey = mediaEnabled ? await loadVideoKey() : null;
  const video = videoKey ? new QwenVideoProvider({ apiKey: videoKey }) : null;
  const media = mediaKey || video ? new MediaService({ sessions, provider: mediaKey ? new MiniMaxMediaProvider({ apiKey: mediaKey }) : null,
    providers: video ? { video } : {}, allowDevelopment: mode === "--dev", capacity: capacity.media, policy: visibility,
    audit: trailed("media", mediaTrail) })
    : mediaEnabled ? unconfiguredMedia : null;
  if (mediaEnabled && !mediaKey) process.stderr.write(`idou-server: ${video ? "图片不可用：服务端没有配置 MiniMax 密钥（MINIMAX_CONFIG_FILE 或 MINIMAX_API_KEY）；视频不受影响。" : MEDIA_UNAVAILABLE}\n`);
  if (video) { const { model, seconds, resolution, aspectRatio } = video.offer("video"); process.stderr.write(`idou-server: 视频生成走阿里云百炼 ${model}（${seconds} 秒 · ${resolution} · ${aspectRatio}，Qwen Token Plan）。\n`); }
  let drive = null;
  let apps = null;
  let appRuntime = null;
  let wiki = null;
  let sourceRegistry = null;
  let publisherKeys = null;
  if (process.env.IDOU_APPS_CONFIG_FILE) {
    const { AppCatalog, AppCatalogService } = await import("../src/control-plane/app-catalog.js");
    apps = new AppCatalogService({ sessions, catalog: await AppCatalog.fromConfig(process.env.IDOU_APPS_CONFIG_FILE, feishu), allowDevelopment: mode === "--dev" });
    appRuntime = new AppRuntimeService({ sessions, catalog: apps.catalog, allowDevelopment: mode === "--dev" });
  }
  if (process.env.IDOU_DRIVE_CONFIG_FILE) {
    const { DriveBudget, PostgresDriveBudget, DriveBudgetService } = await import("../src/control-plane/drive-budget.js");
    // The policies from the operator's file either way; the reservations in
    // the shared database when the durable data lives there (§2.5).
    const ledger = durable
      ? await PostgresDriveBudget.fromConfig(process.env.IDOU_DRIVE_CONFIG_FILE, feishu, { pool: shared.pool })
      : await DriveBudget.fromConfig(process.env.IDOU_DRIVE_CONFIG_FILE, feishu);
    drive = new DriveBudgetService({ sessions, ledger, allowDevelopment: mode === "--dev" });
  }
  if (process.env.IDOU_WIKI_CONFIG_FILE) {
    if (!drive) throw new Error("Wiki coordination requires IDOU_DRIVE_CONFIG_FILE");
    const { WikiCoordinator, WikiCoordinatorService } = await import("../src/control-plane/wiki-coordinator.js");
    wiki = new WikiCoordinatorService({ sessions, coordinator: await WikiCoordinator.fromConfig(process.env.IDOU_WIKI_CONFIG_FILE, drive.ledger), allowDevelopment: mode === "--dev" });
    if (sourceAccess) {
      const { WikiSourceRegistryService } = await import("../src/control-plane/wiki-source-registry.js");
      sourceRegistry = new WikiSourceRegistryService({ sessions, coordinator: wiki.coordinator, sourceAccess });
    }
  }
  if (process.env.IDOU_WIKI_KEY_CONFIG_FILE) {
    if (!login || !wiki || !sourceAccess) throw new Error("Wiki publisher keys require Feishu login, source access and Wiki coordination");
    const { WikiPublisherKeyService } = await import("../src/control-plane/wiki-key-service.js");
    publisherKeys = await WikiPublisherKeyService.fromConfig(process.env.IDOU_WIKI_KEY_CONFIG_FILE, { sessions, coordinator: wiki.coordinator, sourceAccess });
  }
  // Scheduled tasks are opt-in rather than on by default, because starting them
  // opens a TLS listener a sandbox can reach -- the rest of this control plane
  // is loopback-only, and an operator should choose that, not discover it.
  // Assigned after the gateway is listening, because a sandbox reaches the model
  // through this process and therefore needs the port it actually bound. The
  // handler below closes over the variable, not its value, so it sees this once
  // it is set. Computing the origin before listening gave `127.0.0.1:0` on any
  // server without a configured port -- which is every development one.
  // 文档网站: what other people open. Two pieces that never touch each other --
  // a loopback service the application publishes through, and a separate
  // listener that only ever serves what was published. Off unless an operator
  // named an address for it.
  const sitesConfig = loadSitesConfig();
  // Sign-in through Feishu, for the sites and the console alike. A site may
  // follow its table only where there is a Feishu login to ask.
  const siteOAuth = provider ? {
    authorizationUrl: (options) => provider.authorizationUrl(options),
    probeIdentity: (options) => provider.probeIdentity(options),
    // The visitor's own credential, kept by the listener for exactly one
    // purpose: asking Feishu whether this person may read that table.
    redeemVisitor: async ({ code, verifier, redirectUri }) => {
      const { token, user, requestedAt } = await provider.redeem({ code, verifier, redirectUri, scopes: provider.probeScopes });
      return { identity: { userId: user.open_id, tenantId: user.tenant_key },
        token: token.access_token, expiresAt: requestedAt + Math.min(token.expires_in, 86400) * 1000 };
    },
  } : null;
  let siteServer = null, adminServer = null, siteService = null, siteRegistry = null, sitesRoot = null, siteSafety = null, siteRescan = null, siteVisitors = null;
  if (sitesConfig) {
    const { SiteRegistry, PostgresSiteStorage } = await import("../src/control-plane/site-registry.js");
    const { createSiteServer, siteCookieKey } = await import("../src/control-plane/site-server.js");
    const { createSiteDemos } = await import("../src/control-plane/site-demos.js");
    const { baseCellText } = await import("../src/providers/feishu/base-reader.js");
    const { SiteService } = await import("../src/control-plane/site-service.js");
    const { viewPermissionPath, userTokenRefused } = await import("../src/providers/feishu/openapi.js");
    const root = storePlaces().sites(sitesConfig.directory);
    const registry = await SiteRegistry.open(root, durable ? { storage: await PostgresSiteStorage.open({ pool: shared.pool, state: shared.state, key: shared.key }) } : {});
    siteRegistry = registry; sitesRoot = root;
    // Every event is a JSON line on stderr, which is what an operator's log
    // collection keeps.
    const siteAudit = trailed("sites", siteTrail);
    const cookieKey = await siteCookieKey(root, { state: durable });
    // Content safety (docs/site-content-safety.md): every version, every change
    // of audience and every new set of data checked before it is shown; a
    // public page's words also read by the deployment's own chat model -- not
    // on a development server, whose model key is a placeholder.
    const { SiteSafety, scheduleRescans } = await import("../src/control-plane/site-safety.js");
    const { createModerator } = await import("../src/control-plane/site-moderation.js");
    siteSafety = await SiteSafety.open({ db: adminDb, key: createHmac("sha256", cookieKey).update("idou site-safety key").digest(),
      moderate: mode === "--dev" ? null : createModerator({ route: chat.default, log }), log });
    // Sites published before there were checks, checked a few minutes in; any
    // the model did not get to read, read again later (scheduleRescans).
    siteRescan = scheduleRescans({ registry, safety: siteSafety, log });
    // How often each site is opened, counted by day (the console's 访问).
    // Once for each opening (site-server.js `counted`).
    const servedAudit = (event) => {
      siteAudit(event);
      if (event?.event !== "site-access" || !event.counted) return;
      const site = registry.get(event.siteId);
      if (site) siteSafety.countVisit(site.tenantId, site.id, { anonymous: event.anonymous === true, allowed: event.counted === "visit" });
    };
    // Who opened each site, for its publisher (docs/sites-phase1.md §1.5).
    const { SiteVisitors } = await import("../src/control-plane/site-visitors.js");
    siteVisitors = await SiteVisitors.open({ db: adminDb, key: createHmac("sha256", cookieKey).update("idou site-visitors key").digest(),
      // The visitor's own department: the deepest of those they are in.
      departmentOf: org ? async (who) => {
        const ids = await org.departmentsOf(who);
        const depths = await org.depths(who.tenantId, ids);
        return ids.reduce((best, id) => (depths.get(id) ?? -1) > (depths.get(best) ?? -1) ? id : best, ids[0] ?? null);
      } : null,
      named: org ? (tenantId, ids) => org.named(tenantId, ids) : null });
    siteServer = createSiteServer({
      registry, origin: sitesConfig.origin, cookieKey, oauth: siteOAuth, access,
      anonymousAllowed: sitesConfig.anonymousAllowed, allowlist: sitesConfig.allow, audit: servedAudit,
      onView: ({ site, visitor, source }) => siteVisitors.view({ tenantId: site.tenantId, siteId: site.id, visitor, source }),
      // /demo: the templates themselves, with invented rows, for somebody who
      // has not got the application. It reads nothing and belongs to nobody,
      // and it is behind the same sign-in as any site here.
      demos: createSiteDemos({ renderCell: (value) => baseCellText(value) }),
      // Sharing with a group or a department (docs/sites-phase0.md §0.4): which
      // of the site's groups the visitor is in, as the application's bot reads
      // them, and every department they are in, with those above.
      // A read that fails is no answer (`unknown`), never "not in it".
      memberships: async (visitor, chats, { departments: asked = true } = {}) => {
        let unknown = false;
        const departments = org && asked ? await org.departmentsOf(visitor).catch(() => { unknown = true; return []; }) : [];
        const held = groups ? await Promise.all(chats.map(async (chatId) => (await groups.has(chatId, visitor.userId).catch(() => { unknown = true; return false; })) ? chatId : null)) : [];
        return { departments, chats: held.filter(Boolean), unknown };
      },
      // Feishu's yes (200, code 0, auth_result true) and no (auth_result
      // false) are answers; a token it no longer takes means the visitor signs
      // in again, and anything else is no answer (docs/sites-phase0.md §0.3).
      readsSource: async ({ site, credential }) => {
        if (!site.source?.token) return false;
        if (!credential?.token) return "relogin";
        const answer = await fetch(feishu.openApi.url(viewPermissionPath(site.source.kind, site.source.token)),
          { headers: { authorization: `Bearer ${credential.token}` }, signal: AbortSignal.timeout(8_000) });
        const body = await answer.json().catch(() => null);
        if (userTokenRefused(answer.status, body?.code)) return "relogin";
        if (!answer.ok || body?.code !== 0) return "unavailable";
        return body?.data?.auth_result === true;
      },
      // Held in the shared database where there is one: a restart, or another
      // coordinator taking over, does not send every visitor back to sign in.
      credentialStore: durable ? {
        get: async (handle) => (await durable.get("site-visitor", handle))?.value ?? null,
        put: (handle, credential) => durable.put("site-visitor", handle, credential, { ttlMs: Math.max(60_000, credential.expiresAt - Date.now()) }),
        delete: (handle) => durable.delete("site-visitor", handle),
      } : null,
    });
    await new Promise((resolve, reject) => { siteServer.once("error", reject); siteServer.listen(sitesConfig.port, sitesConfig.bind, resolve); });
    siteAudit({ event: "sites-listening", bind: sitesConfig.bind, port: sitesConfig.port, origin: sitesConfig.origin, anonymous: sitesConfig.anonymousAllowed });
    // Feishu checks the redirect URI against the ones registered for this
    // application, and refuses an unregistered one with its own error page
    // (code 20029) that says nothing about us. Measured live. An operator who
    // has just turned this on has no way to know that from the product, so the
    // exact addresses to register are named here, once, at startup.
    if (provider) {
      process.stderr.write(`idou-server: 文档网站的访客登录回调是 ${sitesConfig.origin}/_auth/callback，必须加进飞书开放平台该应用的「重定向 URL」，否则登录会停在飞书的错误页（20029）。\n`);
    } else {
      process.stderr.write("idou-server: 文档网站已开启，但这个服务端没有配置飞书登录，访客无法登录；只有「互联网上获得链接的人可阅读」这一档能用。\n");
    }
    siteService = new SiteService({ sessions, registry, origin: sitesConfig.origin, anonymousAllowed: sitesConfig.anonymousAllowed, groups,
      departments: org ? { search: async (tenantId, text, limit) => {
        const found = await org.search(tenantId, text, limit);
        const trails = new Map((await org.named(tenantId, found.map((department) => department.id))).map((named) => [named.id, named.path]));
        return found.map((department) => ({ ...department, trail: trails.get(department.id) ?? [department.name] }));
      } } : null,
      notify: (siteId, extra) => extra?.gone ? siteServer.forgetSite(siteId) : siteServer.notifySite(siteId),
      audit: siteAudit, allowDevelopment: mode === "--dev", policy: visibility, safety: siteSafety, access, visitors: siteVisitors });
  }

  let scheduled = null, runQueue = null;
  // How each model request ended, for 服务状态 (process-status.js).
  const traffic = new TrafficMeter();
  const server = createModelGateway({ models: chat.models, ...capacity.model, timeoutMs: Math.max(...chat.models.map((entry) => entry.timeoutMs ?? 180_000)), sessions, health, policy: visibility, meter, usage, traffic,
    authHandler: async (req, res) => Boolean(await modelChoice.handle(req, res)) || Boolean(await policyService.handle(req, res)) || Boolean(scheduled && await scheduled.service.handle(req, res)) || Boolean(siteService && await siteService.handle(req, res)) || Boolean(login && await login.handle(req, res)) || Boolean(cliProxy && await cliProxy.handle(req, res)) || Boolean(sourceAccess && await sourceAccess.handle(req, res)) || Boolean(sourceRegistry && await sourceRegistry.handle(req, res)) || Boolean(publisherKeys && await publisherKeys.handle(req, res)) || Boolean(skills && await skills.handle(req, res)) || Boolean(mcp && await mcp.handle(req, res)) || Boolean(media && await media.handle(req, res)) || Boolean(drive && await drive.handle(req, res)) || Boolean(appRuntime && await appRuntime.handle(req, res)) || Boolean(apps && await apps.handle(req, res)) || Boolean(wiki && await wiki.handle(req, res)) });
  // Explicit loopback-only bootstrap. No unauthenticated token-issuing HTTP route.
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(loginConfig?.port || 0, "127.0.0.1", resolve); });
  if (process.env.IDOU_SCHEDULED_TASKS === "1") {
    const { startScheduledTasks } = await import("../src/control-plane/scheduled-tasks.js");
    const dataDir = storePlaces().scheduledTasks;
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    // The identity an unattended run acts as. Held only while the person's own
    // login is live, and only after they have handed it over.
    const consent = new ScheduleConsent({ sessions, allowDevelopment: mode === "--dev",
      audit: event => process.stderr.write(`${JSON.stringify({ component: "schedule-consent", ...event })}\n`) });
    // Executed here, or queued for the workers of the execution pool.
    let pool = null;
    if (execution === "pool") {
      const { RunQueue } = await import("../src/control-plane/run-queue.js");
      const { PoolSandbox } = await import("../src/control-plane/sandbox/pool-sandbox.js");
      // Sealed with the queue's own key, all the workers are given of it.
      const queue = await RunQueue.open({ pool: shared.pool, connect: shared.connect, key: runQueueKey(shared.key) });
      shared.closeWith(() => queue.close());
      runQueue = queue;
      // Ended runs are kept a day for whoever asks, then removed.
      const pruning = setInterval(() => { void queue.prune().catch(() => {}); }, 3600_000); pruning.unref();
      // One coordinator at a time holds the shared data, so its runs are the
      // coordinator's, whichever machine it is on: the one that takes over
      // gives up those its predecessor left, as a restart gives up its own.
      pool = new PoolSandbox({ queue, owner: durable ? "coordinator" : createHash("sha256").update(path.resolve(dataDir)).digest("hex").slice(0, 16), log });
      process.stdout.write("Scheduled tasks: executed by the workers of the execution pool (IDOU_SCHEDULE_EXECUTION=pool).\n");
    }
    // Workers on other machines reach the egress proxy here (egress-relay.js).
    const remoteEgress = loadEgressRemote();
    const { PostgresUnattendedCredentialStore } = await import("../src/control-plane/unattended-credential.js");
    const { PostgresScheduleStore } = await import("../src/control-plane/schedule-store-postgres.js");
    scheduled = await startScheduledTasks({ feishu, sessions, sourceAccess, dataDir, consent, capacity: capacity.schedules, driveBudget: drive?.ledger ?? null,
      ...(durable ? { openCredentials: () => PostgresUnattendedCredentialStore.open({ state: durable }),
        openStore: ({ now, limits }) => PostgresScheduleStore.open({ pool: shared.pool, key: shared.key, now, limits }) } : {}),
      ...(pool ? { execution: { sandbox: pool } } : {}), ...(remoteEgress ? { remoteEgress } : {}),
      allowDevelopment: mode === "--dev",
      // The durable identity, when the operator asked for it. `provider` is null
      // on a development server, where there is no Feishu login to make durable.
      provider, allowedTenants: loginConfig?.allowedTenants ?? null,
      // The application speaking as itself, for the one message a scheduled run
      // sends. Built only when the operator asked for it: it is a different
      // authority from every other write here, so it is a decision rather than a
      // default. Absent on a development server, where there is no application.
      bot: loginConfig && loadScheduleNotifyConfig().bot
        ? new FeishuBot({ feishu, appId: loginConfig.appId, appSecret: loginConfig.appSecret,
          audit: event => process.stderr.write(`${JSON.stringify({ component: "feishu-bot", ...event })}\n`) })
        : null,
      // Validated even on a development server, where there is no Feishu login
      // to make durable: asking for it there is a mistake worth a named error at
      // startup rather than a setting that quietly does nothing.
      unattended: loadUnattendedScheduleConfig(),
      // How the unattended credential is obtained: a dedicated Feishu
      // authorization, redeemed here, never a copy of a live session's token.
      grants: login ? { begin: (who, redeemed) => login.beginGrant(who, redeemed), status: (who, flowId) => login.grantStatus(who, flowId) } : null,
      // How long a run's own words stay on the control plane. The row outlives
      // it; the text does not.
      runDetailDays: loadRunDetailRetention(),
      promptDays: loadSchedulePromptRetention(),
      // Development unless the operator says otherwise; production refuses a
      // deployment whose isolation does not actually hold.
      sandboxMode: loadSandboxMode(),
      // By digest in production; the lock's tag otherwise.
      ...(loadSandboxImage() ? { image: loadSandboxImage() } : {}),
      // gVisor in production. Where the container reaches the egress proxy, and
      // who it runs as, are the host's layout rather than defaults: on a Linux
      // server, the internal network's gateway and the control plane's own user.
      runtime: loadSandboxRuntime(),
      ...(loadSandboxGateway() ? { gatewayAddress: loadSandboxGateway() } : {}),
      ...(loadSandboxUser() ? { sandboxUser: loadSandboxUser() } : {}),
      ...(loadSandboxNetwork() ? { gatewayNetwork: loadSandboxNetwork() } : {}),
      // 8443 is a popular port; an operator who already has something there
      // should be able to move this rather than choose between the two.
      ...(process.env.IDOU_SCHEDULED_TASKS_PORT ? { egressPort: Number(process.env.IDOU_SCHEDULED_TASKS_PORT) } : {}),
      controlPlaneOrigin: `http://127.0.0.1:${server.address().port}`,
      liveSession: (tenantId, userId) => consent.live(tenantId, userId),
      // A run goes to its owner's model, resolved as their conversations are.
      modelFor: (tenantId, userId) => modelChoice.effective({ tenantId, userId }),
      // How runs end, pushes land and tasks are suspended, counted for the checks below.
      observe: (kind, detail) => tally.record(kind, detail),
      trail: (row) => auditLog.record(row),
      policy: visibility,
      log: message => process.stderr.write(`idou-server: ${message}\n`) });
    process.stdout.write(`Scheduled tasks: on. Sandbox egress listening on ${scheduled.egressAddress}:${scheduled.egressPort} (TLS, ${scheduled.certificate.hostname}).\n`);
    if (durable) process.stdout.write("Scheduled tasks: tasks and their runs are kept in the shared database (IDOU_DATA_STORE=postgres).\n");
    if (scheduled.remoteEgressAddress) process.stdout.write(`Scheduled tasks: egress for workers on other machines on ${scheduled.remoteEgressAddress.address}:${scheduled.remoteEgressAddress.port}, from ${remoteEgress.peers.join(", ")} only.\n`);
    if (!scheduled.sandboxReady) process.stdout.write("Scheduled tasks: the sandbox is not ready (the reason is logged above), so runs will be recorded as failures until it is.\n");
    if (!sourceAccess) process.stdout.write("Scheduled tasks: no Feishu login on this server, so tasks run but anything they ask of Feishu is refused.\n");
  }
  // The slug only: where the proxy listens and which of its groups serves the
  // slug are the operator's own settings, and the key is never printed. Then
  // where pictures and video are made, as configured: this said "image and
  // video stay on MiniMax" for a day after video moved to Qwen (2026-09-24).
  const mediaRoutes = !mediaEnabled ? "image and video generation off"
    : `images ${mediaKey ? "on MiniMax" : "unavailable"}, video ${video ? "on Qwen" : mediaKey ? "on MiniMax" : "unavailable"}`;
  process.stdout.write(`Chat models offered: ${chat.models.map((entry) => entry.model).join(", ")} (default ${chat.default.model}); ${mediaRoutes}.\n`);
  // Now, and every five minutes: what an operator needs to hear about
  // (health-monitor.js). Nobody is told of anything before its second look.
  const { LEDGER_CAPACITY } = await import("../src/control-plane/drive-budget.js");
  const { AdminDirectory } = await import("../src/control-plane/admin-directory.js");
  const adminConfig = loadAdminConsoleConfig();
  // What the checks said, and every alert sent, kept for the console's 服务状态
  // (process-status.js); and the processes themselves, checked like the rest.
  const { ProcessStatus, StatusHistory, readServiceStatus, readProcesses, processesCheck } = await import("../src/control-plane/process-status.js");
  const statusHistory = await StatusHistory.open({ db: adminDb, log });
  const workerBeats = runQueue ? () => runQueue.workers() : null;
  const statusPruning = setInterval(() => { void statusHistory.prune().catch(() => {}); }, 6 * 3600_000); statusPruning.unref();
  void statusHistory.prune().catch(() => {});
  monitor = new HealthMonitor({
    checks: coordinatorChecks({ dataDirectory: dataHome(), origins: [loginConfig?.origin, sitesConfig?.origin, adminConfig?.origin],
      scheduled, tally, ledger: drive?.ledger ?? null, capacity: LEDGER_CAPACITY, database: shared?.pool ?? null,
      models: health, defaultModel: chat.default.model, backupDir,
      processes: processesCheck({ read: () => readProcesses({ db: adminDb, workers: workerBeats }) }) }),
    record: (status) => statusHistory.recordSweep(status),
    notify: alerts ? alertAdministrators({ bot: policyBot, log: (line) => process.stderr.write(`${line}\n`), sent: (entry) => statusHistory.recordAlert(entry),
      directory: new AdminDirectory({ users: alerts.users, chatId: alerts.chatId,
        readChatMembers: groups ? (chatId) => groups.members(chatId).then((members) => [...members]) : null,
        log: (message) => process.stderr.write(`${JSON.stringify({ component: "health", event: "admin-directory", message })}\n`) }) }) : null,
    log: (line) => process.stderr.write(`${line}\n`) });
  const checkSafely = () => { void monitor.sweep().catch((error) => log({ component: "health", event: "sweep-failed", message: String(error?.message ?? error).slice(0, 200) })); };
  checkSafely();
  const checking = setInterval(checkSafely, 5 * 60_000); checking.unref();
  process.stdout.write(`Health checks: ${monitor.checks.length}, every 5 minutes${alerts ? "; alerts go to the administrators through the bot (IDOU_ADMIN_ALERTS=1)" : ""}.\n`);
  const { readReleaseManifest } = await import("../src/providers/release-manifest.js");
  const release = await readReleaseManifest().then((manifest) => manifest.releaseId, () => "unknown");
  // This process's heartbeat. Runs are counted here only when this process
  // runs them; with an execution pool they are the workers' to report.
  // Started as the coordinator now -- after any wait for the lease -- so the
  // one that takes over is seen to follow the one before.
  const processStatus = (await ProcessStatus.open({ db: adminDb, role: "coordinator", name: loadProcessName("coordinator", null), release, startedAt: Date.now(), traffic, log,
    sample: () => ({ sessions: liveSessions(sessions), model: modelLoad(server), cli: cliProxy ? cliLoad(cliProxy) : null,
      runs: scheduled?.scheduler && execution !== "pool" ? { active: scheduled.scheduler.running.size, limit: scheduled.scheduler.maxConcurrent } : null,
      unavailable: health?.unavailable?.() ?? [] }) })).start();
  // The administration console (docs/admin-console.md), on a listener and an
  // origin of its own. Who administers: IDOU_ADMIN_USERS (the way back in),
  // the members of IDOU_ADMIN_CHAT, and the roles granted in the console.
  let adminRoles = null;
  if (adminConfig) {
    const { AdminRoles } = await import("../src/control-plane/admin-roles.js");
    // Reading the administrator group is the bot's own credential, not anybody's
    // login, so it needs the application. A deployment with no Feishu
    // application can still name administrators in its own file.
    if (adminConfig.admins.chatId && !(policyBot && groups)) {
      process.stderr.write("idou-server: 设了 IDOU_ADMIN_CHAT，但这个服务端没有配置飞书应用，管理员群读不到；只有 IDOU_ADMIN_USERS 和后台授予的角色生效。\n");
    }
    const directory = new AdminDirectory({ users: adminConfig.admins.users, chatId: adminConfig.admins.chatId,
      // Through the shared cache, so one group read serves both this and the
      // model policy, and removing somebody matters at the same moment in both.
      readChatMembers: policyBot && groups ? (chatId) => groups.members(chatId).then((members) => [...members]) : null,
      log: (message) => log({ component: "admin-console", event: "admin-directory", message }) });
    adminRoles = await AdminRoles.open({ db: adminDb, directory, access, log });
    if (!adminConfig.admins.users.length && !adminConfig.admins.chatId && !adminRoles.granted.size) {
      process.stderr.write("idou-server: 设了 IDOU_ADMIN_URL，但没有任何管理员（IDOU_ADMIN_USERS / IDOU_ADMIN_CHAT）：管理台没有开启。\n");
    } else {
      const { createAdminServer, loadAdminAssets } = await import("../src/control-plane/admin-server.js");
      const { createAdminApi } = await import("../src/control-plane/admin-api.js");
      const { systemState } = await import("../src/control-plane/admin-console.js");
      const { siteCookieKey } = await import("../src/control-plane/site-server.js");
      const { personInventory, offboardLive } = await import("../src/control-plane/person-data.js");
      const api = createAdminApi({ people, access, roles: adminRoles, audit: auditLog, usage: usage.reports, sessions, sites: siteRegistry,
        forgetSite: (siteId) => siteServer?.forgetSite?.(siteId), safety: siteSafety, rescans: siteRescan,
        tasks: scheduled ? { store: scheduled.store, unattended: scheduled.unattended ?? null } : null, skills: skills?.registry ?? null, skillGovernance,
        policy: { store: policyStore, engine: visibility, models: chatModels, ceilings: visibility.ceilings }, org, orgSync,
        appId: loginConfig?.appId ?? null, log,
        status: {
          read: async () => ({ ...await readServiceStatus({ db: adminDb, workers: workerBeats, queue: runQueue ? () => runQueue.counts() : null }),
            backup: backupDir ? { configured: true, ...await readBackupStatus(backupDir).then((read) => read ?? {},
              (error) => ({ error: String(error?.message ?? error).slice(0, 120), errorCode: error?.code ?? null })) } : { configured: false } }),
          alerts: { enabled: Boolean(alerts), users: alerts?.users.length ?? 0, chat: Boolean(alerts?.chatId), bot: Boolean(policyBot) },
          // To the administrator asking, and nobody else: that the bot and its
          // permission work, before an alert has to.
          testAlert: policyBot ? async (admin) => {
            const answer = await policyBot.sendText({ openId: admin.userId, text: `i豆 服务端测试告警：${admin.name || "管理员"}在管理后台点了「发送测试告警」。收到这条说明机器人能私聊你。${alerts ? "真正的告警发给配置里的超级管理员和管理员群的成员。" : "告警现在没有开启（IDOU_ADMIN_ALERTS）。"}` })
              .catch((error) => ({ sent: false, reason: String(error?.message ?? error).slice(0, 160) }));
            await statusHistory.recordAlert({ level: "ok", text: "测试告警", recipients: 1, reached: answer.sent ? 1 : 0, test: true }).catch(() => {});
            return answer;
          } : null },
        system: async () => systemState({ release,
          deployment: { sitesOrigin: sitesConfig?.origin ?? null, anonymous: sitesConfig?.anonymousAllowed === true, allowlist: sitesConfig?.allow?.rules ?? null,
            unattended: process.env.IDOU_SCHEDULE_UNATTENDED === "1", sandboxMode: loadSandboxMode() },
          models: chat.models.map((entry, index) => ({ id: entry.model, provider: entry.provider, isDefault: index === 0 })),
          health, visibility, checks: monitor?.status() ?? null }),
        // What a person has here, read through the live stores: the same
        // inventory the offboarding command prints (person-data.js).
        personData: (who) => personInventory({ who, schedules: scheduled?.store ?? null, credentials: scheduled?.unattended?.store ?? null,
          preferences: modelChoice.preferences ?? null, sites: siteRegistry, ledger: drive?.ledger ?? null }),
        // Leaving, from the console, through the live stores (person-data.js).
        offboard: (who) => offboardLive({ who, scheduled, sessions, preferences: modelChoice.preferences ?? null, sites: siteRegistry,
          ledger: drive?.ledger ?? null, siteServer }) });
      // The sites' key when there is one -- the console's cookie key is made from
      // it under a label of its own -- else one of its own; a development
      // server's lasts as long as the process and writes no file.
      const cookieKey = sitesRoot || durable ? await siteCookieKey(sitesRoot ?? path.join(dataHome(), "admin"), { state: durable })
        : mode === "--dev" ? randomBytes(32) : await siteCookieKey(path.join(dataHome(), "admin"));
      adminServer = createAdminServer({ origin: adminConfig.origin, cookieKey,
        oauth: siteOAuth, allowlist: adminConfig.allow, roles: adminRoles, api, assets: await loadAdminAssets(),
        audit: (event) => auditLog.record(event), log });
      await new Promise((resolve, reject) => { adminServer.once("error", reject); adminServer.listen(adminConfig.port, adminConfig.bind, resolve); });
      log({ component: "admin-console", event: "admin-listening", bind: adminConfig.bind, port: adminConfig.port, origin: adminConfig.origin });
      process.stderr.write(`idou-server: 管理后台在 ${adminConfig.origin}/admin`
        + `（超级管理员 ${adminConfig.admins.users.length} 人在配置文件里${adminConfig.admins.chatId ? `，管理员群 ${adminConfig.admins.chatId}` : ""}，后台授予 ${adminRoles.granted.size} 人）。\n`);
      if (provider) process.stderr.write(`idou-server: 管理后台的登录回调是 ${adminConfig.origin}/_auth/callback，必须加进飞书开放平台该应用的「重定向 URL」。\n`);
    }
  }
  // Counts and limits for an operator, on 127.0.0.1 only (metrics.js).
  let metrics = null;
  if (metricsPort) {
    const { collectMetrics, startMetricsListener } = await import("../src/control-plane/metrics.js");
    metrics = await startMetricsListener({ port: metricsPort, health: monitor, collect: (loop) => collectMetrics({ release, role: "coordinator", startedAt, sessions, gateway: server, cliProxy, scheduler: scheduled?.scheduler ?? null, sourceAccess, renewal: provider?.renewal ?? null, health: monitor, loop }) });
    process.stdout.write(`Metrics: http://127.0.0.1:${metricsPort}/metrics (this machine only).\n`);
  }
  // Everything this process started, closed in one place for both modes. One
  // listener left open keeps the process alive, and it was: the 文档网站
  // listener was never closed, so every restart of the server waited out
  // systemd's 90 seconds and was then killed (reproduced 2026-09-26 by booting
  // the real server and sending SIGTERM). Scheduled tasks go first and are
  // awaited: an unattended run may be mid-exchange for a refresh token, and
  // closing the renewal service underneath it would end that person's
  // credential chain on every restart.
  const closeAll = async () => {
    // Bounded all the same: whatever is still open this long after the signal
    // is named in the log, and the process ends instead of waiting to be
    // killed. A scheduled run still going is given a minute to finish.
    const deadline = setTimeout(() => {
      process.stderr.write(`idou-server: 收到退出信号 ${SHUTDOWN_GRACE_MS / 1000} 秒后仍有资源没有释放，直接退出：${JSON.stringify(process.getActiveResourcesInfo())}\n`);
      process.exit(0);
    }, SHUTDOWN_GRACE_MS);
    deadline.unref();
    clearInterval(checking); clearInterval(statusPruning);
    await scheduled?.close().catch(() => {});
    publisherKeys?.close(); cliProxy?.close(); sourceAccess?.close(); login?.close(); void mcp?.close(); void media?.close(); appRuntime?.close();
    for (const listener of [server, siteServer, adminServer, metrics]) { listener?.close(); listener?.closeAllConnections(); }
    wiki?.coordinator.close(); drive?.ledger.close(); apps?.catalog.close();
    // Sessions last. What is still on its way to the shared store gets there
    // before the database is closed; nothing is revoked, so the sessions this
    // process issued go on at the other replicas, and here once it is back.
    await Promise.all([sourceAccess?.flush(), provider?.renewal?.flush()]).catch(() => {});
    // The last second of counts, before the database they go to is closed.
    await Promise.resolve(usage.close()).catch(() => {});
    // What the console holds that is not written yet, then its database.
    clearInterval(auditPruning); clearInterval(skillUsagePruning); skillGovernance?.close(); siteRescan?.stop();
    await siteSafety?.close().catch(() => {});
    await siteVisitors?.flush().catch(() => {}); siteVisitors?.close();
    await auditLog.close().catch(() => {}); await people.close().catch(() => {});
    clearTimeout(orgSyncSoon); clearInterval(orgSyncing);
    adminRoles?.close(); policyStore.close(); org.close(); access.close();
    sessions.close(); await sessions.flush(); clearInterval(sweeper);
    // Its last traffic written and its row removed: stopped, not lost.
    await processStatus.close().catch(() => {});
    await adminDb.close().catch(() => {});
    // Given up last, with everything above closed: a standby taking over now
    // finds the ports free and nothing of this process still writing.
    await lease?.release().catch(() => {});
    await shared?.close().catch(() => {});
  };
  if (login) {
    process.stdout.write(`Feishu login gateway: ${loginConfig.origin}\nRegister callback: ${login.redirectUri}\nListening on loopback port ${loginConfig.port}; use a TLS reverse proxy for remote access.\nNo development token was issued.\n`);
    const shutdown = async () => { await closeAll(); sessions.sessions.clear(); };
    process.once("SIGTERM", shutdown); process.once("SIGINT", shutdown); return;
  }
  const serverUrl = `http://127.0.0.1:${server.address().port}`;
  const directory = path.join(dataHome(), "dev-sessions");
  const sessionFile = path.join(directory, `local-${server.address().port}.json`);
  const deviceId = randomUUID();
  let current = null;
  // A local session still expires within the registry's 15-minute ceiling. It is
  // rotated well before then and published atomically at one stable path, so a
  // long working session keeps working without widening any token lifetime. The
  // predecessor is revoked after a short overlap so an in-flight request cannot
  // be cut off mid-call.
  const publish = async () => {
    const next = sessions.issue({ tenantId: "development", userId: "local-developer", deviceId });
    const staging = `${sessionFile}.${next.id}.tmp`;
    await writeFile(staging, JSON.stringify({ token: next.token, expiresAt: next.expiresAt, serverUrl }), { mode: 0o600, flag: "wx" });
    try { await rename(staging, sessionFile); }
    catch (error) { await unlink(staging).catch(() => {}); sessions.revoke(next.token); throw error; }
    const previous = current; current = next;
    if (previous) setTimeout(() => sessions.revoke(previous.token), 60_000).unref();
  };
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await publish();
  } catch (error) { server.close(); throw error; }
  const rotation = setInterval(() => { void publish().catch(error => process.stderr.write(`idou-server: session rotation failed: ${error.message}\n`)); }, 10 * 60_000);
  rotation.unref();
  process.stdout.write(`Development gateway: ${serverUrl}\nLocal session rotates every 10 minutes while this server runs. This is NOT Feishu login.\nClient connection file: ${sessionFile}\nSet IDOU_SESSION_FILE to that path in the client process.\n`);
  // Scheduled tasks too, and awaited, as on a Feishu server. Their egress
  // listener alone keeps the process alive, so leaving them out here meant
  // SIGTERM left a development server running -- one per end-to-end run,
  // measured, each still holding its port and its scheduler.
  const shutdown = async () => { clearInterval(rotation); if (current) sessions.revoke(current.token); void unlink(sessionFile).catch(() => {}); await closeAll(); };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
// What serving the model takes, on the coordinator and on a model replica
// alike: the models and their order, which of them answer right now, who may
// use which, and the usage ledger.
// Takes the coordinator lease, or stands by for it (coordinator-lease.js). A
// lease lost while held -- another has taken it, or the database was away too
// long to keep it -- ends this process at once: somebody else may already be
// acting as the coordinator, and whatever this one had in flight is recovered
// by whoever holds the lease next. systemd starts it again, as a standby.
// The lease this process holds, for a start that fails after taking it to give
// it back: otherwise the next start waits a whole lease for its own.
let heldLease = null;
async function coordinatorLease({ shared, log }) {
  const { CoordinatorLease } = await import("../src/control-plane/coordinator-lease.js");
  const lease = await CoordinatorLease.open({ pool: shared.pool, holder: `${os.hostname()}/${process.pid}/${randomUUID().slice(0, 8)}`, ttlMs: loadCoordinatorLease(), log });
  if (await lease.take()) process.stdout.write("Coordinator: holding the coordinator lease (IDOU_DATA_STORE=postgres).\n");
  else {
    const standing = new AbortController(), stop = () => standing.abort(new Error("stopped while standing by"));
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
    try {
      await lease.wait({ signal: standing.signal, onWaiting: (current) => process.stdout.write(`Coordinator: standing by (${current?.live ? `${current.holder} holds the lease` : "the lease is not free yet"}); taking over when it is given up or lapses, binding nothing until then.\n`) });
    } catch (error) {
      if (!standing.signal.aborted) throw error;
      await shared.close().catch(() => {});
      process.stdout.write("Coordinator: stopped while standing by.\n");
      process.exit(0);
    } finally { process.off("SIGTERM", stop); process.off("SIGINT", stop); }
    process.stdout.write("Coordinator: took over the coordinator lease.\n");
  }
  lease.hold({ onLost: (reason) => { heldLease = null; process.stderr.write(`idou-server: 协调副本租约丢失（${reason}），立即退出，由持有租约的协调副本接手。\n`); process.exit(1); } });
  heldLease = lease;
  return lease;
}

async function modelParts({ mode, loginConfig, feishu, shared = null, dataStore = "files", adminDb, log = () => {} }) {
  const chat = await loadChatModelConfigs();
  // Which model a person's work goes to is the server's to say: which models
  // exist and in what order (above), which can answer right now (health), and
  // each person's own pick among them, kept here rather than on a desktop. A
  // development server keeps picks in memory, so a smoke never writes the
  // operator's file.
  const chatModels = chat.models.map((entry) => entry.model);
  const health = new ModelHealth({ order: chatModels, log: (line) => process.stderr.write(`${line}\n`) });
  // Which models each person is offered, and which they may actually reach.
  // Both halves get the same object: filtering only the list would be a lock
  // hung on the door without being locked, because `model` is a field the
  // client sends. Unset means no policy and the code path taken before.
  const { chatMembership, defaultVisibleFrom, loadModelPolicy } = await import("../src/control-plane/model-visibility.js");
  // One bot, one membership cache, shared by everything that asks Feishu about
  // a group -- so being removed from one takes the same time to matter
  // wherever it is asked about.
  const policyBot = loginConfig ? new FeishuBot({ feishu, appId: loginConfig.appId, appSecret: loginConfig.appSecret,
    audit: (event) => process.stderr.write(`${JSON.stringify({ component: "feishu-groups", ...event })}\n`) }) : null;
  const readChatMembers = policyBot
    ? (await import("../src/control-plane/admin-chat-members.js")).chatMemberReader({ bot: policyBot, feishu })
    : null;
  const groups = readChatMembers ? chatMembership({ readChatMembers }) : null;
  // What each person may use (policy.js): the administrators' rules from the
  // console, beside those of IDOU_MODEL_POLICY_FILE, under the ceiling of what
  // this deployment offers. A policy group may be a whole department's group,
  // so its members are read further (50 pages) and held longer (5 minutes)
  // than the administrators' group is.
  const { PolicyStore, PolicyEngine, QuotaMeter } = await import("../src/control-plane/policy.js");
  const { chatMemberReader } = await import("../src/control-plane/admin-chat-members.js");
  const policyGroups = policyBot ? chatMembership({ readChatMembers: chatMemberReader({ bot: policyBot, feishu, pages: 50 }), cacheMs: 5 * 60_000 }) : null;
  const fileRules = await loadModelPolicy(process.env.IDOU_MODEL_POLICY_FILE, { models: chatModels });
  const writes = loginConfig?.cliWriteActions ?? [];
  const ceilings = {
    scheduledTasks: process.env.IDOU_SCHEDULED_TASKS === "1", unattended: process.env.IDOU_SCHEDULE_UNATTENDED === "1",
    sitesPublish: process.env.IDOU_SITES === "1", sitesAnonymous: process.env.IDOU_SITES === "1" && process.env.IDOU_SITES_ANONYMOUS === "1",
    feishuDocument: writes.some((action) => action.startsWith("document.") || action === "cli.write"), feishuMessage: writes.some((action) => action.startsWith("message.")),
    feishuDrive: writes.some((action) => action.startsWith("drive.")), feishuDelete: writes.includes("cli.delete"),
  };
  const policyStore = await PolicyStore.open({ db: adminDb, models: chatModels, fileRules, log });
  // Who is in which department, for rules about departments (org-directory.js).
  const { OrgDirectory } = await import("../src/control-plane/org-directory.js");
  const org = await OrgDirectory.open({ db: adminDb, log });
  const visibility = new PolicyEngine({ store: policyStore, models: chatModels, ceilings, org, defaultVisible: defaultVisibleFrom(process.env.IDOU_MODEL_DEFAULT_VISIBLE),
    inChat: policyGroups ? (chatId, userId) => policyGroups.has(chatId, userId) : null,
    log: (message) => process.stderr.write(`idou-server: ${message}\n`) });
  if (fileRules?.length) {
    process.stderr.write(`idou-server: 部署配置文件里有 ${fileRules.length} 条模型规则（IDOU_MODEL_POLICY_FILE）；没有规则命中的人${
      visibility.defaultVisible === "all" ? "看得见全部模型" : "看不见任何模型"}。后台里的策略和它们一起生效。\n`);
  }
  if (policyStore.size) process.stderr.write(`idou-server: 后台设置的策略 ${policyStore.size} 条。\n`);
  if ((fileRules ?? []).some((rule) => rule.kind === "chat") && !policyGroups) {
    process.stderr.write("idou-server: 策略里有按群的规则，但这个服务端没有配置飞书应用，群读不到——那些规则永远不会命中。\n");
  }
  // How much each person's work costs, counted. This release only counts:
  // nothing is refused and nothing is downgraded, because a limit enforced from
  // numbers nobody has checked stops the wrong people.
  const { ModelUsage, PostgresModelUsage } = await import("../src/control-plane/model-usage.js");
  const usageFile = process.env.IDOU_MODEL_USAGE_FILE
    ?? (mode === "--dev" ? null : path.join(dataHome(), "model-usage.sqlite"));
  // In the shared database, every replica on every machine counts into one
  // ledger; in a file, into this machine's.
  const usage = dataStore === "postgres" ? await PostgresModelUsage.open({ pool: shared.pool, log }) : await ModelUsage.open({ file: usageFile });
  process.stderr.write(`idou-server: 模型用量记账${dataStore === "postgres" ? "：共享数据库" : usageFile ? `：${usageFile}` : "：内存（开发态，重启即清空）"}。这一版只记不拦。\n`);
  const meter = new QuotaMeter({ ledger: usage });
  return { chat, chatModels, health, visibility, usage, policyBot, groups, policyStore, meter, org };
}

// A replica that serves the model and nothing else (docs/scaling-plan.md §2.3).
// nginx sends it the desktops' /v1/responses by the route code at the start of
// the token; everything else stays with the coordinator. It reads the sessions
// it is shown from the shared store, and counts usage into the same ledger as
// the coordinator (SQLite in WAL mode takes writers from several processes).
// Asked to stop, it takes no new requests -- nginx sends them to the other
// replicas -- and lets the answers it is streaming finish.
// What a process holds now, for its heartbeat (process-status.js): counts and
// limits only, as /metrics has them.
const liveSessions = (sessions) => { const at = Date.now(); let alive = 0; for (const session of sessions.sessions.values()) if (session.expiresAt > at) alive += 1; return alive; };
const modelLoad = (gateway) => { const c = gateway.capacity(); return { active: c.active, limit: c.maxConcurrent, people: c.people }; };
const cliLoad = (proxy) => { const c = proxy.capacity(); return { active: c.active, limit: c.maxConcurrent }; };

async function serveModelOnly({ mode, loginConfig, feishu, capacity, metricsPort, startedAt, shared, sessions, sweeper, dataStore, access, adminDb, log }) {
  const { chat, health, visibility, usage, policyStore, meter, org } = await modelParts({ mode, loginConfig, feishu, shared, dataStore, adminDb, log });
  const traffic = new TrafficMeter();
  const server = createModelGateway({ models: chat.models, ...capacity.model, timeoutMs: Math.max(...chat.models.map((entry) => entry.timeoutMs ?? 180_000)), sessions, health, policy: visibility, meter, usage, traffic });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(loginConfig?.port || 0, "127.0.0.1", resolve); });
  const { readReleaseManifest } = await import("../src/providers/release-manifest.js");
  const release = await readReleaseManifest().then((manifest) => manifest.releaseId, () => "unknown");
  let metrics = null;
  if (metricsPort) {
    const { collectMetrics, startMetricsListener } = await import("../src/control-plane/metrics.js");
    metrics = await startMetricsListener({ port: metricsPort, collect: (loop) => collectMetrics({ release, role: "api", startedAt, sessions, gateway: server, loop }) });
  }
  // Its heartbeat and its model traffic, for the console's 服务状态.
  const { ProcessStatus } = await import("../src/control-plane/process-status.js");
  const processStatus = (await ProcessStatus.open({ db: adminDb, role: "api", name: loadProcessName("api", server.address().port), release, startedAt, traffic, log,
    sample: () => ({ sessions: liveSessions(sessions), model: modelLoad(server), unavailable: health?.unavailable?.() ?? [] }) })).start();
  process.stdout.write(`Model replica: http://127.0.0.1:${server.address().port}/v1/responses${metrics ? `, metrics on 127.0.0.1:${metricsPort}` : ""}.\n`);
  const shutdown = async () => {
    const deadline = setTimeout(() => {
      process.stderr.write(`idou-server: 收到退出信号 ${SHUTDOWN_GRACE_MS / 1000} 秒后仍有资源没有释放，直接退出：${JSON.stringify(process.getActiveResourcesInfo())}\n`);
      process.exit(0);
    }, SHUTDOWN_GRACE_MS);
    deadline.unref();
    server.close(); metrics?.close(); metrics?.closeAllConnections();
    for (const until = Date.now() + DRAIN_MS; server.capacity().active > 0 && Date.now() < until;) await new Promise((resolve) => setTimeout(resolve, 100));
    server.closeAllConnections();
    await Promise.resolve(usage.close()).catch(() => {});
    policyStore.close(); org.close(); access.close();
    sessions.close(); await sessions.flush(); clearInterval(sweeper);
    await processStatus.close().catch(() => {});
    await adminDb.close().catch(() => {}); await shared.close().catch(() => {});
  };
  process.once("SIGTERM", shutdown); process.once("SIGINT", shutdown);
}

// A worker of the execution pool (docs/scaling-plan.md step 3): takes the
// scheduled runs the coordinator queued in the shared database and runs them
// in this machine's sandbox, built from the same settings the coordinator's
// would be. Nothing else: no login, no model, no Feishu authority -- and, since
// 2026-09-28, none of their keys either (docs/server-deployment.md §11). It is
// the process that runs what a prompt-injected task produced, and a worker on
// another machine would carry whatever it was given there.
async function serveRuns({ mode, capacity, metricsPort, startedAt, log }) {
  if (mode === "--feishu") {
    const withheld = withheldFromWorker();
    if (withheld.length) throw new Error(`执行节点不该拿到这些：${withheld.join("、")}。它只需要数据库地址、队列密钥（IDOU_RUN_QUEUE_KEY_FILE）和沙箱设置，见 docs/server-deployment.md §11`);
    // The coordinator's own runs could always be told to run as in development;
    // a worker is only ever deployed, so it runs as in production or not at all.
    if (loadSandboxMode() !== "production") throw new Error("生产部署的执行节点要按生产隔离运行：设 IDOU_SANDBOX_MODE=production");
  }
  const databaseConfig = loadWorkerDatabaseConfig();
  if (!databaseConfig) throw new Error("执行节点需要共享数据库：请设置 IDOU_DATABASE_URL 和 IDOU_RUN_QUEUE_KEY_FILE，执行池的队列在那里");
  const key = await readRunQueueKey(databaseConfig);
  const { RunQueue } = await import("../src/control-plane/run-queue.js");
  const { RunWorker } = await import("../src/control-plane/run-worker.js");
  const { openDockerSandbox, egressGateway, EGRESS_PORT } = await import("../src/control-plane/scheduled-tasks.js");
  const name = loadWorkerName();
  const dataDir = storePlaces().scheduledTasks;
  const runsDir = path.join(dataDir, "pool", name);
  await mkdir(runsDir, { recursive: true, mode: 0o700 });
  const gatewayAddress = loadSandboxGateway(), sandboxUser = loadSandboxUser(), image = loadSandboxImage(), gatewayNetwork = loadSandboxNetwork();
  const sandbox = await openDockerSandbox({ runtime: loadSandboxRuntime(), sandboxMode: loadSandboxMode(), ...(image ? { image } : {}),
    ...(gatewayAddress ? { gatewayAddress } : {}), ...(sandboxUser ? { sandboxUser } : {}), ...(gatewayNetwork ? { gatewayNetwork } : {}),
    owner: createHash("sha256").update(path.resolve(runsDir)).digest("hex").slice(0, 16) });
  // A worker that cannot run anything must not take runs: it says why and
  // stops, and the coordinator's runs wait for one that can.
  const available = await sandbox.available();
  if (!available.ok) throw new Error(`执行节点 ${name}：沙箱不可用（${available.reason}）`);
  if (available.faults?.length) log({ component: "run-worker", event: "development-sandbox", faults: available.faults });
  // What a worker killed mid-run left behind: its containers, then their directories.
  const swept = await sandbox.sweep();
  for (const entry of await readdir(runsDir)) if (/^[A-Za-z0-9_-]{1,128}$/.test(entry)) await rm(path.join(runsDir, entry), { recursive: true, force: true });
  if (swept) log({ component: "run-worker", event: "swept", containers: swept });
  const database = openDatabase({ url: databaseConfig.url });
  let queue;
  try { queue = await RunQueue.attach({ pool: database.pool, connect: database.connect, key }); }
  catch (error) { await database.close().catch(() => {}); throw error; }
  const egressPort = process.env.IDOU_SCHEDULED_TASKS_PORT ? Number(process.env.IDOU_SCHEDULED_TASKS_PORT) : EGRESS_PORT;
  // On a machine other than the coordinator's, the containers' egress is
  // relayed to it, unopened (egress-relay.js); on the same machine they reach
  // the coordinator's own listener and there is nothing to relay.
  const upstream = loadEgressUpstream();
  let relay = null;
  if (upstream) {
    const { startEgressRelay } = await import("../src/control-plane/egress-relay.js");
    relay = await startEgressRelay({ listen: { host: gatewayAddress ?? "0.0.0.0", port: egressPort }, upstream, log });
    process.stdout.write(`Run worker ${name}: sandbox egress relayed from ${relay.address.address}:${relay.address.port} to ${upstream.host}:${upstream.port}.\n`);
  }
  const worker = new RunWorker({ queue, sandbox, runsDir, image: sandbox.image, gateway: egressGateway(egressPort),
    concurrency: capacity.schedules.maxConcurrentRuns, log }).start();
  const { readReleaseManifest } = await import("../src/providers/release-manifest.js");
  const release = await readReleaseManifest().then((manifest) => manifest.releaseId, () => "unknown");
  // Its heartbeat, through the queue's own table (worker-role.sql grants it).
  const { WorkerHeartbeat } = await import("../src/control-plane/process-status.js");
  const heartbeat = new WorkerHeartbeat({ queue, name, release, startedAt, log,
    sample: () => ({ runs: { active: worker.running.size, limit: worker.concurrency } }) }).start();
  let metrics = null;
  if (metricsPort) {
    const { collectMetrics, startMetricsListener } = await import("../src/control-plane/metrics.js");
    metrics = await startMetricsListener({ port: metricsPort, collect: (loop) => collectMetrics({ release, role: "worker", startedAt,
      scheduler: { running: worker.running, maxConcurrent: worker.concurrency }, loop }) });
  }
  process.stdout.write(`Run worker ${name}: ${worker.concurrency} at a time, image ${sandbox.image}${metrics ? `, metrics on 127.0.0.1:${metricsPort}` : ""}.\n`);
  const shutdown = async () => {
    const deadline = setTimeout(() => {
      process.stderr.write(`idou-server: 收到退出信号 ${SHUTDOWN_GRACE_MS / 1000} 秒后仍有资源没有释放，直接退出：${JSON.stringify(process.getActiveResourcesInfo())}\n`);
      process.exit(0);
    }, SHUTDOWN_GRACE_MS);
    deadline.unref();
    // What is running finishes within 45 seconds, then is stopped; either way
    // the coordinator hears how it ended.
    await worker.close({ graceMs: DRAIN_MS });
    await heartbeat.close();
    await relay?.close();
    metrics?.close(); metrics?.closeAllConnections();
    await queue.close();
    await database.close().catch(() => {});
  };
  process.once("SIGTERM", shutdown); process.once("SIGINT", shutdown);
}

// Exited, not merely marked. Startup listens before it finishes wiring, so a
// failure after that point left a process that kept serving with half its
// pieces missing and no signal handlers -- it printed one line and carried on
// looking alive. Measured: an egress port conflict produced a control plane
// with no scheduled tasks, no shutdown handler, and no further output.
main().catch(async (error) => {
  process.stderr.write(`idou-server: ${error.message}\n`);
  await heldLease?.release().catch(() => {});
  process.exit(1);
});
