import { randomUUID } from "node:crypto";
import { appId, appDigest } from "../apps/manifest.js";
import { reviewCandidate, reviewCursor, reviewInput } from "../apps/review.js";
import { CLOCK_SKEW_MS } from "./clock-skew.js";

export class AppReviews {
  constructor({ candidates, now = Date.now }) { this.candidates = candidates; this.now = now; this.epoch = 0; this.entry = null; this.drafts = new WeakMap(); }
  close() { this.epoch++; this.entry = null; }
  async command(session, route, body, beforeDispatch = () => {}) {
    await this.candidates.unchanged(session);
    const lease = await this.candidates.request(session, "/auth/app-review-token", session.token, {});
    if (lease.audience !== "app-review" || !/^[A-Za-z0-9_-]{43}$/.test(lease.token) || !Number.isFinite(lease.expiresAt) || lease.expiresAt <= this.now() || lease.expiresAt > Math.min(session.expiresAt, this.now() + 300000 + CLOCK_SKEW_MS)) throw new Error("应用审核授权无效");
    beforeDispatch();
    return this.candidates.request(session, `/v1/apps/${route}`, lease.token, body);
  }
  async list(cursor = null) {
    reviewCursor(cursor); this.close(); const epoch = this.epoch;
    const session = await this.candidates.session(), result = await this.command(session, "review-list", { cursor });
    if (epoch !== this.epoch) throw new Error("审核页面已切换，请重新读取");
    if (!Array.isArray(result.candidates) || result.candidates.length > 10 || result.candidates.some(row => !appId(row.appId) || !appDigest(row.digest) || typeof row.title !== "string" || !row.title.trim() || row.title.length > 80 || !Number.isSafeInteger(row.createdAt) || row.createdAt < 1)) throw new Error("审核队列响应无效");
    reviewCursor(result.nextCursor);
    return { candidates: result.candidates.map(row => ({ appId: row.appId, digest: row.digest, title: row.title, createdAt: row.createdAt })), nextCursor: result.nextCursor };
  }
  async read(appIdValue, digest) {
    if (!appId(appIdValue) || !appDigest(digest)) throw new Error("应用版本标识无效");
    this.close(); const epoch = this.epoch, session = await this.candidates.session();
    const candidate = reviewCandidate(await this.command(session, "review-get", { appId: appIdValue, digest }));
    if (epoch !== this.epoch || candidate.appId !== appIdValue || candidate.digest !== digest) throw new Error("审核页面或版本已变化");
    const handle = randomUUID(), expiresAt = Math.min(session.expiresAt, this.now() + 300000);
    this.entry = { handle, candidate, session, expiresAt, epoch };
    return { handle, expiresAt, ...candidate };
  }
  valid(entry) {
    if (!entry || this.entry !== entry || entry.epoch !== this.epoch || entry.expiresAt <= this.now()) throw new Error("审核快照已失效，请重新读取版本");
  }
  async fresh(entry) {
    this.valid(entry);
    const current = reviewCandidate(await this.command(entry.session, "review-get", { appId: entry.candidate.appId, digest: entry.candidate.digest }));
    this.valid(entry);
    if (current.state !== "submitted" || current.review || JSON.stringify(current) !== JSON.stringify(entry.candidate)) throw new Error("版本已撤回、已审核或清单已变化，请重新读取");
  }
  async prepare(handle, decision, note) {
    const entry = this.entry; if (entry?.handle !== handle) throw new Error("请先打开要审核的版本");
    const input = reviewInput({ appId: entry.candidate.appId, digest: entry.candidate.digest, decision, note });
    await this.fresh(entry);
    const draft = { candidate: structuredClone(entry.candidate), input: structuredClone(input) };
    this.drafts.set(draft, { entry, input }); return draft;
  }
  async decide(draft) {
    const saved = this.drafts.get(draft); this.drafts.delete(draft);
    if (!saved) throw new Error("审核确认已使用或无效，未重新提交");
    await this.fresh(saved.entry);
    this.entry = null; // Consume before the external effect; never auto-resubmit a lost receipt.
    const result = reviewCandidate(await this.command(saved.entry.session, "review", saved.input, () => {
      if (saved.entry.epoch !== this.epoch || saved.entry.expiresAt <= this.now()) throw new Error("审核页面已关闭或过期，未提交结论");
    }));
    if (result.appId !== saved.input.appId || result.digest !== saved.input.digest || result.state !== "submitted" || result.review?.decision !== saved.input.decision || result.review?.note !== saved.input.note) throw new Error("审核回执不一致，请重新读取版本核查");
    return result;
  }
}
