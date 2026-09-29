// State the control plane keeps between requests -- sessions, renewal
// credentials, Feishu access tokens, login flows, one-time grants, leases --
// in one place that every replica of the control plane can reach
// (docs/scaling-plan.md). Two implementations with one contract:
//
//   MemoryStateStore    one process, as before: nothing leaves memory.
//   PostgresStateStore  several processes: a table in PostgreSQL, each value
//                       sealed with AES-256-GCM under a key the replicas share
//                       and the database never sees; changes announced with
//                       LISTEN/NOTIFY so replicas drop what they cached.
//
// A record is { value, version, parent, owner, expiresAt }. `key` is whatever
// the caller indexes by -- a token's digest, never the token. `parent` lets a
// family be dropped at once (a session's children); `owner` lets a person's
// records be counted or listed. Expiry is the database's clock for Postgres,
// so replicas with slightly different clocks agree.
//
// What has to be atomic across replicas is done in one statement: take()
// deletes and returns (a one-time grant is used once, whichever replica sees
// it first), update() compares versions, deleteChildren() removes a family.
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { namedDatabase } from "./database-names.js";

const NAMESPACE = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_KEY = 512;
// As the source names it; a database from before the rename calls it
// mydoubao_state (database-names.js).
const CHANNEL = "idou_state";

function checkName(namespace, key) {
  if (typeof namespace !== "string" || !NAMESPACE.test(namespace)) throw new Error(`Invalid state namespace ${String(namespace).slice(0, 80)}`);
  if (typeof key !== "string" || !key || key.length > MAX_KEY) throw new Error("Invalid state key");
}
function checkTtl(ttlMs) {
  if (ttlMs !== null && ttlMs !== undefined && (!Number.isSafeInteger(ttlMs) || ttlMs < 1)) throw new Error("Invalid state lifetime");
}
function checkKeys(keys) {
  if (!Array.isArray(keys) || keys.length > 10_000 || keys.some((key) => typeof key !== "string" || !key || key.length > MAX_KEY)) throw new Error("Invalid state keys");
}
const optional = (value, name) => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !value || value.length > MAX_KEY) throw new Error(`Invalid state ${name}`);
  return value;
};

// ---------------------------------------------------------------- in memory

export class MemoryStateStore extends EventEmitter {
  constructor({ now = Date.now } = {}) {
    super();
    this.now = now;
    this.records = new Map();
    this.origin = randomUUID();
  }
  #slot(namespace, key) { return `${namespace}\u0000${key}`; }
  #live(record) { return record && (record.expiresAt === null || record.expiresAt > this.now()) ? record : null; }
  #copy(record) { return record ? { value: structuredClone(record.value), version: record.version, parent: record.parent, owner: record.owner, expiresAt: record.expiresAt } : null; }
  #announce(namespace, key, op) { this.emit("change", { namespace, key, op, local: true }); }

