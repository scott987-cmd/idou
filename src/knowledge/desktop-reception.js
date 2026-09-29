import { EventEmitter } from "node:events";
import { WikiCoordinatorClient } from "./coordinator-client.js";
import { WikiRecipientKeyClient } from "./recipient-key-client.js";
import { WikiSourceRegistryClient } from "./source-registry-client.js";
import { WikiDiscoveryClient } from "./discovery-client.js";
import { WikiBundleReceiver } from "./bundle-receiver.js";
import { WikiCloudWork } from "./cloud-work.js";

export class DesktopWikiReception extends EventEmitter {
  constructor({ wiki, drive, feishu, configureSource, businessAccess, getSession, cloudWork = new WikiCloudWork(), fetchImpl = fetch, now = Date.now, timers = { set: setTimeout, clear: clearTimeout } }) {
    super();
    if (typeof configureSource !== "function" || typeof businessAccess !== "function") throw new Error("Native reception configuration required");
    Object.assign(this, { wiki, configureSource, businessAccess, cloudWork, now, timers });
    const transport = { getSession, fetchImpl, now, businessAccess };
    this.discovery = new WikiDiscoveryClient({ ...transport, feishu }); this.keys = new WikiRecipientKeyClient(transport);
    this.receiver = new WikiBundleReceiver({ coordinator: new WikiCoordinatorClient(transport), drive, wiki, businessAccess, keyAuthority: this.keys, sourceRegistry: new WikiSourceRegistryClient(transport) });
    this.run = null; this.closed = false;
  }
  status() {
    const run = this.run;
    return { state: this.closed ? "closed" : run?.state ?? "idle", enabled: !this.closed && run?.state === "running", busy: Boolean(run?.pending),
      counts: { ...(run?.counts ?? { pages: 0, received: 0, skipped: 0, unavailable: 0 }) }, nextAt: run?.nextAt ?? null, expiresAt: run?.expiresAt ?? null,
      folderReference: run?.folderReference ?? null, reason: run?.reason ?? null };
  }
  changed() { try { this.emit("changed", this.status()); } catch { /* UI cannot own the work. */ } }
  current(run) {
    this.businessAccess(); run.controller.signal.throwIfAborted();
    if (this.closed || this.run !== run || !["starting", "running"].includes(run.state) || run.expiresAt <= this.now()) throw new Error("reception invalidated");
  }
  schedule(run, delay) {
    this.timers.clear(run.timer); run.nextAt = this.now() + delay;
    run.timer = this.timers.set(() => { if (this.run === run) void this.tick(); }, delay); run.timer?.unref?.();
  }
  scheduleExpiry(run) {
    const expiresAt = run.expiresAt; this.timers.clear(run.expiryTimer);
    run.expiryTimer = this.timers.set(() => { if (this.run === run && run.expiresAt === expiresAt) void this.stop("session-expired"); }, Math.max(0, expiresAt - this.now())); run.expiryTimer?.unref?.();
  }
  // Called only at the shared native cloud-work checkpoint. Preserve seen and
  // failed versions, cursor and counts; re-login is not permission to replay.
  async refreshSession() {
    const run = this.run;
    if (!run || run.state !== "running" || this.closed) return this.status();
    try {
      this.current(run); const page = await this.discovery.page(run.after, { signal: run.controller.signal }); this.current(run);
      if (["catalogDigest", "policyDigest", "folderReference", "originalOrigin"].some(key => page[key] !== run[key]) || page.expiresAt < run.expiresAt) throw new Error("reception policy changed");
      run.expiresAt = page.expiresAt; this.scheduleExpiry(run); this.changed();
    } catch { if (this.run === run && run.state === "running") await this.stop("renewal-policy-unavailable"); }
    return this.status();
  }
  start() {
    if (this.closed || this.run?.state === "stopping") return Promise.reject(new Error("知识接收正在关闭。"));
    if (this.run?.pending) return this.run.pending;
    if (this.run?.state === "running") return Promise.resolve(this.status());
    this.run?.controller.abort(); this.timers.clear(this.run?.timer); this.timers.clear(this.run?.expiryTimer);
    const run = { state: "starting", controller: new AbortController(), counts: { pages: 0, received: 0, skipped: 0, unavailable: 0 }, after: null, seen: new Map(), failed: new Map(), expiresAt: Infinity };
    this.run = run;
    run.pending = Promise.resolve().then(async () => {
      try {
        this.current(run); const page = await this.discovery.page(null, { signal: run.controller.signal }); this.current(run);
        await this.configureSource(page.originalOrigin); this.current(run);
        run.expiresAt = page.expiresAt; run.folderReference = page.folderReference; run.catalogDigest = page.catalogDigest;
        run.originalOrigin = page.originalOrigin; run.policyDigest = page.policyDigest;
        run.state = "running"; this.schedule(run, 0);
        this.scheduleExpiry(run);
      } catch { if (run.state === "starting") { run.state = "paused"; run.reason = "configuration-or-identity-unavailable"; } }
      finally { run.pending = null; this.changed(); }
      return this.status();
    });
    this.changed(); return run.pending;
  }
  tick() {
    const run = this.run;
    if (!run || this.closed || run.state !== "running") return Promise.resolve(this.status());
    if (run.pending) return run.pending;
    this.timers.clear(run.timer); run.nextAt = null;
    run.pending = Promise.resolve().then(async () => {
      try {
        await this.cloudWork.run(async () => {
          this.current(run); const page = await this.discovery.page(run.after, { signal: run.controller.signal }); this.current(run);
          if (["catalogDigest", "policyDigest", "folderReference", "originalOrigin", "expiresAt"].some(key => page[key] !== run[key])) throw new Error("reception policy changed");
          run.counts.pages++;
          for (const target of page.targets) {
            this.current(run);
            if (run.seen.get(target.shardKey) === target.publicationHash || run.failed.get(target.shardKey) === target.publicationHash) { run.counts.skipped++; continue; }
            try {
              await this.receiver.receive(target.shardKey, page.folderReference, { signal: run.controller.signal, expectedPublicationHash: target.publicationHash,
                assertCurrent: async () => { this.current(run); await this.discovery.assertCandidate(page, target, { signal: run.controller.signal }); this.current(run); } });
              this.current(run); run.seen.set(target.shardKey, target.publicationHash); run.failed.delete(target.shardKey); run.counts.received++;
            } catch {
              this.current(run); run.failed.set(target.shardKey, target.publicationHash); run.counts.unavailable++;
              // One failed version does not block other publishers, and is not
              // silently retried within this run. No body/error text reaches UI.
            }
            if (run.seen.size + run.failed.size > 2000) throw new Error("reception capacity");
          }
          run.after = page.nextAfter;
        }, { signal: run.controller.signal });
      } catch { if (run.state === "running") { run.state = "paused"; run.reason = "policy-session-or-work-unavailable"; run.controller.abort(); } }
      finally { run.pending = null; if (run.state === "running") this.schedule(run, 120000); else this.timers.clear(run.expiryTimer); this.changed(); }
      return this.status();
    });
    this.changed(); return run.pending;
  }
  stop(reason = "user-stopped") {
    const run = this.run; if (!run) return Promise.resolve(this.status()); if (run.stopping) return run.stopping;
    run.state = "stopping"; run.reason = reason; run.controller.abort(); this.timers.clear(run.timer); this.timers.clear(run.expiryTimer); run.nextAt = null;
    run.stopping = Promise.resolve().then(async () => { await run.pending?.catch(() => {}); run.state = "stopped"; this.changed(); return this.status(); });
    this.changed(); return run.stopping;
  }
  async close() { this.closed = true; await this.stop("closed"); this.keys.close(); this.removeAllListeners(); }
}
