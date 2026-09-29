import { createHash } from "node:crypto";
import { DRIVE_REPLACE } from "../providers/feishu/cli-write-contract.js";
import { EITHER, ownFileName } from "../product-names.js";

const REPORT_NAME = new RegExp(`^${EITHER}-[a-f0-9-]{36}\\.schedule\\.md$`);

const MAX_REPORT_BYTES = 4 * 1024 * 1024;
// How many reports each scheduled task keeps in Drive. Once it keeps this many,
// the next one overwrites the oldest in place instead of adding a file: a task
// that runs daily used to add one file a day for good (27 in one night of
// acceptance runs, measured 2026-09-22), all in the person's recent documents.
export const KEPT_REPORTS = 3;
// Which kept reports the next one may overwrite, oldest first: every one but the
// newest KEPT_REPORTS - 1, once the task keeps as many as it may. The oldest
// still intact is overwritten. One provably gone is skipped for the next, so a
// task whose receipts name files a person already deleted gets back down to
// KEPT_REPORTS rather than overwriting while it counts ghosts. `kept` is newest
// first (ScheduleStore.retainedReports).
export const reportCandidates = (kept) => (Array.isArray(kept) && kept.length >= KEPT_REPORTS ? kept.slice(KEPT_REPORTS - 1).reverse() : []);

export class ScheduleArchiveError extends Error {
  constructor(message, artifact = null) { super(message); this.artifact = artifact; }
}

// The sandbox can read, but it cannot write to Drive. Once it has exited, this
// control-plane-owned postprocessor sends only its report bytes to its owner's
// own Drive space (我的空间), charged to the tenant's Drive budget. The model
// cannot choose the target, file name, operation id, or authority.
//
// Until 2026-09-28 the target was the one folder the tenant administrator
// pre-authorized in the Drive budget policy, shared by everybody in the tenant:
// every task owner had to be able to save there, so everyone could open
// everyone's reports -- and a report is excerpts of its owner's documents. What
// is already in that folder stays there; a task stops rotating it, and it is
// its owners' or the administrator's to delete.
export class ScheduleReportArchive {
  constructor({ feishu, sessions, sourceAccess, budget, controlPlaneOrigin, now = Date.now,
    createSidecar = options => feishu.client.sidecar(options), createClient = config => feishu.client.create(config) } = {}) {
    if (!feishu?.client || !sessions || !sourceAccess || !budget || !controlPlaneOrigin) throw new Error("定时报告归档需要飞书安全桥接、会话和云盘配额");
    Object.assign(this, { feishu, sessions, sourceAccess, budget, controlPlaneOrigin, now, createSidecar, createClient });
  }

