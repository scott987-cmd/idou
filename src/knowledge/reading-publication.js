import { EventEmitter } from "node:events";
import { WikiPublicationScheduler, PUBLICATION_SCHEDULE_LIMITS } from "./publication-scheduler.js";
import { publicationScope } from "./publication-scope.js";
import { wikiDigest, wikiExact, wikiHash } from "./manifest.js";

const sameIdentity = (a, b) => a?.principal === b?.principal && a?.tenantKey === b?.tenantKey;

// Native orchestration of retained local reads -> frozen server scope -> actual
// publisher. One outer timer owns the cadence; the inner scheduler never ticks
// independently. Imported-only evidence does not feed a re-publication loop.
export class WikiReadingPublication extends EventEmitter {
  constructor({ wiki, publisher, authorizeScope, businessAccess, cloudWork, now = Date.now, timers = { set: setTimeout, clear: clearTimeout } }) {
    super();
    if (!wiki || typeof businessAccess !== "function") throw new Error("自动发布需要知识节点和原生身份授权。");
    Object.assign(this, { wiki, businessAccess, cloudWork, now, timers }); this.run = null; this.closed = false;
    this.scheduler = new WikiPublicationScheduler({ publisher, authorizeScope, now, timers: { set: () => null, clear() {} } });
  }
  status() {
    const run = this.run;
    return { state: this.closed ? "closed" : run?.state ?? "idle", enabled: !this.closed && run?.state === "running", busy: Boolean(run?.pending),
      sourceCount: run?.sourceCount ?? 0, nextAt: run?.nextAt ?? null, expiresAt: run?.expiresAt ?? null, reason: run?.reason ?? null,
      counts: { ...(run?.counts ?? { cycles: 0, published: 0, unchanged: 0 }) }, last: run?.last ? { ...run.last } : null };
  }
  changed() { try { this.emit("changed", this.status()); } catch { /* An observer cannot own worker lifecycle. */ } }
  valid(run) {
    this.businessAccess(); run.controller.signal.throwIfAborted();
    if (this.closed || this.run !== run || !["starting", "running"].includes(run.state) || run.expiresAt <= this.now()) throw new Error("reading publication invalidated");
  }
  clear(run) { this.timers.clear(run.timer); this.timers.clear(run.expiryTimer); run.timer = run.expiryTimer = null; run.nextAt = null; }
  schedule(run, delay = PUBLICATION_SCHEDULE_LIMITS.intervalMs) {
    this.clear(run); run.nextAt = this.now() + delay;
    run.timer = this.timers.set(() => { if (this.run === run) void this.tick(); }, delay); run.timer?.unref?.();
    this.scheduleExpiry(run);
  }
  scheduleExpiry(run) {
    const expiresAt = run.expiresAt;
    this.timers.clear(run.expiryTimer);
    run.expiryTimer = this.timers.set(() => { if (this.run === run && run.expiresAt === expiresAt) void this.stop("expired"); }, Math.max(0, expiresAt - this.now())); run.expiryTimer?.unref?.();
  }
  // Native-only checkpoint while holding this account's cloud-work slot. This
  // replaces a future-cycle authorization, never an in-flight upload or pause.
  refreshSession(expiresAt) {
    const run = this.run;
    if (!run || run.state !== "running" || this.closed) return this.status();
    this.valid(run);
    if (this.scheduler.current?.pending || !Number.isSafeInteger(expiresAt) || expiresAt <= this.now() || expiresAt > this.now() + 900000) throw new Error("unsafe publication checkpoint");
    run.expiresAt = Math.min(run.hardExpiresAt, expiresAt); run.scopeDigest = null;
    this.scheduleExpiry(run); this.changed(); return this.status();
  }
  async selection(run) {
    this.valid(run);
    const value = await this.wiki.publicationCandidates({ signal: run.controller.signal, expectedIdentity: run.identity }); this.valid(run);
    if (value?.selectionKind !== "retained-local-reads" || value.permissionsChecked !== false || !value.identity?.principal || !value.identity.tenantKey ||
      run.identity && !sameIdentity(run.identity, value.identity) || !Array.isArray(value.sourceIds) || value.sourceIds.length > 200 ||
      !value.sourceIds.every(wikiDigest) || new Set(value.sourceIds).size !== value.sourceIds.length) throw new Error("invalid reading candidates");
    return structuredClone(value);
  }
  async start(input) {
    if (this.closed || this.run?.pending || ["starting", "running", "stopping"].includes(this.run?.state)) throw new Error("请先停止当前阅读自动发布。");
    wikiExact(input, ["shardKey", "folderReference"]);
    if (!wikiDigest(input.shardKey) || typeof input.folderReference !== "string" || !input.folderReference || input.folderReference.length > 2048) throw new Error("自动发布目标无效。");
    const run = { target: structuredClone(input), state: "starting", identity: null, controller: new AbortController(), scopeDigest: null,
      expiresAt: this.now() + PUBLICATION_SCHEDULE_LIMITS.lifetimeMs, nextAt: null, sourceCount: 0, counts: { cycles: 0, published: 0, unchanged: 0 }, last: null, reason: null, pending: null };
    run.hardExpiresAt = run.expiresAt; this.run = run;
    run.pending = Promise.resolve().then(async () => {
      try {
        const selected = await this.selection(run); run.identity = selected.identity; run.sourceCount = selected.sourceIds.length;
        run.state = "running"; this.schedule(run, 0);
      } catch {
        if (run.state === "starting") { run.state = "paused"; run.reason = "selection-failed"; run.controller.abort(); }
        throw new Error("阅读自动发布未开启，身份、来源或安全存储尚未核验。");
      } finally { run.pending = null; this.changed(); }
      return this.status();
    });
    this.changed(); return run.pending;
  }
  tick() {
    const run = this.run;
    if (!run || this.closed || run.state !== "running") return Promise.resolve(this.status());
    if (run.pending) return run.pending;
    this.timers.clear(run.timer); run.timer = null; run.nextAt = null;
    run.pending = Promise.resolve().then(async () => {
      try {
        const operation = async () => {
        const selected = await this.selection(run); run.sourceCount = selected.sourceIds.length; run.counts.cycles++;
        if (!selected.sourceIds.length) {
          await this.scheduler.stop("no-local-read-sources"); this.valid(run); run.scopeDigest = null;
          run.last = { outcome: "waiting-for-sources" };
        } else {
          const scope = publicationScope({ ...run.target, sourceIds: selected.sourceIds }), digest = wikiHash(scope);
          if (run.scopeDigest !== digest) {
            await this.scheduler.stop("reading-scope-changed"); this.valid(run);
            await this.scheduler.start(scope); this.valid(run); run.scopeDigest = digest;
            run.expiresAt = Math.min(run.expiresAt, this.scheduler.status().expiresAt);
          }
          this.valid(run); const before = this.scheduler.status();
          if (before.state !== "running") throw new Error("inner schedule stopped");
          await this.scheduler.tick(); this.valid(run); const after = this.scheduler.status();
          run.counts.published += after.counts.published - before.counts.published;
          run.counts.unchanged += after.counts.unchanged - before.counts.unchanged; run.last = after.last;
          if (after.state !== "running") { run.reason = after.reason; throw new Error("publication paused"); }
        }
        };
        if (this.cloudWork) await this.cloudWork.run(operation, { signal: run.controller.signal }); else await operation();
      } catch {
        if (run.state === "running") { run.state = "paused"; run.reason ||= "selection-or-publication-failed"; run.controller.abort(); this.clear(run); }
      } finally {
        if (run.state !== "running") await this.scheduler.stop(run.reason);
        run.pending = null; if (this.run === run && run.state === "running") this.schedule(run); this.changed();
      }
      return this.status();
    });
    this.changed(); return run.pending;
  }
  async stop(reason = "user-stopped") {
    const run = this.run; if (!run) return this.status(); if (run.stopping) return run.stopping;
    run.state = "stopping"; run.reason = reason; run.controller.abort(); this.clear(run); this.changed();
    run.stopping = (async () => { await this.scheduler.stop(reason); await run.pending?.catch(() => {}); run.state = "stopped"; this.changed(); return this.status(); })();
    return run.stopping;
  }
  async close() { this.closed = true; await this.stop("closed"); await this.scheduler.close(); }
}
