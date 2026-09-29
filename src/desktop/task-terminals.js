import { EventEmitter } from "node:events";
import { stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pty from "node-pty";

const DEFAULT_MAX_BYTES = 1024 * 1024;
const MAX_WRITE_BYTES = 64 * 1024;
const SIZE = Object.freeze({ minColumns: 2, maxColumns: 500, minRows: 1, maxRows: 300 });
const ENVIRONMENT_NAMES = new Set([
  "HOME", "USER", "LOGNAME", "SHELL", "PATH", "LANG", "TMPDIR",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "__CF_USER_TEXT_ENCODING",
]);

function boundedInteger(value, fallback, minimum, maximum) {
  return Number.isSafeInteger(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}

export function terminalSize(value = {}) {
  return {
    cols: boundedInteger(value.cols, 80, SIZE.minColumns, SIZE.maxColumns),
    rows: boundedInteger(value.rows, 24, SIZE.minRows, SIZE.maxRows),
  };
}

export function terminalEnvironment(source = process.env) {
  const result = {};
  for (const [name, value] of Object.entries(source ?? {})) {
    if ((!ENVIRONMENT_NAMES.has(name) && !/^LC_[A-Z_]{1,30}$/.test(name)) || typeof value !== "string" || value.length > 16_384 || value.includes("\0")) continue;
    result[name] = value;
  }
  result.PATH ||= "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  result.TERM = "xterm-256color";
  result.COLORTERM = "truecolor";
  result.TERM_PROGRAM = "idou";
  return result;
}

function shellFor(environment, platform = process.platform) {
  if (platform === "win32") return { file: process.env.COMSPEC || "C:\\Windows\\System32\\cmd.exe", args: [] };
  const allowed = new Set(["/bin/zsh", "/usr/bin/zsh", "/bin/bash", "/usr/bin/bash", "/bin/sh"]);
  const requested = allowed.has(environment.SHELL) ? environment.SHELL : platform === "darwin" ? "/bin/zsh" : "/bin/bash";
  // The app process already has the login shell's PATH. Loading rc/profile files
  // again could re-introduce secrets which were deliberately removed above.
  if (path.basename(requested) === "zsh") return { file: requested, args: ["-f"] };
  if (path.basename(requested) === "bash") return { file: requested, args: ["--noprofile", "--norc"] };
  return { file: requested, args: [] };
}

class OutputBuffer {
  constructor(maxBytes) { this.maxBytes = maxBytes; this.parts = []; this.bytes = 0; this.truncated = false; }
  append(value) {
    let part = Buffer.from(String(value), "utf8");
    if (part.length >= this.maxBytes) {
      this.parts = [part.subarray(part.length - this.maxBytes)]; this.bytes = this.maxBytes; this.truncated = true; return;
    }
    this.parts.push(part); this.bytes += part.length;
    while (this.bytes > this.maxBytes && this.parts.length) {
      const overflow = this.bytes - this.maxBytes, first = this.parts[0];
      if (first.length <= overflow) { this.parts.shift(); this.bytes -= first.length; }
      else { this.parts[0] = first.subarray(overflow); this.bytes -= overflow; }
      this.truncated = true;
    }
  }
  text() { return Buffer.concat(this.parts, this.bytes).toString("utf8"); }
}

function publicRecord(record) {
  return {
    taskId: record.taskId, terminalId: record.id, cwd: record.cwd, state: record.state,
    output: record.output.text(), truncated: record.output.truncated,
    seq: record.seq, ...(record.exit ? { exit: { ...record.exit } } : {}),
  };
}

export class TaskTerminals extends EventEmitter {
  constructor({ getTask, spawn = pty.spawn, environment = process.env, platform = process.platform, maxBytes = DEFAULT_MAX_BYTES } = {}) {
    super();
    if (typeof getTask !== "function") throw new TypeError("getTask is required");
    if (typeof spawn !== "function") throw new TypeError("spawn is required");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024) throw new TypeError("maxBytes must be at least 1024");
    this.getTask = getTask; this.spawn = spawn; this.environment = terminalEnvironment(environment); this.shell = shellFor(this.environment, platform); this.maxBytes = maxBytes;
    this.byId = new Map(); this.byTask = new Map(); this.closed = false;
  }

  async open(taskId, size = {}) {
    this.#available();
    const task = this.#task(taskId), existing = this.byTask.get(task.id);
    if (existing) return publicRecord(this.byId.get(existing));
    return this.#spawn(task, size);
  }

  async reopen(taskId, terminalId, size = {}) {
    this.#available();
    const record = this.#owned(taskId, terminalId);
    if (record.state === "running") throw new Error("终端仍在运行，无需重新打开");
    this.#forget(record);
    return this.#spawn(this.#task(taskId), size);
  }

  write(taskId, terminalId, data) {
    const record = this.#owned(taskId, terminalId);
    if (record.state !== "running") throw new Error("终端已经退出，请重新打开");
    if (typeof data !== "string" || !data.length || Buffer.byteLength(data, "utf8") > MAX_WRITE_BYTES) throw new Error("终端输入无效或过长");
    record.pty.write(data); return { accepted: true };
  }

  resize(taskId, terminalId, value) {
    const record = this.#owned(taskId, terminalId);
    if (record.state !== "running") throw new Error("终端已经退出，请重新打开");
    const size = terminalSize(value); record.pty.resize(size.cols, size.rows); return size;
  }

  inspect(taskId, terminalId) { return publicRecord(this.#owned(taskId, terminalId)); }

  close(taskId, terminalId) {
    const record = this.#owned(taskId, terminalId);
    if (record.state === "running") { record.state = "closing"; record.pty.kill(); }
    this.#forget(record); return { closed: true };
  }

  closeTask(taskId) {
    const terminalId = this.byTask.get(taskId);
    if (!terminalId) return { closed: false };
    return this.close(taskId, terminalId);
  }

  closeAll() {
    this.closed = true;
    for (const record of [...this.byId.values()]) {
      if (record.state === "running") { record.state = "closing"; try { record.pty.kill(); } catch { /* process already exited */ } }
      this.#forget(record);
    }
  }

  async #spawn(task, value) {
    const info = await stat(task.cwd).catch(() => null);
    if (!info?.isDirectory()) throw new Error("任务工作目录已移动或不可用");
    if (this.closed) throw new Error("终端服务正在退出");
    const size = terminalSize(value), id = randomUUID(), output = new OutputBuffer(this.maxBytes);
    const process = this.spawn(this.shell.file, this.shell.args, { cwd: task.cwd, env: { ...this.environment }, name: "xterm-256color", cols: size.cols, rows: size.rows });
    const record = { id, taskId: task.id, cwd: task.cwd, state: "running", output, pty: process, exit: null, seq: 0, dataDisposable: null, exitDisposable: null };
    this.byId.set(id, record); this.byTask.set(task.id, id);
    record.dataDisposable = process.onData((data) => {
      if (this.byId.get(id) !== record) return;
      output.append(data); record.seq += 1; this.emit("data", { taskId: task.id, terminalId: id, seq: record.seq, data: String(data) });
    });
    record.exitDisposable = process.onExit(({ exitCode, signal }) => {
      if (this.byId.get(id) !== record) return;
      record.state = "exited"; record.exit = { exitCode: Number.isInteger(exitCode) ? exitCode : null, signal: Number.isInteger(signal) ? signal : null };
      this.emit("exit", { taskId: task.id, terminalId: id, ...record.exit });
    });
    return publicRecord(record);
  }

  #task(taskId) {
    const task = this.getTask(taskId);
    if (!task || task.mode !== "coding") throw new Error("只有编程任务可以打开终端");
    return task;
  }

  #owned(taskId, terminalId) {
    this.#available();
    if (typeof terminalId !== "string" || terminalId.length > 200) throw new Error("终端身份无效");
    const task = this.#task(taskId), record = this.byId.get(terminalId);
    if (!record || record.taskId !== task.id || this.byTask.get(task.id) !== record.id) throw new Error("终端不属于当前任务");
    return record;
  }

  #forget(record) {
    if (this.byId.get(record.id) === record) this.byId.delete(record.id);
    if (this.byTask.get(record.taskId) === record.id) this.byTask.delete(record.taskId);
    record.dataDisposable?.dispose?.(); record.exitDisposable?.dispose?.();
  }

  #available() { if (this.closed) throw new Error("终端服务正在退出"); }
}

export const TERMINAL_OUTPUT_LIMIT = DEFAULT_MAX_BYTES;
