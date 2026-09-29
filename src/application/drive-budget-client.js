import { CLOCK_SKEW_MS } from "./clock-skew.js";
const sha = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export class DriveBudgetClient {
  constructor(media) { this.media = media; this.cached = null; }
  async exchange(session, route, token, body) {
    try { return await this.media.request(session, route, token, body); }
    catch (error) {
      if (error.status === 404 && route === "/auth/drive-token") throw new Error("服务端未配置云盘预算，请管理员配置后再保存");
      if (error.status) throw new Error(`云盘预算服务拒绝操作（HTTP ${error.status}），请核查额度、策略与账号；未自动重传`);
      throw new Error("云盘预算服务连接或响应异常，许可结果可能未知；未自动重传");
    }
  }
  async request(session, route, body) {
    await this.media.unchanged(session);
    if (!this.cached || this.cached.parent !== session.token || this.cached.origin !== session.serverUrl || this.cached.expiresAt < Date.now() + 30000) {
      const lease = await this.exchange(session, "/auth/drive-token", session.token, {});
      if (lease.audience !== "drive-budget" || !/^[A-Za-z0-9_-]{43}$/.test(lease.token) || !Number.isFinite(lease.expiresAt) || lease.expiresAt <= Date.now() || lease.expiresAt > Math.min(session.expiresAt, Date.now() + 300000 + CLOCK_SKEW_MS)) throw new Error("云盘预算授权无效");
      await this.media.unchanged(session); this.cached = { ...lease, parent: session.token, origin: session.serverUrl };
    }
    const result = await this.exchange(session, route, this.cached.token, body);
    await this.media.unchanged(session); return result;
  }
  async policy(session, folder, bytes) {
    const value = await this.request(session, "/v1/drive/policy", {});
    if (!sha(value.policyDigest) || value.providerId !== folder.providerId || value.driveTenantKey !== folder.identity.tenantKey || value.folderToken !== folder.token) throw new Error("目标文件夹或 CLI 企业不符合服务端云盘策略");
    if (![value.maxBytes, value.chargedBytes, value.remainingBytes].every((n) => Number.isSafeInteger(n) && n >= 0) || value.remainingBytes !== Math.max(0, value.maxBytes - value.chargedBytes)) throw new Error("云盘额度响应无效");
    if (bytes > value.remainingBytes) throw new Error("企业配置的云盘预算不足，未上传");
    return value;
  }
  async reserve(session, id, delivery, policyDigest) {
    const value = await this.request(session, "/v1/drive/reserve", { id, policyDigest, providerId: delivery.folder.providerId, driveTenantKey: delivery.folder.identity.tenantKey, folderToken: delivery.folder.token, bytes: delivery.bytes, sha256: delivery.sha256 });
    if (value.id !== id || value.state !== "reserved") throw new Error("云盘上传已有许可记录，需核查原成果，不能重复上传");
  }
  async dispatch(session, id, policyDigest) {
    const value = await this.request(session, "/v1/drive/dispatch", { id, policyDigest });
    if (value.id !== id || value.state !== "dispatched" || value.granted !== true) throw new Error("未获得一次性云盘上传许可");
  }
  async report(session, id, fileToken) {
    const value = await this.request(session, "/v1/drive/report", { id, fileToken });
    if (value.id !== id || value.state !== "reported") throw new Error("云盘回执尚未记入服务端预算");
  }
}
