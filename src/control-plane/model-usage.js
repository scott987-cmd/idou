// How much each person's work costs, counted.
//
// This release only counts. Nothing is refused and nothing is downgraded --
// docs/server-administration.md §6.3 says why: a limit enforced from numbers
// nobody has checked stops the wrong people, and the numbers are new. So the
// quota a deployment writes is parsed, stored and shown, and the release after
// this one is the one that acts on it.
//
// **What it holds is a count.** Tokens in, tokens out, how many requests, how
// many were downgraded -- per person, per model, per day. There is no column
// for a prompt, an answer, or a tool's arguments, and that is the mechanism:
// the console cannot show what this cannot hold.
//
// A day is UTC. A deployment spanning time zones has to agree on one boundary,
// and any other choice is somebody's local midnight imposed on everyone else.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { namedDatabase } from "./database-names.js";

export const USAGE_LIMITS = Object.freeze({
  // Rows are one per person, model and day, so this is years of a large
  // deployment. Past it the oldest days go, because a ledger that fills up and
  // starts refusing writes would make the gateway fail over a count.
  rows: 2_000_000,
  keepDays: 400,
});

export const utcDay = (at) => new Date(at).toISOString().slice(0, 10);

// A person is stored as a hash of tenant and id, like model-choice.js does: the
// ledger says that somebody used this much, not who they are. The console needs
// to name people, so the id is kept beside it -- but the key is the hash, so a
// row is still findable when an id changes shape.
const keyFor = (who) => createHash("sha256").update(`${who.tenantId}\n${who.userId}`).digest("hex");

export class ModelUsage {
  // The coordinator and every model replica open the same file, and systemd
  // starts them together. On a new file SQLite answers "database is locked" to
  // all but one of them at once -- switching to WAL does not wait for the
  // others the way a write does (reproduced with four processes, 9-26) -- so
  // opening is tried again for a few seconds.
  static async open({ file = null, now = Date.now } = {}) {
    if (file) await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    for (let attempt = 0; ; attempt += 1) {
      try { return new ModelUsage({ file, now }); } catch (error) {
        if (!file || attempt >= 8 || !/database is locked/.test(String(error?.message))) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
      }
    }
  }

  // No file is a development server: it counts in memory and forgets on
  // restart, so a smoke never writes the operator's ledger.
  constructor({ file = null, now = Date.now } = {}) {
    this.now = now;
    this.db = new DatabaseSync(file ?? ":memory:", { timeout: 1000, allowExtension: false });
    try {
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;");
      const version = this.db.prepare("PRAGMA user_version").get().user_version;
      if (![0, 1].includes(version)) throw new Error("模型用量账本的版本不认识");
      this.db.exec(`CREATE TABLE IF NOT EXISTS model_usage (
        person TEXT NOT NULL, tenant TEXT NOT NULL, user_id TEXT NOT NULL, model TEXT NOT NULL, day TEXT NOT NULL,
        requests INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0,
        downgraded INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
        PRIMARY KEY(person, model, day)
      ) STRICT; PRAGMA user_version=1;`);
      if (this.db.prepare("PRAGMA quick_check").get().quick_check !== "ok") throw new Error("模型用量账本已损坏");
      this.add = this.db.prepare(`INSERT INTO model_usage
        (person, tenant, user_id, model, day, requests, input_tokens, output_tokens, total_tokens, downgraded, updated_at)
        VALUES (?,?,?,?,?,1,?,?,?,?,?)
        ON CONFLICT(person, model, day) DO UPDATE SET
          requests = requests + 1,
          input_tokens = input_tokens + excluded.input_tokens,
          output_tokens = output_tokens + excluded.output_tokens,
          total_tokens = total_tokens + excluded.total_tokens,
          downgraded = downgraded + excluded.downgraded,
          updated_at = excluded.updated_at`);
    } catch (error) { this.db.close(); throw error; }
  }

