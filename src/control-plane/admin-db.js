// The administration data: who has used this deployment, who is signed out or
// disabled, who administers it, the audit trail (docs/admin-console.md).
//
// One set of SQL, two databases. A deployment with a shared PostgreSQL keeps it
// there -- every model replica has to know at once who has been disabled, so it
// cannot sit in one machine's file. A single process with no database keeps it
// in a SQLite file of its own. What differs between the two is said here and
// nowhere else: placeholders, how a change is announced to the other processes,
// how a transaction holds its connection. The stores above write `?` and
// `idou_admin_*` and run on either.
//
// Names follow database-names.js: a database made before the rename calls
// these tables mydoubao_admin_*, and so does every query sent to it.
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { namedDatabase } from "./database-names.js";

// As the source names it; mydoubao_admin on a database from before the rename.
export const ADMIN_CHANNEL = "idou_admin";

// PostgreSQL hands int8 and numeric back as strings, because they can exceed
// what a JavaScript number holds. Nothing here comes near that -- times in
// milliseconds, counts of rows -- so they are read as numbers, as SQLite does.
const NUMBERS = { getTypeParser: (oid, format) => (oid === 20 || oid === 1700) && format !== "binary" ? (value) => Number(value) : pg.types.getTypeParser(oid, format) };

// `?` to `$1`, `$2`… -- outside quoted text, so a literal question mark in a
// string is left alone.
export function numbered(sql) {
  let n = 0, out = "", quoted = false;
  for (const char of sql) {
    if (char === "'") quoted = !quoted;
    out += !quoted && char === "?" ? `$${++n}` : char;
  }
  return out;
}

class PostgresAdmin extends EventEmitter {
  constructor({ pool, connect, prefix, name, log }) {
    super();
    this.dialect = "postgres";
    this.pool = pool; this.connect = connect; this.prefix = prefix; this.name = name; this.log = log;
    this.channel = name(ADMIN_CHANNEL);
    this.origin = randomUUID();
    this.closed = false; this.listener = null;
  }