  async put(namespace, key, value, { ttlMs = null, parent = null, owner = null } = {}) {
    checkName(namespace, key); checkTtl(ttlMs);
    const slot = this.#slot(namespace, key), previous = this.#live(this.records.get(slot));
    const record = { namespace, key, value: structuredClone(value), version: (previous?.version ?? 0) + 1,
      parent: optional(parent, "parent"), owner: optional(owner, "owner"), expiresAt: ttlMs ? this.now() + ttlMs : null };
    this.records.set(slot, record);
    this.#announce(namespace, key, "put");
    return { version: record.version };
  }
  async get(namespace, key) {
    checkName(namespace, key);
    return this.#copy(this.#live(this.records.get(this.#slot(namespace, key))));
  }
  async take(namespace, key) {
    checkName(namespace, key);
    const slot = this.#slot(namespace, key), record = this.#live(this.records.get(slot));
    this.records.delete(slot);
    if (record) this.#announce(namespace, key, "delete");
    return this.#copy(record);
  }
  async delete(namespace, key) { return Boolean(await this.take(namespace, key)); }
  async update(namespace, key, expectedVersion, value, { ttlMs = null } = {}) {
    checkName(namespace, key); checkTtl(ttlMs);
    const slot = this.#slot(namespace, key), record = this.#live(this.records.get(slot));
    if (!record || record.version !== expectedVersion) return null;
    const next = { ...record, value: structuredClone(value), version: record.version + 1, expiresAt: ttlMs ? this.now() + ttlMs : record.expiresAt };
    this.records.set(slot, next);
    this.#announce(namespace, key, "put");
    return { version: next.version };
  }
  async deleteChildren(namespace, parent) {
    checkName(namespace, "x"); optional(parent, "parent");
    const removed = [];
    for (const [slot, record] of this.records) {
      if (record.namespace === namespace && record.parent === parent) { this.records.delete(slot); removed.push(record.key); this.#announce(namespace, record.key, "delete"); }
    }
    return removed;
  }
  async list(namespace, { parent = null, owner = null, limit = 1000, after = null } = {}) {
    checkName(namespace, "x");
    const rows = [];
    const records = [...this.records.values()].filter((record) => record.namespace === namespace && this.#live(record))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    for (const record of records) {
      if (after !== null && record.key <= after) continue;
      if (parent !== null && record.parent !== parent) continue;
      if (owner !== null && record.owner !== owner) continue;
      rows.push({ key: record.key, ...this.#copy(record) });
      if (rows.length >= limit) break;
    }
    return rows;
  }
  async count(namespace) {
    checkName(namespace, "x");
    return [...this.records.values()].filter((record) => record.namespace === namespace && this.#live(record)).length;
  }
  // Written only if nothing (alive) is there: null when something was.
  async create(namespace, key, value, options = {}) {
    checkName(namespace, key);
    if (this.#live(this.records.get(this.#slot(namespace, key)))) return null;
    return this.put(namespace, key, value, options);
  }
  async present(namespace, keys) {
    checkName(namespace, "x"); checkKeys(keys);
    return keys.filter((key) => this.#live(this.records.get(this.#slot(namespace, key))));
  }
  async sweep() {
    let removed = 0;
    for (const [slot, record] of this.records) if (!this.#live(record)) { this.records.delete(slot); removed += 1; }
    return removed;
  }
  // One process holds every lock there is.
  async lock() { return { held: true, release: async () => {} }; }
  async close() { this.records.clear(); this.removeAllListeners(); }
}

// ------------------------------------------------------------- PostgreSQL

// Sealed as version byte, 12-byte nonce, 16-byte tag, ciphertext. The
// additional data binds a value to its namespace and key: a row copied into
// another slot does not open.
function seal(key, namespace, slotKey, value) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`${namespace}\u0000${slotKey}`));
  const body = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value), "utf8")), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), body]);
}
function unseal(key, namespace, slotKey, sealed) {
  if (!Buffer.isBuffer(sealed) || sealed.length < 29 || sealed[0] !== 1) throw new Error("Unreadable state record");
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(1, 13));
  decipher.setAAD(Buffer.from(`${namespace}\u0000${slotKey}`));
  decipher.setAuthTag(sealed.subarray(13, 29));
  return JSON.parse(Buffer.concat([decipher.update(sealed.subarray(29)), decipher.final()]).toString("utf8"));
}

// Bytes rather than a JSON value (a site's files, sealed as they are): the
// same scheme, marked 2 so neither can be mistaken for the other.
function sealBytes(key, namespace, slotKey, bytes) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`${namespace}\u0000${slotKey}`));
  const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([Buffer.from([2]), nonce, cipher.getAuthTag(), body]);
}
function openBytes(key, namespace, slotKey, sealed) {
  if (!Buffer.isBuffer(sealed) || sealed.length < 29 || sealed[0] !== 2) throw new Error("Unreadable sealed bytes");
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(1, 13));
  decipher.setAAD(Buffer.from(`${namespace}\u0000${slotKey}`));
  decipher.setAuthTag(sealed.subarray(13, 29));
  return Buffer.concat([decipher.update(sealed.subarray(29)), decipher.final()]);
}

