import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import { tomlValue } from "./gateway-config.js";
import { resolveCodexRuntime } from "./bundled-codex.js";
import { verifyBundledNode } from "../node-runtime.js";

export class CodexAppServerClient extends EventEmitter {
  constructor({ binary = "codex", cwd = process.cwd(), env = process.env, configOverrides = {}, requestTimeoutMs = 30_000 } = {}) {
    super();
    this.binary = binary;
    this.cwd = cwd;
    this.env = env;
    this.configOverrides = configOverrides;
    this.requestTimeoutMs = requestTimeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.child = null;
  }

  async start() {
    if (this.child) return;
    const overrides = Object.entries(this.configOverrides).flatMap(([key, value]) => ["-c", `${key}=${tomlValue(value)}`]);
    // Asked here, at the one place a session's Codex is started, so no path
    // into this class can launch a binary a packaged app has not verified --
    // Codex, or the Node it runs the application's scripts on.
    const { binary } = await resolveCodexRuntime(this.binary);
    await verifyBundledNode();
    if (this.child) return;
    this.child = spawn(binary, ["app-server", "--stdio", ...overrides], {
      cwd: this.cwd,
      env: this.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.on("data", (chunk) => this.emit("stderr", chunk.toString("utf8")));
    const child = this.child;
    child.stdin.on("error", (error) => this.failPending(error));
    child.on("error", (error) => this.failPending(error));
    child.on("close", (code) => {
      const error = new Error(`codex app-server exited with code ${code}`);
      this.failPending(error);
      if (this.child === child) this.child = null;
      this.emit("stopped", error);
    });

    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.handleLine(line));

    await this.request("initialize", {
      clientInfo: { name: "idou", title: "i豆", version: "0.1.0" },
      // Null unless a caller opts in: experimental methods and fields change what
      // the app-server sends, so only the one operation that needs them asks
      // (taking a turn back forks the thread with `beforeTurnId`).
      capabilities: this.capabilities ?? null,
    });
    this.notify("initialized");
  }

  request(method, params) {
    if (!this.child) throw new Error("codex app-server is not running");
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex request timed out: ${method}`)); }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ method, id, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
    return promise;
  }

  notify(method, params) {
    this.write(params === undefined ? { method } : { method, params });
  }

  respond(id, result) {
    this.write({ id, result });
  }

  respondError(id, code, message) {
    this.write({ id, error: { code, message } });
  }

  write(message) {
    if (!this.child?.stdin.writable) throw new Error("codex app-server stdin is closed");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit("protocolError", new Error("invalid JSON from codex app-server"));
      return;
    }

    if (message.id !== undefined && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || "app-server request failed"));
      else pending.resolve(message.result);
      return;
    }

    if (message.id !== undefined && message.method) {
      this.emit("serverRequest", message);
      return;
    }

    if (message.method) this.emit("notification", message);
  }

  failPending(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
      }, 2_000);
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 4_000);
      child.once("close", () => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        resolve();
      });
    });
    if (this.child === child) this.child = null;
  }
}
