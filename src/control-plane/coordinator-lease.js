// Hot standby for the coordinator (docs/scaling-plan.md §2.6). With its durable
// data in the shared database (§2.5), another coordinator can take a stopped
// one's place. What must never happen is two at once: two schedulers, two
// egress proxies, two sites listeners, each sure it is the one. So the
// coordinator holds a lease -- one row -- and a standby takes it only once it
// has been given up or has lapsed.
//
//   - Every time compared is the database's. No two machines' clocks meet.
//   - The holder renews every third of the lease. One that cannot renew stops
//     itself before its lease can lapse, by its own monotonic clock counted
//     from when it last asked. A standby may take over only after the lapse,
//     so it never finds the old holder still acting.
//   - Stopping cleanly gives the lease up, and a standby takes over within its
//     next look rather than when the lease runs out.
//
// A lease rather than an advisory lock: a lock lives as long as its connection
// does in the database's eyes, and a machine that vanishes holds it until TCP
// keepalive gives up -- two hours by default.
import { namedDatabase } from "./database-names.js";

const SCHEMA = `CREATE TABLE IF NOT EXISTS idou_coordinator (
  id int PRIMARY KEY CHECK (id = 1), holder text NOT NULL,
  lease_until timestamptz NOT NULL, since timestamptz NOT NULL)`;

export class CoordinatorLease {
  // `ttlMs` how long a lease lasts unrenewed; renewed every third of it, and
  // given up by its holder `marginMs` before it would lapse.
  static async open({ pool, holder, ttlMs = 30_000, marginMs = Math.min(5000, Math.floor(ttlMs / 4)), clock = () => performance.now(), log = () => {} }) {
    if (typeof holder !== "string" || !holder || holder.length > 200) throw new Error("Invalid coordinator lease holder");
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || marginMs < 1 || marginMs >= ttlMs / 2) throw new Error("Invalid coordinator lease timing");
    ({ pool } = await namedDatabase({ pool }));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('idou:schema:coordinator'))");
      await client.query(SCHEMA);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; } finally { client.release(); }
    return new CoordinatorLease({ pool, holder, ttlMs, marginMs, clock, log });
  }

  // Who holds it, by the database's clock: what a standby is waiting for, and
  // what bin/migrate-data.js will not run beside. Null when nobody ever has.
  static async current(pool) {
    ({ pool } = await namedDatabase({ pool }));
    const { rows } = await pool.query(`SELECT to_regclass('idou_coordinator') IS NOT NULL AS present`);
    if (!rows[0].present) return null;
    const lease = (await pool.query("SELECT holder, lease_until > now() AS live, lease_until FROM idou_coordinator WHERE id = 1")).rows[0];
    return lease ? { holder: lease.holder, live: lease.live, leaseUntil: lease.lease_until } : null;
  }

  #renewing = null;
  #timers = [];

  constructor({ pool, holder, ttlMs, marginMs, clock, log }) {
    Object.assign(this, { pool, holder, ttlMs, marginMs, clock, log });
    this.renewedAt = null;
    this.lost = false;
  }

  // Taken if nobody holds a live lease. The moment of asking is what the
  // holder counts from: the database's lease starts no earlier than that.
  async take() {
    const asked = this.clock();
    const { rows } = await this.pool.query(`INSERT INTO idou_coordinator (id, holder, lease_until, since)
      VALUES (1, $1, now() + $2 * interval '1 millisecond', now())
      ON CONFLICT (id) DO UPDATE SET holder = EXCLUDED.holder, lease_until = EXCLUDED.lease_until, since = EXCLUDED.since
      WHERE idou_coordinator.lease_until <= now()
      RETURNING holder`, [this.holder, this.ttlMs]);
    if (rows[0]?.holder !== this.holder) return false;
    this.renewedAt = asked; this.lost = false;
    return true;
  }

  // Looks every `everyMs` until it is taken. `onWaiting` is told once, with who
  // holds it. A database that cannot be reached is looked at again, not fatal:
  // a standby's whole job is to be there when the rest comes back.
  async wait({ everyMs = 2000, signal = null, onWaiting = () => {} } = {}) {
    for (let told = false; ;) {
      signal?.throwIfAborted();
      try { if (await this.take()) return; }
      catch (error) { this.log({ component: "coordinator-lease", event: "wait-failed", message: String(error?.message ?? error).slice(0, 200) }); }
      if (!told) { told = true; onWaiting(await CoordinatorLease.current(this.pool).catch(() => null)); }
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, everyMs);
        const stop = () => { clearTimeout(timer); reject(signal.reason); };
        signal?.addEventListener("abort", stop, { once: true });
      });
    }
  }

  // Kept until released or lost; `onLost` is told once, with why. Renewed
  // every third of the lease; watched every second, apart from the renewal,
  // so a renewal that hangs cannot carry the holder past its lease.
  hold({ onLost }) {
    if (this.renewedAt === null) throw new Error("A lease must be taken before it is held");
    this.onLost = onLost;
    const renewEvery = Math.floor(this.ttlMs / 3);
    this.#timers.push(setInterval(() => { if (!this.#renewing) this.#renewing = this.#renew().finally(() => { this.#renewing = null; }); }, renewEvery));
    this.#timers.push(setInterval(() => this.#watch(), Math.min(1000, Math.floor(this.marginMs / 2) || 1)));
    for (const timer of this.#timers) timer.unref?.();
  }

  async #renew() {
    const asked = this.clock();
    try {
      const { rowCount } = await this.pool.query(`UPDATE idou_coordinator SET lease_until = now() + $2 * interval '1 millisecond'
        WHERE id = 1 AND holder = $1 AND lease_until > now()`, [this.holder, this.ttlMs]);
      if (this.lost) return;
      // Not ours any more, or lapsed before this reached the database: either
      // way somebody may already be acting as the coordinator.
      if (rowCount !== 1) return this.#lose("另一个协调副本已经接手，或租约已经过期");
      this.renewedAt = asked;
    } catch (error) {
      this.log({ component: "coordinator-lease", event: "renew-failed", message: String(error?.message ?? error).slice(0, 200) });
    }
    this.#watch();
  }

  #watch() {
    if (!this.lost && this.clock() - this.renewedAt >= this.ttlMs - this.marginMs) this.#lose("租约快到期了还没续上：共享数据库连不上，或者这个进程停顿过");
  }

  #lose(reason) {
    if (this.lost) return;
    this.lost = true;
    for (const timer of this.#timers.splice(0)) clearInterval(timer);
    this.onLost?.(reason);
  }

  // Given up, so a standby takes over at its next look. Only ours: a lease
  // somebody else holds by now is theirs.
  async release() {
    for (const timer of this.#timers.splice(0)) clearInterval(timer);
    await this.#renewing?.catch(() => {});
    if (this.lost || this.renewedAt === null) return false;
    this.lost = true;
    const { rowCount } = await this.pool.query("DELETE FROM idou_coordinator WHERE id = 1 AND holder = $1", [this.holder]).catch(() => ({ rowCount: 0 }));
    return rowCount === 1;
  }
}
