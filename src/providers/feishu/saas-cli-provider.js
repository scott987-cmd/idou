import { runProcess } from "../process-runner.js";
import { bundledBinaryPath, resolveFeishuRuntime } from "./bundled-runtime.js";
import { createHash } from "node:crypto";
import { parseSaasDocumentReference, projectDocumentXml } from "./document-format.js";
import { sheetReference } from "./sheet-reader.js";
import { DOCUMENT_SEARCH_MAX_QUERY, DOCUMENT_SEARCH_MAX_PAGE_SIZE } from "./cli-read-contract.js";
import { feishuFailure, successfulUserPayload } from "./document-errors.js";
import { SaasDriveFiles } from "./drive-files.js";
import { SaasDocumentEdits } from "./document-edits.js";
import { SaasDocumentAuthoring } from "./document-authoring.js";
import { SaasCliWriter } from "./cli-writer.js";
import { SaasMessageDelivery } from "./message-delivery.js";
import { SaasChatReader } from "./chat-reader.js";
import { SaasSheetReader } from "./sheet-reader.js";
import { SaasSheetEdits } from "./sheet-edits.js";
import { SaasBaseRecords } from "./base-records.js";
import { SaasBaseEdits } from "./base-edits.js";
import { baseReference } from "./base-reader.js";
import { SAAS_PROVIDER_ID } from "./saas-deployment.js";

const SAFE_SKILL_SEGMENT = /^[A-Za-z0-9._-]+$/;

// Search rows are server text: highlight markup is stripped, control and
// bidirectional characters are removed, and the result is never interpreted as
// markup, a command or a resource.
const searchLabel = (value, limit = 300) => typeof value === "string"
  ? value.replace(/<\/?hb?>/g, "").replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/[<>]/g, "").trim().slice(0, limit)
  : "";
const searchTime = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT[\d:.+\-Z]{1,20}$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;

function isSafeSkillPath(skillPath) {
  if (typeof skillPath !== "string") return false;
  const segments = skillPath.split("/");
  return (
    segments.length > 0 &&
    /^lark-[a-z0-9-]+$/.test(segments[0]) &&
    segments.every((segment) => segment !== "." && segment !== ".." && SAFE_SKILL_SEGMENT.test(segment))
  );
}

// How long a user check made under one application session is shared with the
// reads that follow it (see documentIdentity): long enough for one question's
// reads, and never longer than this even when the session stays the same.
const IDENTITY_REUSE_MS = 30_000;

export class SaasFeishuCliProvider {
  constructor(config = {}, runner = runProcess, { accountVerifier = null, now = Date.now, identityReuseMs = IDENTITY_REUSE_MS } = {}) {
    this.id = SAAS_PROVIDER_ID;
    this.binary = config.binary || bundledBinaryPath();
    this.profile = config.profile || null;
    if (config.environment !== undefined && typeof config.environment !== "function") throw new Error("Feishu CLI environment must be a native-process provider");
    this.environment = config.environment || null;
    // Which application session the bridge would send the next request under, as a
    // digest (FeishuCliSidecar.sessionFingerprint). Without one, every identity
    // check goes to Feishu.
    if (config.identityKey !== undefined && typeof config.identityKey !== "function") throw new Error("Feishu CLI identity key must be a native session digest");
    this.identityKey = config.identityKey || null;
    this.now = now; this.identityReuseMs = identityReuseMs; this.recentIdentity = null;
    this.runner = runner;
    if (accountVerifier !== null && typeof accountVerifier.verify !== "function") throw new Error("Invalid Feishu account verifier");
    this.accountVerifier = accountVerifier;
    this.drive = new SaasDriveFiles(this);
    this.documentEdits = new SaasDocumentEdits(this);
    this.documentAuthoring = new SaasDocumentAuthoring(this);
    this.cliWriter = new SaasCliWriter(this);
    this.messages = new SaasMessageDelivery(this);
    this.chatReader = new SaasChatReader(this);
    this.sheets = new SaasSheetReader(this);
    this.sheetEdits = new SaasSheetEdits(this);
    this.baseRecords = new SaasBaseRecords(this);
    this.baseEdits = new SaasBaseEdits(this);
  }