  #identity(parentToken, schedule) {
    const who = this.sessions.verify(parentToken);
    if (!who || who.audience !== "codex-model-gateway" || who.authProvider !== "feishu" ||
        who.tenantId !== schedule.tenant || who.userId !== schedule.owner || who.cliBridge !== true || who.cliDriveWrites !== true) {
      throw new ScheduleArchiveError("报告未保存：当前运行身份没有获准写入云盘");
    }
    // Also proves this exact session still owns the OAuth grant the sidecar will
    // use. A registry row alone is not evidence that credentials are bound.
    try { this.sourceAccess.current(parentToken); }
    catch { throw new ScheduleArchiveError("报告未保存：飞书登录桥接已失效"); }
    return who;
  }

  // Charged to the tenant's policy, bound to the folder the bytes go to.
  #input(runId, policy, bytes, folder) {
    return { id: runId, policyDigest: policy.policyDigest, providerId: policy.providerId,
      driveTenantKey: policy.driveTenantKey, folderToken: folder.token,
      bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }

  // The owner's own space, found as the owner, through the same bridge the
  // upload goes through: the sidecar holds the owner's session and nobody
  // else's, so the root it reads is theirs.
  async #ownSpace(client, policy, tenantOrigin, signal) {
    if (typeof client.drive.resolveRoot !== "function") throw new ScheduleArchiveError("报告未保存：这个飞书部署还不能把报告存到本人的云空间");
    const folder = await client.drive.resolveRoot(tenantOrigin, { signal });
    signal?.throwIfAborted();
    if (folder.root !== true || folder.providerId !== policy.providerId || folder.identity.tenantKey !== policy.driveTenantKey) {
      throw new ScheduleArchiveError("报告未保存：云空间实时核验不一致");
    }
    return folder;
  }

  #record(state, name, input, fileToken = null, url = null) {
    return { state, providerId: input.providerId, fileToken, url, name, bytes: input.bytes, sha256: input.sha256,
      archivedAt: this.now() };
  }

  // `candidates` are the kept reports this run may overwrite, oldest first
  // (reportCandidates) -- chosen by the caller from this schedule's own
  // receipts, never by the run. Where the operator has enabled that, the first
  // one still intact is overwritten in place and the result names its run
  // (`replaced`); every one found no longer intact on the way is named in
  // `stale`, for the caller to stop counting.
  async archive({ schedule, parentToken, runId, report, signal, candidates = [] }) {
    if (!Buffer.isBuffer(report) || !report.length || report.length > MAX_REPORT_BYTES) {
      throw new ScheduleArchiveError("报告未保存：任务输出大小不符合归档限制");
    }
    if (!Array.isArray(candidates)) candidates = [];
    signal?.throwIfAborted();
    const identity = this.#identity(parentToken, schedule);
    const policy = await this.budget.snapshot(identity);
    if (policy.providerId !== this.feishu.id || policy.driveTenantKey !== schedule.tenant) {
      throw new ScheduleArchiveError("报告未保存：云盘额度配置与任务租户不一致");
    }
    const tenantOrigin = this.sourceAccess.originalOrigins?.[schedule.tenant];
    if (!tenantOrigin) throw new ScheduleArchiveError("报告未保存：未配置该租户的飞书内容域名");
    const name = ownFileName(`${runId}.schedule.md`);
    // Sent before and never heard back from: said as it is, before a CLI is
    // started to find where it would go -- a bridge that is down must not turn
    // an unknown outcome into "not saved".
    if (await this.budget.unresolved(identity, runId)) {
      throw new ScheduleArchiveError("报告上传结果不确定，请到你的云空间（我的空间）核查；系统不会自动重传。",
        this.#record("unknown", name, { providerId: policy.providerId, bytes: report.length, sha256: createHash("sha256").update(report).digest("hex") }));
    }

    const sidecar = await this.createSidecar({ appId: identity.appId,
      getSession: async () => ({ token: parentToken, expiresAt: identity.expiresAt, serverUrl: this.controlPlaneOrigin, identity }) }).start();
    try {
      const client = this.createClient({ profile: null, environment: intent => sidecar.environment(intent),
        identityKey: () => sidecar.sessionFingerprint() });
      const folder = await this.#ownSpace(client, policy, tenantOrigin, signal);
      const input = this.#input(runId, policy, report, folder);
      const own = { own: true };
      const reservation = await this.budget.reserve(identity, input, own);
      const known = await this.budget.reservation(identity, input, own);
      if (reservation.state === "dispatched" || known.state === "dispatched") {
        throw new ScheduleArchiveError("报告上传结果不确定，请到你的云空间（我的空间）核查；系统不会自动重传。",
          this.#record("unknown", name, input));
      }

      // A prior reported reservation is safe to verify, never to upload again.
      if (known.state === "reported") {
        try {
          const receipt = await client.drive.verify({ folder, name, fileToken: known.fileToken, signal });
          // An earlier attempt that overwrote a kept report landed: say which, or
          // two runs would go on naming the same file.
          const overwritten = candidates.find((kept) => kept.fileToken === receipt.fileToken);
          return { detail: `报告已保存到飞书云盘：${receipt.url}`,
            artifact: this.#record("verified", name, input, receipt.fileToken, receipt.url),
            ...(overwritten ? { replaced: overwritten.runId } : {}) };
        } catch {
          throw new ScheduleArchiveError("报告已有上传回执但实时核验失败，请到你的云空间（我的空间）核查；系统不会自动重传。",
            this.#record("unknown", name, input, known.fileToken));
        }
      }

      let fileToken = null;
      const onDispatched = async () => { signal?.throwIfAborted(); await this.budget.change(identity, { id: runId, policyDigest: policy.policyDigest }, true); };
      const onUploaded = async (token) => { fileToken = token; await this.budget.change(identity, { id: runId, fileToken: token }, false); };
      const stale = []; let unreplaced = null;
      const replaceable = candidates.length > 0 && typeof client.drive.replace === "function" &&
        this.sourceAccess.cliWriteActions?.includes(DRIVE_REPLACE);
      for (const kept of replaceable ? candidates : []) {
        try {
          const receipt = await client.drive.replace({ bytes: report, name, previous: kept, folder, confirmed: true, signal, onDispatched, onUploaded });
          signal?.throwIfAborted();
          return { detail: `报告已保存到飞书云盘（替换了这个任务最早的一份）：${receipt.url}`,
            artifact: this.#record("verified", name, input, receipt.fileToken, receipt.url), replaced: kept.runId, stale };
        } catch (error) {
          if (error instanceof ScheduleArchiveError) throw error;
          const after = await this.budget.reservation(identity, input, own);
          if (after.state === "dispatched" || after.state === "reported") {
            throw new ScheduleArchiveError("报告上传结果不确定，请到你的云空间（我的空间）核查；系统不会自动重传。",
              this.#record("unknown", name, input, after.fileToken ?? fileToken));
          }
          if (signal?.aborted) throw error;
          // Nothing was sent. A report Drive shows is gone, renamed or changed
          // is not one this task keeps any more: on to the next oldest. Any
          // other failure proves nothing about it -- a new file, as before, and
          // the reason goes to the operator's log, not to the person.
          if (error?.code !== "drive_file_not_intact") { unreplaced = String(error?.message ?? error).slice(0, 160); break; }
          stale.push(kept.runId);
        }
      }
      try {
        const receipt = await client.drive.upload({ bytes: report, name, folder, confirmed: true, signal, onDispatched, onUploaded });
        signal?.throwIfAborted();
        return { detail: `报告已保存到飞书云盘：${receipt.url}`,
          artifact: this.#record("verified", name, input, receipt.fileToken, receipt.url), stale, ...(unreplaced ? { unreplaced } : {}) };
      } catch (error) {
        if (error instanceof ScheduleArchiveError) throw error;
        const after = await this.budget.reservation(identity, input, own);
        if (after.state === "dispatched" || after.state === "reported") {
          throw new ScheduleArchiveError("报告上传结果不确定，请到你的云空间（我的空间）核查；系统不会自动重传。",
            this.#record("unknown", name, input, after.fileToken ?? fileToken));
        }
        throw new ScheduleArchiveError(`报告未保存：${String(error?.message ?? error).slice(0, 160)}`);
      }
    } finally { await sidecar.close(); }
  }

  // 参考上一次的结果 (G4): the report this schedule's last run left, read back
  // as the same person, the same way it was written: through the owner's own
  // space, and by the file its receipt names -- which also still finds one a
  // run left in the old shared folder. Only the bytes its receipt recorded are accepted: a file changed in
  // Drive since is not what this task wrote. Held in memory long enough to go
  // into the next run's instructions, and never kept here -- the control plane
  // passes a report along, as it does when archiving, and does not store one.
  async recall({ schedule, parentToken, artifact, signal, maxChars = 6000 }) {
    if (!artifact || !/^[A-Za-z0-9_-]{1,256}$/.test(artifact.fileToken ?? "") || !REPORT_NAME.test(artifact.name ?? "") ||
        !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1 || artifact.bytes > MAX_REPORT_BYTES || !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? "")) {
      throw new ScheduleArchiveError("上一次的报告记录无效");
    }
    signal?.throwIfAborted();
    const identity = this.#identity(parentToken, schedule);
    const policy = await this.budget.snapshot(identity);
    if (policy.providerId !== this.feishu.id || policy.driveTenantKey !== schedule.tenant) throw new ScheduleArchiveError("云盘额度配置与任务租户不一致");
    const tenantOrigin = this.sourceAccess.originalOrigins?.[schedule.tenant];
    if (!tenantOrigin) throw new ScheduleArchiveError("未配置该租户的飞书内容域名");
    const sidecar = await this.createSidecar({ appId: identity.appId,
      getSession: async () => ({ token: parentToken, expiresAt: identity.expiresAt, serverUrl: this.controlPlaneOrigin, identity }) }).start();
    try {
      const client = this.createClient({ profile: null, environment: intent => sidecar.environment(intent),
        identityKey: () => sidecar.sessionFingerprint() });
      const folder = await this.#ownSpace(client, policy, tenantOrigin, signal);
      const bytes = await client.drive.download({ folder, name: artifact.name, fileToken: artifact.fileToken, maxBytes: artifact.bytes });
      if (bytes.length !== artifact.bytes || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) {
        throw new ScheduleArchiveError("云盘上的报告和当时保存的不一致");
      }
      const text = bytes.toString("utf8").trim();
      return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
    } finally { await sidecar.close(); }
  }
}
