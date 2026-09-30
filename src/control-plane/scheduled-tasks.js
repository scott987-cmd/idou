import { createHash, X509Certificate } from "node:crypto";
import { createServer } from "node:https";
import { admitPeers } from "./egress-relay.js";
import path from "node:path";
import { SCHEDULE_LIMITS, ScheduleStore } from "./schedule-store.js";
import { Scheduler } from "./scheduler.js";
import { ScheduleService } from "./schedule-service.js";
import { SandboxEgressService } from "./sandbox-egress.js";
import { ScheduledRunner } from "./scheduled-run.js";
import { DockerSandbox } from "./sandbox/docker-sandbox.js";
import { sandboxImageTag } from "./sandbox/sandbox-image.js";
import { readPins } from "../providers/runtime-artifacts.js";
import { readReleaseManifest } from "../providers/release-manifest.js";
import { runProcess } from "../providers/process-runner.js";
import { ensureEgressCertificate, EGRESS_HOSTNAME } from "./egress-tls.js";
import { SchedulePush } from "./schedule-push.js";
import { UnattendedCredentialStore } from "./unattended-credential.js";
import { UnattendedConsent } from "./unattended-consent.js";
import { ScheduleReportArchive, ScheduleArchiveError, reportCandidates } from "./schedule-report-archive.js";
import { ScheduleDelivery } from "./schedule-delivery.js";
import { ScheduleReminders } from "./schedule-reminders.js";

// Everything a scheduled task needs, assembled in one place: the rules on disk,
// the clock that reads them, the container each run happens in, the one address
// that container may reach, and the HTTP surface the desktop manages it through.
//
// It is a module rather than another forty lines in bin/server.js because the
// assembly has behaviour worth testing on its own -- what happens when Docker is
// absent, where the certificate lives, what a run is allowed to do -- and
// because a startup file nobody dares touch is its own kind of failure.
export const EGRESS_PORT = 8443;

// `liveSession(tenant, userId)` is how this learns whether a schedule's owner is
// still signed in, and it is injected rather than derived because the control
// plane genuinely does not hold what would be needed to derive it: the session
// registry keeps only token digests, and the raw token lives in the desktop's
// memory. That is the right arrangement -- a server that hoarded live tokens
// would be a worse thing to breach -- but it means an unattended run has no
// identity until the person has explicitly handed one over. Until that consent
// exists, the default here refuses every run and says why, rather than
// pretending a schedule is running when it cannot.
const noSession = () => null;

// How long a deleted task's runs stay in 运行记录 (G11).
const ORPHAN_RUN_DAYS = 90;
// How often the egress certificate, and the authorizations about to end, are
// looked at while the server runs.
const CERTIFICATE_CHECK_MS = 6 * 3600_000;
const REMINDER_CHECK_MS = 6 * 3600_000;

// The network a sandbox joins when IDOU_SANDBOX_NETWORK does not name one: the
// one this host already has. A host set up before the product was renamed has
// mydoubao-egress, and its firewall is written for that network's bridge
// (docs/server-deployment.md); a new one is set up with idou-egress.
export async function egressNetworkName({ docker = "docker", run = runProcess } = {}) {
  const earlier = await run(docker, ["network", "inspect", "mydoubao-egress", "--format", "{{.Name}}"], { timeoutMs: 10_000, maxOutputBytes: 4096 }).catch(() => null);
  return earlier?.code === 0 ? "mydoubao-egress" : "idou-egress";
}

