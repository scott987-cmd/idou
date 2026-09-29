import { EventEmitter } from "node:events";

export const DISCOVERY_LIMITS = Object.freeze({ chats: 5, pagesPerChat: 3, candidates: 200, documentsPerCycle: 5, intervalMs: 120_000, lookbackMs: 86400_000, lifetimeMs: 8 * 3600_000 });
function sameIdentity(a, b) {
  if (!a?.principal || !a.tenantKey || a.principal !== b?.principal || a.tenantKey !== b.tenantKey) throw new Error("自动整理的飞书身份已变化，请重新选择范围。");
}

// A native, bounded, single-flight discovery worker. It stores neither chat
// bodies nor durable subscriptions. The source document remains authoritative.
export class MessageDiscovery extends EventEmitter {
  constructor({ provider, wiki, reader, businessAccess = () => {}, now = Date.now, timers = { set: setTimeout, clear: clearTimeout } }) {
    super(); Object.assign(this, { provider, wiki, reader, businessAccess, now, timers });
    this.epoch = 0; this.attemptSequence = 0; this.targets = new Map(); this.attempts = new Map(); this.pending = null; this.closed = false;
    this.message = "尚未开启消息文档自动整理。"; this.last = null; this.expiresAt = null; this.nextAt = null;
  }
  status() {
    return { enabled: this.targets.size > 0, busy: Boolean(this.pending), message: this.message, nextAt: this.nextAt, expiresAt: this.expiresAt,
      chats: [...this.targets.values()].map(row => ({ id: row.chat.id, name: row.chat.name })), last: this.last && { ...this.last }, limits: DISCOVERY_LIMITS, synthesis: this.wiki.status().synthesis };
  }
  changed() { this.emit("changed", this.status()); }
  async add(handle, confirm) {
    this.businessAccess(); if (this.closed || this.stopping) throw new Error("自动整理正在关闭，请稍后操作。");
    const epoch = this.epoch, selection = this.reader.captureSelection(handle);
    if (this.targets.has(selection.chat.id)) return this.status();
    if (this.targets.size >= DISCOVERY_LIMITS.chats) throw new Error("本次最多自动整理 5 个会话，请先停止再重新选择。");
    if (!await confirm(structuredClone({ chat: selection.chat, identity: selection.identity, limits: DISCOVERY_LIMITS }))) return null;
    const current = () => { this.businessAccess(); selection.current(); if (this.closed || this.stopping || epoch !== this.epoch) throw new Error("自动整理状态已变化，未加入会话。"); };
    current(); sameIdentity(selection.identity, await this.provider.documentIdentity()); current();
    if (this.targets.size) sameIdentity(selection.identity, this.identity);
    if (this.targets.size >= DISCOVERY_LIMITS.chats) throw new Error("本次自动整理会话已达到上限。");
    if (!await this.wiki.cipher.available()) throw new Error("系统安全加密不可用，不能开启自动整理。"); current();
    if (this.targets.size) sameIdentity(selection.identity, this.identity);
    if (!this.targets.has(selection.chat.id) && this.targets.size >= DISCOVERY_LIMITS.chats) throw new Error("本次自动整理会话已达到上限。");
    this.identity = selection.identity; this.targets.set(selection.chat.id, { chat: selection.chat });
    if (!this.expiresAt) {
      this.expiresAt = this.now() + DISCOVERY_LIMITS.lifetimeMs;
      this.leaseTimer = this.timers.set(() => { void this.stop("自动整理许可已到期，请重新选择会话开启。"); }, DISCOVERY_LIMITS.lifetimeMs); this.leaseTimer?.unref?.();
    }
    this.message = "自动整理已开启，将在后台发现并核验消息中的文档。";
    if (!this.pending) this.schedule(0); this.changed(); return this.status();
  }
  schedule(delay = DISCOVERY_LIMITS.intervalMs) {
    this.timers.clear(this.timer); this.nextAt = this.now() + delay;
    this.timer = this.timers.set(() => { this.timer = null; this.nextAt = null; void this.tick(); }, delay); this.timer?.unref?.();
  }
  async stop(message = "自动整理已停止；已保存的文档副本仍在查询时核验权限。") {
    this.epoch++; this.stopping = true; this.timers.clear(this.timer); this.timer = null; this.nextAt = null;
    this.timers.clear(this.leaseTimer); this.leaseTimer = null;
    this.targets.clear(); this.attempts.clear(); this.expiresAt = null; this.identity = null; this.controller?.abort();
    this.message = message; this.changed();
    try { await this.pending; } finally { this.stopping = false; this.changed(); }
    return this.status();
  }
  async close() { this.closed = true; await this.stop(); }
  tick() {
    if (this.pending) return this.pending;
    if (!this.targets.size || this.closed || this.stopping) return Promise.resolve(this.status());
    this.timers.clear(this.timer); this.timer = null; this.nextAt = null;
    const epoch = this.epoch, identity = this.identity, controller = new AbortController(); this.controller = controller;
    const current = () => {
      this.businessAccess(); controller.signal.throwIfAborted();
      if (this.closed || epoch !== this.epoch || !this.targets.size || this.now() >= this.expiresAt) throw new Error("自动整理许可已到期或变化");
    };
    this.pending = this.cycle(identity, controller.signal, current).catch(() => {
      if (epoch === this.epoch) {
        this.epoch++; this.targets.clear(); this.attempts.clear(); this.expiresAt = null; this.identity = null;
        this.timers.clear(this.leaseTimer); this.leaseTimer = null;
        this.message = "自动整理已暂停：身份、权限、网络或许可状态需要重新核验。请重新选择会话开启。";
      }
    }).finally(() => {
      this.pending = null; if (this.controller === controller) this.controller = null;
      if (epoch === this.epoch && this.targets.size && !this.closed) this.schedule(); this.changed();
    });
    this.changed(); return this.pending;
  }
  async cycle(identity, signal, current) {
    current(); if (!await this.wiki.cipher.available()) throw new Error("Secure local storage unavailable");
    current(); sameIdentity(identity, await this.provider.documentIdentity({ signal })); current();
    const end = new Date(this.now()).toISOString(), start = new Date(this.now() - DISCOVERY_LIMITS.lookbackMs).toISOString();
    const candidates = new Map(), stats = { checkedAt: this.now(), pages: 0, discovered: 0, attempted: 0, retained: 0, skipped: 0, limited: false };
    this.message = "正在后台发现消息中的文档…"; this.changed();
    for (const target of [...this.targets.values()]) {
      let next = null; const cursors = new Set();
      for (let page = 0; page < DISCOVERY_LIMITS.pagesPerChat; page++) {
        current(); const result = await this.provider.chatReader.read(target.chat.id, next, identity, { start, end, signal }); current();
        sameIdentity(identity, result.identity); stats.pages++;
        const visit = row => {
          stats.limited ||= row.threadPartial;
          if (!row.deleted) for (const url of row.documents) {
            // Anchored/partial reads must not silently become whole-document reads.
            if (new URL(url).hash) { stats.skipped++; continue; }
            if (candidates.has(url)) continue;
            if (candidates.size >= DISCOVERY_LIMITS.candidates) { stats.limited = true; continue; }
            candidates.set(url, { messageId: row.id, url });
          }
          for (const child of row.replies) visit(child);
        };
        result.messages.forEach(visit); next = result.next;
        if (!next) break;
        if (cursors.has(next)) { stats.limited = true; break; } cursors.add(next);
        if (page === DISCOVERY_LIMITS.pagesPerChat - 1) stats.limited = true;
      }
    }
    stats.discovered = candidates.size;
    // Round-robin across candidates, including failed ones, so a repeated first
    // link cannot starve later documents. No message body is kept between cycles.
    this.attempts = new Map([...this.attempts].filter(([url]) => candidates.has(url)));
    const selected = [...candidates.values()].sort((a, b) => (this.attempts.get(a.url) || 0) - (this.attempts.get(b.url) || 0)).slice(0, DISCOVERY_LIMITS.documentsPerCycle);
    stats.limited ||= candidates.size > selected.length;
    for (const candidate of selected) {
      current(); stats.attempted++; this.attempts.set(candidate.url, ++this.attemptSequence);
      try {
        await this.provider.chatReader.resolveDocument(candidate.messageId, candidate.url, identity, { signal }); current();
        const document = await this.provider.readDocument(candidate.url, { signal }); current(); sameIdentity(identity, document.identity);
        // A document read can take time; check the discovery message again before
        // enqueueing its source. The source's own ACL still governs future queries.
        await this.provider.chatReader.resolveDocument(candidate.messageId, candidate.url, identity, { signal }); current();
        if (document.partial) { stats.skipped++; continue; }
        if (await this.wiki.observe(document, { signal })) stats.retained++; else stats.skipped++;
        current();
      } catch {
        current(); sameIdentity(identity, await this.provider.documentIdentity({ signal })); current(); stats.skipped++;
      }
    }
    current(); sameIdentity(identity, await this.provider.documentIdentity({ signal })); current();
    this.last = stats;
    this.message = `本轮发现 ${stats.discovered} 个文档链接，保留或更新 ${stats.retained} 篇，跳过 ${stats.skipped} 项${stats.limited ? "；本轮覆盖不完整" : ""}。`;
  }
}
