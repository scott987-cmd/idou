import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { validateTaskId } from "./task-store.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/;
const VISIBLE = new Set(["queued", "dispatching", "paused", "failed"]);
const MUTABLE = new Set(["queued", "paused", "failed"]);
const MAX_QUEUED = 10;
const MAX_BYTES = 256 * 1024;
const clone = value => structuredClone(value);
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function payload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.text !== "string" || !value.text.trim() || value.text.length > 100_000) throw new Error("请输入 1–100000 字的下一轮内容");
  const clean = { text: value.text.trim(), ...(value.context ? { context: clone(value.context) } : {}), ...(value.options ? { options: clone(value.options) } : {}) };
  const encoded = JSON.stringify(clean);
  if (Buffer.byteLength(encoded) > MAX_BYTES) throw new Error("下一轮内容和引用过多，请减少后再排队");
  return clean;
}
function validEntry(row) {
  return row && UUID.test(row.id) && UUID.test(row.taskId) && UUID.test(row.clientRequestId) && ["queued", "dispatching", "dispatched", "paused", "failed", "canceled"].includes(row.state)
    && Number.isSafeInteger(row.revision) && row.revision > 0 && Number.isFinite(row.createdAt) && Number.isFinite(row.updatedAt)
    && DIGEST.test(row.capturedConfigRevision) && DIGEST.test(row.payloadDigest) && digest(payload(row.payload)) === row.payloadDigest
    && (row.dispatchedTurnKey === null || (typeof row.dispatchedTurnKey === "string" && row.dispatchedTurnKey.length <= 200))
    && (row.reason === null || (typeof row.reason === "string" && row.reason.length <= 500)) && typeof row.unknown === "boolean";
}
function validTaskState(row) {
  return row && UUID.test(row.taskId) && typeof row.paused === "boolean" && Number.isSafeInteger(row.revision) && row.revision > 0
    && (row.reason === null || (typeof row.reason === "string" && row.reason.length <= 500));
}

export function taskQueueConfigRevision(task, model = null) {
  return digest({ mode: task.mode, cwd: task.cwd, permission: task.permission, executionPermission: task.executionPermission ?? null,
    stage: task.stage ?? null, knowledgeScope: task.knowledgeScope ?? null, enterpriseSkill: task.enterpriseSkill ?? null,
    mcpConnection: task.mcpConnection ?? null, model: model ?? null });
}

