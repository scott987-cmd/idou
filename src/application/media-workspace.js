import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { validateServerUrl } from "../control-plane/client-session.js";
import { mediaResultUrl } from "../control-plane/minimax-media.js";
import { validateTaskId } from "./task-store.js";
import { validateDelivery } from "./media-delivery.js";
import { CLOCK_SKEW_MS } from "./clock-skew.js";

const uuid = (value) => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const states = ["running", "awaiting_acceptance", "failed", "submission_unknown", "canceled", "expired"];
const localStates = [...states, "unresolved", "server_lost"];
const sha = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function mediaInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["kind", "prompt", "aspectRatio"].includes(key)) || !["image", "video"].includes(value.kind) || typeof value.prompt !== "string" || !value.prompt.trim()) throw new Error("请输入有效的图片或视频描述");
  // Too long is said as too long, with the limit: 请输入有效的图片或视频描述 for a
  // 2,500-character brief sent the Agent looking for something else wrong (2026-09-23).
  const limit = value.kind === "image" ? 1500 : 2000;
  if (value.prompt.length > limit) throw new Error(`${value.kind === "image" ? "图片" : "视频"}描述最多 ${limit} 个字符，这次是 ${value.prompt.length} 个；请精简后再生成`);
  if (value.kind === "video") { if (value.aspectRatio !== undefined) throw new Error("视频尺寸由服务端配置"); return { kind: value.kind, prompt: value.prompt }; }
  const aspectRatio = value.aspectRatio ?? "1:1";
  if (!["1:1", "16:9", "4:3", "3:2", "2:3", "3:4", "9:16", "21:9"].includes(aspectRatio)) throw new Error("图片比例无效");
  return { kind: "image", prompt: value.prompt, aspectRatio };
}
// Who makes it and with what, as the server said when it issued the lease --
// the confirmation card is built from this, so it names where the description
// really goes. A server from before offers says nothing and only ever used
// MiniMax, with these models; a job for it names no model.
export const MEDIA_PROVIDERS = Object.freeze({ minimax: "MiniMax", qwen: "阿里云百炼" });
const LEGACY_OFFERS = Object.freeze({
  image: Object.freeze({ provider: "minimax", model: "image-01", legacy: true }),
  video: Object.freeze({ provider: "minimax", model: "MiniMax-Hailuo-2.3", seconds: 6, resolution: "768P", legacy: true }),
});
// Only the fields named here are taken, so a later server can say more
// without this refusing it, and nothing else of the answer reaches the card.
export function mediaOffer(value, kind) {
  if (value === undefined) return LEGACY_OFFERS[kind];
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(MEDIA_PROVIDERS, value.provider)
      || typeof value.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.model)) throw new Error("媒体授权响应无效");
  const { provider, model, seconds, resolution, aspectRatio } = value;
  if (kind !== "video") return Object.freeze({ provider, model });
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60 || typeof resolution !== "string" || !/^[0-9]{3,4}P$/.test(resolution)
      || (aspectRatio !== undefined && (typeof aspectRatio !== "string" || !/^[0-9]{1,2}:[0-9]{1,2}$/.test(aspectRatio)))) throw new Error("媒体授权响应无效");
  return Object.freeze({ provider, model, seconds, resolution, ...(aspectRatio === undefined ? {} : { aspectRatio }) });
}
// A chat server on GLM with no MiniMax key answers every media route with 503
// media_provider_not_configured. That is configuration, not a passing outage,
// so it is said as such rather than as a temporary-sounding HTTP 503.
const NO_MEDIA_PROVIDER = "服务端没有配置 MiniMax 密钥，图片与视频暂不可用，请联系管理员。对话模型不受影响。";
class MediaHttpError extends Error {
  constructor(status, code = null) { super(code === "media_provider_not_configured" ? NO_MEDIA_PROVIDER : `媒体服务暂不可用（HTTP ${status}）。未自动重新生成。`); this.status = status; this.code = code; }
}
// Only the gateway's own error code, from a small JSON body; nothing of the
// body is ever shown.
async function refusalCode(response) {
  if (response.headers.get("content-type")?.split(";")[0].trim() !== "application/json" || !response.body) return null;
  const chunks = []; let size = 0; const reader = response.body.getReader();
  try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 4096) { await reader.cancel(); return null; } chunks.push(Buffer.from(value)); } }
  catch { return null; } finally { reader.releaseLock(); }
  try { const code = JSON.parse(Buffer.concat(chunks))?.error?.code; return typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : null; } catch { return null; }
}
// What the server's code for a job's last failure means. For a job still
// running it is the last time the server asked the provider about it: a video
// that says running with an error for a long time is not progressing, and
// "hasError" alone left the Agent to guess how (2026-09-23: 40 minutes of
// polling a video that was never going to arrive). Only the server's own short
// code is passed on; nothing of a provider's payload ever is.
const MEDIA_ERRORS = {
  media_provider_unavailable: "生成服务暂时连不上或超时",
  media_provider_protocol_error: "生成服务返回的内容和预期的格式不符",
  media_provider_rejected: "生成服务拒绝了这个任务",
  media_provider_response_too_large: "生成服务返回的内容超出上限",
  invalid_media_result: "生成服务给的成果不合规（地址或文件信息不对）",
  invalid_media_task: "任务编号不合规",
  media_task_unknown: "生成服务查不到这个任务（编号不存在或已过期）",
};
function jobSnapshot(value, kind, expectedId, now, model) {
  if (!value || !uuid(value.id) || (expectedId && value.id !== expectedId) || value.kind !== kind || value.model !== model || !states.includes(value.state) || value.persisted !== false || !Number.isFinite(value.createdAt) || !Number.isFinite(value.expiresAt) || value.expiresAt <= value.createdAt || value.expiresAt > value.createdAt + 86400000 || typeof value.providerMayContinue !== "boolean") throw new Error("媒体任务响应无效，未使用结果");
  const result = { jobId: value.id, state: value.state, model: value.model, expiresAt: value.expiresAt, providerMayContinue: value.providerMayContinue, hasError: Boolean(value.error),
    error: typeof value.error === "string" && /^[a-z_]{1,64}$/.test(value.error) ? value.error : null };
  if (value.state === "awaiting_acceptance") {
    if (!value.result || !Number.isFinite(value.result.expiresAt) || value.result.expiresAt <= now || value.result.expiresAt > now + 3600000 || !(value.result.bytes === null || (Number.isSafeInteger(value.result.bytes) && value.result.bytes > 0 && value.result.bytes <= 104857600))) throw new Error("临时成果已过期或响应无效");
    result.result = { url: mediaResultUrl(value.result.url), expiresAt: value.result.expiresAt, bytes: value.result.bytes };
  }
  return result;
}