// Also what the run queue seals its jobs and results with (run-queue.js), and
// the durable stores their bytes (docs/scaling-plan.md §2.5).
export { seal as sealValue, unseal as openValue, sealBytes, openBytes };

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS idou_state (
    namespace text NOT NULL, key text NOT NULL, parent text, owner text,
    value bytea NOT NULL, version bigint NOT NULL,
    expires_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (namespace, key));
  CREATE INDEX IF NOT EXISTS idou_state_parent ON idou_state (namespace, parent) WHERE parent IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idou_state_owner ON idou_state (namespace, owner) WHERE owner IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idou_state_expiry ON idou_state (expires_at) WHERE expires_at IS NOT NULL;`;
const LIVE = "(expires_at IS NULL OR expires_at > now())";
// CREATE ... IF NOT EXISTS is not safe against itself: two replicas started
// together both created the table, and one failed on pg_type_typname_nsp_index
// (measured on the server, 9-26). So the schema is made under a lock the
// transaction holds; whoever comes second finds it made.
const lockId = (prefix, name) => createHash("sha256").update(`${prefix}:${name}`).digest().readBigInt64BE(0).toString();
async function createSchema(pool, prefix) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [lockId(prefix, "schema:state")]);
    await client.query(SCHEMA);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}

export class PostgresStateStore extends EventEmitter {
  // `pool` is a pg.Pool; `connect` makes a dedicated pg.Client for LISTEN and
  // for locks, which have to hold one connection for as long as they last.
  static async open({ pool, connect, key }) {
    if (!pool?.query || typeof connect !== "function") throw new Error("PostgreSQL state needs a pool and a way to connect");
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("PostgreSQL state needs a 32-byte sealing key");
    const named = await namedDatabase({ pool, connect });
    await createSchema(named.pool, named.prefix);
    const store = new PostgresStateStore({ pool: named.pool, connect: named.connect, key, prefix: named.prefix, channel: named.name(CHANNEL) });
    await store.#listen();
    return store;
  }

  constructor({ pool, connect, key, prefix = "idou", channel = CHANNEL }) {
    super();
    this.pool = pool; this.connect = connect; this.key = key; this.prefix = prefix; this.channel = channel;
    this.origin = randomUUID();
    this.closed = false; this.listener = null; this.locks = new Map();
  }

  // Notifications carry only which slot changed and who changed it. A lost
  // listening connection is re-established -- tried again, less and less often,
  // for as long as the database stays away -- and once it listens again, a
  // "reset" tells every cache that it may have missed changes meanwhile.
  async #listen() {
    const client = await this.connect();
    try {
      client.on("notification", (message) => {
        if (message.channel !== this.channel) return;
        try {
          const { n, k, o, origin } = JSON.parse(message.payload);
          if (origin !== this.origin) this.emit("change", { namespace: n, key: k, op: o, local: false });
        } catch { /* not ours */ }
      });
      const lost = () => {
        if (this.closed || this.listener !== client) return;
        this.listener = null;
        void client.end().catch(() => {});
        this.#relisten(1000);
      };
      client.on("error", lost); client.on("end", lost);
      await client.query(`LISTEN ${CHANNEL}`);
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
      try { await this.#listen(); } catch { this.#relisten(Math.min(delay * 2, 30_000)); return; }
      this.emit("change", { op: "reset", local: false });
    }, delay);
    timer.unref?.();
  }
  #notice(namespace, key, op) { return JSON.stringify({ n: namespace, k: key, o: op, origin: this.origin }); }
  #record(namespace, row) {
    return row ? { key: row.key, value: unseal(this.key, namespace, row.key, row.value), version: Number(row.version), parent: row.parent, owner: row.owner,
      expiresAt: row.expires_at ? row.expires_at.getTime() : null } : null;
  }
  #announce(namespace, key, op) { this.emit("change", { namespace, key, op, local: true }); }

  async put(namespace, key, value, { ttlMs = null, parent = null, owner = null } = {}) {
    checkName(namespace, key); checkTtl(ttlMs);
    const { rows } = await this.pool.query(`
      WITH written AS (
        INSERT INTO idou_state (namespace, key, parent, owner, value, version, expires_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, 1, CASE WHEN $6::bigint IS NULL THEN NULL ELSE now() + ($6::bigint * interval '1 millisecond') END, now())
        ON CONFLICT (namespace, key) DO UPDATE SET parent = EXCLUDED.parent, owner = EXCLUDED.owner, value = EXCLUDED.value,
          version = CASE WHEN idou_state.expires_at IS NULL OR idou_state.expires_at > now() THEN idou_state.version + 1 ELSE 1 END,
          expires_at = EXCLUDED.expires_at, updated_at = now()
        RETURNING version)
      SELECT version, pg_notify('${CHANNEL}', $7) FROM written`,
    [namespace, key, optional(parent, "parent"), optional(owner, "owner"), seal(this.key, namespace, key, value), ttlMs ?? null, this.#notice(namespace, key, "put")]);
    this.#announce(namespace, key, "put");
    return { version: Number(rows[0].version) };
  }

  async get(namespace, key) {
    checkName(namespace, key);
    const { rows } = await this.pool.query(`SELECT key, parent, owner, value, version, expires_at FROM idou_state WHERE namespace = $1 AND key = $2 AND ${LIVE}`, [namespace, key]);
    return this.#record(namespace, rows[0]);
  }

  async take(namespace, key) {
    checkName(namespace, key);
    const { rows } = await this.pool.query(`
      WITH gone AS (DELETE FROM idou_state WHERE namespace = $1 AND key = $2 RETURNING key, parent, owner, value, version, expires_at)
      SELECT gone.*, (gone.expires_at IS NULL OR gone.expires_at > now()) AS live, pg_notify('${CHANNEL}', $3) FROM gone`, [namespace, key, this.#notice(namespace, key, "delete")]);
    const row = rows[0];
    if (row) this.#announce(namespace, key, "delete");
    // Removed either way; returned only if it had not expired, by the
    // database's clock.
    return row?.live ? this.#record(namespace, row) : null;
  }

  async delete(namespace, key) { return Boolean(await this.take(namespace, key)); }

  async update(namespace, key, expectedVersion, value, { ttlMs = null } = {}) {
    checkName(namespace, key); checkTtl(ttlMs);
    const { rows } = await this.pool.query(`
      WITH written AS (
        UPDATE idou_state SET value = $3, version = version + 1, updated_at = now(),
          expires_at = CASE WHEN $5::bigint IS NULL THEN expires_at ELSE now() + ($5::bigint * interval '1 millisecond') END
        WHERE namespace = $1 AND key = $2 AND version = $4 AND ${LIVE}
        RETURNING version)
      SELECT version, pg_notify('${CHANNEL}', $6) FROM written`,
    [namespace, key, seal(this.key, namespace, key, value), expectedVersion, ttlMs ?? null, this.#notice(namespace, key, "put")]);
    if (!rows[0]) return null;
    this.#announce(namespace, key, "put");
    return { version: Number(rows[0].version) };
  }

  async deleteChildren(namespace, parent) {
    checkName(namespace, "x");
    // Removed and announced in one statement.
    const { rows } = await this.pool.query(`
      WITH gone AS (DELETE FROM idou_state WHERE namespace = $1 AND parent = $2 RETURNING key)
      SELECT key, pg_notify('${CHANNEL}', json_build_object('n', $1::text, 'k', key, 'o', 'delete', 'origin', $3::text)::text) FROM gone`,
    [namespace, optional(parent, "parent"), this.origin]);
    for (const row of rows) this.#announce(namespace, row.key, "delete");
    return rows.map((row) => row.key);
  }

  // In the order of the key; `after` continues from the last key of the
  // previous page.
  async list(namespace, { parent = null, owner = null, limit = 1000, after = null } = {}) {
    checkName(namespace, "x");
    const { rows } = await this.pool.query(`SELECT key, parent, owner, value, version, expires_at FROM idou_state
      WHERE namespace = $1 AND ($2::text IS NULL OR parent = $2) AND ($3::text IS NULL OR owner = $3) AND ($5::text IS NULL OR key > $5) AND ${LIVE} ORDER BY key LIMIT $4`,
    [namespace, parent, owner, Math.min(Math.max(1, limit), 10_000), after]);
    return rows.map((row) => this.#record(namespace, row));
  }

  async count(namespace) {
    checkName(namespace, "x");
    const { rows } = await this.pool.query(`SELECT count(*)::int AS n FROM idou_state WHERE namespace = $1 AND ${LIVE}`, [namespace]);
    return rows[0].n;
  }

  // Written only if nothing alive is there, in one statement, so two
  // replicas creating the same thing at once end with one of them: null for
  // the one that found it already there.
  async create(namespace, key, value, { ttlMs = null, parent = null, owner = null } = {}) {
    checkName(namespace, key); checkTtl(ttlMs);
    const { rows } = await this.pool.query(`
      WITH written AS (
        INSERT INTO idou_state (namespace, key, parent, owner, value, version, expires_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, 1, CASE WHEN $6::bigint IS NULL THEN NULL ELSE now() + ($6::bigint * interval '1 millisecond') END, now())
        ON CONFLICT (namespace, key) DO UPDATE SET parent = EXCLUDED.parent, owner = EXCLUDED.owner, value = EXCLUDED.value, version = 1,
          expires_at = EXCLUDED.expires_at, updated_at = now()
          WHERE idou_state.expires_at IS NOT NULL AND idou_state.expires_at <= now()
        RETURNING version)
      SELECT version, pg_notify('${CHANNEL}', $7) FROM written`,
    [namespace, key, optional(parent, "parent"), optional(owner, "owner"), seal(this.key, namespace, key, value), ttlMs ?? null, this.#notice(namespace, key, "put")]);
    if (!rows[0]) return null;
    this.#announce(namespace, key, "put");
    return { version: Number(rows[0].version) };
  }

  // Which of these keys the store still holds: what a replica that missed
  // notifications checks its cache against.
  async present(namespace, keys) {
    checkName(namespace, "x"); checkKeys(keys);
    if (!keys.length) return [];
    const { rows } = await this.pool.query(`SELECT key FROM idou_state WHERE namespace = $1 AND key = ANY($2::text[]) AND ${LIVE}`, [namespace, keys]);
    return rows.map((row) => row.key);
  }

  async sweep() {
    const { rowCount } = await this.pool.query("DELETE FROM idou_state WHERE expires_at IS NOT NULL AND expires_at <= now()");
    return rowCount;
  }

  // A named lock held on a connection of its own, for as long as that
  // connection lives: a replica that dies releases it with its connection.
  async lock(name) {
    if (typeof name !== "string" || !name) throw new Error("Invalid lock name");
    if (this.locks.has(name)) return this.locks.get(name);
    const client = await this.connect();
    const { rows } = await client.query("SELECT pg_try_advisory_lock($1) AS held", [lockId(this.prefix, name)]);
    if (!rows[0].held) { await client.end().catch(() => {}); return { held: false, release: async () => {} }; }
    const handle = { held: true, lost: false, release: async () => { this.locks.delete(name); await client.end().catch(() => {}); } };
    client.on("error", () => { handle.lost = true; this.locks.delete(name); this.emit("lock-lost", { name }); });
    this.locks.set(name, handle);
    return handle;
  }

  async close() {
    this.closed = true;
    const listener = this.listener; this.listener = null;
    await listener?.end().catch(() => {});
    for (const handle of [...this.locks.values()]) await handle.release();
    this.removeAllListeners();
  }
}
