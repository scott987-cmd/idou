// What goes with a session besides the session itself -- its Feishu access
// grant, its renewal grant -- kept in the shared store beside it
// (state-store.js), so that a replica that reads the session after a restart
// also has what makes it work (docs/scaling-plan.md §2.4). Sealed like
// everything in the store; keyed by the session's id.
//
// Writes for one session take turns, as the sessions' own do, so a removal
// cannot land before the write it follows. A write that fails is logged and
// not tried again: the most it costs is that one person signs in again after
// the next restart.
export class SharedRecords {
  #tails = new Map();
  constructor({ state, namespace, log = () => {} }) {
    if (typeof state?.put !== "function" || typeof state.get !== "function") throw new Error("Shared records need a state store");
    this.state = state; this.namespace = namespace; this.log = log;
  }
  #turn(key, operation) {
    const turn = (this.#tails.get(key) ?? Promise.resolve(true)).then(operation).then(() => true, (error) => {
      this.log({ component: "shared-records", namespace: this.namespace, event: "write-failed", message: String(error?.message ?? error).slice(0, 200) });
      return false;
    });
    this.#tails.set(key, turn);
    void turn.then(() => { if (this.#tails.get(key) === turn) this.#tails.delete(key); });
    return turn;
  }
  // Until `expiresAt`, when the session it goes with ends anyway.
  put(key, value, expiresAt, now = Date.now()) {
    return this.#turn(key, () => this.state.put(this.namespace, key, value, { ttlMs: Math.max(1, Math.floor(expiresAt - now)) }));
  }
  delete(key) { return this.#turn(key, () => this.state.delete(this.namespace, key)); }
  // After whatever this replica still has on its way for the key.
  async get(key) {
    await this.#tails.get(key);
    return (await this.state.get(this.namespace, key))?.value ?? null;
  }
  // Whether this key's writes so far reached the store.
  async settled(key) { return (await this.#tails.get(key)) ?? true; }
  async flush() { await Promise.all([...this.#tails.values()]); }
}
