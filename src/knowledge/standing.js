// Which of two documents is the one still in force.
//
// Retrieval answers "what is this passage about". It has no opinion at all
// about "is this passage still true", and the measurement says that is where
// the remaining wrong answers live: in every trap question of the evaluation
// corpus, the current document and the dead one reach the prompt in the same
// turn. So the job here is not recall. It is ranking between two documents that
// both matched, and labelling what is sent.
//
// Three rules keep this honest, and each was forced by a measurement:
//
//   * It only ever demotes. Across the corpus, a quarter of questions have the
//     gold passage within 7% of the strongest distractor, and a tenth have it
//     behind — so any smooth prior wide enough to promote would flip correct
//     and incorrect answers at random. `prior <= 1` always.
//   * It only demotes a document that some other document says, in words, has
//     been repealed — quoted back so a person can check the judgement. Looking
//     old is not evidence.
//   * Everything else is a label, not a score. The model is told what the
//     documents say about themselves, with the quote, and decides.
//
// Entirely local arithmetic: no model call, no network, and the same pages give
// the same answer twice.

import { pagesSignature } from "./retrieval.js";

// A document's own statement about its date, from its head. Effective dates beat
// meeting dates beat publication dates: a policy that says when it takes effect
// has said the thing that matters for deciding which version governs.
const HEAD = 600;
const TABLE_ROW = /^\s*\|/u;
const DATE_KINDS = Object.freeze([
  ["effective", /(?:生效|施行|执行)日期[：:]\s*(20\d\d)[-年.](\d{1,2})[-月.](\d{1,2})|自\s*(20\d\d)\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日起(?:施行|执行|生效)/],
  ["meeting", /会议(?:日期|时间)[：:]\s*(20\d\d)[-年.](\d{1,2})[-月.](\d{1,2})/],
  ["report", /(?:报告|汇报)(?:日期|周期)[：:]\s*(20\d\d)[-年.](\d{1,2})[-月.](\d{1,2})/],
  ["updated", /(?:更新|修订)日期[：:]\s*(20\d\d)[-年.](\d{1,2})[-月.](\d{1,2})/],
  ["published", /(?:发布|印发)日期[：:]\s*(20\d\d)[-年.](\d{1,2})[-月.](\d{1,2})/],
  ["dated", /(20\d\d)[-年](\d{1,2})[-月](\d{1,2})/],
]);

const pad = (value) => String(value).padStart(2, "0");

export function documentDate(text, title = "") {
  // A table row's date belongs to that row, not to the document: the first rows
  // of a spreadsheet are full of dates, and none of them says when the table
  // itself is from.
  const head = String(text ?? "").slice(0, HEAD).split("\n").filter((line) => !TABLE_ROW.test(line)).join("\n");
  for (const [kind, pattern] of DATE_KINDS) {
    const match = pattern.exec(head);
    if (!match) continue;
    const parts = match.slice(1).filter(Boolean);
    if (parts.length < 3) continue;
    const [year, month, day] = parts.map(Number);
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    const line = head.slice(head.lastIndexOf("\n", match.index) + 1, head.indexOf("\n", match.index) === -1 ? undefined : head.indexOf("\n", match.index));
    return { value: `${year}-${pad(month)}-${pad(day)}`, kind, quote: line.trim().slice(0, 120) };
  }
  // A title that dates itself ("（2025 版）", "2026 修订版") is weaker than a
  // statement in the text, and is used only when the text says nothing.
  const fromTitle = /(20\d\d)\s*(?:年)?\s*(?:版|修订版)/.exec(String(title ?? ""));
  return fromTitle ? { value: `${fromTitle[1]}-01-01`, kind: "version", quote: String(title).slice(0, 120) } : null;
}