  #query(client, sql, params) { return client.query({ text: numbered(sql), values: params, types: NUMBERS }); }
  async all(sql, params = []) { return (await this.#query(this.pool, sql, params)).rows; }
  async get(sql, params = []) { return (await this.#query(this.pool, sql, params)).rows[0] ?? null; }
  async run(sql, params = []) { const result = await this.#query(this.pool, sql, params); return { changes: result.rowCount ?? 0, rows: result.rows }; }
  async exec(sql) { await this.pool.query(sql); }

  // Tables made once, whoever starts first. The coordinator and every model
  // replica start together under systemd, and two `CREATE TABLE IF NOT EXISTS`
  // at the same moment still collide in the catalog -- so they take turns on
  // an advisory lock, as every other store here does. One lock for all of the
  // administration tables: some of them are made by more than one store.
  async schema(name, ddl) {
    await this.transaction(async (tx) => {
      await tx.run("SELECT pg_advisory_xact_lock(hashtext('idou:schema:admin'))");
      await tx.exec(ddl);
    });
  }

  // One connection for the whole of `work`: a transaction is a property of a
  // connection, and a pool would hand each statement to whichever is free.
  async transaction(work) {
    const client = await this.pool.connect();
    const tx = {
      all: async (sql, params = []) => (await this.#query(client, sql, params)).rows,
      get: async (sql, params = []) => (await this.#query(client, sql, params)).rows[0] ?? null,
      run: async (sql, params = []) => { const result = await this.#query(client, sql, params); return { changes: result.rowCount ?? 0, rows: result.rows }; },
      exec: async (sql) => { await client.query(sql); },
    };
    try {
      await client.query("BEGIN");
      const value = await work(tx);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  // What changed, never the change itself: a listener reads the rows again.
  async announce(topic, detail = null) {
    await this.pool.query("SELECT pg_notify($1, $2)", [this.channel, JSON.stringify({ t: topic, d: detail, o: this.origin })]);
    this.emit("change", { topic, detail, local: true });
  }

  // A lost listening connection is tried again, less and less often, for as
  // long as the database stays away; once it listens again, "reset" tells every
  // copy held in memory that it may have missed something meanwhile.
  async listen() {
    if (!this.connect) return;
    const client = await this.connect();
    try {
      client.on("notification", (message) => {
        if (message.channel !== this.channel) return;
        try {
          const { t, d, o } = JSON.parse(message.payload);
          if (o !== this.origin && typeof t === "string") this.emit("change", { topic: t, detail: d ?? null, local: false });
        } catch { /* not ours */ }
      });
      const lost = () => {
        if (this.closed || this.listener !== client) return;
        this.listener = null;
        void client.end().catch(() => {});
        this.#relisten(1000);
      };
      client.on("error", lost); client.on("end", lost);
      await client.query(`LISTEN ${ADMIN_CHANNEL}`);
      if (this.closed) throw new Error("closed");
      this.listener = client;
    } catch (error) {
      await client.end().catch(() => {});
      throw error;
    }
  }
  #relisten(delay) {
    const timer = setTimeout(async () => {
      if (this.closed) return;
      try { await this.listen(); } catch { this.#relisten(Math.min(delay * 2, 30_000)); return; }
      this.emit("change", { topic: "reset", detail: null, local: false });
    }, delay);
    timer.unref?.();
  }

  async close() {
    this.closed = true;
    const listener = this.listener; this.listener = null;
    await listener?.end().catch(() => {});
    this.removeAllListeners();
  }
}

class SqliteAdmin extends EventEmitter {
  constructor({ file }) {
    super();
    this.dialect = "sqlite";
    this.prefix = "idou";
    this.name = (text) => text;
    this.db = new DatabaseSync(file ?? ":memory:", { timeout: 2000, allowExtension: false });
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON;");
    this.statements = new Map();
    this.queue = Promise.resolve();
    this.closed = false;
  }

  #prepared(sql) {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      if (this.statements.size > 500) this.statements.clear();
      this.statements.set(sql, statement);
    }
    return statement;
  }
  // node:sqlite takes numbers, strings, bigints, buffers and null.
  #values(params) { return params.map((value) => value === undefined ? null : typeof value === "boolean" ? (value ? 1 : 0) : value); }
  #all(sql, params) { return this.#prepared(sql).all(...this.#values(params)).map((row) => ({ ...row })); }
  #get(sql, params) { const row = this.#prepared(sql).get(...this.#values(params)); return row ? { ...row } : null; }
  #run(sql, params) {
    const statement = this.#prepared(sql);
    if (/\breturning\b/i.test(sql)) { const rows = statement.all(...this.#values(params)).map((row) => ({ ...row })); return { changes: rows.length, rows }; }
    const result = statement.run(...this.#values(params));
    return { changes: Number(result.changes), rows: [] };
  }

  // One connection, so statements take turns with transactions rather than
  // landing inside one somebody else began.
  #turn(work) {
    const turn = this.queue.then(work, work);
    this.queue = turn.then(() => {}, () => {});
    return turn;
  }
  all(sql, params = []) { return this.#turn(() => this.#all(sql, params)); }
  get(sql, params = []) { return this.#turn(() => this.#get(sql, params)); }
  run(sql, params = []) { return this.#turn(() => this.#run(sql, params)); }
  exec(sql) { return this.#turn(() => { this.db.exec(sql); }); }
  // One process, one connection: nobody to race.
  schema(name, ddl) { return this.exec(ddl); }

  transaction(work) {
    return this.#turn(async () => {
      const tx = {
        all: async (sql, params = []) => this.#all(sql, params),
        get: async (sql, params = []) => this.#get(sql, params),
        run: async (sql, params = []) => this.#run(sql, params),
        exec: async (sql) => { this.db.exec(sql); },
      };
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const value = await work(tx);
        this.db.exec("COMMIT");
        return value;
      } catch (error) {
        try { this.db.exec("ROLLBACK"); } catch { /* already ended */ }
        throw error;
      }
    });
  }

  // One process: whoever holds a copy is in this process and hears it here.
  async announce(topic, detail = null) { this.emit("change", { topic, detail, local: true }); }
  async listen() {}

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.queue;
    this.statements.clear();
    this.db.close();
    this.removeAllListeners();
  }
}

// `pool` (a pg.Pool) and `connect` when there is a shared database; otherwise
// `file`, or neither for a development server, which keeps it in memory and
// forgets it on restart -- a smoke never writes an operator's file.
export async function openAdminDatabase({ pool = null, connect = null, file = null, log = () => {} } = {}) {
  if (pool) {
    const named = await namedDatabase({ pool, connect });
    const database = new PostgresAdmin({ pool: named.pool, connect: named.connect, prefix: named.prefix, name: named.name, log });
    await database.listen();
    return database;
  }
  if (file) await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  return new SqliteAdmin({ file });
}