export class TaskQueue {
  constructor(filename, { now = Date.now } = {}) {
    this.filename = filename; this.now = now; this.entries = []; this.tasks = new Map(); this.pending = Promise.resolve(); this.loaded = false; this.readOnly = false; this.warnings = [];
  }
  serial(operation) {
    const next = this.pending.then(operation); this.pending = next.catch(() => {}); return next;
  }
  async init() {
    if (this.loaded) return;
    await mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    let value;
    try { value = JSON.parse(await readFile(this.filename, "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") { this.loaded = true; return; }
      this.readOnly = true; this.warnings.push("下一轮队列记录无法读取，原文件未修改；队列已设为只读。"); this.loaded = true; return;
    }
    if (value?.schemaVersion !== 1) {
      this.readOnly = true; this.warnings.push("下一轮队列来自更新版本，原文件未修改；请升级应用后再处理。"); this.loaded = true; return;
    }
    if (!Array.isArray(value.entries) || !Array.isArray(value.tasks) || value.entries.length > 500 || value.tasks.length > 500 || !value.entries.every(validEntry) || !value.tasks.every(validTaskState)) {
      this.readOnly = true; this.warnings.push("下一轮队列记录无效，原文件未修改；队列已设为只读。"); this.loaded = true; return;
    }
    this.entries = value.entries; this.tasks = new Map(value.tasks.map(row => [row.taskId, row])); this.loaded = true;
    let changed = false;
    for (const entry of this.entries) {
      if (entry.state === "dispatching") { entry.state = "failed"; entry.unknown = true; entry.reason = "应用退出时派发结果未知；不会自动重试"; entry.revision += 1; entry.updatedAt = this.now(); changed = true; }
      else if (entry.state === "queued") { entry.state = "paused"; entry.reason = "应用已重新启动；请核对后继续"; entry.revision += 1; entry.updatedAt = this.now(); changed = true; }
    }
    for (const taskId of new Set(this.entries.filter(row => VISIBLE.has(row.state)).map(row => row.taskId))) {
      const state = this.state(taskId); if (!state.paused) { state.paused = true; state.reason = "应用已重新启动；请核对后继续"; state.revision += 1; changed = true; }
    }
    if (changed) await this.save();
  }
  state(taskId) {
    validateTaskId(taskId);
    let row = this.tasks.get(taskId);
    if (!row) { row = { taskId, paused: false, reason: null, revision: 1 }; this.tasks.set(taskId, row); }
    return row;
  }
  snapshot(taskId) {
    const state = this.state(taskId);
    return { paused: state.paused, reason: state.reason, revision: state.revision,
      entries: this.entries.filter(row => row.taskId === taskId && VISIBLE.has(row.state)).sort((a, b) => a.createdAt - b.createdAt).map(clone),
      readOnly: this.readOnly, warnings: [...this.warnings] };
  }
  assertWritable() { if (this.readOnly) throw new Error(this.warnings[0] || "下一轮队列当前只读"); }
  async save() {
    this.assertWritable();
    const value = JSON.stringify({ schemaVersion: 1, tasks: [...this.tasks.values()], entries: this.entries.slice(-500) });
    const temporary = `${this.filename}.${randomUUID()}.tmp`; let handle;
    try {
      handle = await open(temporary, "wx", 0o600); await handle.writeFile(value); await handle.sync(); await handle.close(); handle = null;
      await rename(temporary, this.filename);
      if (process.platform !== "win32") { const directory = await open(path.dirname(this.filename), "r"); try { await directory.sync(); } finally { await directory.close(); } }
    } finally { await handle?.close(); await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  }
  enqueue(taskId, request, capturedConfigRevision) {
    return this.serial(async () => {
      await this.init(); this.assertWritable(); validateTaskId(taskId);
      if (!UUID.test(request?.clientRequestId ?? "") || !DIGEST.test(capturedConfigRevision ?? "")) throw new Error("下一轮请求身份无效");
      const clean = payload(request), payloadDigest = digest(clean);
      const prior = this.entries.find(row => row.taskId === taskId && row.clientRequestId === request.clientRequestId);
      if (prior) {
        if (prior.payloadDigest !== payloadDigest || prior.capturedConfigRevision !== capturedConfigRevision) throw new Error("同一个下一轮请求不能改成不同内容");
        return clone(prior);
      }
      if (this.entries.filter(row => row.taskId === taskId && VISIBLE.has(row.state)).length >= MAX_QUEUED) throw new Error("下一轮队列最多 10 条；原草稿没有丢失");
      const task = this.state(taskId), now = this.now();
      const entry = { id: randomUUID(), taskId, clientRequestId: request.clientRequestId, state: task.paused ? "paused" : "queued", revision: 1,
        createdAt: now, updatedAt: now, payload: clean, payloadDigest, capturedConfigRevision, dispatchedTurnKey: null, reason: task.paused ? task.reason : null, unknown: false };
      this.entries.push(entry); await this.save(); return clone(entry);
    });
  }
  update(taskId, queueId, expectedRevision, nextPayload) {
    return this.serial(async () => {
      await this.init(); this.assertWritable(); const entry = this.owned(taskId, queueId);
      if (!MUTABLE.has(entry.state) || entry.unknown) throw new Error("这条下一轮记录不能修改；结果未知的记录只能移除后重新输入");
      if (entry.revision !== expectedRevision) throw new Error("这条下一轮内容已变化，请重新核对");
      entry.payload = payload(nextPayload); entry.payloadDigest = digest(entry.payload); entry.revision += 1; entry.updatedAt = this.now();
      const task = this.state(taskId); task.paused = true; task.reason = "下一轮内容已编辑；请核对当前设置后继续"; task.revision += 1;
      entry.state = "paused"; entry.reason = task.reason; await this.save(); return clone(entry);
    });
  }
  remove(taskId, queueId, expectedRevision) {
    return this.serial(async () => {
      await this.init(); this.assertWritable(); const entry = this.owned(taskId, queueId);
      if (entry.state === "dispatching") throw new Error("这条消息正在派发，结果确定前不能移除");
      if (!VISIBLE.has(entry.state) || entry.revision !== expectedRevision) throw new Error("这条下一轮记录已变化，请刷新后重试");
      entry.state = "canceled"; entry.reason = "已移除"; entry.revision += 1; entry.updatedAt = this.now(); await this.save(); return clone(entry);
    });
  }
  owned(taskId, queueId) {
    validateTaskId(taskId); if (!UUID.test(queueId ?? "")) throw new Error("下一轮记录身份无效");
    const entry = this.entries.find(row => row.id === queueId && row.taskId === taskId); if (!entry) throw new Error("找不到这条下一轮记录"); return entry;
  }
  pause(taskId, reason = "下一轮队列已暂停", { ifPresent = false } = {}) {
    return this.serial(async () => {
      await this.init(); this.assertWritable();
      if (ifPresent && !this.entries.some(entry => entry.taskId === taskId && VISIBLE.has(entry.state))) return this.snapshot(taskId);
      const task = this.state(taskId); task.paused = true; task.reason = String(reason).slice(0, 500); task.revision += 1;
      for (const entry of this.entries) if (entry.taskId === taskId && entry.state === "queued") { entry.state = "paused"; entry.reason = task.reason; entry.revision += 1; entry.updatedAt = this.now(); }
      await this.save(); return this.snapshot(taskId);
    });
  }
  pauseAll(reason = "应用已退出；请重新核对下一轮队列") {
    return this.serial(async () => {
      await this.init(); this.assertWritable(); const ids = new Set(this.entries.filter(row => VISIBLE.has(row.state)).map(row => row.taskId));
      for (const taskId of ids) { const task = this.state(taskId); task.paused = true; task.reason = String(reason).slice(0, 500); task.revision += 1;
        for (const entry of this.entries) if (entry.taskId === taskId && entry.state === "queued") { entry.state = "paused"; entry.reason = task.reason; entry.revision += 1; entry.updatedAt = this.now(); } }
      if (ids.size) await this.save();
    });
  }
  resume(taskId, capturedConfigRevision) {
    return this.serial(async () => {
      await this.init(); this.assertWritable(); if (!DIGEST.test(capturedConfigRevision ?? "")) throw new Error("当前任务配置无效");
      const task = this.state(taskId); task.paused = false; task.reason = null; task.revision += 1;
      for (const entry of this.entries) if (entry.taskId === taskId && entry.state === "paused" && !entry.unknown) {
        entry.state = "queued"; entry.reason = null; entry.capturedConfigRevision = capturedConfigRevision; entry.revision += 1; entry.updatedAt = this.now();
      }
      await this.save(); return this.snapshot(taskId);
    });
  }
  begin(taskId, currentConfigRevision) {
    return this.serial(async () => {
      await this.init(); this.assertWritable(); const task = this.state(taskId); if (task.paused) return null;
      const entry = this.entries.find(row => row.taskId === taskId && row.state === "queued"); if (!entry) return null;
      if (entry.capturedConfigRevision !== currentConfigRevision) {
        task.paused = true; task.reason = "权限、模型、知识范围或任务配置已变化；请核对后继续"; task.revision += 1;
        for (const row of this.entries) if (row.taskId === taskId && row.state === "queued") { row.state = "paused"; row.reason = task.reason; row.revision += 1; row.updatedAt = this.now(); }
        await this.save(); return null;
      }
      entry.state = "dispatching"; entry.reason = "正在派发；应用退出后不会自动重试"; entry.revision += 1; entry.updatedAt = this.now(); await this.save(); return clone(entry);
    });
  }
  dispatched(taskId, queueId, turnKey) {
    return this.serial(async () => {
      await this.init(); this.assertWritable(); const entry = this.owned(taskId, queueId);
      if (entry.state !== "dispatching" || typeof turnKey !== "string" || !turnKey || turnKey.length > 200) throw new Error("下一轮派发回执无效");
      entry.state = "dispatched"; entry.dispatchedTurnKey = turnKey; entry.reason = null; entry.revision += 1; entry.updatedAt = this.now(); await this.save(); return clone(entry);
    });
  }
  failed(taskId, queueId, reason, { unknown = false } = {}) {
    return this.serial(async () => {
      await this.init(); this.assertWritable(); const entry = this.owned(taskId, queueId); if (entry.state !== "dispatching") throw new Error("下一轮记录不在派发中");
      entry.state = "failed"; entry.unknown = unknown === true; entry.reason = String(reason).slice(0, 500); entry.revision += 1; entry.updatedAt = this.now();
      const task = this.state(taskId); task.paused = true; task.reason = entry.reason; task.revision += 1;
      for (const row of this.entries) if (row.taskId === taskId && row.state === "queued") { row.state = "paused"; row.reason = task.reason; row.revision += 1; row.updatedAt = this.now(); }
      await this.save(); return clone(entry);
    });
  }
  removeTask(taskId) {
    return this.serial(async () => { await this.init(); this.assertWritable(); this.entries = this.entries.filter(row => row.taskId !== taskId); this.tasks.delete(taskId); await this.save(); });
  }
  async flush() { await this.pending; }
}
