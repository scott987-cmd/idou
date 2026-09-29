import { randomUUID } from "node:crypto";
import { mkdtemp, open, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { appId, appDigest } from "../apps/manifest.js";
import { reviewCursor } from "../apps/review.js";
import { runtimeBinding, runtimeDetail } from "../apps/runtime-grant.js";
import { runtimeRequest } from "../apps/runtime-http.js";
import { CLOCK_SKEW_MS } from "./clock-skew.js";

export class AppRuntimeExports {
  constructor({ candidates, now = Date.now, request = runtimeRequest }) { Object.assign(this, { candidates, now, request }); this.epoch = 0; this.entry = null; this.drafts = new WeakMap(); }
  close() { this.epoch++; this.entry = null; }
  async command(session, route, body) {
    await this.candidates.unchanged(session);
    const lease = await this.candidates.request(session, "/auth/app-runtime-operator-token", session.token, {});
    if (lease.audience !== "app-runtime-operator" || typeof lease.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(lease.token) || !Number.isSafeInteger(lease.expiresAt) || lease.expiresAt <= this.now() || lease.expiresAt > Math.min(session.expiresAt, this.now() + 300000 + CLOCK_SKEW_MS)) throw new Error("运行操作员授权无效");
    return this.candidates.request(session, `/v1/apps/${route}`, lease.token, body);
  }
  async list(cursor = null) {
    reviewCursor(cursor); this.close(); const epoch = this.epoch, session = await this.candidates.session();
    const result = await this.command(session, "runtime-list", { cursor });
    if (epoch !== this.epoch) throw new Error("运行验收页面已切换");
    if (!Array.isArray(result.candidates) || result.candidates.length > 10 || result.candidates.some(row => !appId(row.appId) || !appDigest(row.digest) || typeof row.title !== "string" || !row.title.trim() || row.title.length > 80 || !Number.isSafeInteger(row.createdAt))) throw new Error("运行版本列表无效");
    reviewCursor(result.nextCursor);
    return { candidates: result.candidates.map(row => ({ appId: row.appId, digest: row.digest, title: row.title, createdAt: row.createdAt })), nextCursor: result.nextCursor };
  }
  async read(id, digest) {
    if (!appId(id) || !appDigest(digest)) throw new Error("运行版本标识无效");
    this.close(); const epoch = this.epoch, session = await this.candidates.session();
    const detail = runtimeDetail(await this.command(session, "runtime-get", { appId: id, digest }));
    if (epoch !== this.epoch || detail.binding.appId !== id || detail.binding.digest !== digest) throw new Error("运行页面或版本已变化");
    this.entry = { handle: randomUUID(), epoch, session, detail, expiresAt: Math.min(session.expiresAt, this.now() + 300000) };
    return { ...structuredClone(detail), handle: this.entry.handle, expiresAt: this.entry.expiresAt };
  }
  valid(entry) { if (!entry || this.entry !== entry || entry.epoch !== this.epoch || entry.expiresAt <= this.now()) throw new Error("运行许可确认已失效，请重新读取"); }
  async fresh(entry) {
    this.valid(entry); await this.candidates.unchanged(entry.session);
    const { appId, digest } = entry.detail.binding;
    const current = runtimeDetail(await this.command(entry.session, "runtime-get", { appId, digest }));
    this.valid(entry);
    if (JSON.stringify(current) !== JSON.stringify(entry.detail)) throw new Error("运行版本或节点策略已变化，请重新读取");
  }
  async prepare(handle) {
    const entry = this.entry; if (entry?.handle !== handle || entry.exporting) throw new Error("请先重新读取运行版本"); await this.fresh(entry);
    const draft = { detail: structuredClone(entry.detail) }; this.drafts.set(draft, entry); return draft;
  }
  async export(draft, parentDirectory) {
    const entry = this.drafts.get(draft); this.drafts.delete(draft);
    if (!entry || entry.exporting) throw new Error("运行许可确认已使用，不会自动重新签发");
    entry.exporting = true;
    await this.fresh(entry);
    if (typeof parentDirectory !== "string" || !path.isAbsolute(parentDirectory)) throw new Error("请选择许可导出目录");
    const parent = await realpath(parentDirectory); this.valid(entry);
    let directory, grant, complete = false;
    const active = async () => { this.valid(entry); await this.candidates.unchanged(entry.session); this.valid(entry); };
    try {
      directory = await mkdtemp(path.join(parent, "idou-runtime-"));
      await active();
      const { appId, digest } = entry.detail.binding;
      grant = await this.request(entry.session.serverUrl, entry.session.token, "/auth/app-runtime-token", { appId, digest, expectedBinding: entry.detail.binding });
      const binding = runtimeBinding(grant.binding);
      if (typeof grant.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(grant.token) || grant.audience !== "app-runtime" || grant.deployed !== false || JSON.stringify(binding) !== JSON.stringify(entry.detail.binding) || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= this.now() || grant.expiresAt > Math.min(entry.session.expiresAt, this.now() + 300000)) throw new Error("运行许可回执与确认内容不一致");
      await active();
      const filename = path.join(directory, "runtime-grant.json"), file = await open(filename, "wx", 0o600);
      try { await file.writeFile(JSON.stringify({ token: grant.token, audience: grant.audience, binding, expiresAt: grant.expiresAt, deployed: false })); await file.sync(); } finally { await file.close(); }
      await active();
      complete = true; this.entry = null;
      // Never return the bearer, parent token or grant contents to the renderer.
      return { filename, expiresAt: grant.expiresAt, binding, deployed: false };
    } finally {
      if (!complete) {
        if (typeof grant?.token === "string" && /^[A-Za-z0-9_-]{43}$/.test(grant.token)) await this.request(entry.session.serverUrl, grant.token, "/v1/apps/runtime-revoke", {}).catch(() => {});
        if (directory) await rm(directory, { recursive: true, force: true });
        if (this.entry === entry) this.entry = null;
      }
    }
  }
}