// The Docker sandbox runs are made in, as the settings say: here for a
// coordinator that runs its own, and on a worker of the execution pool
// (run-worker.js), which has to build exactly the same one.
export async function openDockerSandbox({ docker = "docker", runtime = "runc", gatewayNetwork = null, gatewayAddress = null,
  gatewayHost = `${EGRESS_HOSTNAME}:${gatewayAddress ?? "host-gateway"}`, sandboxMode = "development", image = sandboxImageTag(), sandboxUser = null, owner, now = Date.now }) {
  const release = await readReleaseManifest();
  return new DockerSandbox({ docker, runtime, gatewayNetwork: gatewayNetwork ?? await egressNetworkName({ docker }), gatewayHost, mode: sandboxMode, image,
    ...(sandboxUser ? { uid: sandboxUser.uid, gid: sandboxUser.gid } : {}), pins: await readPins(), release, owner, now });
}
// What happens to a finished run's report: saved to its owner's space, then
// written to the places they chose (schedule-delivery.js) -- whether or not it
// could be saved, since those are theirs and the words are the run's either
// way; not for a run that was stopped. What happened at each place is added to
// the run's record, beside what happened to the report, and how many it did
// not reach is kept with it (`undelivered`).
export const afterRun = ({ archive, delivery = null }) => async (finished) => {
  let saved = null, failure = null;
  try { saved = await archive(finished); } catch (error) { failure = error; }
  const { lines, missed } = delivery && !finished.signal?.aborted ? await delivery.deliver(finished) : { lines: [], missed: 0 };
  if (failure) {
    if (!lines.length) throw failure;
    throw new ScheduleArchiveError([String(failure?.message ?? failure), ...lines].join("\n"), failure?.artifact ?? null);
  }
  return lines.length ? { ...saved, detail: [saved?.detail ?? "报告已保存到飞书云盘。", ...lines].join("\n"), ...(missed ? { undelivered: missed } : {}) } : saved;
};

// A finished run's result, pushed to its owner (schedule-push.js). With the bot
// on, one that did not reach them is said on the run, which then reads 未全部
// 送达 rather than a plain success (the long-running review, 2026-09-29: a bot
// missing its permission had every result go nowhere, each run still 成功).
// Without a bot a push is only tried as the owner, and one this server does not
// allow is how it was set up, not a failure.
// `observe` hears each bot push, for the administrators' check (health-monitor.js).
export const notifyOwner = ({ push, store, bot, log = () => {}, observe = () => {} }) => async (finished) => {
  const outcome = await push.deliver(finished);
  if (outcome.sent) { if (outcome.as === "bot") observe("push_sent"); return; }
  log(`定时任务：结果未推送（${outcome.reason}）。`);
  const refused = String(outcome.reason ?? "");
  if (!bot || !finished.runId || !refused.startsWith("bot: ")) return;
  observe("push_failed", refused.slice(5, 200));
  await Promise.resolve().then(() => store.markUndelivered(finished.schedule.tenant, finished.runId, `结果没有推送给你：机器人没有发出（${refused.slice(5, 300)}）`))
    .catch((error) => log(`定时任务：推送失败没有记进运行记录（${String(error?.message ?? error).slice(0, 120)}）。`));
};

// Where a container finds the egress proxy.
export const egressGateway = (egressPort = EGRESS_PORT) => `https://${EGRESS_HOSTNAME}:${egressPort}`;

// A report this server no longer keeps gives back the Drive budget it was
// charged. Before, every report a task overwrote stayed counted, and the ledger
// only filled (drive-budget.js). Its reservation was made as its owner, and is
// given back as them; without a ledger there is nothing to give back.
export function reportReleaser({ driveBudget, appId }) {
  return async ({ tenant, owner, runId }) => (driveBudget && appId
    ? driveBudget.release({ authProvider: "feishu", tenantId: tenant, appId, userId: owner }, runId)
    : false);
}
// Every superseded report's, a page at a time; how many were given back.
export async function reclaimSupersededReports({ store, release, pageSize = 500 }) {
  let given = 0;
  for (let after = null; ;) {
    const page = await store.supersededReports({ after, limit: pageSize });
    for (const row of page) if (await release(row).catch(() => false)) given += 1;
    if (page.length < pageSize) break;
    after = page.at(-1);
  }
  return given;
}

