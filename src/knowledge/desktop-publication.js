import { EventEmitter } from "node:events";
import { WikiCoordinatorClient } from "./coordinator-client.js";
import { WikiPublicationScopeClient } from "./publication-scope-client.js";
import { WikiPublisherKeyClient } from "./publisher-key-client.js";
import { WikiSourceRegistryClient } from "./source-registry-client.js";
import { DriveBudgetClient } from "../application/drive-budget-client.js";
import { WikiBundlePublisher } from "./bundle-publisher.js";
import { WikiReadingPublication } from "./reading-publication.js";

// One instance per desktop account, never a renderer-owned scheduler. Server
// configuration selects the destination; normal reads select the source set.
export class DesktopWikiPublication extends EventEmitter {
  constructor({ wiki, drive, feishu, filename, configureSource, businessAccess, getSession, cloudWork, fetchImpl = fetch, now = Date.now, timers = { set: setTimeout, clear: clearTimeout } }) {
    super();
    if (typeof configureSource !== "function" || typeof businessAccess !== "function") throw new Error("Desktop Wiki publication requires native configuration");
    Object.assign(this, { wiki, configureSource, businessAccess, now, timers });
    const transport = { getSession, fetchImpl, now };
    this.coordinator = new WikiCoordinatorClient(transport);
    this.scopes = new WikiPublicationScopeClient({ ...transport, businessAccess, feishu });
    this.keys = new WikiPublisherKeyClient({ ...transport, businessAccess, feishu });
    this.publisher = new WikiBundlePublisher({ coordinator: this.coordinator, wiki, drive, businessAccess, filename, cipher: wiki.cipher, keyAuthority: this.keys,
      sourceRegistry: new WikiSourceRegistryClient(transport), budget: new DriveBudgetClient({ unchanged: session => this.coordinator.unchanged(session), request: (...args) => this.coordinator.post(...args) }) });
    this.worker = new WikiReadingPublication({ wiki, publisher: this.publisher, authorizeScope: (input, options) => this.scopes.authorize(input, options), businessAccess, cloudWork, now, timers });
    this.worker.on("changed", () => this.changed());
    this.stage = "idle"; this.reason = null; this.target = null; this.epoch = 0; this.pending = null; this.stopping = null; this.closed = false;
  }
  status() {
    const work = this.worker.status(), state = this.closed ? "closed" : this.stage === "running" ? work.state : this.stage;
    return { ...work, state, enabled: !this.closed && this.stage === "running" && work.enabled, busy: Boolean(this.pending || this.stopping || work.busy), reason: this.reason || work.reason,
      folderReference: this.target?.folderReference ?? null, expiresAt: this.target?.expiresAt ?? null };
  }
  changed() { try { this.emit("changed", this.status()); } catch { /* Views do not own publication. */ } }
  scheduleExpiry(target, epoch) {
    this.timers.clear(this.expiryTimer);
    this.expiryTimer = this.timers.set(() => { if (this.epoch === epoch && this.target === target) void this.stop("session-expired"); }, Math.max(0, target.expiresAt - this.now())); this.expiryTimer?.unref?.();
  }
  async refreshSession() {
    if (!this.status().enabled || this.closed || this.stopping) return this.status();
    const epoch = this.epoch, target = this.target, signal = this.controller.signal;
    try {
      this.businessAccess(); signal.throwIfAborted();
      const next = await this.scopes.target({ signal });
      this.businessAccess(); signal.throwIfAborted();
      if (this.epoch !== epoch || this.target !== target || !this.status().enabled) throw new Error("publication changed");
      if (["shardKey", "originalOrigin", "folderReference", "policyDigest"].some(key => next[key] !== target[key]) || next.expiresAt < target.expiresAt) throw new Error("publication policy changed");
      this.worker.refreshSession(next.expiresAt); this.target = next; this.scheduleExpiry(next, epoch); this.changed();
    } catch { if (this.epoch === epoch) await this.stop("renewal-policy-unavailable"); }
    return this.status();
  }
  start() {
    if (this.closed || this.stopping) return Promise.reject(new Error("知识同步正在关闭或停止。"));
    if (this.pending) return this.pending;
    if (this.status().enabled) return Promise.resolve(this.status());
    const epoch = ++this.epoch, controller = new AbortController(); this.controller = controller; this.stage = "starting"; this.reason = null;
    const current = () => { controller.signal.throwIfAborted(); this.businessAccess(); if (this.closed || this.epoch !== epoch) throw new Error("publication invalidated"); };
    this.pending = Promise.resolve().then(async () => {
      try {
        current(); const target = await this.scopes.target({ signal: controller.signal }); current();
        // Set the server-approved canonical source reader before selecting or
        // exporting. Existing cached XML is not used as server-verified evidence.
        await this.configureSource(target.originalOrigin); current();
        this.target = target;
        await this.worker.start({ shardKey: target.shardKey, folderReference: target.folderReference }); current();
        this.stage = "running";
        this.scheduleExpiry(target, epoch);
      } catch {
        await this.worker.stop("startup-not-authorized");
        if (this.epoch === epoch) { this.stage = "paused"; this.reason = "target-or-identity-unavailable"; }
      } finally { this.pending = null; this.changed(); }
      return this.status();
    });
    this.changed(); return this.pending;
  }
  stop(reason = "user-stopped") {
    if (this.stopping) return this.stopping;
    this.epoch++; this.controller?.abort(); this.timers.clear(this.expiryTimer); this.expiryTimer = null; this.stage = "stopping"; this.reason = reason;
    this.stopping = Promise.resolve().then(async () => {
      await this.worker.stop(reason); await this.pending?.catch(() => {});
      this.stage = "stopped"; this.stopping = null; this.changed(); return this.status();
    });
    this.changed(); return this.stopping;
  }
  async close() {
    this.closed = true; await this.stop("closed"); await this.worker.close(); this.keys.close(); this.scopes.close(); this.worker.removeAllListeners(); this.removeAllListeners();
  }
}