  // One answered request. Never called for a refused one: a request that never
  // reached a provider cost nothing and counting it would overstate everybody.
  record({ who, model, usage = null, downgraded = false, at = this.now() }) {
    if (!who?.tenantId || !who?.userId || typeof model !== "string" || !model) return null;
    const whole = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
    const input = whole(usage?.input_tokens ?? usage?.prompt_tokens);
    const output = whole(usage?.output_tokens ?? usage?.completion_tokens);
    // Providers disagree about whether total is given or implied. Trust it when
    // it is there and adds up to at least the parts; otherwise add them, so a
    // provider that reports nothing useful counts as a request and no tokens
    // rather than as a gap nobody notices.
    const reported = whole(usage?.total_tokens);
    const total = reported >= input + output ? reported : input + output;
    const row = { person: keyFor(who), tenant: String(who.tenantId), userId: String(who.userId), model, day: utcDay(at) };
    this.add.run(row.person, row.tenant, row.userId, row.model, row.day, input, output, total, downgraded ? 1 : 0, at);
    this.#sweep();
    return { ...row, input, output, total };
  }

  #sweep() {
    if (Math.random() > 0.01) return;   // now and then, not on every request
    const cutoff = utcDay(this.now() - USAGE_LIMITS.keepDays * 86_400_000);
    this.db.prepare("DELETE FROM model_usage WHERE day < ?").run(cutoff);
  }

  // What the console shows: the last `days` days, heaviest first.
  perPerson({ days = 30, limit = 100, at = this.now() } = {}) {
    const since = utcDay(at - Math.max(1, days) * 86_400_000);
    return this.db.prepare(`SELECT user_id AS userId, tenant,
        SUM(requests) AS requests, SUM(total_tokens) AS tokens, SUM(downgraded) AS downgraded,
        COUNT(DISTINCT model) AS models, MAX(updated_at) AS lastAt
      FROM model_usage WHERE day >= ? GROUP BY person ORDER BY tokens DESC LIMIT ?`).all(since, Math.max(1, limit));
  }

  perModel({ days = 30, at = this.now() } = {}) {
    const since = utcDay(at - Math.max(1, days) * 86_400_000);
    return this.db.prepare(`SELECT model, SUM(requests) AS requests, SUM(total_tokens) AS tokens,
        SUM(downgraded) AS downgraded, COUNT(DISTINCT person) AS people
      FROM model_usage WHERE day >= ? GROUP BY model ORDER BY tokens DESC`).all(since);
  }

  // One person's running total for today, which is what a quota is measured
  // against -- read now, enforced in the release after this one.
  today(who, { at = this.now() } = {}) {
    const row = this.db.prepare("SELECT COALESCE(SUM(total_tokens),0) AS tokens, COALESCE(SUM(requests),0) AS requests FROM model_usage WHERE person=? AND day=?")
      .get(keyFor(who), utcDay(at));
    return { tokens: row.tokens, requests: row.requests };
  }

  // Every row, and rows loaded as they are: for moving the ledger between here
  // and PostgreSQL (bin/migrate-data.js).
  rows() { return this.db.prepare("SELECT * FROM model_usage ORDER BY day, person, model").all().map((row) => ({ ...row })); }
  load(rows) {
    const put = this.db.prepare(`INSERT INTO model_usage (person, tenant, user_id, model, day, requests, input_tokens, output_tokens, total_tokens, downgraded, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(person, model, day) DO UPDATE SET requests = excluded.requests, input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens, total_tokens = excluded.total_tokens, downgraded = excluded.downgraded, updated_at = excluded.updated_at`);
    this.db.exec("BEGIN");
    try {
      for (const row of rows) put.run(row.person, row.tenant, row.user_id, row.model, row.day, row.requests, row.input_tokens, row.output_tokens, row.total_tokens, row.downgraded, row.updated_at);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  flush() { return Promise.resolve(); }

  close() { try { this.db.close(); } catch { /* already closed */ } }
}

// The same ledger in the PostgreSQL the replicas share (docs/scaling-plan.md
// §2.5): what every model replica counts lands in one place, on whichever
// machine it runs. Counts are added up in memory and written once a second,
// as one statement per batch, so a hundred thousand people's requests are not
// a hundred thousand writes; a process that dies loses at most that second,
// which a ledger that only counts can afford. Reads answer as the SQLite
// ledger's do, and are awaited.
const PG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS idou_model_usage (
    person text NOT NULL, tenant text NOT NULL, user_id text NOT NULL, model text NOT NULL, day text NOT NULL,
    requests bigint NOT NULL DEFAULT 0, input_tokens bigint NOT NULL DEFAULT 0, output_tokens bigint NOT NULL DEFAULT 0,
    total_tokens bigint NOT NULL DEFAULT 0, downgraded bigint NOT NULL DEFAULT 0, updated_at bigint NOT NULL,
    PRIMARY KEY (person, model, day));
  CREATE INDEX IF NOT EXISTS idou_model_usage_day ON idou_model_usage (day);`;

export class PostgresModelUsage {
  static async open({ pool, now = Date.now, flushMs = 1000, log = () => {} }) {
    ({ pool } = await namedDatabase({ pool }));
    const client = await pool.connect();
    try {
      // Made under a lock: replicas start together (state-store.js).
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('idou:schema:model-usage'))");
      await client.query(PG_SCHEMA);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; } finally { client.release(); }
    return new PostgresModelUsage({ pool, now, flushMs, log });
  }

  constructor({ pool, now, flushMs, log }) {
    Object.assign(this, { pool, now, log });
    this.pending = new Map();
    this.writing = Promise.resolve();
    this.timer = setInterval(() => { void this.flush(); }, flushMs);
    this.timer.unref?.();
  }

  // Counted as the SQLite ledger counts (same arguments, same answer), added
  // to what this second has so far.
  record({ who, model, usage = null, downgraded = false, at = this.now() }) {
    if (!who?.tenantId || !who?.userId || typeof model !== "string" || !model) return null;
    const whole = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
    const input = whole(usage?.input_tokens ?? usage?.prompt_tokens);
    const output = whole(usage?.output_tokens ?? usage?.completion_tokens);
    const reported = whole(usage?.total_tokens);
    const total = reported >= input + output ? reported : input + output;
    const row = { person: keyFor(who), tenant: String(who.tenantId), userId: String(who.userId), model, day: utcDay(at) };
    const slot = `${row.person}\n${row.model}\n${row.day}`;
    const held = this.pending.get(slot) ?? { ...row, requests: 0, input: 0, output: 0, total: 0, downgraded: 0, at };
    held.requests += 1; held.input += input; held.output += output; held.total += total; held.downgraded += downgraded ? 1 : 0; held.at = Math.max(held.at, at);
    this.pending.set(slot, held);
    return { ...row, input, output, total };
  }

  // What this process has counted and not yet written, in one statement.
  // Writes take turns, so two flushes never add the same counts twice.
  //
  // In the order of the key: two replicas writing the same people at once
  // otherwise lock the rows in opposite orders, PostgreSQL ends one statement
  // as a deadlock -- measured with two replicas and two people -- and what it
  // counted was lost. And a batch that fails goes back to be written with the
  // next one rather than being dropped.
  flush() {
    const batch = [...this.pending.values()].sort((x, y) => {
      const left = `${x.person}\n${x.model}\n${x.day}`, right = `${y.person}\n${y.model}\n${y.day}`;
      return left < right ? -1 : left > right ? 1 : 0;
    });
    this.pending.clear();
    if (!batch.length) return this.writing;
    const values = [], params = [];
    for (const row of batch) {
      const at = params.length;
      values.push(`(${Array.from({ length: 11 }, (_, index) => `$${at + index + 1}`).join(", ")})`);
      params.push(row.person, row.tenant, row.userId, row.model, row.day, row.requests, row.input, row.output, row.total, row.downgraded, row.at);
    }
    this.writing = this.writing.then(() => this.pool.query(`INSERT INTO idou_model_usage
        (person, tenant, user_id, model, day, requests, input_tokens, output_tokens, total_tokens, downgraded, updated_at)
      VALUES ${values.join(", ")}
      ON CONFLICT (person, model, day) DO UPDATE SET
        requests = idou_model_usage.requests + excluded.requests,
        input_tokens = idou_model_usage.input_tokens + excluded.input_tokens,
        output_tokens = idou_model_usage.output_tokens + excluded.output_tokens,
        total_tokens = idou_model_usage.total_tokens + excluded.total_tokens,
        downgraded = idou_model_usage.downgraded + excluded.downgraded,
        updated_at = GREATEST(idou_model_usage.updated_at, excluded.updated_at)`, params))
      .then(() => this.#sweep(), (error) => {
        this.log({ component: "model-usage", event: "write-failed", rows: batch.length, message: String(error?.message ?? error).slice(0, 200) });
        for (const row of batch) {
          const slot = `${row.person}\n${row.model}\n${row.day}`, held = this.pending.get(slot);
          if (!held) { this.pending.set(slot, row); continue; }
          held.requests += row.requests; held.input += row.input; held.output += row.output; held.total += row.total;
          held.downgraded += row.downgraded; held.at = Math.max(held.at, row.at);
        }
      })
      .catch(() => {});
    return this.writing;
  }

  async #sweep() {
    if (Math.random() > 0.01) return;
    await this.pool.query("DELETE FROM idou_model_usage WHERE day < $1", [utcDay(this.now() - USAGE_LIMITS.keepDays * 86_400_000)]);
  }

  async perPerson({ days = 30, limit = 100, at = this.now() } = {}) {
    await this.flush();
    const since = utcDay(at - Math.max(1, days) * 86_400_000);
    const { rows } = await this.pool.query(`SELECT max(user_id) AS "userId", max(tenant) AS tenant,
        SUM(requests)::bigint AS requests, SUM(total_tokens)::bigint AS tokens, SUM(downgraded)::bigint AS downgraded,
        COUNT(DISTINCT model)::int AS models, MAX(updated_at)::bigint AS "lastAt"
      FROM idou_model_usage WHERE day >= $1 GROUP BY person ORDER BY tokens DESC LIMIT $2`, [since, Math.max(1, limit)]);
    return rows.map((row) => ({ ...row, requests: Number(row.requests), tokens: Number(row.tokens), downgraded: Number(row.downgraded), lastAt: Number(row.lastAt) }));
  }

  async perModel({ days = 30, at = this.now() } = {}) {
    await this.flush();
    const since = utcDay(at - Math.max(1, days) * 86_400_000);
    const { rows } = await this.pool.query(`SELECT model, SUM(requests)::bigint AS requests, SUM(total_tokens)::bigint AS tokens,
        SUM(downgraded)::bigint AS downgraded, COUNT(DISTINCT person)::int AS people
      FROM idou_model_usage WHERE day >= $1 GROUP BY model ORDER BY tokens DESC`, [since]);
    return rows.map((row) => ({ ...row, requests: Number(row.requests), tokens: Number(row.tokens), downgraded: Number(row.downgraded) }));
  }

  async today(who, { at = this.now() } = {}) {
    await this.flush();
    const { rows } = await this.pool.query("SELECT COALESCE(SUM(total_tokens),0)::bigint AS tokens, COALESCE(SUM(requests),0)::bigint AS requests FROM idou_model_usage WHERE person=$1 AND day=$2",
      [keyFor(who), utcDay(at)]);
    return { tokens: Number(rows[0].tokens), requests: Number(rows[0].requests) };
  }

  // Every row, for moving the ledger between SQLite and here (bin/migrate-data.js).
  async rows() {
    await this.flush();
    const { rows } = await this.pool.query("SELECT * FROM idou_model_usage ORDER BY day, person, model");
    return rows.map((row) => ({ ...row, requests: Number(row.requests), input_tokens: Number(row.input_tokens), output_tokens: Number(row.output_tokens),
      total_tokens: Number(row.total_tokens), downgraded: Number(row.downgraded), updated_at: Number(row.updated_at) }));
  }
  // Rows as they are, replacing any with the same person, model and day.
  async load(rows) {
    for (let at = 0; at < rows.length; at += 500) {
      const batch = rows.slice(at, at + 500), values = [], params = [];
      for (const row of batch) {
        const base = params.length;
        values.push(`(${Array.from({ length: 11 }, (_, index) => `$${base + index + 1}`).join(", ")})`);
        params.push(row.person, row.tenant, row.user_id, row.model, row.day, row.requests, row.input_tokens, row.output_tokens, row.total_tokens, row.downgraded, row.updated_at);
      }
      await this.pool.query(`INSERT INTO idou_model_usage (person, tenant, user_id, model, day, requests, input_tokens, output_tokens, total_tokens, downgraded, updated_at)
        VALUES ${values.join(", ")} ON CONFLICT (person, model, day) DO UPDATE SET requests = excluded.requests, input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens, total_tokens = excluded.total_tokens, downgraded = excluded.downgraded, updated_at = excluded.updated_at`, params);
    }
  }

  async close() { clearInterval(this.timer); await this.flush(); }
}