// Native-only: prompts live in a confirmed draft until submission; token and result
// URL never enter the journal or renderer. The journal reserves before POST.
export class MediaWorkspace {
  constructor({ filename, getSession, getTask, fetchImpl = fetch, now = Date.now }) {
    Object.assign(this, { filename, getSession, getTask, fetch: fetchImpl, now });
    this.rows = []; this.leases = new Map(); this.queue = Promise.resolve(); this.loaded = false;
  }
  serial(fn) { const next = this.queue.then(fn); this.queue = next.catch(() => {}); return next; }
  async load() {
    if (this.loaded) return;
    try {
      const handle = await open(this.filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 1048576 || (process.platform !== "win32" && ((stat.mode & 0o077) || stat.uid !== process.getuid()))) throw new Error();
        const value = JSON.parse(await handle.readFile("utf8"));
        if (value.schemaVersion !== 1 || !Array.isArray(value.rows) || value.rows.length > 200) throw new Error();
        for (const row of value.rows) {
          if (!uuid(row.id) || !uuid(row.taskId) || !uuid(row.instanceId) || (row.jobId !== null && !uuid(row.jobId)) || !["image", "video"].includes(row.kind) || !localStates.includes(row.state) || !/^[a-f0-9]{64}$/.test(row.ownerKey) || !Number.isFinite(row.createdAt) || Object.keys(row).some((key) => !["id", "taskId", "instanceId", "jobId", "kind", "state", "ownerKey", "createdAt", "delivery", "submitError"].includes(key))) throw new Error();
          if (row.delivery) validateDelivery(row.delivery);
        }
        if (new Set(value.rows.map((row) => row.id)).size !== value.rows.length) throw new Error();
        this.rows = value.rows;
      } finally { await handle.close(); }
    } catch (error) { if (error.code !== "ENOENT") throw new Error("媒体任务记录无效，原记录未改动；请联系管理员"); }
    this.loaded = true;
  }
  async save() {
    await mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    const temporary = `${this.filename}.${randomUUID()}.tmp`; let handle;
    try {
      handle = await open(temporary, "wx", 0o600); await handle.writeFile(JSON.stringify({ schemaVersion: 1, rows: this.rows })); await handle.sync(); await handle.close(); handle = null;
      await rename(temporary, this.filename);
      // Ensure the reservation's rename reaches the directory before a paid POST.
      if (process.platform !== "win32") { const directory = await open(path.dirname(this.filename), "r"); try { await directory.sync(); } finally { await directory.close(); } }
    } finally { await handle?.close(); await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
  }
  async session() {
    const value = await this.getSession();
    if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value.token) || !Number.isFinite(value.expiresAt) || value.expiresAt <= this.now()) throw new Error("请先连接模型服务或重新登录");
    return { ...value, serverUrl: validateServerUrl(value.serverUrl) };
  }
  async unchanged(session) {
    const current = await this.session();
    if (current.token !== session.token || current.serverUrl !== session.serverUrl || JSON.stringify(current.identity) !== JSON.stringify(session.identity)) throw new Error("账号或服务端连接已变化，未沿用旧媒体结果");
  }
  async request(session, route, token, body) {
    let response;
    try { response = await this.fetch(`${session.serverUrl}${route}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }); }
    catch { throw new Error("媒体服务连接中断；提交结果可能未知，未自动重新生成"); }
    if (!response.ok || !response.body || response.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
      const code = response.status === 503 ? await refusalCode(response) : null;
      await response.body?.cancel().catch(() => {}); throw new MediaHttpError(response.status, code);
    }
    const chunks = []; let size = 0; const reader = response.body.getReader();
    try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 32768) { await reader.cancel(); throw new Error("媒体响应超限"); } chunks.push(Buffer.from(value)); } }
    finally { reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks)); } catch { throw new Error("媒体服务响应无效"); }
  }
  async lease(session, kind) {
    const prior = this.leases.get(kind);
    if (prior?.parent === session.token && prior.origin === session.serverUrl && prior.expiresAt > this.now() + 30000) return prior;
    let value;
    // This route either exists or it does not. A 404 here is never a missing
    // job; it means the control plane was started without media enabled, and
    // saying so beats an HTTP status the operator has to go and look up.
    try { value = await this.request(session, "/auth/media-token", session.token, { kind }); }
    catch (error) {
      if (error instanceof MediaHttpError && error.status === 404) throw new Error("控制面没有启用图片与视频服务。请在部署文件中加上 IDOU_MEDIA_ENABLED=1 并重启服务端；启用后每次生成都是一次真实付费调用。");
      throw error;
    }
    const owner = value.owner;
    if (value.audience !== "media-service" || value.kind !== kind || !uuid(value.instanceId) || !/^[A-Za-z0-9_-]{43}$/.test(value.token) || !Number.isFinite(value.expiresAt) || value.expiresAt <= this.now() || value.expiresAt > Math.min(session.expiresAt, this.now() + 300000 + CLOCK_SKEW_MS) || !owner || !["development", "feishu"].includes(owner.authProvider) || ![owner.tenantId, owner.userId].every((s) => typeof s === "string" && s.length > 0 && s.length <= 256) || (owner.authProvider === "feishu" && (typeof owner.appId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(owner.appId)))) throw new Error("媒体授权响应无效");
    if (session.identity && (owner.authProvider !== "feishu" || ["tenantId", "userId", "appId"].some((key) => session.identity[key] !== owner[key]))) throw new Error("媒体授权账号不匹配");
    const offer = mediaOffer(value.offer, kind);
    await this.unchanged(session);
    const lease = { token: value.token, expiresAt: value.expiresAt, instanceId: value.instanceId, ownerKey: sha([session.serverUrl, owner.authProvider, owner.tenantId, owner.appId, owner.userId]), parent: session.token, origin: session.serverUrl, offer };
    this.leases.set(kind, lease); return lease;
  }
  task(id) { validateTaskId(id); if (this.getTask(id).mode !== "cowork") throw new Error("图片与视频生成属于工作任务"); }
  async prepare(taskId, input) {
    this.task(taskId); const request = mediaInput(input), session = await this.session();
    const lease = await this.lease(session, request.kind);
    return { taskId, request, session, lease };
  }
  async create(draft) {
    return this.serial(async () => {
      this.task(draft.taskId); await this.unchanged(draft.session); await this.load();
      if (draft.lease.expiresAt <= this.now() || this.rows.length >= 200) throw new Error("媒体授权已过期或本地记录已满，请重新检查");
      const row = { id: randomUUID(), taskId: draft.taskId, kind: draft.request.kind, instanceId: draft.lease.instanceId, ownerKey: draft.lease.ownerKey, jobId: null, state: "unresolved", createdAt: this.now() };
      this.rows.push(row);
      await this.save(); // Failure here must never dispatch the paid request.
      try {
        await this.unchanged(draft.session);
        // The model the person confirmed goes with the job, and the server
        // refuses it if that is not what it would use.
        const value = await this.request(draft.session, "/v1/media/jobs", draft.lease.token, { ...draft.request, idempotencyKey: row.id, instanceId: row.instanceId, confirmed: true,
          ...(draft.lease.offer.legacy ? {} : { model: draft.lease.offer.model }) });
        await this.unchanged(draft.session);
        const job = jobSnapshot(value, row.kind, null, this.now(), draft.lease.offer.model); row.jobId = job.jobId; row.state = job.state; await this.save();
      } catch (error) {
        // Never retry generation here: the request may already have been billed.
        // But swallowing the reason left a record sitting at "待核查" with nothing
        // to act on, so the reason is kept — a local message or an HTTP status,
        // never a token, a URL or a provider payload.
        row.submitError = String(error?.message ?? error).slice(0, 200);
        await this.save().catch(() => {});
      }
      return this.public(row);
    });
  }
  public(row, job = {}) { return { id: row.id, taskId: row.taskId, kind: row.kind, state: row.state, createdAt: row.createdAt, hasResult: Boolean(job.result), hasError: job.hasError ?? false, ...(job.error ? { error: job.error, errorMeaning: MEDIA_ERRORS[job.error] ?? "生成服务报告了错误" } : {}), persisted: row.delivery?.state === "available", deliveryState: row.delivery?.state ?? null, ...(row.submitError ? { submitError: row.submitError } : {}) }; }
  async list(taskId) {
    return this.serial(async () => { this.task(taskId); await this.load(); const session = await this.session(), lease = await this.lease(session, "image"); return this.rows.filter((row) => row.taskId === taskId && row.ownerKey === lease.ownerKey).map((row) => this.public(row)); });
  }
  async inspect(taskId, id, cancel = false) {
    this.task(taskId); await this.load(); const row = this.rows.find((row) => row.id === id && row.taskId === taskId);
    if (!row) throw new Error("找不到当前任务的媒体记录");
    const session = await this.session(), lease = await this.lease(session, row.kind);
    if (row.ownerKey !== lease.ownerKey) throw new Error("媒体任务不属于当前账号或服务端");
    if (row.instanceId !== lease.instanceId) { row.state = "server_lost"; await this.save(); return { row }; }
    let job;
    try {
      const value = await this.request(session, row.jobId ? "/v1/media/job" : "/v1/media/lookup", lease.token, row.jobId ? { id: row.jobId } : { idempotencyKey: row.id, instanceId: row.instanceId });
      // Jobs live in the server's memory and its configuration cannot change
      // without a restart, which ends them: any job it still has was made with
      // the model its lease names today.
      await this.unchanged(session); job = jobSnapshot(value, row.kind, row.jobId, this.now(), lease.offer.model); row.jobId = job.jobId;
      if (cancel && ["running", "awaiting_acceptance"].includes(job.state)) {
        const canceled = await this.request(session, "/v1/media/cancel", lease.token, { id: row.jobId });
        await this.unchanged(session); job = jobSnapshot(canceled, row.kind, row.jobId, this.now(), lease.offer.model);
      }
      row.state = job.state;
    } catch (error) {
      this.leases.delete(row.kind);
      if (!(error instanceof MediaHttpError) || ![404, 409].includes(error.status)) throw error;
      row.state = "unresolved";
    }
    await this.save(); return { row, job, session };
  }
  refresh(taskId, id, cancel = false) { return this.serial(async () => { const { row, job } = await this.inspect(taskId, id, cancel); return this.public(row, job); }); }
  result(taskId, id) { return this.serial(async () => {
    const { row, job, session } = await this.inspect(taskId, id);
    if (!job?.result) throw new Error("临时成果尚不可用，请刷新任务状态");
    return { kind: row.kind, ...job.result, session };
  }); }
  async close() { await this.queue; this.leases.clear(); }
}