  withProfile(args) {
    return this.profile ? [...args, "--profile", this.profile] : args;
  }

  async invoke(args, options = {}) {
    if (!Array.isArray(args) || args.some((item) => typeof item !== "string")) {
      throw new TypeError("Feishu CLI arguments must be an array of strings");
    }
    if (args.includes("--profile")) {
      throw new Error("Feishu profile is owned by provider configuration");
    }
    if (args.includes("--yes") && options.highRiskConfirmed !== true) {
      throw new Error("high-risk Feishu operations require explicit confirmation");
    }

    // A write intent is native-only: it never comes from the renderer, the model
    // or CLI arguments, and it scopes the credential for this one invocation.
    const { feishuWriteIntent = null, ...processOptions } = options;
    const runtime = await resolveFeishuRuntime({ binary: this.binary });
    processOptions.signal?.throwIfAborted();
    // Guard the actual dispatch too: a confirmation/budget callback may have
    // awaited since the caller's earlier identity check. Only local metadata
    // and the fixed read used by the verifier itself avoid recursion.
    const metadata = args[0] === "--version" || args[0] === "skills" && ["list", "read"].includes(args[1]);
    const identityRead = JSON.stringify(args) === JSON.stringify(["api", "GET", "/open-apis/authen/v1/user_info", "--as", "user", "--format", "json"]);
    if (this.accountVerifier && !metadata && !identityRead) await this.documentIdentity({ signal: processOptions.signal });
    processOptions.signal?.throwIfAborted();
    const sidecar = await this.environment?.(feishuWriteIntent) || {};
    return this.runner(runtime.binary, this.withProfile(args), { ...processOptions, env: { ...(processOptions.env || process.env), ...sidecar } });
  }

  async version() {
    const result = await this.invoke(["--version"]);
    if (result.code !== 0) throw new Error(result.stderr.trim() || "lark-cli --version failed");
    const match = result.stdout.match(/(?:version\s+)?(\d+\.\d+\.\d+)/i);
    return match?.[1] || result.stdout.trim();
  }

  async listSkills() {
    const result = await this.invoke(["skills", "list"]);
    if (result.code !== 0) throw new Error(result.stderr.trim() || "lark-cli skills list failed");
    const payload = JSON.parse(result.stdout);
    if (payload.ok !== true || !Array.isArray(payload.skills)) {
      throw new Error("lark-cli skills list returned an incompatible payload");
    }
    return payload.skills;
  }

  async readSkill(skillPath) {
    if (!isSafeSkillPath(skillPath)) {
      throw new Error(`invalid Feishu skill path: ${skillPath}`);
    }
    const [skill, ...relativePath] = skillPath.split("/");
    const args = ["skills", "read", skill];
    if (relativePath.length > 0) args.push(relativePath.join("/"));
    const result = await this.invoke(args);
    if (result.code !== 0) throw new Error(result.stderr.trim() || `unable to read ${skillPath}`);
    return result.stdout;
  }

