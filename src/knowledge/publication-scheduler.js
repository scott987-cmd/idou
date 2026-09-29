import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { wikiHash, wikiUuid } from "./manifest.js";
import { publicationScope } from "./publication-scope.js";

export const PUBLICATION_SCHEDULE_LIMITS = Object.freeze({ intervalMs: 120000, lifetimeMs: 8 * 3600000, sources: 200 });

// Native only. authorizeScope must independently bind an approved scope to the
// current enterprise identity/device/policy. No permissive default is provided.
export class WikiPublicationScheduler extends EventEmitter {
  constructor({ publisher, authorizeScope, now = Date.now, intervalMs = PUBLICATION_SCHEDULE_LIMITS.intervalMs, timers = { set: setTimeout, clear: clearTimeout } }) {
    super();
    if (!publisher || typeof authorizeScope !== "function" || !Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > PUBLICATION_SCHEDULE_LIMITS.intervalMs) throw new Error("自动发布需要明确的原生范围授权。");
    Object.assign(this, { publisher, authorizeScope, now, intervalMs, timers }); this.current = null; this.closed = false;
  }
  status() {
    const run = this.current;
    return { state: this.closed ? "closed" : run?.state ?? "idle", enabled: !this.closed && run?.state === "running", busy: Boolean(run?.pending),
      nextAt: run?.nextAt ?? null, expiresAt: run?.expiresAt ?? null, reason: run?.reason ?? null,
      counts: { ...(run?.counts ?? { cycles: 0, published: 0, unchanged: 0 }) }, last: run?.last ? { ...run.last } : null };
  }
  changed() { try { this.emit("changed", this.status()); } catch { /* UI observers cannot change worker lifecycle. */ } }
  valid(run) {
    if (this.closed || this.current !== run || !["authorizing", "running"].includes(run.state)) throw new Error("schedule invalidated");
    run.controller.signal.throwIfAborted();
    if (run.expiresAt !== null && run.expiresAt <= this.now()) throw new Error("schedule expired");
  }
  async verify(run) { this.valid(run); await run.grant.assertCurrent(); this.valid(run); }
  clear(run) {
    this.timers.clear(run.timer); this.timers.clear(run.expiryTimer); run.timer = run.expiryTimer = null; run.nextAt = null;
  }
  release(run) {
    if (!run.releasePromise) run.releasePromise = Promise.resolve().then(() => run.grant?.release?.()).catch(() => {});
    return run.releasePromise;
  }
  async start(input) {
    if (this.closed || this.current?.pending || ["running", "authorizing", "stopping"].includes(this.current?.state)) throw new Error("请先停止并等待当前自动发布结束。");
    const scope = publicationScope(structuredClone(input)), run = { scope, state: "authorizing", controller: new AbortController(), expiresAt: null,
      nextAt: null, counts: { cycles: 0, published: 0, unchanged: 0 }, last: null, reason: null, pending: null };
    this.current = run;
    run.pending = Promise.resolve().then(async () => {
      try {
        this.valid(run);
        run.grant = await this.authorizeScope(structuredClone(scope), { signal: run.controller.signal });
        if (!run.grant || run.grant.scopeDigest !== wikiHash(scope) || !Number.isSafeInteger(run.grant.expiresAt) || run.grant.expiresAt <= this.now() ||
          run.grant.expiresAt > this.now() + PUBLICATION_SCHEDULE_LIMITS.lifetimeMs || typeof run.grant.assertCurrent !== "function" || typeof run.grant.release !== "function") throw new Error("invalid scope grant");
        run.expiresAt = run.grant.expiresAt; await this.verify(run); run.state = "running";
        run.expiryTimer = this.timers.set(() => { if (this.current === run) void this.stop("expired"); }, run.expiresAt - this.now()); run.expiryTimer?.unref?.();
        this.schedule(run, 0);
      } catch {
        if (run.state === "authorizing") { run.state = "paused"; run.reason = "authorization-failed"; run.controller.abort(); }
        await this.release(run); throw new Error("自动发布未开启，范围授权无效、已取消或已过期。");
      } finally { run.pending = null; this.changed(); }
      return this.status();
    });
    this.changed(); return run.pending;
  }
  schedule(run, delay = this.intervalMs) {
    if (this.current !== run || run.state !== "running" || this.closed) return;
    this.timers.clear(run.timer); run.nextAt = this.now() + delay;
    run.timer = this.timers.set(() => { run.timer = null; run.nextAt = null; void this.tick(run); }, delay); run.timer?.unref?.();
  }
  tick(run = this.current) {
    if (!run || this.current !== run || run.state !== "running" || this.closed) return Promise.resolve(this.status());
    if (run.pending) return run.pending;
    this.timers.clear(run.timer); run.timer = null; run.nextAt = null;
    const options = { signal: run.controller.signal, assertCurrent: () => this.verify(run) };
    run.pending = Promise.resolve().then(async () => {
      try {
        await this.verify(run);
        const plan = await this.publisher.plan(structuredClone(run.scope), options); await this.verify(run);
        if (!Number.isSafeInteger(plan?.generation) || plan.generation < 0 || !["ready", "unchanged", "review-required", "remote-head"].includes(plan.state) ||
          (plan.operationId !== undefined && !wikiUuid(plan.operationId))) throw new Error("invalid plan");
        run.counts.cycles++;
        if (["review-required", "remote-head"].includes(plan.state)) {
          run.last = { outcome: plan.state, generation: plan.generation, ...(plan.operationId ? { operationId: plan.operationId } : {}) };
          run.state = "paused"; run.reason = plan.state; run.controller.abort(); this.clear(run);
        } else {
          let result = plan;
          if (plan.state === "ready") {
            const id = randomUUID(); run.last = { outcome: "publishing", operationId: id, generation: plan.generation + 1 }; this.changed();
            await this.verify(run);
            result = await this.publisher.publish({ ...structuredClone(run.scope), id, confirmed: true }, options);
            await this.verify(run);
          }
          if (!["published", "unchanged"].includes(result?.state) || !Number.isSafeInteger(result.generation) || result.generation < 1 ||
            (result.id !== undefined && !wikiUuid(result.id)) || (result.operationId !== undefined && !wikiUuid(result.operationId))) throw new Error("invalid publication result");
          run.counts[result.state]++; run.last = { outcome: result.state, generation: result.generation,
            ...(result.state === "unchanged" ? { remoteBytesVerified: false } : {}),
            ...((result.id || result.operationId) ? { operationId: result.id || result.operationId } : {}) };
        }
      } catch {
        if (this.current === run && run.state === "running") { run.state = "paused"; run.reason = "operation-failed"; run.controller.abort(); this.clear(run); }
      } finally {
        if (run.state !== "running") await this.release(run);
        run.pending = null;
        if (this.current === run) { if (run.state === "running") this.schedule(run); this.changed(); }
      }
      return this.status();
    });
    this.changed(); return run.pending;
  }
  async stop(reason = "user-stopped") {
    const run = this.current; if (!run) return this.status();
    if (run.stopPromise) return run.stopPromise;
    run.state = "stopping"; run.reason = reason; run.controller.abort(); this.clear(run); this.changed();
    run.stopPromise = (async () => { await run.pending?.catch(() => {}); await this.release(run); run.state = "stopped"; this.changed(); return this.status(); })();
    return run.stopPromise;
  }
  async close() { this.closed = true; return this.stop("closed"); }
}