const VOID = /已废止|已作废|已失效|停止执行|不再适用|予以废止|同时废止|自动失效/gu;
const VOIDS = /已废止|已作废|已失效|停止执行|不再适用|予以废止|同时废止|自动失效/u;
const CITE = /[《「]([^》」\n]{4,60})[》」]/gu;
const BREAK = /[，。；！？、]|原办法|原制度|原规范|原文件|旧办法|旧制度/u;
const SELF = /(?:^|[，。；：\s(（])(?:本办法|本制度|本规范|本通知|本指引|本文件|本文档)(?:已|现|自即日起)?$/u;
const AMEND = /决议|会议决定|决定将|调整为|变更为|改为|同意将|批准将|上调至|下调至|缩短为|延长为|按本通知执行|以本[^，。]{0,6}为准|同步修订|另行更新|不再由|改由/u;
// What can be amended at all: something that states a rule or a target. A record
// of what was decided — minutes, a weekly report, a progress report — is not
// amended by a later document that repeats its decision; without this, the
// September progress report "amends" the August minutes it is quoting.
const AMENDABLE = /制度|规范|办法|指引|通知|细则|标准|手册|政策|okr|计划|目标|台账/iu;
const RECORD = /纪要|周报|汇报|报告|简报/u;
// A citation and the repeal verb must be close enough to be one statement.
const GAP = 30;
// 「《A》《B》《C》予以废止」点的是三份文件，不是最后一份。只有靠顿号、逗号、
// 「和」这类并列标记串在动词前面的引用才算数：「按《B》执行，《C》予以废止」
// 里的《B》不在这条链上，因为中间隔着一个动词。
const LIST = /^[\s、，,；;]*(?:和|与|及|以及)?[\s、，,；;]*$/u;

const normalize = (title) => String(title ?? "").replace(/[\s（）()《》「」、,，]/gu, "").toLocaleLowerCase();
const stem = (title) => normalize(title).replace(/(20)?\d{2}(年)?(版|修订版)?/gu, "").replace(/v\d+(\.\d+)*/gu, "").replace(/第.{1,3}版/gu, "");

// Titles, indexed once per call. Resolving a citation used to filter the whole
// store three times over, and finding a document named without quotation marks
// used to walk every page for every sentence -- which is why this was quadratic
// and unusable past a few hundred documents.
const PREFIX = 4;
function titleIndex(pages) {
  const exact = new Map(), stems = new Map(), gates = new Map(), tokens = new Map(), prefixes = new Map();
  const add = (map, key, page) => { if (!key) return; const list = map.get(key); if (list) list.push(page); else map.set(key, [page]); };
  for (const page of pages) {
    add(exact, normalize(page.title), page);
    add(stems, stem(page.title), page);
    add(prefixes, stem(page.title).slice(0, PREFIX), page);
    const own = titleTokens(page.title);
    tokens.set(page.owner, own);
    // A line can only name this document if it contains the opening pair of one
    // of the title's own words; that pair is the cheap gate into the few
    // candidates worth a substring check.
    for (const gate of new Set(own.map((token) => token.slice(0, 2)))) add(gates, gate, page);
  }
  return { pages, exact, stems, gates, tokens, prefixes };
}

const titleTokens = (title) => (String(title ?? "").match(/[\p{Script=Han}]{2,}|[A-Za-z0-9]{2,}/gu) ?? [])
  .map((token) => token.replace(/^20\d\d年?$/u, "")).filter(Boolean).filter((token) => !/^(?:版|修订版)$/u.test(token));

// The document a citation names, or null. Three levels, each requiring a unique
// match: exact, then ignoring year and version, then a long-enough prefix.
export function resolveTitle(cited, pages, selfOwner = null) {
  const index = Array.isArray(pages) ? titleIndex(pages) : pages;
  const not = (list) => (list ?? []).filter((page) => page.owner !== selfOwner);
  const exact = not(index.exact.get(normalize(cited)));
  if (exact.length === 1) return exact[0];
  const byStem = not(index.stems.get(stem(cited)));
  if (byStem.length === 1) return byStem[0];
  const needle = stem(cited);
  if ([...needle].filter((character) => /\p{Script=Han}/u.test(character)).length < 6) return null;
  // Only titles that already share the citation's first characters can start
  // with it, so the last level looks at a bucket rather than the whole store.
  const prefixed = (index.prefixes.get(needle.slice(0, PREFIX)) ?? []).filter((page) => page.owner !== selfOwner && stem(page.title).startsWith(needle));
  return prefixed.length === 1 ? prefixed[0] : null;
}

// Rejoining every stored page into one string, on every search, was the largest
// single cost at a thousand documents: the text has not changed, so neither has
// its join, its date, or the sentences worth looking at. Keyed by content hash —
// the same identity the store verifies with — and bounded.
const CACHE_LIMIT = 12_000;
const cached = new Map();
function readingOf(page) {
  const key = page.contentHash ? `${page.owner}:${page.contentHash}` : null;
  const hit = key && cached.get(key);
  if (hit) return hit;
  const text = page.chunks.map((chunk) => chunk.text).join("");
  // Scanning every line of every document, on every search, is what made this
  // cost seconds at ten thousand documents. The scan depends only on the text,
  // so it is done once per version: what is left per search is resolving the
  // names it found against the titles in the store, which is a lookup.
  const reading = { text, date: documentDate(text, page.title), declares: VOIDS.test(text), amends: AMEND.test(text),
    repeals: VOIDS.test(text) ? repealLines(text) : [], amends_lines: AMEND.test(text) ? amendLines(text) : [] };
  if (key) {
    if (cached.size >= CACHE_LIMIT) cached.clear();
    cached.set(key, reading);
  }
  return reading;
}

// Every repeal a document declares about another, with the sentence it declared
// it in. A repeal inside a table row is a description of history, not a
// declaration, and is skipped.
// The sentences in one document that declare a repeal, with the title each one
// names. Text only: no other document is consulted, so this is cacheable.
function repealLines(text) {
  const found = [];
  for (const line of text.split("\n")) {
    if (TABLE_ROW.test(line)) continue;
    VOID.lastIndex = 0;
    for (let match = VOID.exec(line); match; match = VOID.exec(line)) {
      const before = line.slice(0, match.index);
      CITE.lastIndex = 0;
      const cites = [];
      for (let cite = CITE.exec(before); cite; cite = CITE.exec(before)) cites.push(cite);
      const cited = cites.at(-1) ?? null;
      if (!cited) {
        // "本办法已废止" — the document about itself, and only where it counts.
        if (SELF.test(before.trimEnd()) && !line.includes("《")) found.push({ kind: "self", quote: line.trim().slice(0, 200) });
        continue;
      }
      const gap = before.slice(cited.index + cited[0].length);
      if (gap.length > GAP || BREAK.test(gap)) continue;
      const chained = [cited];
      for (let index = cites.length - 2; index >= 0; index -= 1) {
        if (!LIST.test(before.slice(cites[index].index + cites[index][0].length, cites[index + 1].index))) break;
        chained.unshift(cites[index]);
      }
      for (const cite of chained) found.push({ kind: "repeal", cited: cite[1], quote: line.trim().slice(0, 200) });
    }
  }
  return found;
}

function repeals(page, reading, index) {
  const found = [];
  for (const line of reading.repeals) {
    if (line.kind === "self") { found.push(line); continue; }
    const victim = resolveTitle(line.cited, index, page.owner);
    if (victim) found.push({ kind: "repeal", victim, quote: line.quote });
  }
  return found;
}

// A later decision that changes part of an earlier document. It labels, it never
// demotes: the rest of the amended document is still in force.
// The sentences that change something, with any titles they quote. Text only.
function amendLines(text) {
  const found = [];
  for (const line of text.split("\n")) {
    if (TABLE_ROW.test(line) || !AMEND.test(line)) continue;
    const cites = [];
    CITE.lastIndex = 0;
    for (let cite = CITE.exec(line); cite; cite = CITE.exec(line)) cites.push(cite[1]);
    found.push({ line, cites });
  }
  return found;
}

function amendments(page, reading, index, frequency) {
  const found = [], seen = new Set();
  for (const { line, cites } of reading.amends_lines) {
    let target = null;
    for (const cited of cites) {
      const resolved = resolveTitle(cited, index, page.owner);
      if (resolved) { target = resolved; break; }
    }
    if (!target) target = bareTarget(line, index, page.owner, frequency);
    if (!target || seen.has(target.owner)) continue;
    if (RECORD.test(target.title) || !AMENDABLE.test(target.title)) continue;
    seen.add(target.owner);
    found.push({ target, quote: line.trim().slice(0, 200) });
  }
  return found;
}

// "Q3 OKR 中 KR1.1 的发布日期由总裁办另行更新" names a document without quoting
// its title. Two of the target's own distinctive tokens, in order and close
// together, one of them rare across the store.
// A title shared by hundreds of documents cannot identify one of them: a
// sentence mentioning it is ambiguous, and an ambiguous reference names nothing.
const AMBIGUOUS = 64;
function bareTarget(line, index, selfOwner, frequency) {
  // Only the documents whose title opens with a pair this line contains are
  // worth checking, instead of every document in the store.
  const candidates = new Set();
  for (let i = 0; i + 2 <= line.length; i += 1) {
    const bucket = index.gates.get(line.slice(i, i + 2));
    if (!bucket || bucket.length > AMBIGUOUS) continue;
    for (const page of bucket) candidates.add(page);
  }
  if (candidates.size > AMBIGUOUS) return null;
  for (const page of index.pages) {
    if (!candidates.has(page) || page.owner === selfOwner) continue;
    const tokens = index.tokens.get(page.owner) ?? [];
    if (tokens.length < 2) continue;
    if (!tokens.some((token) => (frequency.get(token.toLocaleLowerCase()) ?? 0) <= 6)) continue;
    // Any two of the title's words, in the order the title has them: "Q3 OKR"
    // names 「2026 年 Q3 公司 OKR」 without ever saying 公司.
    for (let i = 0; i < tokens.length - 1; i += 1) {
      const first = line.indexOf(tokens[i]);
      if (first < 0) continue;
      for (let j = i + 1; j < tokens.length; j += 1) {
        const second = line.indexOf(tokens[j], first + tokens[i].length);
        if (second >= 0 && second - (first + tokens[i].length) <= 20) return page;
      }
    }
  }
  return null;
}

const BASE = Object.freeze({ current: 1, unknown: 1, amended: 1, conflict: 1, superseded: 0.75, "self-void": 0.75 });
const INCOMPLETE = /资源未展开/u;
export const STANDING_STATES = Object.freeze(["current", "amended", "conflict", "superseded", "self-void", "unknown"]);

// The standing of every page, as one pass over the store. Pages are already
// scoped to one tenant and principal by the caller: a document belonging to one
// account can never repeal another account's.
const graphs = new Map();
const GRAPH_CACHE = 4;

export function standingGraph(pages) {
  // The judgement depends on the documents' own text and on nothing else, so the
  // same set of documents gives the same graph — and a search re-reads eight
  // documents that have usually not changed. Without this the whole store was
  // judged again for every question.
  const key = pagesSignature(pages ?? []);
  const hit = graphs.get(key);
  if (hit) { graphs.delete(key); graphs.set(key, hit); return hit; }
  const list = (pages ?? []).filter((page) => page?.chunks?.length);
  const readings = new Map(list.map((page) => [page.owner, readingOf(page)]));
  const texts = new Map([...readings].map(([owner, reading]) => [owner, reading.text]));
  const dates = new Map([...readings].map(([owner, reading]) => [owner, reading.date]));
  const index = titleIndex(list);
  const frequency = new Map();
  for (const page of list) {
    for (const token of new Set((index.tokens.get(page.owner) ?? []).map((value) => value.toLocaleLowerCase()))) {
      frequency.set(token, (frequency.get(token) ?? 0) + 1);
    }
  }
  const records = new Map(list.map((page) => [page.owner, { state: "unknown", evidence: null, supersededBy: null, amendedBy: [], supersedes: [], date: dates.get(page.owner) }]));
  const before = (a, b) => {
    const one = dates.get(a)?.value, two = dates.get(b)?.value;
    return one && two ? one <= two : null;
  };
  // Gather every declaration first, then decide per victim: more than one
  // document may say the same policy is dead (the successor itself, and the FAQ
  // that repeats it), and the one worth naming is the successor.
  const declared = new Map();
  for (const page of list) {
    if (!readings.get(page.owner).declares) continue;
    for (const repeal of repeals(page, readings.get(page.owner), index)) {
      if (repeal.kind === "self") {
        const record = records.get(page.owner);
        if (record.state === "unknown") { record.state = "self-void"; record.evidence = repeal.quote; }
        continue;
      }
      if (!records.has(repeal.victim.owner)) continue;
      // A document cannot repeal one that came after it; that is a disagreement,
      // and a disagreement is shown, not acted on.
      if (before(page.owner, repeal.victim.owner) === true) {
        const victim = records.get(repeal.victim.owner);
        if (victim.state === "unknown") { victim.state = "conflict"; victim.evidence = repeal.quote; }
        continue;
      }
      declared.set(repeal.victim.owner, [...(declared.get(repeal.victim.owner) ?? []), { by: page, quote: repeal.quote }]);
    }
  }
  for (const [owner, claims] of declared) {
    // The successor states when it takes effect; a FAQ about it only says when
    // it was written. Failing that, the earliest declaration — the one that did
    // the repealing, not the ones repeating it.
    const ranked = [...claims].sort((a, b) => {
      const kindOf = (claim) => (dates.get(claim.by.owner)?.kind === "effective" ? 0 : 1);
      return kindOf(a) - kindOf(b) || String(dates.get(a.by.owner)?.value ?? "9999").localeCompare(String(dates.get(b.by.owner)?.value ?? "9999")) || a.by.title.localeCompare(b.by.title);
    });
    const victim = records.get(owner), winner = ranked[0];
    victim.state = "superseded"; victim.evidence = winner.quote;
    victim.supersededBy = { id: winner.by.id, title: winner.by.title, docDate: dates.get(winner.by.owner)?.value ?? null };
    for (const claim of claims) records.get(claim.by.owner).supersedes.push({ id: records.has(owner) ? list.find((page) => page.owner === owner).id : owner, title: list.find((page) => page.owner === owner).title });
  }
  for (const page of list) {
    if (!readings.get(page.owner).amends) continue;
    for (const amendment of amendments(page, readings.get(page.owner), index, frequency)) {
      // Only a later document amends an earlier one, and both must say when
      // they are from; otherwise this is just a sentence with a verb in it.
      if (before(page.owner, amendment.target.owner) !== false) continue;
      const target = records.get(amendment.target.owner);
      if (target.amendedBy.length >= 3 || target.amendedBy.some((item) => item.id === page.id)) continue;
      target.amendedBy.push({ id: page.id, title: page.title, docDate: dates.get(page.owner)?.value ?? null, evidence: amendment.quote });
    }
  }
  for (const page of list) {
    const record = records.get(page.owner);
    if (record.state === "unknown" && record.amendedBy.length) record.state = "amended";
    if (record.state === "unknown" && (dates.get(page.owner)?.kind === "effective" || /第[一二三四五六七八九十百]+条/u.test(texts.get(page.owner).slice(0, 2000)))) record.state = "current";
    const complete = (page.warnings ?? []).some((warning) => INCOMPLETE.test(warning)) ? 0.95 : 1;
    record.prior = Math.min(1, Math.max(0.5, BASE[record.state] * complete));
  }
  if (graphs.size >= GRAPH_CACHE) graphs.delete(graphs.keys().next().value);
  graphs.set(key, records);
  return records;
}

// What a hit says about itself, with nothing sent when there is nothing to say.
export function standingLabel(record) {
  if (!record) return {};
  const label = {};
  if (record.date) { label.docDate = record.date.value; label.docDateKind = record.date.kind; }
  if (["superseded", "self-void", "conflict"].includes(record.state)) {
    label.standing = record.state;
    if (record.evidence) label.standingEvidence = record.evidence;
    if (record.supersededBy) label.supersededBy = record.supersededBy;
  }
  if (record.amendedBy?.length) { label.standing = label.standing ?? "amended"; label.amendedBy = record.amendedBy; }
  return label;
}