  // `fresh` asks for a check made now rather than one shared with the reads just
  // before it. Every write asks for it.
  async documentIdentity({ signal, fresh = false } = {}) {
    if (this.accountVerifier) {
      const user = await this.accountVerifier.verify(async ({ signal: checkSignal }) => {
        const result = await this.invoke(["api", "GET", "/open-apis/authen/v1/user_info", "--as", "user", "--format", "json"], { timeoutMs: 30000, maxOutputBytes: 65536, signal: checkSignal });
        const data = successfulUserPayload(result).data;
        return { openId: data?.open_id, tenantKey: data?.tenant_key, tenantUserId: data?.user_id };
      }, { signal });
      return { principal: createHash("sha256").update(JSON.stringify([this.id, this.profile, user.tenantKey, user.openId])).digest("hex"), tenantKey: user.tenantKey, verifiedAt: Date.now() };
    }
    if (this.environment) {
      // One question re-reads up to ten sources, and each read confirmed the user
      // before and after itself: nineteen user_info round trips for one question,
      // each its own CLI process, counted in the running application. Under the
      // login bridge the user is the application session's, and the control plane
      // binds a session to one Feishu user -- renewal replaces the token, never the
      // user -- so a check made under the same session moments ago still answers.
      // It is shared only while the session is the one it was made under (a new
      // login or a renewal is a different session and is checked again) and for
      // at most identityReuseMs. A write always checks afresh, and the control
      // plane rechecks the session itself before it dispatches one.
      const now = this.now ?? Date.now;
      const key = typeof this.identityKey === "function" ? await this.identityKey() : null;
      const recent = this.recentIdentity;
      if (!fresh && key && recent?.key === key && now() - recent.checkedAt < (this.identityReuseMs ?? 0)) return { ...recent.identity };
      const result = await this.invoke(["api", "GET", "/open-apis/authen/v1/user_info", "--as", "user", "--format", "json"], { timeoutMs: 30_000, maxOutputBytes: 65536, signal });
      const data = successfulUserPayload(result).data;
      if (typeof data?.open_id !== "string" || !data.open_id || typeof data?.tenant_key !== "string" || !data.tenant_key) throw new Error("没能从飞书读到你的账号信息，请稍后再试；一直这样的话请重新登录。");
      const identity = { principal: createHash("sha256").update(JSON.stringify([this.id, this.profile, data.tenant_key, data.open_id])).digest("hex"), tenantKey: data.tenant_key, verifiedAt: now() };
      // Kept for the reads that follow only if the session did not change while
      // the check was in flight: otherwise nobody knows whose user this was.
      if (key) {
        const after = await this.identityKey().catch(() => null);
        this.recentIdentity = after === key ? { key, identity, checkedAt: now() } : null;
      }
      return { ...identity };
    }
    const result = await this.invoke(["auth", "status", "--json", "--verify"], { timeoutMs: 30_000, signal });
    if (result.code !== 0) throw feishuFailure(result);
    let payload;
    try { payload = JSON.parse(result.stdout); } catch { throw new Error("无法确认飞书登录身份"); }
    const user = payload.identities?.user;
    if (payload.verified !== true || !user || user.tokenStatus !== "valid" || typeof user.openId !== "string" || !user.openId || payload.ok === false) throw new Error("尚未验证飞书用户登录；请先完成现有 CLI 的用户授权。");
    const tenantKey = typeof user.tenantKey === "string" ? user.tenantKey : null;
    return { principal: createHash("sha256").update(JSON.stringify([this.id, this.profile, tenantKey, user.openId])).digest("hex"), tenantKey, verifiedAt: Date.now() };
  }

  async documentConnection() {
    try {
      await this.documentIdentity();
      const message = this.accountVerifier ? "飞书连接正常：这台电脑上的飞书命令行登录的就是你本人，每次操作都会重新核对。"
        : this.environment ? "飞书连接正常：刚刚用你的飞书身份实时核验通过。"
        : "飞书 CLI 用户身份已验证（开发连接）";
      return { connected: true, message };
    }
    catch (error) { return { connected: false, message: error.message }; }
  }

