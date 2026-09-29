import { createHash, randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { mkdir, readFile, writeFile, rename, unlink, stat } from "node:fs/promises";
import path from "node:path";
import { documentId, chunkId } from "./identity.js";
import { SYNTHESIS_RECIPE, synthesisKey, carrySynthesis as carryModelSynthesis, validateFacts, synthesisInput } from "./synthesis.js";
import { DEFAULT_CHAT_MODEL, isChatModel } from "../providers/codex/chat-models.js";
import { MODEL_MISMATCH, modelProblem } from "../providers/codex/server-model.js";
import { wikiDigest, wikiExact } from "./manifest.js";
import { knowledgeGraph } from "./graph.js";
import { chunkSpans, queryTerms, buildIndex, buildDocumentIndex, rankDocuments, rankChunks, selectExcerpts, questionIdentifiers, questionCellNames, pagesContaining, exportProfiles, importProfiles, profileState, exportFrequencies, importFrequencies } from "./retrieval.js";
import { standingGraph, standingLabel } from "./standing.js";
import { duplicateGroups } from "./duplicates.js";
import { PageStore } from "./page-store.js";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const nonempty = (value) => typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\0");
const sameIdentity = (a, b) => a?.principal === b?.principal && a?.tenantKey === b?.tenantKey;
const carryLocalRead = (old, page) => old?.owner === page.owner && Number.isSafeInteger(old.localReadAt) && old.localReadAt >= 0 && old.localReadAt <= page.observedAt ? { ...page, localReadAt: old.localReadAt } : page;
// A page that failed its last verification keeps saying so across a restart:
// the count is what decides when a source that can no longer be read is given
// up on, so losing it on load would keep an unreadable page for ever.
const carryStale = (old, page) => old?.owner === page.owner && Number.isSafeInteger(old.staleCount) && old.staleCount > 0
  ? { ...page, staleCount: old.staleCount, staleAt: Number.isFinite(old.staleAt) ? old.staleAt : page.observedAt } : page;
// When a copy was last actually used: the person's read, or a verification made
// to answer something. Retention counts from this, not from the first read --
// a policy the person opened once in March and has asked about every week since
// was being deleted on day 31 while it was still answering questions.
const carryUsed = (old, page) => old?.owner === page.owner && Number.isSafeInteger(old.usedAt) && old.usedAt > (page.usedAt ?? 0) ? { ...page, usedAt: old.usedAt } : page;
// Rebuilt from the stored text on load, which no longer carries the reader's
// resource list, so the embeds travel with the page the way localReadAt does.
// Rebuilt pages lose the reader's own `kind`, and what a page is does not change.
const carryKind = (old, page) => old?.owner === page.owner && old.sourceKind && !page.sourceKind ? { ...page, sourceKind: old.sourceKind } : page;
const carryEmbeds = (old, page) => old?.owner === page.owner && Array.isArray(old.embeds) && old.embeds.length && !page.embeds?.length ? { ...page, embeds: old.embeds.slice(0, 10) } : page;
const carrySynthesis = (old, page) => carryKind(old, carryEmbeds(old, carryUsed(old, carryStale(old, carryLocalRead(old, carryModelSynthesis(old, page))))));
export const retainedAt = (page) => Math.max(page.observedAt, Number.isSafeInteger(page.usedAt) ? page.usedAt : 0);
// The model a synthesizer's binding names is the one the person consents to and
// the one a reservation records. A synthesizer that names none predates
// configurable models and was MiniMax; one naming an unknown model is refused.
const bindingModel = (binding) => binding?.model === undefined ? DEFAULT_CHAT_MODEL : isChatModel(binding.model) ? binding.model : null;
// A scope's synthesizer, from what it knows of its server's model (a
// ServerModel) and a way to make a gateway client for one model. Consent is
// only given under a model the server confirmed, and the binding names it. The
// call is made for the model agreed to, which the binding carries, never for
// whatever a later look at /healthz says: a refusal elsewhere, or the server
// going quiet, between the reservation and the call would otherwise fail the
// page for good without a request ever leaving this machine. A server that
// has moved on refuses the agreed model before any upstream call, and that
// reservation is given back (see maybeSynthesize).
export const confirmedSynthesizer = (serverModel, create) => ({
  async binding() {
    const known = await serverModel.current();
    if (!known.model) throw new Error(`${modelProblem(known)}；确认前不能开启自动归纳，正文不会发送给模型。`);
    return create(known.model).binding();
  },
  generate: (page, options) => create(options?.binding?.model).generate(page, options),
});

// Evidence pages, not model-authored summaries. Offsets refer to the provider's
// normalized text, never to Feishu block IDs or a lossless editing representation.
export function evidencePage(document, observedAt) {
  const identity = document.identity;
  if (!nonempty(identity?.tenantKey) || !nonempty(identity?.principal) || !Number.isFinite(identity.verifiedAt)) throw new Error("缺少已验证的租户身份，未建立本机知识副本");
  for (const key of ["providerId", "resourceId", "sourceRevision", "contentHash", "sourceUrl", "title"]) {
    if (!nonempty(document[key])) throw new Error("知识来源信息不完整");
  }
  if (document.partial !== false || new URL(document.sourceUrl).hash) throw new Error("局部阅读不建立全文知识副本");
  if (new URL(document.sourceUrl).protocol !== "https:" || typeof document.text !== "string" || !document.text.trim() || document.text.length > 500_000) throw new Error("知识来源正文为空、过大或链接无效");
  const id = documentId({ tenantId: identity.tenantKey, providerId: document.providerId, resourceType: "document", resourceId: document.resourceId });
  // Sections, not fixed windows: a chunk ends where a heading or a paragraph
  // does, so a hit points at the rule rather than at the first screenful of the
  // document it lives in. Still a lossless tiling — load() rebuilds a stored
  // page by joining these back together, and a citation offset still lands on
  // the same characters.
  const chunks = chunkSpans(document.text).map(({ start, end }, ordinal) => {
    const text = document.text.slice(start, end);
    return { id: chunkId({ documentId: id, revision: `${document.sourceRevision}:${document.contentHash}`, ordinal, text }), start, end, text };
  });
  return { id, owner: digest(JSON.stringify([id, identity.principal])), format: "source-excerpts-v2",
    tenantId: identity.tenantKey, principal: identity.principal, providerId: document.providerId, resourceId: document.resourceId,
    sourceUrl: document.sourceUrl, revision: document.sourceRevision, contentHash: document.contentHash,
    title: document.title, authorizedAt: identity.verifiedAt, observedAt, chunks,
    // A spreadsheet and a Base table answer differently from prose: the passage
    // that matches is one band of rows, and a question about "which rows" or
    // "how many" needs the whole table, not the best few chunks of it.
    ...(["feishu-sheet", "feishu-base"].includes(document.kind) ? { sourceKind: document.kind } : {}),
    // What the document embeds rather than contains. The reader already resolves
    // every embedded spreadsheet, Base table and attachment to a label and a
    // token, and the text keeps only a placeholder for them -- so an answer that
    // needs the numbers inside an embedded sheet has to be told where they live.
    embeds: embedded(document),
    warnings: (document.warnings || []).filter((item) => typeof item === "string").slice(0, 20),
    aclEvidence: { kind: "successful-user-source-read", subject: identity.principal, checkedAt: identity.verifiedAt } };
}

// The spreadsheets and Base tables a document points at, as a link the person
// and the knowledge copy can both open. Feishu serves them from the same host
// as the document, so the link is rebuilt from the document's own origin rather
// than trusted from anything inside the content.
const EMBED_KINDS = Object.freeze({ sheet: ["电子表格", "sheets"], sheets: ["电子表格", "sheets"], bitable: ["多维表格", "base"] });
function embedded(document) {
  const rows = [], seen = new Set();
  let origin = null;
  try { origin = new URL(document.sourceUrl).origin; } catch { return rows; }
  for (const resource of document.resources ?? []) {
    const kind = EMBED_KINDS[resource?.kind];
    if (!kind || typeof resource.token !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(resource.token) || seen.has(resource.token)) continue;
    seen.add(resource.token);
    const query = kind[1] === "sheets" && typeof resource.sheetId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(resource.sheetId) ? `?sheet=${resource.sheetId}`
      : kind[1] === "base" && typeof resource.tableId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(resource.tableId) ? `?table=${resource.tableId}` : "";
    rows.push({ kind: kind[0], title: String(resource.label ?? kind[0]).slice(0, 200), sourceUrl: `${origin}/${kind[1]}/${resource.token}${query}` });
    if (rows.length >= 10) break;
  }
  return rows;
}

// How much a single search is allowed to cost and to send. VERIFY bounds the
// Feishu round-trips one question pays for: only the documents the ranking
// actually wants are re-read, where every candidate used to be. The rest bound
// what can reach a prompt; the caller may ask for less (the person's own search
// box does).
// `coverage` is how much a passage is lifted for holding the question's rarest
// words. Without it a question naming "P6" and "南京" was answered from FAQ
// paragraphs that repeat 出差/住宿/报销 and hold no figure, while the table that
// answers sat eleventh. Measured: full evidence 71% -> 75% on the evaluation
// corpus and 68% -> 75% with a thousand unrelated documents around it; 2 and
// above overshoot, promoting passages that merely share several middling words.
const RETRIEVAL = Object.freeze({ verify: 8, concurrency: 4, rank: 60, perDocument: 10, maxRows: 32, maxChars: 12_000, excerptChars: 1100, coverage: 1 });
// Deliberately no "recently verified" cache. Re-reading the same eight
// documents for the Agent's second and third search costs a few seconds;
// skipping it would mean answering from a permission check made a moment ago
// rather than now, and a link since repointed at another document (pinned in
// test/local-wiki.test.js) would go unnoticed for the length of the window.
// Latency is the cheaper thing to spend.
// Three failed verifications in a row and the copy goes. One failure is a
// network hiccup; it must not cost the person a document, but a document that
// cannot be re-read can never be answered from either.
const STALE_LIMIT = 3;
// How long "this source was used again" may sit in memory before the copy on
// disk is rewritten to say so. Retention counts from use, so it must reach disk
// eventually; it does not have to reach it once per question.
const USE_WRITE_MS = 60_000;
// How many departures the copy remembers, and for how long: as long as a document
// itself would have been kept, so a notice never outlives the reason for it.
const GONE_LIMIT = 20;
const goneRecord = (page, reason, at) => ({ id: page.id, title: String(page.title ?? "").slice(0, 200), sourceUrl: page.sourceUrl,
  reason, at, tenantId: page.tenantId, principal: page.principal });
// The profile file is rewritten at most this often while documents are only
// being added: it is a derived cache, and a store of a thousand documents is
// megabytes of it. Anything that takes a document's terms off the list --
// removal, or a new version of the text -- is written at once instead, because
// then the file still holds terms of something this person no longer stores.
const PROFILE_WRITE_MS = 60_000;

// A document another document says has been repealed still answers "what
// changed", so it is kept and sent — but two passages of it, not ten.
const RETIRED = Object.freeze(["superseded", "self-void"]);
const RETIRED_ROWS = 2;
// How many extra documents a question may read because they contain an
// identifier it names verbatim.
const EXACT_READS = 2;

const hitFrom = (page, row, standing = null, family = null) => ({
  id: page.id, title: page.title, sourceUrl: page.sourceUrl, revision: page.revision,
  excerpt: row.excerpt, section: row.heading ?? "", chunkId: row.chunk?.id ?? page.chunks[0].id, start: row.start, end: row.end,
  warnings: page.warnings, checkedAt: page.authorizedAt, format: page.format,
  ...(page.embeds?.length ? { embeds: page.embeds } : {}),
  ...(page.sourceKind ? { sourceKind: page.sourceKind, rows: page.chunks.reduce((total, chunk) => total + (chunk.text.match(/\n\|/gu)?.length ?? 0), 0) } : {}),
  ...standingLabel(standing),
  ...(family ? { duplicates: { copies: family.copies, others: family.others.slice(0, 5) } } : {}),
  ...(page.synthesis?.state === "complete" ? { synthesis: page.synthesis } : {}) });

// The documents a ranking wants, most promising first, each named once — and
// always the live page, not the one the index was built from. The index is
// cached by content, so its pages can be an earlier copy of the same document
// carrying older metadata; acting on those would, for instance, keep resetting
// the count of failed verifications.
const documentsFor = (ranked, live = null) => {
  const seen = new Map();
  for (const hit of ranked) {
    if (seen.has(hit.page.owner)) continue;
    seen.set(hit.page.owner, live?.get(hit.page.owner) ?? hit.page);
  }
  return [...seen.values()];
};
const byOwner = (pages) => new Map(pages.map((page) => [page.owner, page]));

export class LocalWiki {
  // A thousand documents is roughly 9 MB of text and, with the caches below,
  // about 130 ms of local work per question and ~120 MB of memory (measured).
  // The byte ceiling is what actually binds, so it is set well above what a
  // thousand documents need rather than at the old 10 MiB, which a store of
  // 1,100 documents would have hit silently.
  constructor({ filename, provider, cipher, synthesizer = null, now = Date.now, maxBytes = 64 * 1024 * 1024, maxDocuments = 1000, retentionMs = 30 * 86400_000 }) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || !Number.isSafeInteger(maxDocuments) || maxDocuments < 1 || !Number.isSafeInteger(retentionMs) || retentionMs < 1) throw new Error("Invalid local wiki budget");
    this.filename = filename; this.provider = provider; this.cipher = cipher; this.now = now;
    this.synthesizer = synthesizer; this.synthesisPolicy = null; this.synthesisCalls = 0; this.synthesisController = null; this.synthesisEpoch = 0;
    this.maxBytes = maxBytes; this.maxDocuments = maxDocuments; this.retentionMs = retentionMs;
    // Sidecar, not part of the store: it can be deleted at any time and the only
    // cost is one slow first question. Keeping it inside the store would make
    // every "this was used again" write carry megabytes of derived terms.
    this.store = new PageStore({ filename, cipher, maxBytes });
    this.profileFile = filename ? `${filename}.profiles` : null; this.profiles = null; this.profilesAt = 0;
    this.pages = null; this.written = null; this.gone = []; this.queue = Promise.resolve(); this.pending = 0; this.closed = false; this.message = "阅读完整飞书文档后自动整理原文摘录；不调用模型，不上传云盘。";
  }
  status() { return { pending: this.pending, message: this.message, maxBytes: this.maxBytes, maxDocuments: this.maxDocuments,
    synthesis: { enabled: Boolean(this.synthesisPolicy && this.synthesisPolicy.expiresAt > this.now()), busy: Boolean(this.synthesisController), remaining: 6 - this.synthesisCalls,
      model: this.synthesisPolicy?.model || null, serverUrl: this.synthesisPolicy?.serverUrl || null } }; }
  // `model`, when given, is the one the consent the person answered named. A
  // server that has moved to another since is a new question, not this one.
  enableSynthesis({ model } = {}) {
    if (this.closed || !this.synthesizer) throw new Error("知识归纳服务不可用");
    const epoch = this.synthesisEpoch;
    return this.serial(async () => {
      const identity = await this.provider.documentIdentity(), binding = await this.synthesizer.binding();
      if (!nonempty(identity.principal) || !nonempty(identity.tenantKey) || binding.expiresAt <= this.now() || !bindingModel(binding) || !await this.cipher.available()) throw new Error("开启归纳需要有效的飞书租户、模型连接和系统加密");
      if (model !== undefined && bindingModel(binding) !== model) throw new Error("服务端所用模型已变化，未开启自动归纳；请查看更新后的说明再开启");
      if (this.closed || epoch !== this.synthesisEpoch) throw new Error("归纳设置已切换，请重新开启");
      this.disableSynthesis();
      this.synthesisPolicy = { ...binding, ...identity, model: bindingModel(binding) };
      this.message = "自动归纳已开启：后续阅读会发送受限正文到当前网关；本次启动最多 6 次。";
      return this.status();
    });
  }
  disableSynthesis() {
    this.synthesisEpoch++;
    this.synthesisPolicy = null; this.synthesisController?.abort();
    this.message = "自动归纳已关闭。已发送的请求可能已计费；原文摘录仍自动整理。";
    return this.status();
  }
  serial(operation) {
    this.pending++;
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {}).finally(() => { this.pending--; });
    return result;
  }
  // Serializes credential rotation behind any current observation/model call.
  // Consent and the six-call budget stay local; only a verified same-account
  // successor binding is adopted. Failed/reserved pages remain non-replayable.
  withSynthesisCheckpoint(operation) {
    if (typeof operation !== "function") return Promise.reject(new Error("知识归纳续期操作无效"));
    return this.serial(async () => {
      const policy = this.synthesisPolicy, epoch = this.synthesisEpoch;
      if (policy && policy.expiresAt <= this.now()) this.disableSynthesis();
      let result;
      try { result = await operation(); }
      catch (error) { if (this.synthesisPolicy === policy) this.disableSynthesis(); throw error; }
      if (!policy || this.synthesisPolicy !== policy || epoch !== this.synthesisEpoch) return result;
      try {
        const identity = await this.provider.documentIdentity(), binding = await this.synthesizer.binding();
        if (this.closed || this.synthesisPolicy !== policy || epoch !== this.synthesisEpoch || !nonempty(identity.principal) || !nonempty(identity.tenantKey) ||
            identity.principal !== policy.principal || identity.tenantKey !== policy.tenantKey || binding.serverUrl !== policy.serverUrl || bindingModel(binding) !== policy.model ||
            binding.sessionHash === policy.sessionHash || binding.expiresAt <= Math.max(this.now(), policy.expiresAt)) throw new Error("invalid synthesis renewal");
        this.synthesisPolicy = { ...binding, ...identity, model: policy.model };
        this.message = `自动归纳已续期：后续阅读继续使用当前网关；本次开启仍剩 ${Math.max(0, 6 - this.synthesisCalls)} 次。`;
      } catch {
        if (this.synthesisPolicy === policy) {
          this.disableSynthesis();
          this.message = "登录已续期，但自动归纳身份或模型连接未通过核验；请手动重新开启。";
        }
      }
      return result;
    });
  }
  async load() {
    if (!await this.cipher.available()) throw new Error("系统安全加密不可用，本机知识整理已暂停；不会改为明文保存。");
    if (this.pages) return;
    let legacy = false;
    try {
      const stored = await this.store.read();
      if (!stored) { this.pages = []; this.written = null; return; }
      legacy = stored.legacy;
      this.gone = Array.isArray(stored.gone) ? stored.gone : [];
      if (stored.pages.length > this.maxDocuments) throw new Error("Invalid knowledge format");
      // Rebuild derived fields instead of trusting stored chunk offsets/IDs.
      this.pages = stored.pages.map((page) => carrySynthesis(page, evidencePage({ ...page, sourceRevision: page.revision, partial: false,
        text: page.chunks.map((chunk) => chunk.text).join(""), identity: { principal: page.principal, tenantKey: page.tenantId, verifiedAt: page.authorizedAt } }, page.observedAt)));
      if (this.pages.some((page) => !Number.isFinite(page.observedAt))) throw new Error("Invalid observation time");
      this.written = { state: LocalWiki.state(this.pages), used: this.pages.reduce((newest, page) => Math.max(newest, Number.isSafeInteger(page.usedAt) ? page.usedAt : 0), 0) };
      // A document whose own file cannot be read is one document to open again,
      // not a reason to refuse the whole copy -- but it is never passed over in
      // silence.
      if (stored.unreadable) this.message = `有 ${stored.unreadable} 篇本机副本读不出来，已跳过；重新打开对应飞书文档即可恢复。`;
    } catch (error) {
      this.pages = null;
      if (error.code === "ENOENT") { this.pages = []; this.written = null; return; }
      throw new Error("本机知识文件无法安全读取，已暂停整理；现有文件未被覆盖。");
    }
    // The single-file copy this machine had before: written back one file per
    // document, which retires the old blob at the same path. `written` is
    // cleared first, or the save would decide nothing had changed -- which is
    // true of the pages and false of the layout.
    // Term lists first: they describe these documents whatever file they are
    // stored in, and the migration below must not look like a store with no
    // profiles at all.
    await this.restoreProfiles();
    if (legacy) { this.written = null; await this.save(this.pages); }
  }
  // What a stored page is, for deciding whether the file on disk still says it.
  // `usedAt` is deliberately left out: it moves on every single search, and
  // re-encrypting the whole store to record "this was used again" would make a
  // large knowledge copy pay for every question.
  static state(pages) {
    return pages.map((page) => LocalWiki.pageState(page)).join("\n");
  }
  static pageState(page) {
    return `${page.owner}:${page.contentHash}:${page.revision}:${page.staleCount ?? 0}:${page.localReadAt ?? 0}:${page.synthesis?.state ?? ""}`;
  }
  async save(pages, signal, beforeCommit, removed = []) {
    signal?.throwIfAborted();
    // Only this app's derived cache is evicted, never source documents or tasks.
    const cutoff = this.now() - this.retentionMs;
    const expired = pages.filter((page) => retainedAt(page) <= cutoff);
    const ordered = pages.filter((page) => retainedAt(page) > cutoff).sort((a, b) => retainedAt(b) - retainedAt(a));
    const overflow = ordered.slice(this.maxDocuments);
    pages = ordered.slice(0, this.maxDocuments);
    // What leaves the copy without the person removing it is said, with why. A
    // document that silently stops answering is indistinguishable from one that
    // never had anything to say, and the person has no way to know they should
    // open it again. What they remove themselves is not in here: they know.
    const leaving = [...removed, ...expired.map((page) => [page, "expired"]), ...overflow.map((page) => [page, "count"])]
      .map(([page, reason]) => goneRecord(page, reason, this.now()));
    // A search that verified eight unchanged documents changes nothing on disk
    // except when they were last used, and that can wait: the copy is rewritten
    // at most once a minute for use alone, and immediately for anything else.
    const state = LocalWiki.state(pages);
    const used = pages.reduce((newest, page) => Math.max(newest, Number.isSafeInteger(page.usedAt) ? page.usedAt : 0), 0);
    this.departed = false;
    if (!beforeCommit && !leaving.length && this.written?.state === state && used - (this.written.used ?? 0) < USE_WRITE_MS) { this.pages = pages; await this.afterPages(pages); return; }
    await mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    // Only the pages that actually changed are re-encrypted and rewritten; the
    // whole set becomes visible when the manifest is renamed.
    const history = this.gone.filter((item) => item.at > cutoff);
    const { kept, gone } = await this.store.write(pages, { signal, beforeCommit, stateOf: LocalWiki.pageState,
      gone: [...leaving, ...history].slice(0, GONE_LIMIT), note: (page, reason) => goneRecord(page, reason, this.now()) });
    const arrived = leaving.length + (pages.length - kept.length);
    this.departed = arrived > 0;
    this.gone = [...gone].sort((a, b) => b.at - a.at).slice(0, GONE_LIMIT);
    if (arrived) this.message = `有 ${arrived} 篇来源被清理出本机副本（${this.gone.slice(0, arrived).map((item) => `《${item.title}》`).slice(0, 3).join("、")}${arrived > 3 ? " 等" : ""}）；飞书原文不受影响，重新打开即可恢复。`;
    this.pages = kept;
    this.written = { state: LocalWiki.state(kept), used };
    await this.afterPages(kept);
  }
  // What the last process worked out about which terms distinguish which
  // document. Rebuilding it is the whole cost of a large store's first question
  // -- about 1.3 s at a thousand documents, 14 s at ten thousand -- and nothing
  // in it is new: it is derived from text this machine already holds, so it is
  // encrypted with the same key and deleted with the documents it describes.
  // A file that cannot be read is not an error; it is one slow question.
  async restoreProfiles() {
    if (!this.profileFile || !this.pages?.length) return 0;
    try {
      const info = await stat(this.profileFile);
      if (info.size > this.maxBytes) return 0;
      const value = JSON.parse(gunzipSync(Buffer.from(await this.cipher.decrypt(await readFile(this.profileFile)), "base64")).toString("utf8"));
      if (![1, 2].includes(value?.version) || !Array.isArray(value.rows)) return 0;
      // Only rows that describe a document this store still holds at exactly
      // this version: anything else is a leftover and would be scored against
      // text that is no longer there.
      const held = new Map(this.pages.map((page) => [page.owner, page.contentHash]));
      const rows = value.rows.filter((row) => held.get(row?.owner) === row?.contentHash);
      const restored = importProfiles(rows);
      // The counts the profiles were ranked with. A file from before they were
      // kept has none, and the first question then counts every document again
      // rather than ranking with counts drawn from the profiles alone.
      if (value.version === 2) importFrequencies(value.frequency);
      this.profiles = profileState(this.pages);
      this.profilesAt = this.now();
      return restored;
    } catch { return 0; }
  }
  // Written after the documents themselves, never instead of them, and never on
  // the path that answers a question unless a document just left the store.
  async rememberProfiles(pages, { force = false, closing = false } = {}) {
    if (!this.profileFile || (this.closed && !closing)) return false;
    const state = profileState(pages ?? []);
    if (state === this.profiles) return false;
    // `profilesAt` of zero means nothing has been written yet, which a clock
    // starting near zero would otherwise read as "just written".
    if (!force && this.profilesAt && this.now() - this.profilesAt < PROFILE_WRITE_MS) return false;
    const rows = state ? exportProfiles(pages) : [];
    // Nothing in memory is not the same as nothing worth keeping: right after a
    // restart no profile has been rebuilt yet, and deleting the file then would
    // throw away exactly what it exists to save. The file goes when the
    // documents it describes are gone.
    if (!rows.length && pages?.length) return false;
    const temporary = `${this.profileFile}.${randomUUID()}.tmp`;
    try {
      if (!rows.length) {
        await unlink(this.profileFile).catch((error) => { if (error.code !== "ENOENT") throw error; });
      } else {
        const encrypted = await this.cipher.encrypt(gzipSync(Buffer.from(JSON.stringify({ version: 2, rows, frequency: exportFrequencies() }), "utf8"), { level: 1 }).toString("base64"));
        if (encrypted.length > this.maxBytes) { this.profiles = state; this.profilesAt = this.now(); return false; }
        await mkdir(path.dirname(this.profileFile), { recursive: true, mode: 0o700 });
        await writeFile(temporary, encrypted, { flag: "wx", mode: 0o600 });
        await rename(temporary, this.profileFile);
      }
      this.profiles = state; this.profilesAt = this.now();
      return true;
    } catch { return false; }
    finally { await unlink(temporary).catch(() => {}); }
  }
  // Additions wait; a document leaving does not. Losing a term list costs a
  // slow question, but keeping one after its document was removed would leave
  // words from a deleted source on this disk.
  afterPages(pages) {
    const state = profileState(pages ?? []);
    if (state === this.profiles) return null;
    const current = new Set(state.split("\n").filter(Boolean));
    if (this.profiles && this.profiles.split("\n").filter(Boolean).some((key) => !current.has(key))) return this.rememberProfiles(pages, { force: true });
    // Written here rather than scheduled: a write that outlives the call that
    // caused it would land after a shutdown, or after the person removed the
    // documents it describes. Once a minute, next to a write the store was
    // making anyway, is affordable -- about 100 ms at a thousand documents,
    // against the 1.3 s first question it saves.
    return this.rememberProfiles(pages);
  }
  observe(document, { signal } = {}) {
    // Snapshot the accepted read immediately; rendering/navigation is not blocked
    // by encryption and disk IO. Queue length is bounded for repeated reads.
    if (this.closed || signal?.aborted) return Promise.resolve(false);
    if (this.pending >= 32) { this.message = "知识整理队列已满，后续阅读时会再次尝试。"; return Promise.resolve(false); }
    const snapshot = structuredClone(document);
    return this.serial(async () => {
      try {
        signal?.throwIfAborted();
        const source = this.provider.normalizeObservedDocument ? await this.provider.normalizeObservedDocument(snapshot, { signal }) : snapshot;
        let page = evidencePage(source, this.now()); await this.load(); signal?.throwIfAborted();
        const old = this.pages.find((item) => item.owner === page.owner);
        if (old && old.authorizedAt > page.authorizedAt) return false;
        page = carrySynthesis(old, page);
        page.localReadAt = page.observedAt;
        await this.save([page, ...this.pages.filter((item) => item.owner !== page.owner)], signal);
        const retained = this.pages.some((item) => item.owner === page.owner);
        // A read that pushed something else out says so; the routine line would
        // otherwise overwrite the only place that departure is announced.
        if (!this.departed) this.message = retained ? "已自动整理阅读来源。搜索时会重新核验飞书身份、权限与版本。" : "来源超过本机知识配额，未保留副本。";
        if (retained) await this.maybeSynthesize(page, signal);
        return retained;
      } catch (error) {
        this.message = error.message.startsWith("缺少") || error.message.startsWith("局部") || error.message.startsWith("系统") || error.message.startsWith("本机知识文件") ? error.message : "本机知识整理失败，原文阅读不受影响。";
        return false;
      }
    });
  }
  async maybeSynthesize(page, signal) {
    const policy = this.synthesisPolicy;
    if (!policy || page.synthesis || this.synthesisCalls >= 6) return;
    if (policy.expiresAt <= this.now() || policy.principal !== page.principal || policy.tenantKey !== page.tenantId) { this.disableSynthesis(); return; }
    const controller = new AbortController(); this.synthesisController = controller;
    const abort = () => controller.abort(); signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let reserved = false;
    const assertCurrent = () => {
      if (controller.signal.aborted || this.synthesisPolicy !== policy || policy.expiresAt <= this.now()) throw new Error("归纳许可已失效");
    };
    const checkSource = async () => {
      assertCurrent(); const fresh = await this.provider.readDocument(page.sourceUrl, { signal: controller.signal }); assertCurrent();
      const current = evidencePage(fresh, page.observedAt);
      if (current.owner !== page.owner || synthesisKey(current) !== synthesisKey(page)) throw new Error("归纳期间来源或权限已变化");
    };
    try {
      await checkSource();
      const binding = await this.synthesizer.binding(); assertCurrent();
      // Consent named a model; a server now enforcing another is a new connection.
      if (binding.sessionHash !== policy.sessionHash || binding.serverUrl !== policy.serverUrl || bindingModel(binding) !== policy.model) { this.disableSynthesis(); return; }
      // Durable reservation precedes the paid request. Interrupted/failed attempts
      // are not replayed automatically, including after an application restart.
      page = { ...page, synthesis: { key: synthesisKey(page), recipe: SYNTHESIS_RECIPE, model: policy.model, state: "reserved" } };
      await this.save([page, ...this.pages.filter((item) => item.owner !== page.owner)]); assertCurrent();
      if (!this.pages.some((item) => item.owner === page.owner)) return;
      reserved = true; this.synthesisCalls++;
      this.message = "正在通过服务端归纳阅读来源…";
      const result = await this.synthesizer.generate(page, { binding: policy, signal: controller.signal }); assertCurrent();
      const facts = validateFacts(result, page);
      await checkSource();
      page = { ...page, synthesis: { ...page.synthesis, state: "complete", facts, coverage: synthesisInput(page).coverage } };
      await this.save([page, ...this.pages.filter((item) => item.owner !== page.owner)]);
      this.message = "已生成带原文引用的模型归纳；引文可追溯不代表推论已获事实验证。";
    } catch (error) {
      // The gateway turns down a model it does not enforce before any upstream
      // call, so a model_not_allowed refusal billed nothing: the reservation and
      // the call are given back and the page can be summarised once the model is
      // right, where it used to stay "failed" for good. Any other failure keeps
      // the reservation, because that request may already have been billed.
      const released = reserved && error?.modelMismatch === true;
      if (released) {
        const { synthesis: _refused, ...unsummarised } = page; page = unsummarised;
        this.synthesisCalls = Math.max(0, this.synthesisCalls - 1);
      } else if (reserved) page = { ...page, synthesis: { ...page.synthesis, state: "failed" } };
      if (reserved) await this.save([page, ...this.pages.filter((item) => item.owner !== page.owner)]);
      this.message = "本次归纳未完成、已取消或来源已变化；保留原文摘录，不自动重试。";
      // The server now enforces a model other than the one agreed to. Every later
      // read would be refused the same way, so stop instead of failing each one.
      if (error?.modelMismatch && this.synthesisPolicy === policy) { this.disableSynthesis(); this.message = `自动归纳已关闭：${MODEL_MISMATCH}后再开启；本次未调用模型、不计费，这篇来源可在重新开启后再归纳。`; }
    } finally { signal?.removeEventListener("abort", abort); if (this.synthesisController === controller) this.synthesisController = null; }
  }
  // `ids` narrows the search to documents the person chose. It only ever removes
  // candidates: a document outside the scope cannot be reached, and one inside it
  // is still re-read and re-verified before it can appear.
  search(query = "", { ids = null, signal = null, verify = RETRIEVAL.verify, perDocument = RETRIEVAL.perDocument, maxRows = RETRIEVAL.maxRows, maxChars = RETRIEVAL.maxChars, coverage = RETRIEVAL.coverage } = {}) {
    if (this.closed) return Promise.reject(new Error("本机知识节点已关闭"));
    if (typeof query !== "string" || query.length > 200) return Promise.reject(new Error("知识搜索词最多 200 字"));
    if (ids !== null && (!Array.isArray(ids) || ids.some((id) => typeof id !== "string"))) return Promise.reject(new Error("知识范围无效"));
    const scope = ids === null ? null : new Set(ids);
    if (this.pending >= 32) return Promise.reject(new Error("知识整理繁忙，请稍后搜索"));
    return this.serial(async () => {
      const identity = await this.provider.documentIdentity();
      if (!nonempty(identity.tenantKey) || !nonempty(identity.principal)) throw new Error("缺少已验证的租户身份，无法查询知识副本");
      await this.load();
      const stored = this.pages.filter((page) => page.tenantId === identity.tenantKey && page.principal === identity.principal && retainedAt(page) > this.now() - this.retentionMs && (!scope || scope.has(page.id)));
      const terms = queryTerms(query);
      // Which documents are worth a Feishu round-trip: what the stored copy says
      // the ranking wants, or — for the empty query the person's search box uses
      // to look at what is stored — simply the most recent.
      // Standing is arithmetic over the stored copies: which of them another
      // document says has been repealed. It can only push such a document down
      // among documents that already matched -- never lift one, and never
      // conjure a match (rankChunks multiplies a score that is zero when
      // nothing matched).
      const standing = standingGraph(stored);
      const prior = (page) => standing.get(page.owner)?.prior ?? 1;
      // Copies of one document cannot be told apart by ranking — nothing in
      // their text says which one governs — so one of them stands for the group
      // and the answer is told the others exist. Measured: a few hundred copies
      // of the evaluation corpus take full-evidence coverage from 68% to 11%.
      const families = duplicateGroups(stored, standing);
      const live = byOwner(stored);
      // Which documents to spend a Feishu round-trip on is a document-level
      // question, and answering it document by document is what keeps a large
      // store affordable: passage-level scoring then runs only on what comes
      // back verified.
      const speaksFor = (page) => {
        const family = families.get(page.owner);
        return !family || family.representative.owner === page.owner;
      };
      // Statistics over the documents that can actually be chosen, not over the
      // copies of them. A store holding thirteen archived copies of a roster made
      // every term in it look ordinary -- it appears in fourteen "documents" --
      // so the roster stopped ranking for the questions only it can answer.
      // Measured: the right document reached 57% of questions before, 96% after.
      const speaking = stored.filter(speaksFor);
      // Names the question mentions that a roster here holds as a cell of their
      // own (retrieval.js, questionCellNames): their documents are read, and the
      // row is sent, the way an identifier's is.
      const names = terms.length ? questionCellNames(speaking, query) : [];
      const wanted = terms.length
        ? rankDocuments(buildDocumentIndex(speaking), terms, { prior, limit: Math.max(verify * 4, 32) }).map((hit) => live.get(hit.page.owner) ?? hit.page)
        : [...speaking].sort((a, b) => b.observedAt - a.observedAt);
      const chosen = wanted.slice(0, verify);
      // A question naming an identifier -- a contract number, an order code -- is
      // asking about the document that holds it, which ranking alone does not
      // reach when that document is a large table. Those documents are read as
      // well, at most two, and a table among them is re-verified by its
      // revision rather than re-read in full.
      if (terms.length) {
        for (const page of pagesContaining(speaking, [...questionIdentifiers(query), ...names], { limit: EXACT_READS })) {
          if (!chosen.some((item) => item.owner === page.owner)) chosen.push(live.get(page.owner) ?? page);
        }
      }
      const checked = await this.verify(chosen, identity, { signal });
      const updated = [], fresh = [], removed = [];
      let unavailable = 0;
      for (const page of this.pages) {
        const result = checked.get(page.owner);
        if (!result) { updated.push(page); continue; }
        if (result.page) updated.push(result.page);
        if (result.removed) removed.push([page, result.reason]);
        if (result.page && !result.stale) fresh.push(result.page); else unavailable++;
      }
      // A login switch during multi-document verification invalidates the entire
      // response, not just the final source. Never fall back to cached ACLs.
      if (!sameIdentity(identity, await this.provider.documentIdentity())) throw new Error("查询期间飞书身份已变化，请重新搜索");
      await this.save(updated, signal, undefined, removed);
      // Excerpts come from the text that was just re-read, never from the stored
      // copy the ranking ran against.
      // Recomputed on what was just re-read: a repeal clause may have been added
      // to a document this morning, and the ranking ran against last night's copy.
      const current = standingGraph(fresh);
      const retired = (page) => RETIRED.includes(current.get(page.owner)?.state);
      const now = byOwner(fresh);
      const ranked = (terms.length ? rankChunks(buildIndex(fresh), terms, { limit: RETRIEVAL.rank, perDocument, coverage, identifiers: questionIdentifiers(query), cells: names, prior: (page) => current.get(page.owner)?.prior ?? 1 }) : [])
        .map((hit) => (now.get(hit.page.owner) === hit.page ? hit : { ...hit, page: now.get(hit.page.owner) ?? hit.page }));
      // The budget is spent on what is in force first. Ranking alone let a
      // repealed document that matched well take the room its replacement
      // needed -- the excerpt limit is what a question can carry, and a rule
      // that has been repealed is never the answer to "what applies now". The
      // repealed text still goes in afterwards, capped, because it is the only
      // thing that can answer "what changed".
      const inForce = [], expired = [], seen = new Map();
      for (const hit of ranked) {
        if (!retired(hit.page)) { inForce.push(hit); continue; }
        const used = seen.get(hit.page.owner) ?? 0;
        if (used >= RETIRED_ROWS) continue;
        seen.set(hit.page.owner, used + 1);
        expired.push(hit);
      }
      const kept = [...inForce, ...expired];
      const hits = terms.length
        ? selectExcerpts(kept, { maxChars, maxRows, excerptChars: RETRIEVAL.excerptChars }).map((row) => hitFrom(row.page, row, current.get(row.page.owner), families.get(row.page.owner)))
        : fresh.slice(0, maxRows).map((page) => hitFrom(page, { chunk: page.chunks[0], start: page.chunks[0].start, end: page.chunks[0].end, excerpt: page.chunks[0].text, heading: "" }, current.get(page.owner), families.get(page.owner)));
      return { hits, unavailable, limited: wanted.length > chosen.length, message: this.message };
    });
  }
  // One stored document, re-read and re-verified, by the short id the excerpts
  // carry. This is how the Agent opens more of something it already has a
  // passage from; it can reach nothing the person has not read and nothing
  // outside a chosen scope, and it returns text only after the same Feishu
  // check a search makes.
  document(reference, { ids = null, signal = null } = {}) {
    if (this.closed) return Promise.reject(new Error("本机知识节点已关闭"));
    if (typeof reference !== "string" || !/^[a-f0-9]{6,64}$/.test(reference)) return Promise.reject(new Error("知识文档编号无效"));
    if (ids !== null && (!Array.isArray(ids) || ids.some((id) => typeof id !== "string"))) return Promise.reject(new Error("知识范围无效"));
    const scope = ids === null ? null : new Set(ids);
    if (this.pending >= 32) return Promise.reject(new Error("知识整理繁忙，请稍后再读"));
    return this.serial(async () => {
      const identity = await this.provider.documentIdentity();
      if (!nonempty(identity.tenantKey) || !nonempty(identity.principal)) throw new Error("缺少已验证的租户身份，无法查询知识副本");
      await this.load();
      const matches = this.pages.filter((page) => page.tenantId === identity.tenantKey && page.principal === identity.principal &&
        retainedAt(page) > this.now() - this.retentionMs && (!scope || scope.has(page.id)) && page.id.startsWith(reference));
      if (!matches.length) throw new Error("知识副本里没有这篇文档");
      if (matches.length > 1) throw new Error("这个编号对应多篇文档，请用更完整的编号");
      const checked = await this.verify(matches, identity, { signal });
      const result = checked.get(matches[0].owner);
      const removed = [];
      const updated = this.pages.flatMap((page) => {
        const outcome = checked.get(page.owner);
        if (outcome?.removed) removed.push([page, outcome.reason]);
        return !outcome ? [page] : outcome.page ? [outcome.page] : [];
      });
      if (!sameIdentity(identity, await this.provider.documentIdentity())) throw new Error("读取期间飞书身份已变化，请重新读取");
      await this.save(updated, signal, undefined, removed);
      if (!result?.page || result.stale) throw new Error("这篇文档此刻无法从飞书重新核验，没有返回任何正文");
      const page = result.page;
      return { id: page.id, title: page.title, sourceUrl: page.sourceUrl, revision: page.revision, text: page.chunks.map((chunk) => chunk.text).join("") };
    });
  }
  // Verification is this product's promise: nothing reaches an answer that was
  // not re-read from Feishu and re-checked against this login a moment ago. What
  // changed is the price. Only the documents a question actually wants are
  // re-read, they are re-read at the same time rather than one after another,
  // and a read that fails no longer deletes the copy: a network hiccup used to
  // cost the person a document silently. A failed check leaves the page kept but
  // unusable — it cannot appear in any answer — and the third failure in a row
  // removes it. A read that comes back as a different resource is removed at
  // once: that is not a failed read, it is the wrong document.
  async verify(pages, identity, { signal = null, concurrency = RETRIEVAL.concurrency } = {}) {
    const results = new Map();
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, pages.length) }, async () => {
      for (let at; (at = next++) < pages.length;) {
        const page = pages[at];
        signal?.throwIfAborted();
        try {
          // What is stored goes along, so a source with a revision of its own can
          // confirm -- asked as this user -- that nothing changed, instead of
          // sending every cell again. A document ignores it and is read in full.
          const fresh = await this.provider.readDocument(page.sourceUrl, { signal, known: { providerId: page.providerId, resourceId: page.resourceId,
            sourceUrl: page.sourceUrl, sourceRevision: page.revision, contentHash: page.contentHash, title: page.title,
            text: page.chunks.map((chunk) => chunk.text).join(""), warnings: page.warnings } });
          if (!sameIdentity(identity, fresh.identity) || fresh.resourceId !== page.resourceId || fresh.providerId !== page.providerId) { results.set(page.owner, { removed: true, reason: "changed-source" }); continue; }
          const { staleAt: _at, staleCount: _count, ...carried } = page;
          results.set(page.owner, { page: { ...carrySynthesis(carried, evidencePage(fresh, page.observedAt)), usedAt: this.now() } });
        } catch (error) {
          if (signal?.aborted) throw error;
          const failures = (Number.isSafeInteger(page.staleCount) ? page.staleCount : 0) + 1;
          results.set(page.owner, failures >= STALE_LIMIT ? { removed: true, reason: "unreadable" } : { stale: true, page: { ...page, staleAt: this.now(), staleCount: failures } });
        }
      }
    }));
    return results;
  }
  // The picture as it stands, from what is already stored, with no network at
  // all. The store already keeps these pages on this machine — titles, text and
  // all — so drawing from them adds nothing at rest that was not there before.
  // It is the instant view on entering the section; graph() below is the one
  // that re-checks every source against Feishu and replaces it.
  // What is actually in here, without a single network call: the person could
  // add sources but never see the list, which is most of why the knowledge base
  // felt like a black box. Titles and links only — no excerpt text, because
  // nothing in this list has been re-verified and a listing is not an answer.
  inventory() {
    if (this.closed) return Promise.reject(new Error("本机知识节点已关闭"));
    return this.serial(async () => {
      const identity = await this.provider.documentIdentity();
      if (!nonempty(identity.tenantKey) || !nonempty(identity.principal)) throw new Error("缺少已验证的租户身份，无法查看知识副本");
      await this.load();
      const scoped = this.pages.filter((page) => page.tenantId === identity.tenantKey && page.principal === identity.principal && retainedAt(page) > this.now() - this.retentionMs);
      // The same arithmetic the search uses, so what the list says about a
      // document is what an answer would be told about it.
      const standing = standingGraph(scoped);
      // Near-identical copies are the one thing a large store cannot answer
      // around, so the list says which sources have them and which copy is the
      // one being sent.
      const families = duplicateGroups(scoped, standing);
      const counted = { current: 0, amended: 0, superseded: 0, "self-void": 0, conflict: 0, unknown: 0 };
      const sources = scoped
        .sort((a, b) => retainedAt(b) - retainedAt(a))
        .map((page) => ({ id: page.id, title: page.title, sourceUrl: page.sourceUrl, revision: page.revision,
          kind: page.sourceKind ?? "feishu-document", chars: page.chunks.reduce((total, chunk) => total + chunk.text.length, 0),
          observedAt: page.observedAt, usedAt: Number.isSafeInteger(page.usedAt) ? page.usedAt : null,
          readAt: Number.isSafeInteger(page.localReadAt) ? page.localReadAt : null,
          stale: Number.isSafeInteger(page.staleCount) ? page.staleCount : 0,
          synthesized: page.synthesis?.state === "complete", embeds: page.embeds?.length ?? 0,
          ...(() => {
            const family = families.get(page.owner);
            return family ? { duplicates: { copies: family.copies, speaksForGroup: family.representative.owner === page.owner,
              others: family.others.slice(0, 5).map((item) => ({ id: item.id, title: item.title })) } } : {};
          })(),
          ...(() => {
            const record = standing.get(page.owner);
            counted[record?.state ?? "unknown"] += 1;
            return { standing: record?.state ?? "unknown", ...(record?.date ? { docDate: record.date.value, docDateKind: record.date.kind } : {}),
              ...(record?.supersededBy ? { supersededBy: record.supersededBy, standingEvidence: record.evidence } : {}),
              ...(record?.amendedBy?.length ? { amendedBy: record.amendedBy } : {}) };
          })() }));
      const duplicated = new Set();
      for (const [owner, family] of families) if (scoped.some((page) => page.owner === owner)) duplicated.add(family.representative.owner);
      const gone = this.gone.filter((item) => item.tenantId === identity.tenantKey && item.principal === identity.principal)
        .map(({ id, title, sourceUrl, reason, at }) => ({ id, title, sourceUrl, reason, at }));
      return { sources, counts: counted, duplicateGroups: duplicated.size, gone, maxDocuments: this.maxDocuments,
        retentionDays: Math.round(this.retentionMs / 86400_000), message: this.message };
    });
  }
  // Removing a copy is the person's own decision, made in the application, and
  // it removes only this machine's derived copy: the Feishu document is
  // untouched, and reading it again rebuilds the copy.
  forget(id) {
    if (this.closed) return Promise.reject(new Error("本机知识节点已关闭"));
    if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) return Promise.reject(new Error("知识来源编号无效"));
    return this.serial(async () => {
      const identity = await this.provider.documentIdentity();
      if (!nonempty(identity.tenantKey) || !nonempty(identity.principal)) throw new Error("缺少已验证的租户身份，无法移除知识副本");
      await this.load();
      const page = this.pages.find((item) => item.id === id && item.tenantId === identity.tenantKey && item.principal === identity.principal);
      if (!page) throw new Error("这个来源不在当前账号的知识副本里");
      await this.save(this.pages.filter((item) => item.owner !== page.owner));
      this.message = `已移除《${page.title}》的本机副本；飞书原文不受影响，再次阅读会重新建立。`;
      return { removed: { id: page.id, title: page.title }, remaining: this.pages.length, message: this.message };
    });
  }
  graphSnapshot() {
    if (this.closed) return Promise.reject(new Error("本机知识节点已关闭"));
    return this.serial(async () => {
      const identity = await this.provider.documentIdentity();
      if (!nonempty(identity.tenantKey) || !nonempty(identity.principal)) throw new Error("缺少已验证的租户身份，无法查询知识副本");
      await this.load();
      const scoped = this.pages.filter((page) => page.tenantId === identity.tenantKey && page.principal === identity.principal && retainedAt(page) > this.now() - this.retentionMs);
      const pages = scoped.map((page) => ({ id: page.id, title: page.title, sourceUrl: page.sourceUrl, revision: page.revision,
        chars: page.chunks.reduce((total, chunk) => total + chunk.text.length, 0), chunkCount: page.chunks.length,
        synthesized: page.synthesis?.state === "complete", text: page.chunks.map((chunk) => chunk.text).join("\n") }));
      const latest = scoped.reduce((max, page) => Math.max(max, page.observedAt), 0);
      return { ...knowledgeGraph(pages), snapshot: true, observedAt: latest || null, message: this.message };
    });
  }
  // The same picture the search results come from, drawn all at once. Access is
  // checked exactly as in search: every document is re-read and re-verified
  // against Feishu before it can appear, so a source whose permission was taken
  // away leaves the graph instead of lingering as a title someone can still see.
  // Relationships are computed locally from stored evidence — no model call, no
  // network beyond the permission re-check, and no text leaves this machine.
  graph({ signal } = {}) {
    if (this.closed) return Promise.reject(new Error("本机知识节点已关闭"));
    if (this.pending >= 32) return Promise.reject(new Error("知识整理繁忙，请稍后构建图谱"));
    return this.serial(async () => {
      const identity = await this.provider.documentIdentity();
      if (!nonempty(identity.tenantKey) || !nonempty(identity.principal)) throw new Error("缺少已验证的租户身份，无法查询知识副本");
      await this.load();
      const scoped = this.pages.filter((page) => page.tenantId === identity.tenantKey && page.principal === identity.principal && retainedAt(page) > this.now() - this.retentionMs);
      const checked = await this.verify(scoped, identity, { signal });
      const updated = [], verified = [], removed = [];
      let unavailable = 0;
      for (const page of this.pages) {
        const result = checked.get(page.owner);
        if (!result) { updated.push(page); continue; }
        if (result.page) updated.push(result.page);
        if (result.removed) removed.push([page, result.reason]);
        if (!result.page || result.stale) { unavailable++; continue; }
        const current = result.page;
        verified.push({ id: current.id, title: current.title, sourceUrl: current.sourceUrl, revision: current.revision,
          chars: current.chunks.reduce((total, chunk) => total + chunk.text.length, 0), chunkCount: current.chunks.length,
          synthesized: current.synthesis?.state === "complete",
          text: current.chunks.map((chunk) => chunk.text).join("\n") });
      }
      // A login switch part-way through invalidates the whole picture, exactly as
      // it does for a search: never draw one account's graph for another.
      if (!sameIdentity(identity, await this.provider.documentIdentity())) throw new Error("构建期间飞书身份已变化，请重新构建图谱");
      await this.save(updated, undefined, undefined, removed);
      return { ...knowledgeGraph(verified), unavailable, message: this.message };
    });
  }
  async close() {
    this.closed = true; this.disableSynthesis(); await this.queue;
    // The last thing a shutdown can do for the next start is leave the term
    // lists where they can be read again.
    if (this.pages?.length) await this.rememberProfiles(this.pages, { force: true, closing: true }).catch(() => {});
    this.pages = null;
  }

  publicationCandidates({ signal, expectedIdentity } = {}) {
    if (this.closed || this.pending >= 32) return Promise.reject(new Error("知识节点已关闭或繁忙。"));
    return this.serial(async () => {
      const current = () => { signal?.throwIfAborted(); if (this.closed) throw new Error("知识节点已关闭。"); };
      current(); const identity = await this.provider.documentIdentity({ signal }); current();
      if (!identity?.principal || !identity.tenantKey || expectedIdentity && !sameIdentity(identity, expectedIdentity)) throw new Error("自动发布的来源身份已变化。");
      await this.load(); current();
      const sourceIds = this.pages.filter(page => page.principal === identity.principal && page.tenantId === identity.tenantKey && !page.staleCount &&
        Number.isSafeInteger(page.localReadAt) && page.localReadAt > this.now() - this.retentionMs && page.localReadAt <= this.now() &&
        retainedAt(page) > this.now() - this.retentionMs).slice(0, Math.min(this.maxDocuments, 200)).map(page => page.id).sort();
      if (!sameIdentity(identity, await this.provider.documentIdentity({ signal }))) throw new Error("自动发布的来源身份已变化。");
      current(); return { identity: { ...identity }, sourceIds, selectionKind: "retained-local-reads", permissionsChecked: false };
    });
  }

  exportEvidence(ids, { signal } = {}) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 200 || !ids.every(wikiDigest) || new Set(ids).size !== ids.length) return Promise.reject(new Error("请选择有效且不重复的知识来源。"));
    if (this.closed || this.pending >= 32) return Promise.reject(new Error("知识节点已关闭或繁忙。"));
    return this.serial(async () => {
      const current = () => { signal?.throwIfAborted(); if (this.closed) throw new Error("知识节点已关闭。"); };
      current(); const identity = await this.provider.documentIdentity(); await this.load(); current();
      const pages = [];
      for (const id of ids) {
        const old = this.pages.find(page => page.id === id && page.principal === identity.principal && page.tenantId === identity.tenantKey && retainedAt(page) > this.now() - this.retentionMs);
        if (!old) throw new Error("知识来源已失效或不属于当前身份，未准备传输。");
        const fresh = await this.provider.readDocument(old.sourceUrl, { signal }); current();
        const page = evidencePage(fresh, this.now());
        if (!sameIdentity(identity, fresh.identity) || page.id !== old.id) throw new Error("准备传输期间来源身份已变化。");
        pages.push(carrySynthesis(old, page));
      }
      if (!sameIdentity(identity, await this.provider.documentIdentity())) throw new Error("准备传输期间账号已变化。");
      current(); return { identity, pages };
    });
  }

  importEvidence(records, origin, { signal, expectedIdentity, assertCurrent } = {}) {
    if (this.closed || this.pending >= 32) return Promise.reject(new Error("知识节点已关闭或繁忙。"));
    if (!Array.isArray(records) || !records.length || records.length > 200 || typeof assertCurrent !== "function") return Promise.reject(new Error("知识导入缺少来源或授权核验。"));
    const snapshot = structuredClone(records), provenance = structuredClone(origin);
    return this.serial(async () => {
      const current = async () => { signal?.throwIfAborted(); if (this.closed) throw new Error("closed"); await assertCurrent(); signal?.throwIfAborted(); if (this.closed) throw new Error("closed"); };
      try {
        wikiExact(provenance, ["kind", "ciphertextSha256", "nodeId", "generation"]);
        if (provenance.kind !== "wiki-bundle" || ![provenance.ciphertextSha256, provenance.nodeId].every(wikiDigest) || !Number.isSafeInteger(provenance.generation) || provenance.generation < 1) throw new Error("invalid origin");
        await current(); const identity = await this.provider.documentIdentity();
        if (!identity.tenantKey || !identity.principal || !sameIdentity(identity, expectedIdentity)) throw new Error("identity mismatch");
        await this.load(); await current();
        const pages = [], seen = new Set();
        for (const record of snapshot) {
          if (record.tenantId !== identity.tenantKey) throw new Error("tenant mismatch");
          const fresh = await this.provider.readDocument(record.sourceUrl, { signal }); await current();
          if (!sameIdentity(identity, fresh.identity) || ["providerId", "resourceId", "sourceUrl", "title", "contentHash", "text"].some(key => fresh[key] !== record[key]) || fresh.sourceRevision !== record.revision) throw new Error("source mismatch");
          let page = evidencePage(fresh, this.now()); if (seen.has(page.owner)) throw new Error("duplicate source"); seen.add(page.owner);
          if (record.synthesis) {
            // The publisher's model, whichever it was, stays on the record.
            if (record.synthesis.recipe !== SYNTHESIS_RECIPE || !isChatModel(record.synthesis.model)) throw new Error("synthesis mismatch");
            page = { ...page, synthesis: { key: synthesisKey(page), recipe: SYNTHESIS_RECIPE, model: record.synthesis.model, state: "complete",
              facts: validateFacts(record.synthesis, page), coverage: synthesisInput(page).coverage, origin: provenance } };
          } else page = carrySynthesis(this.pages.find(old => old.owner === page.owner), page);
          pages.push(carryLocalRead(this.pages.find(old => old.owner === page.owner), page));
        }
        if (!sameIdentity(identity, await this.provider.documentIdentity())) throw new Error("identity changed");
        await current();
        // One commit after every source passed. Imported ACL/owner/chunk offsets
        // never replace the recipient's fresh authorization or normalization.
        await this.save([...pages, ...this.pages.filter(page => !seen.has(page.owner))], signal, current);
        const retained = pages.filter(page => this.pages.some(saved => saved.owner === page.owner)).length;
        this.message = `已核验并导入 ${retained}/${pages.length} 个来源；搜索时仍重新检查原文权限。`;
        return { retained, requested: pages.length };
      } catch { throw new Error("知识包导入未完成：来源权限、版本、账号、发布状态或存储核验失败；未使用包内授权代替原文检查。"); }
    });
  }
}
