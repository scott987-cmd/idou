import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";

// Which chat model a person's work uses, decided by the server.
//
// The server says which models exist (IDOU_MODEL_PROVIDERS, default first)
// and which of them can answer right now (model-health.js). A person may pick
// one of those for themselves; the pick is kept here, per person, so it is the
// same on every device and an administrator's change reaches everyone who has
// not picked. It used to be a file on each desktop, which meant a default
// switched on the server did not reach a desktop that had once saved the old
// one -- measured on 2026-09-19, when the old one had stopped answering.
//
// The model a request actually goes to is always the server's to say:
// `effective` is the person's pick while it is offered and answering, else the
// first in the server's order that is. Scheduled runs are resolved the same
// way, for their owner.
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const key = (who) => createHash("sha256").update(`${who.tenantId}\n${who.userId}`).digest("hex");

// The picks, one small file, written whole and renamed into place. Keys are
// hashes of tenant and person: the file says that someone chose a model, not
// who. Without a file (a development server) the picks live in memory.
export class ModelPreferences {
  static async open({ file = null } = {}) {
    const made = new ModelPreferences(file);
    if (!file) return made;
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      const stored = JSON.parse(await readFile(file, "utf8"));
      for (const [id, row] of Object.entries(stored?.choices ?? {})) {
        if (/^[0-9a-f]{64}$/.test(id) && SLUG.test(row?.model ?? "")) made.choices.set(id, { model: row.model, at: Number(row.at) || 0 });
      }
    } catch (error) { if (error?.code !== "ENOENT") throw new Error(`模型偏好文件无法读取：${error.message}`); }
    return made;
  }

  constructor(file) { this.file = file; this.choices = new Map(); this.writing = Promise.resolve(); }

  get(who) { return this.choices.get(key(who))?.model ?? null; }

  async set(who, model, at = Date.now()) {
    if (model === null) this.choices.delete(key(who)); else this.choices.set(key(who), { model, at });
    if (!this.file) return;
    // One write at a time, each of the whole current state.
    const write = this.writing.then(() => this.#write());
    this.writing = write.catch(() => {});
    await write;
  }

  async #write() {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify({ version: 1, choices: Object.fromEntries(this.choices) }));
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, this.file);
  }

  // Every choice, and choices loaded as they are: for moving them between this
  // file and the shared database (bin/migrate-data.js).
  entries() { return [...this.choices].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, row]) => [id, { ...row }]); }
  async load(entries) {
    for (const [id, row] of entries) if (/^[0-9a-f]{64}$/.test(id) && SLUG.test(row?.model ?? "")) this.choices.set(id, { model: row.model, at: Number(row.at) || 0 });
    if (!this.file) return;
    const write = this.writing.then(() => this.#write());
    this.writing = write.catch(() => {});
    await write;
  }
}

// The same choices in the shared database (docs/scaling-plan.md §2.5): one row
// a person rather than the whole file rewritten for every change -- which,
// for a hundred thousand people, was ten megabytes a click. Read from memory,
// as the file's are; the coordinator that serves them is the only writer, and
// one taking over reads them all when it starts.
const PREFERENCES = "model-preference";
export class PostgresModelPreferences {
  static async open({ state }) {
    const made = new PostgresModelPreferences(state);
    for (let after = null; ;) {
      const page = await state.list(PREFERENCES, { after, limit: 5000 });
      for (const { key: id, value: row } of page) {
        if (/^[0-9a-f]{64}$/.test(id) && SLUG.test(row?.model ?? "")) made.choices.set(id, { model: row.model, at: Number(row.at) || 0 });
      }
      if (page.length < 5000) break;
      after = page.at(-1).key;
    }
    return made;
  }
  constructor(state) { this.state = state; this.choices = new Map(); }
  get(who) { return this.choices.get(key(who))?.model ?? null; }
  async set(who, model, at = Date.now()) {
    const id = key(who);
    if (model === null) { this.choices.delete(id); await this.state.delete(PREFERENCES, id); return; }
    this.choices.set(id, { model, at });
    await this.state.put(PREFERENCES, id, { model, at });
  }
  entries() { return [...this.choices].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, row]) => [id, { ...row }]); }
  async load(entries) {
    for (const [id, row] of entries) {
      if (!/^[0-9a-f]{64}$/.test(id) || !SLUG.test(row?.model ?? "")) continue;
      this.choices.set(id, { model: row.model, at: Number(row.at) || 0 });
      await this.state.put(PREFERENCES, id, { model: row.model, at: Number(row.at) || 0 });
    }
  }
}