  // Keyword search over the caller's own Feishu documents, so a document can be
  // picked by name instead of by pasting a link. Read-only: it goes out on the
  // same read credential as a document fetch and takes no write grant. Rows the
  // application could not open are dropped rather than shown.
  async searchDocuments({ query, kind = "document", pageSize = 15, pageToken = null }, { signal } = {}) {
    if (typeof query !== "string" || !query.trim() || [...query].length > DOCUMENT_SEARCH_MAX_QUERY || /[\x00-\x1f\x7f]/.test(query)) throw new Error(`请输入 1–${DOCUMENT_SEARCH_MAX_QUERY} 个字的关键词`);
    if (!["document", "sheet", "base"].includes(kind)) throw new Error("不支持的飞书内容类型");
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > DOCUMENT_SEARCH_MAX_PAGE_SIZE) throw new Error("搜索分页大小无效");
    if (pageToken !== null && (typeof pageToken !== "string" || !pageToken || pageToken.length > 4096 || /[\x00-\x20\x7f]/.test(pageToken))) throw new Error("搜索翻页标记无效");
    const identity = await this.documentIdentity({ signal });
    const types = kind === "sheet" ? "sheet" : kind === "base" ? "bitable" : "docx,doc,wiki";
    const result = await this.invoke(["drive", "+search", "--query", query.trim(), "--doc-types", types, "--page-size", String(pageSize), "--sort", "edit_time",
      ...(pageToken ? ["--page-token", pageToken] : []), "--as", "user", "--format", "json"], { timeoutMs: 30_000, maxOutputBytes: 1024 * 1024, signal });
    const data = successfulUserPayload(result).data;
    // An empty result set comes back as null, which is "nothing matched".
    const results = data?.results ?? [];
    if (!Array.isArray(results) || results.length > DOCUMENT_SEARCH_MAX_PAGE_SIZE || typeof data.has_more !== "boolean") throw new Error("飞书搜索响应格式不兼容");
    const seen = new Set(), documents = [];
    // Recorded from the live endpoint: a row is
    // {entity_type, result_meta:{url, token, doc_types, owner_name, update_time_iso, is_cross_tenant, ...},
    //  title_highlighted, summary_highlighted}. The highlighted fields carry <h>
    // markup and are only ever used as text.
    for (const row of results) {
      const meta = row?.result_meta;
      if (!meta || typeof meta !== "object" || meta.is_cross_tenant === true) continue;
      let reference;
      // Search links carry a block anchor for the matched passage. Opening that
      // would give a partial read, which cannot then be edited, so a picked
      // result always means the whole document.
      const link = typeof meta.url === "string" ? meta.url.split("#")[0] : meta.url;
      // The link the application would open is the only identity a row gets; a
      // row it could not open is not shown at all.
      try { reference = kind === "sheet" ? sheetReference(link) : kind === "base" ? baseReference(link) : parseSaasDocumentReference(link); } catch { continue; }
      if (seen.has(reference.url)) continue;
      seen.add(reference.url);
      documents.push({ url: reference.url, title: searchLabel(row.title_highlighted) || reference.url,
        kind, type: (searchLabel(meta.doc_types, 40) || searchLabel(row.entity_type, 40)).toLowerCase() || "unknown",
        owner: searchLabel(meta.owner_name, 80), summary: searchLabel(row.summary_highlighted, 200),
        editedAt: searchTime(meta.update_time_iso) });
    }
    const next = data.has_more ? data.page_token : null;
    if (data.has_more && (typeof next !== "string" || !next || next.length > 4096)) throw new Error("飞书搜索分页不完整");
    const current = await this.documentIdentity({ signal });
    if (current.principal !== identity.principal) throw new Error("搜索期间飞书身份已变化，请重新搜索。");
    return { documents, next: data.has_more ? next : null, excluded: results.length - documents.length, identity: current };
  }

  async readDocument(reference, { signal } = {}) {
    const parsed = parseSaasDocumentReference(reference), identity = await this.documentIdentity({ signal });
    const result = await this.invoke(["docs", "+fetch", "--doc", parsed.url, "--as", "user", "--doc-format", "xml", "--detail", "simple", "--format", "json"], { timeoutMs: 30_000, maxOutputBytes: 2 * 1024 * 1024, signal });
    const document = successfulUserPayload(result).data?.document;
    if (!document || typeof document.document_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(document.document_id) ||
        !/^(0|[1-9]\d*)$/.test(String(document.revision_id)) || !Number.isSafeInteger(Number(document.revision_id))) throw new Error("飞书文档缺少有效资源标识或版本号");
    if (parsed.kind === "docx" && document.document_id !== parsed.token) throw new Error("飞书返回的文档与请求目标不一致");
    const projection = projectDocumentXml(document.content);
    const currentIdentity = await this.documentIdentity({ signal });
    if (currentIdentity.principal !== identity.principal) throw new Error("读取期间飞书身份已变化，请重新打开文档。");
    return { kind: "feishu-document", providerId: this.id, resourceId: document.document_id, sourceUrl: parsed.url,
      sourceRevision: String(document.revision_id), ...projection, partial: parsed.partial || projection.partial,
      contentHash: createHash("sha256").update(document.content).digest("hex"), identity: currentIdentity };
  }
}
