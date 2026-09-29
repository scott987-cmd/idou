import { randomBytes } from "node:crypto";
import { verifyCatalog, skillDigest, MAX_CATALOG_BYTES } from "../skills/catalog-format.js";
import { validateServerUrl } from "../control-plane/client-session.js";
import { CLOCK_SKEW_MS } from "./clock-skew.js";

export class EnterpriseSkillsClient {
  constructor({ getSession, publicKey, runtimeVersions, fetchImpl = fetch, now = Date.now }) {
    Object.assign(this, { getSession, publicKey, runtimeVersions, fetch: fetchImpl, now }); this.revision = 0; this.busy = false;
  }
  async request(origin, route, token, value) {
    const response = await this.fetch(`${origin}${route}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(value) });
    const json = response.headers.get("content-type")?.startsWith("application/json") && response.body;
    // A refusal carries the reason in its body. Throwing on the status alone
    // turned "you are not an administrator" into "service unavailable", which
    // sends the person looking at the server instead of at the name list.
    if (!response.ok) {
      let code = "";
      if (json) { try { code = (await response.json())?.error ?? ""; } catch { code = ""; } } else await response.body?.cancel();
      // The reason and the status are both worth keeping: one says what to do,
      // the other is what an operator greps for in a log.
      throw new Error(code ? `${shelfMessage(code)}（HTTP ${response.status}）` : `企业技能服务不可用（HTTP ${response.status}）；未使用旧目录。`);
    }
    if (!json) { await response.body?.cancel(); throw new Error(`企业技能服务不可用（HTTP ${response.status}）；未使用旧目录。`); }
    const reader = response.body.getReader(), chunks = []; let length = 0;
    try { while (true) { const result = await reader.read(); if (result.done) break; length += result.value.length; if (length > 2 * MAX_CATALOG_BYTES) { await reader.cancel(); throw new Error("企业技能响应超过大小限制"); } chunks.push(Buffer.from(result.value)); } }
    finally { reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("企业技能响应格式无效"); }
  }
  async catalog() {
    if (!this.publicKey) throw new Error("尚未配置企业技能验签公钥，请联系管理员；不会信任服务端临时下发的公钥。");
    if (this.busy) throw new Error("正在核验企业技能，请稍后操作"); this.busy = true;
    try {
      const session = await this.getSession(), origin = validateServerUrl(session.serverUrl);
      const identity = session.identity;
      if (identity?.provider !== "feishu") throw new Error("请先完成飞书登录并确认账号，再查看企业技能。");
      const child = await this.request(origin, "/auth/skills-token", session.token, {});
      if (child.audience !== "skill-center" || typeof child.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(child.token) || !Number.isFinite(child.expiresAt) || child.expiresAt <= this.now() || child.expiresAt > Math.min(session.expiresAt, this.now() + 300000 + CLOCK_SKEW_MS)) throw new Error("企业技能凭证无效");
      const nonce = randomBytes(32).toString("base64url");
      const envelope = await this.request(origin, "/v1/skills/catalog", child.token, { nonce });
      let catalog;
      try { catalog = verifyCatalog(envelope, { publicKey: this.publicKey, serverUrl: origin, tenantId: identity.tenantId, appId: identity.appId, nonce, now: this.now() }); }
      catch { throw new Error("企业技能签名、账号或时效校验失败；未展示该目录。"); }
      const current = await this.getSession();
      if (current.token !== session.token || current.serverUrl !== origin || current.expiresAt <= this.now() || current.identity?.tenantId !== identity.tenantId || current.identity?.userId !== identity.userId || current.identity?.appId !== identity.appId) throw new Error("登录已变化，未使用旧技能目录");
      if (catalog.revision < this.revision) throw new Error("企业技能目录版本回退，已拒绝加载"); this.revision = catalog.revision;
      return catalog;
    } finally { this.busy = false; }
  }
  // Managing the shelf, as opposed to reading it. These use the parent session
  // rather than the read-only skill-center token, so a client that can only read
  // the catalogue structurally cannot change it.
  async manage(route, body = {}) {
    const session = await this.getSession(), origin = validateServerUrl(session.serverUrl);
    if (session.identity?.provider !== "feishu") throw new Error("请先完成飞书登录并确认账号，再管理企业技能。");
    const result = await this.request(origin, route, session.token, body);
    if (result?.error) throw new Error(shelfMessage(result.error));
    return result;
  }
  shelf() { return this.manage("/v1/skills/manage"); }
  // The shelf changed under us, so the next read must not be rejected as a
  // rollback against the revision this client last saw.
  // The bundle travels as exactly the fields a skill is made of. Anything the
  // client carries alongside it for display -- the digest, the source marker --
  // is stripped here, because the catalogue format admits no extra key.
  async publish(skill) {
    const { digest, compatible, source, enabled, modes, importedAt, history, compatibilityMessage, fileCount, ...bundle } = skill;
    const result = await this.manage("/v1/skills/publish", { skill: bundle }); this.revision = 0; return result;
  }
  async unpublish(id) { const result = await this.manage("/v1/skills/unpublish", { id }); this.revision = 0; return result; }

  metadata(skill) {
    const { files, ...metadata } = skill;
    const mismatches = Object.entries(skill.runtimeVersions).filter(([name, versions]) => versions.length && !versions.includes(this.runtimeVersions[name])).map(([name]) => name);
    return { ...metadata, digest: skillDigest(skill), fileCount: files.length, compatible: mismatches.length === 0, compatibilityMessage: mismatches.length ? `未声明兼容当前 ${mismatches.join(" / ")} 版本，仅可预览` : "版本声明与当前应用锁定版本匹配（未做执行兼容性验证）" };
  }
  async list() { const catalog = await this.catalog(); return { revision: catalog.revision, expiresAt: catalog.expiresAt, skills: catalog.skills.map((skill) => this.metadata(skill)) }; }
  async read(reference) {
    if (!reference || typeof reference.id !== "string" || typeof reference.version !== "string" || typeof reference.digest !== "string") throw new Error("请选择企业技能的明确版本");
    const catalog = await this.catalog(), skill = catalog.skills.find((item) => item.id === reference.id && item.version === reference.version);
    if (!skill || skillDigest(skill) !== reference.digest) throw new Error("技能已下架或版本已变化，请刷新目录后重新选择");
    return { ...this.metadata(skill), files: skill.files, revision: catalog.revision };
  }
}

// The server answers with a code; the person needs a sentence. Anything not
// listed is surfaced as-is rather than smoothed over into a wrong explanation.
export function shelfMessage(code) {
  return {
    skill_publish_not_permitted: "当前账号不在企业技能管理员名单里，不能上架或下架。名单由服务端的 IDOU_SKILL_ADMINS 决定。",
    skill_registry_not_configured: "服务端还没有开启企业技能货架。需要管理员配置 IDOU_SKILL_REGISTRY_FILE 与签名密钥。",
    skill_already_published: "这个技能的这个版本已经在货架上了，内容也没有变化。",
    skill_not_published: "货架上没有这个技能，可能已被别人下架。",
    skill_shelf_full: "本企业货架已满，请先下架不再使用的技能。",
    enterprise_skill_id_required: "只有企业技能能上架；本机技能需要先转换身份。",
  }[code] || `企业技能货架拒绝了这次操作：${String(code).slice(0, 120)}`;
}