class ChoiceError extends Error { constructor(status, message) { super(message); this.status = status; } }

export class ModelChoiceService {
  // `models` is the server's list, default first; `health` says which answer.
  constructor({ sessions, preferences, models, health = null, visibility = null, allowDevelopment = false }) {
    if (!sessions?.verify || !preferences || !Array.isArray(models) || !models.length) throw new Error("Model choice needs sessions, preferences and the server's models");
    Object.assign(this, { sessions, preferences, models: [...models], health, visibility, allowDevelopment });
  }

  // Which models this person is offered. The server's own order, narrowed by
  // the deployment's policy when there is one -- and never empty: a person with
  // no model at all cannot work, so a policy that leaves them none still leaves
  // them the server's default, and the console is where that is noticed.
  async offered(who) {
    const visible = this.visibility ? await this.visibility.visible(who) : null;
    if (!visible) return [...this.models];
    const narrowed = this.models.filter((model) => visible.includes(model));
    return narrowed.length ? narrowed : [this.models[0]];
  }

  // The model this person's work goes to.
  async effective(who) {
    const usable = (model) => !this.health || this.health.usable(model);
    const offered = await this.offered(who);
    const choice = this.preferences.get(who);
    // A choice that is no longer offered falls back on its own -- which is what
    // happens to somebody the moment a model is taken away from them.
    if (choice && offered.includes(choice) && usable(choice)) return choice;
    return offered.find(usable) ?? offered[0];
  }

  async options(who) {
    const offered = await this.offered(who);
    const choice = this.preferences.get(who);
    return { available: offered, default: offered[0], choice: choice && offered.includes(choice) ? choice : null,
      current: await this.effective(who), unavailable: this.health ? this.health.unavailable() : [] };
  }

  async handle(req, res) {
    const route = { "/v1/models/options": "options", "/v1/models/choose": "choose" }[req.url];
    if (!route) return false;
    try {
      if (req.headers.origin) throw new ChoiceError(403, "browser_origin_not_allowed");
      if (req.method !== "POST") throw new ChoiceError(405, "method_not_allowed");
      const who = this.#who(req);
      const body = await readJson(req);
      if (route === "choose") {
        // null goes back to following the server's default.
        const model = body?.model ?? null;
        if (model !== null && !(await this.offered(who)).includes(model)) throw new ChoiceError(400, "该模型当前不可选");
        await this.preferences.set(who, model);
      }
      send(res, 200, await this.options(who));
    } catch (error) {
      req.resume();
      send(res, error instanceof ChoiceError ? error.status : 400, { error: error?.message ?? "model_choice_failed" });
    }
    return true;
  }

  #who(req) {
    const header = req.headers.authorization;
    const who = this.sessions.verify(typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "");
    if (!who) throw new ChoiceError(401, "session_expired_or_invalid");
    if (who.authProvider !== "feishu" && !this.allowDevelopment) throw new ChoiceError(403, "verified_login_required");
    if (who.audience !== "codex-model-gateway") throw new ChoiceError(403, "scope_required");
    return who;
  }
}

async function readJson(req) {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json") throw new ChoiceError(415, "json_required");
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 4096) throw new ChoiceError(413, "request_too_large"); chunks.push(Buffer.from(chunk)); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw new ChoiceError(400, "invalid_json"); }
}

function send(res, status, value) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}