export async function startScheduledTasks({
  // `feishu` is the deployment every Feishu call a run makes is for: where the
  // egress reads, what the notification may do, which CLI bridge the container
  // configures. Required even without a login, so nothing here guesses one.
  feishu, sessions, sourceAccess, dataDir, controlPlaneOrigin, consent = null, liveSession = noSession, allowDevelopment = false,
  // Off unless the operator turned it on. With `unattended` absent, every line
  // below behaves exactly as it did before this existed -- which is what
  // "default off" has to mean for something that holds a durable credential.
  provider = null, allowedTenants = null, unattended = null, bot = null, driveBudget = null, runDetailDays = 30, promptDays = 30, grants = null,
  // The tag is derived from the lock rather than written here a second time; in
  // production the operator names the image by digest instead (see
  // IDOU_SANDBOX_IMAGE), and the sandbox refuses anything less.
  image = sandboxImageTag(), runtime = "runc", gatewayNetwork = null, sandboxMode = "development",
  // Where the container reaches the egress proxy (IDOU_SANDBOX_GATEWAY).
  // Given an address, the proxy listens on it alone; without one, the container
  // goes through the host gateway and the proxy listens everywhere, which only
  // development accepts.
  gatewayAddress = null,
  gatewayHost = `${EGRESS_HOSTNAME}:${gatewayAddress ?? "host-gateway"}`,
  // Who the container runs as (IDOU_SANDBOX_USER); unset, nobody.
  sandboxUser = null,
  egressPort = EGRESS_PORT, now = Date.now, log = () => {}, docker = "docker",
  // The model a run asks for, from the server's own resolution for the owner;
  // without it the sandbox keeps its built-in default.
  modelFor = null,
  // How many runs at once, and how many schedules a person and a tenant may
  // keep (loadCapacity in server-config.js). Unset keeps the store's and the
  // scheduler's own defaults.
  capacity = {},
  // Where runs execute: unset, this machine's Docker; given a sandbox, that
  // one -- the execution pool's (sandbox/pool-sandbox.js), which queues each
  // run for a worker. Everything else about a run stays here either way.
  execution = null,
  // Workers on other machines (egress-relay.js): the same egress proxy, also
  // on an address they can reach, for the listed peers only.
  remoteEgress = null,
  // Where the unattended credentials are kept: unset, this machine's
  // directory; given, that store -- the shared database's (§2.5).
  openCredentials = null,
  // Where the tasks and their runs are kept, the same way: unset, this
  // machine's SQLite file; given, the store it opens (schedule-store-postgres.js).
  openStore = null,
  // Told how each run ended, each bot push and each suspension -- never what a
  // run said -- for the administrators' checks (health-monitor.js).
  observe = () => {},
} = {}) {
  // `sourceAccess` is optional on purpose. Without it a schedule can still be
  // written, listed and deleted -- it simply cannot run, and says so at every
  // turn. That is more honest than the section vanishing on a control plane
  // without Feishu login, and it is what makes the UI reachable in development.
  if (!sessions || !dataDir) throw new Error("Scheduled tasks need a session registry and a data directory");
  if (!feishu?.openApi) throw new Error("Scheduled tasks need the Feishu deployment they run against");
  if (sourceAccess && sourceAccess.feishu !== feishu) throw new Error("Scheduled tasks and source access must belong to the same Feishu deployment");

  const limits = { perUser: capacity.perUser, perTenant: capacity.perTenant };
  const store = openStore ? await openStore({ now, limits }) : new ScheduleStore({ databaseFile: path.join(dataDir, "schedules.db"), now, limits });
  // Containers are marked with the data directory they belong to, so the sweep
  // below removes this control plane's leftovers and nobody else's running tasks.
  const owner = createHash("sha256").update(path.resolve(dataDir)).digest("hex").slice(0, 16);
  const sandbox = execution?.sandbox ?? await openDockerSandbox({ docker, runtime, gatewayNetwork, gatewayHost, sandboxMode, image, sandboxUser, owner, now });

  // Reported rather than assumed: without a working Docker there is nothing to
  // run a task in, and a schedule that fires into nothing is worse than one that
  // says up front it cannot run.
  const available = await sandbox.available();
  if (!available.ok) log(`定时任务：沙箱不可用（${available.reason}）。任务可以创建，但到点会记为失败。`);
  // Said out loud on a developer machine, every start. "It runs here" must never
  // be mistaken for "it is isolated here": on an ordinary bridge the container
  // reaches the internet directly -- measured -- and the egress proxy is then a
  // convention rather than a boundary.
  else if (available.faults?.length) {
    log(`定时任务：沙箱按开发模式运行，以下隔离不成立——${available.faults.join("；")}。生产部署请设 IDOU_SANDBOX_MODE=production。`);
  }

  const certificate = await ensureEgressCertificate({ directory: path.join(dataDir, "egress-tls"), now });
  const egress = new SandboxEgressService({ sourceAccess, schedules: store, sessions, controlPlaneOrigin, now,
    audit: (event) => log(JSON.stringify({ component: "sandbox-egress", ...event })) });

  // The sandbox reaches this and nothing else. TLS is not decoration here: the
  // CLI sidecar inside the container refuses any upstream that is neither HTTPS
  // nor literal loopback, and inside a container loopback is the container.
  const egressServer = createServer({ key: certificate.key, cert: certificate.cert },
    (req, res) => { void egress.handle(req, res).then((claimed) => { if (!claimed) { res.writeHead(404, { "content-type": "application/json" }); res.end('{"error":"not_found"}'); } }); });
  await new Promise((resolve, reject) => {
    // 8443 is a popular port, and the bare EADDRINUSE names neither what wanted
    // it nor the setting that moves it. Measured on a machine where another
    // program held it: the control plane failed here and said only the address.
    egressServer.once("error", (error) => reject(error?.code === "EADDRINUSE"
      ? new Error(`定时任务的出口代理无法监听 ${egressPort} 端口（已被占用）。用 IDOU_SCHEDULED_TASKS_PORT 换一个端口。`)
      : error?.code === "EADDRNOTAVAIL"
        ? new Error(`定时任务的出口代理无法监听 ${gatewayAddress}:${egressPort}：这台机器上没有这个地址。IDOU_SANDBOX_GATEWAY 应是沙箱网络（${gatewayNetwork}）的网关 IP，网络要先建好。`)
        : error));
    egressServer.listen(egressPort, gatewayAddress ?? "0.0.0.0", resolve);
  }).catch((error) => { store.close(); throw error; });
  // The same proxy for workers elsewhere: they relay their containers' TLS here
  // unopened, so this is the certificate and the handler the local listener
  // has, and nobody but the named peers gets as far as the handshake.
  let remoteServer = null;
  if (remoteEgress) {
    remoteServer = createServer({ key: certificate.key, cert: certificate.cert },
      (req, res) => { void egress.handle(req, res).then((claimed) => { if (!claimed) { res.writeHead(404, { "content-type": "application/json" }); res.end('{"error":"not_found"}'); } }); });
    admitPeers(remoteServer, remoteEgress.peers, (event) => log(JSON.stringify(event)));
    await new Promise((resolve, reject) => {
      remoteServer.once("error", (error) => reject(new Error(`定时任务的远程出口无法监听 ${remoteEgress.host}:${remoteEgress.port}（${error?.code ?? error?.message}）。检查 IDOU_EGRESS_REMOTE_LISTEN。`)));
      remoteServer.listen(remoteEgress.port, remoteEgress.host, resolve);
    }).catch((error) => { egressServer.close(); store.close(); throw error; });
  }

  const reportArchive = driveBudget && sourceAccess ? new ScheduleReportArchive({
    feishu, sessions, sourceAccess, budget: driveBudget, controlPlaneOrigin, now,
  }) : null;
  const runner = new ScheduledRunner({ sandbox, egress, image, appId: sourceAccess?.appId ?? null, apiOrigin: feishu.openApi.origin, ca: certificate.ca,
    gateway: egressGateway(egressPort),
    workspaceFor: async (claim) => path.join(dataDir, "runs", claim.runId),
    workspaceRoot: path.join(dataDir, "runs"), modelFor,
    limits: { memoryMb: 1024, cpus: 1, timeoutMs: 10 * 60_000 },
    // 参考上一次的结果: the last report this schedule archived, read back the
    // way it was written. Where nothing is archived there is nothing to read.
    recall: async ({ schedule, parentToken, signal }) => {
      if (!reportArchive) throw new Error("服务端没有配置飞书云盘归档（IDOU_DRIVE_CONFIG_FILE），读不到上一次的报告");
      const previous = await store.previousReport(schedule.tenant, schedule.id);
      return previous ? { text: await reportArchive.recall({ schedule, parentToken, artifact: previous, signal }) } : null;
    },
    now, log });

  // Bounded to the tenants this deployment admits, and audited through the same
  // sink as everything else the control plane does. A notification is the one
  // outward act here that nobody clicks a card for, so what it did and on whose
  // behalf has to be answerable afterwards.
  const push = new SchedulePush({ feishu, origin: controlPlaneOrigin, bot, allowedTenants,
    audit: (event) => log(JSON.stringify({ component: "schedule-notify", ...event })) });
  // And to the places its owner chose for it when they set it up -- a document
  // to append to, a chat to send to (schedule-delivery.js) -- written as them,
  // once the run is over. Nothing without the bridge that writes as them.
  const delivery = sourceAccess ? new ScheduleDelivery({ feishu, sessions, sourceAccess, store, push, controlPlaneOrigin, now }) : null;
  // Each task keeps its KEPT_REPORTS latest reports: once it has that many, the
  // oldest still intact -- read from its own receipts here, never from the
  // run -- is overwritten in place. Its run stops naming the file, and so does
  // every run whose file was found deleted, renamed or changed on the way.
  const releaseReport = reportReleaser({ driveBudget, appId: sourceAccess?.appId });
  const reclaimReports = () => reclaimSupersededReports({ store, release: releaseReport });
  const archive = reportArchive ? async (finished) => {
    const kept = await store.retainedReports(finished.schedule.tenant, finished.schedule.id);
    const saved = await reportArchive.archive({ ...finished, candidates: reportCandidates(kept) });
    if (saved?.unreplaced) log(`定时任务：报告没有替换最早的一份，改为新建文件（${saved.unreplaced}）。`);
    // The report is saved either way; a receipt left naming a file only means
    // that run is counted as kept until a later run finds out otherwise.
    for (const runId of [saved?.replaced, ...(saved?.stale ?? [])].filter(Boolean)) {
      try { await store.supersedeReport(finished.schedule.tenant, runId); }
      catch (error) { log(`定时任务：不再保留的报告，运行记录未更新（${String(error?.message ?? error).slice(0, 120)}）。`); continue; }
      // And the Drive budget it was charged for: the bytes are no longer the
      // ones it reserved. Missed here, the next start gives it back.
      await releaseReport({ tenant: finished.schedule.tenant, owner: finished.schedule.owner, runId })
        .catch((error) => log(`定时任务：不再保留的报告，云盘额度未归还（${String(error?.message ?? error).slice(0, 120)}），下次启动再试。`));
    }
    return saved;
  } : async () => {
    throw new Error("报告未保存：服务端没有配置飞书云盘归档（IDOU_DRIVE_CONFIG_FILE）");
  };

  // The durable half, and the only thing here that outlives a login. Opened only
  // when the operator asked for it; see the header of unattended-credential.js
  // for what holding it costs.
  let unattendedConsent = null;
  if (unattended?.enabled) {
    if (!provider) throw new Error("无人值守定时任务需要飞书登录提供方");
    const credentials = openCredentials ? await openCredentials() : await UnattendedCredentialStore.open({ directory: path.join(dataDir, "unattended"), now });
    unattendedConsent = new UnattendedConsent({ store: credentials, sessions, provider, allowedTenants,
      windowDays: unattended.windowDays, now, audit: (event) => log(JSON.stringify({ component: "schedule-unattended", ...event })) });
    const held = await credentials.count();
    log(`定时任务：无人值守运行已开启（最长 ${unattended.windowDays} 天），当前保存了 ${held} 份长效凭据于 ${credentials.directory === "postgres" ? "共享数据库" : path.join(dataDir, "unattended")}。`);
  }

  // Their owners are told, through the bot, before the authorization their
  // tasks run on ends, and when tasks of theirs are suspended.
  const reminders = new ScheduleReminders({ store, unattended: unattendedConsent, bot, feishu, allowedTenants, promptDays, now, log });

  const scheduler = new Scheduler({ store, now, execute: runner.execute, ...(capacity.maxConcurrentRuns ? { maxConcurrent: capacity.maxConcurrentRuns } : {}),
    onEvent: (event) => {
      if (event.kind === "suspended") { reminders.suspended(event.schedule, event.reason); observe("suspended", event.reason ?? null); }
      else if (["completed", "failed"].includes(event.kind)) observe(event.kind);
    },
    // A scheduled task only ever runs inside the lifetime of the login that
    // created it. `sourceAccess` is the only thing that knows whether one is
    // still live, and it is asked per run rather than trusted from creation.
    // What decides whether a run may happen is whether it has an identity, not
    // whether that identity can reach Feishu. Conflating the two meant a server
    // without Feishu login skipped every task outright, when the accurate
    // behaviour is that it runs and its Feishu calls are refused -- which the
    // egress already says plainly, from inside, where the task can report it.
    // The live login first, always. While the person is signed in and has
    // granted the session-scoped consent, a run uses that identity and no
    // refresh token is spent -- the durable credential is not even read.
    authorize: async (schedule) => {
      const live = liveSession(schedule.tenant, schedule.owner);
      if (live?.token) return { ok: true, parentToken: live.token };
      if (!unattendedConsent) return { ok: false, reason: "登录已过期或未授权定时任务，任务已暂停，重新登录并授权后自动恢复" };
      const minted = await unattendedConsent.identity(schedule.tenant, schedule.owner);
      return minted.ok ? { ok: true, parentToken: minted.token } : { ok: false, retry: minted.retry === true, reason: minted.reason };
    },
    postprocess: afterRun({ archive, delivery }),
    // What a finished task concluded goes to the person who created it, in
    // Feishu, so an unattended task is worth leaving unattended. Only ever to
    // them: `push` reads the recipient from the stored schedule and takes none
    // from the run. Where the operator has not enabled `message.send` this is
    // refused like any other write, logged once, and the run is unaffected.
    notify: notifyOwner({ push, store, bot, log, observe }) });

  const service = new ScheduleService({ sessions, store, scheduler, consent, allowDevelopment, unattended: unattendedConsent, grants, feishu, resourceResolver: sourceAccess, push, now });
  // Containers and run tokens outlive a control plane that was killed; both are
  // cleared at start rather than left to expire on their own.
  let recoverySafe = false;
  try {
    const swept = await sandbox.sweep();
    recoverySafe = true;
    if (swept > 0) log(`定时任务：清理了 ${swept} 个上次遗留的沙箱容器。`);
  } catch { log("定时任务：未确认遗留容器停止，保留工作目录；本次启动禁用执行，请修复 Docker 后重启。"); }
  runner.sweepRunTokens();
  // The directories those runs were working in. A killed control plane runs no
  // finally, so without this they accumulate -- measured at 34 MB from a single
  // run, holding whatever the task had read.
  if (recoverySafe) {
    await runner.sweepWorkspaces().catch(() => 0);
    await store.recoverInterruptedRuns();
  }
  // And what those runs said, once the desktop has had every chance to collect
  // it. Run rows stay; only their text goes -- a task that has been failing for
  // a month must still read as one.
  const retentionMs = runDetailDays * 86400_000;
  const prune = async () => {
    const cleared = await store.pruneRunDetail(retentionMs);
    if (cleared > 0) log(`定时任务：清除了 ${cleared} 条超过 ${runDetailDays} 天的运行正文（运行记录本身保留）。`);
    // And the rows themselves, past what 运行记录 keeps: each task's newest (as
    // many as any view shows of one task) and whatever is younger than the
    // text above, so the desktop has had its chance at all of it; a deleted
    // task's (G11) for longer. A report's Drive reservation is given back first.
    const pruned = await store.pruneRuns({ keep: SCHEDULE_LIMITS.maxRuns, olderThanMs: retentionMs,
      orphanOlderThanMs: ORPHAN_RUN_DAYS * 86400_000, release: releaseReport });
    if (pruned > 0) log(`定时任务：清除了 ${pruned} 条超出保留范围的运行记录（每个任务保留最新 ${SCHEDULE_LIMITS.maxRuns} 条和 ${runDetailDays} 天内的，已删除任务的保留 ${ORPHAN_RUN_DAYS} 天）。`);
    const prompts = await store.prunePrompts(promptDays * 86400_000);
    if (prompts > 0) log(`定时任务：清除了 ${prompts} 条停用超过 ${promptDays} 天的提示词（配置与运行记录保留，恢复需重建任务）。`);
  };
  // A database away at that moment is tried again the next day; said, not thrown.
  const pruneSafely = () => prune().catch((error) => log(`定时任务：清理没有完成（${String(error?.message ?? error).slice(0, 120)}），明天再试。`));
  await pruneSafely();
  // What reports gave up before their reservations were given back with them
  // -- every overwritten report, until this release -- is given back once, now.
  if (driveBudget && sourceAccess?.appId) {
    void reclaimReports().then((given) => { if (given) log(`定时任务：归还了 ${given} 份不再保留的报告占用的云盘额度。`); },
      (error) => log(`定时任务：云盘额度归还没有完成（${String(error?.message ?? error).slice(0, 120)}），下次启动再试。`));
  }
  const pruning = setInterval(pruneSafely, 86400_000);
  pruning.unref?.();
  // The egress certificate is renewed while the server runs, not only when it
  // starts. It lasts 90 days and is re-issued in its last 14, and it used to be
  // looked at only at start: a server not restarted in that window would have
  // had every run fail at once the day it ran out (the one issued on 2026-09-29,
  // on 2026-12-28), and again every 90 days. Looked at every six hours; a new
  // one goes into both listeners without a restart -- a handshake from then on
  // gets it, a run already connected keeps what it has -- and the CA the
  // containers trust is the same one unless it had itself run out.
  let issued = certificate;
  const renewCertificate = async () => {
    const next = await ensureEgressCertificate({ directory: path.join(dataDir, "egress-tls"), now });
    if (!next.reissued) return false;
    for (const listener of [egressServer, remoteServer]) listener?.setSecureContext({ key: next.key, cert: next.cert });
    runner.ca = next.ca;
    issued = next;
    log(`定时任务：出口证书已续签，有效期到 ${new Date(new X509Certificate(next.cert).validTo).toISOString()}，没有重启。`);
    return true;
  };
  const renewSafely = () => renewCertificate().catch((error) => log(`定时任务：出口证书续签没有完成（${String(error?.message ?? error).slice(0, 160)}），六小时后再试。`));
  const renewing = setInterval(renewSafely, CERTIFICATE_CHECK_MS);
  renewing.unref?.();
  // Reminders of an ending authorization: looked at on start and every six
  // hours; each is sent once per grant, whatever restarts come between.
  const remindSafely = () => reminders.sweep().then((told) => { if (told) log(`定时任务：提醒了 ${told} 个人无人值守授权快到期。`); },
    (error) => log(`定时任务：到期提醒没有完成（${String(error?.message ?? error).slice(0, 120)}），六小时后再试。`));
  void remindSafely();
  const reminding = setInterval(remindSafely, REMINDER_CHECK_MS);
  reminding.unref?.();
  // Keep the management surface available, but never launch beside containers
  // whose shutdown we could not establish. start() cannot reopen a closed clock.
  if (recoverySafe) await scheduler.start();
  else await scheduler.close();

  return {
    service, scheduler, egress, store, runner, reportArchive, certificate, reminders,
    // What the egress listeners serve now, and when it runs out (operations
    // watch, metrics); and the renewal itself, for a caller that cannot wait
    // six hours to see it work.
    egressCertificate: () => ({ validTo: Date.parse(new X509Certificate(issued.cert).validTo), ca: issued.ca }),
    renewEgressCertificate: renewCertificate,
    unattended: unattendedConsent,
    sandboxReady: available.ok && recoverySafe,
    egressPort, egressAddress: gatewayAddress ?? "0.0.0.0",
    remoteEgressAddress: remoteServer?.address() ?? null,
    async close() {
      clearInterval(pruning); clearInterval(renewing); clearInterval(reminding);
      await scheduler.close();
      await reminders.close();
      unattendedConsent?.close();
      egress.closeAll();
      for (const listener of [egressServer, remoteServer]) { listener?.close(); listener?.closeAllConnections?.(); }
      await store.close();
    },
  };
}
