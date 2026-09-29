// How the local knowledge copy finds the passage that answers a question.
// Deliberately arithmetic and offline, like graph.js: no model call, nothing
// leaves the machine, and the same corpus and question give the same answer
// twice. It is kept out of local-wiki.js -- which is about storing sources and
// re-verifying them against Feishu -- so retrieval can be measured on its own
// against a fixed corpus (test/knowledge-retrieval.test.js).
//
// Three things differ from the substring counter this replaces, each for a
// failure measured on the 16-document evaluation corpus:
//   * chunks are paragraph-sized and end where sections end, so a hit points at
//     the rule rather than at the first 1500 characters of the document it
//     lives in;
//   * scoring is BM25 over CJK bigrams and Latin words, so a term that appears
//     in every document (审批) cannot outrank one that appears in two (请假);
//   * the excerpt grows outwards from the matched chunk to the heading and the
//     table header above it, because a table row without its header answers
//     nothing. The excerpt stays an exact slice of the source text, so a
//     citation can still be checked character for character.

// Characters, not tokens: the store is Chinese text where a token count means
// little. A chunk is a few paragraphs; the minimum keeps a heading from cutting
// a two-line chunk out of a table, the maximum bounds a document with no line
// breaks at all.
export const CHUNK_TARGET = 600;
export const CHUNK_MIN = 240;
export const CHUNK_MAX = 1000;
// Standard BM25 constants. b stays at 0.75: section-sized chunks differ enough
// in length that ignoring length normalisation favours long preamble chunks.
const K1 = 1.2;
const B = 0.75;
// A question's own words matter more than how often they repeat, so the query
// side is a set. The cap bounds work for a pasted paragraph.
const MAX_QUERY_TERMS = 64;
// A title hit is evidence about the whole document, not about this passage.
// Worth about one occurrence, never enough on its own to beat a real match.
const TITLE_WEIGHT = 0.6;
// What share of a question's terms count as the ones that identify an answer.
const DECISIVE_SHARE = 0.25;

const HEADING = /^(?:#{1,6}\s|第[零一二三四五六七八九十百千万0-9]{1,8}[条章节款项部篇]|[一二三四五六七八九十]{1,3}、|\d{1,2}[.、)]\s)/u;
const TABLE_ROW = /^\s*\|/u;
const TABLE_RULE = /^\s*\|[\s:|-]+\|?\s*$/u;

const lowTail = (character) => /^[\uDC00-\uDFFF]$/.test(character ?? "");

// Every line of `text` as [start, end) with its newline kept on the end, so the
// pieces always join back into exactly the text they came from.
function lineSpans(text) {
  const lines = [];
  for (let start = 0; start < text.length;) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline + 1;
    lines.push({ start, end });
    start = end;
  }
  return lines;
}

const lineText = (text, line) => text.slice(line.start, line.end);
const isHeading = (value) => HEADING.test(value.trimStart());
const isBlank = (value) => value.trim() === "";

// A lossless tiling of the document: the chunks join back to the text exactly,
// and each one is text.slice(start, end). Boundaries prefer, in order, the line
// before a heading, a blank line, and any line end; a single line longer than
// CHUNK_MAX is cut on a character boundary rather than left whole.
export function chunkSpans(text) {
  const source = String(text);
  if (!source.length) return [];
  const lines = lineSpans(source), spans = [];
  let start = 0;
  for (let index = 0; index < lines.length;) {
    const line = lines[index], length = line.end - start;
    // A line that would take the chunk past its maximum: close what is already
    // gathered, and if the line alone is that long, cut it on a character.
    if (length > CHUNK_MAX) {
      if (line.start > start) { spans.push({ start, end: line.start }); start = line.start; continue; }
      let end = start + CHUNK_MAX;
      if (lowTail(source[end])) end -= 1;
      spans.push({ start, end });
      start = end;
      continue;
    }
    const next = lines[index + 1];
    const nextValue = next ? lineText(source, next) : "";
    // A heading belongs to what follows it, so close the chunk before it. A
    // blank line is a weaker break, taken only once the chunk is worth keeping.
    const breakBefore = next && length >= CHUNK_MIN && (isHeading(nextValue) || (isBlank(nextValue) && length >= CHUNK_TARGET * 0.6));
    if (length >= CHUNK_TARGET || breakBefore || !next) {
      spans.push({ start, end: line.end });
      start = line.end;
    }
    index += 1;
  }
  if (start < source.length) spans.push({ start, end: source.length });
  return spans;
}

// Character bigrams for Han runs, whole words for Latin and numbers. The same
// crude stand-in graph.js uses, with two differences that matter for search: a
// one-character Han run (一, 3F) still produces a term, and digits stay attached
// to what they qualify (4天, 3万) instead of splitting the run.
export function termCounts(text) {
  const counts = new Map();
  const bump = (term) => counts.set(term, (counts.get(term) ?? 0) + 1);
  for (const run of String(text).toLocaleLowerCase().match(/[\p{Script=Han}]+|[a-z0-9][a-z0-9._%+-]{0,23}/gu) ?? []) {
    if (!/^[\p{Script=Han}]+$/u.test(run)) { bump(run); continue; }
    // Single characters as well as bigrams. A question rarely writes a word the
    // way the document does -- 「想请 4 天假」 never produces the bigram 请假 --
    // and a lone 请 or 假 is weak but real evidence; idf keeps the characters
    // that appear everywhere from mattering.
    for (const character of run) bump(character);
    for (let index = 0; index + 2 <= run.length; index += 1) bump(run.slice(index, index + 2));
  }
  return counts;
}

// The terms a question is actually about. Deduplicated: a word repeated in the
// question says nothing about which passage answers it.
export function queryTerms(query) {
  return [...termCounts(query).keys()].slice(0, MAX_QUERY_TERMS);
}

// Term counts are derived from the text and nothing else, so they are cached
// under the text itself — not under the object holding it, and not under an id
// the caller chose. Object identity would miss on every verification (which
// rebuilds the page) and every restart; a caller-supplied id would be wrong the
// moment two different passages were given the same one. The key is a reference
// to a string that already exists, so this costs no copy.
const CACHE_LIMIT = 400_000;
const chunkTerms = new Map();
const pageTerms = new Map();
const countsFor = (cache, key, text) => {
  const cached = cache.get(key);
  if (cached) return cached;
  const counts = termCounts(text);
  // Bounded, and cleared wholesale rather than evicted one by one: the cost of
  // rebuilding is one tokenisation pass, and a store this large is rare.
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, counts);
  return counts;
};

// Which pages an index was built from, cheaply. Content hashes make it identical
// across a re-read that changed nothing, which is the common case.
export function pagesSignature(pages) {
  // Order-independent: the store re-sorts itself by what was used most recently,
  // so the same set of documents arrives in a different order after every
  // search, and an order-sensitive signature missed the cache every time.
  let sum = 0, xor = 0;
  for (const page of pages) {
    let hash = 0x811c9dc5;
    const mix = (value) => { const text = String(value); for (let i = 0; i < text.length; i += 1) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193); } };
    mix(page.owner ?? page.id ?? "");
    mix(page.title ?? "");
    // A stored page carries a content hash; anything else (a test double, a
    // projection built by hand) is identified by its text, so two different sets
    // of pages can never look like the same index.
    if (page.contentHash) mix(page.contentHash);
    else for (const chunk of page.chunks ?? []) mix(chunk.text ?? "");
    sum = (sum + (hash >>> 0)) >>> 0;
    xor ^= hash;
  }
  return `${pages.length}:${sum}:${xor >>> 0}`;
}
// Least-recently-used, because every search builds two indexes: one over the
// whole store, which is expensive and wanted again next time, and one over the
// handful of documents just re-read, which is cheap and different every time.
// A cache that evicted by insertion order let the cheap ones push out the
// expensive one, and the store was re-indexed on every question.
const indexes = new Map();
const INDEX_CACHE = 8;

// One corpus-wide view of the pages a search may draw from. Document frequency
// is counted over chunks, which is what BM25 scores; building it is one pass
// over cached term maps.
export function buildIndex(pages) {
  const key = pagesSignature(pages ?? []);
  const cached = indexes.get(key);
  if (cached) { indexes.delete(key); indexes.set(key, cached); return cached; }
  const entries = [], frequency = new Map();
  let total = 0;
  for (const page of pages ?? []) {
    if (!page?.chunks?.length) continue;
    const title = countsFor(pageTerms, page.title ?? "", page.title ?? "");
    for (const chunk of page.chunks) {
      const counts = countsFor(chunkTerms, chunk.text, chunk.text);
      let length = 0;
      for (const [term, count] of counts) { length += count; frequency.set(term, (frequency.get(term) ?? 0) + 1); }
      entries.push({ page, chunk, counts, title, length });
      total += length;
    }
  }
  const size = entries.length;
  const index = { entries, frequency, size, average: size ? total / size : 0 };
  if (indexes.size >= INDEX_CACHE) indexes.delete(indexes.keys().next().value);
  indexes.set(key, index);
  return index;
}

const idf = (index, term) => {
  const seen = index.frequency.get(term) ?? 0;
  return Math.log(1 + (index.size - seen + 0.5) / (seen + 0.5));
};

// Choosing which documents are worth a Feishu round-trip does not need every
// chunk of every stored document in memory — at ten thousand documents that is
// a gigabyte of term maps, and it is rebuilt to answer one question. A document
// is picked by its own profile: the terms that distinguish it from the rest of
// this person's store, kept as a bounded list. Chunk-level scoring then runs on
// the handful of documents that come back verified, where it decides which
// passage to quote.
//
// The profile is a projection, not a summary: it is the document's own term
// counts with the undistinctive ones dropped, so a term that appears in half the
// store stops taking up room while a name that appears once still does.
export const PROFILE_TERMS = 800;
// How many documents are tokenised before their profiles are cut and their term
// counts released.
const PROFILE_BATCH = 500;
// Terms are interned: a profile holds ids, not strings, so ten thousand
// documents cost tens of megabytes instead of a gigabyte of Map objects. The
// dictionary only ever holds terms that survived a profile's cut.
const dictionary = new Map();
const words = [];
const intern = (term) => {
  const id = dictionary.get(term);
  if (id !== undefined) return id;
  const next = words.length;
  dictionary.set(term, next);
  words.push(term);
  return next;
};
const profiles = new Map();

const documentText = (page) => page.chunks.map((chunk) => chunk.text).join("");

// One document's profile: the terms that distinguish it, as sorted ids with
// their counts. Cached by content, because verification re-reads documents that
// have not changed, and rebuilding a profile is a full tokenisation.
const profileKey = (page, profileTerms) => (page.contentHash ? `${page.owner}:${page.contentHash}:${profileTerms}` : null);

function profileOf(page, counts, frequency, size, profileTerms) {
  const key = profileKey(page, profileTerms);
  const hit = key && profiles.get(key);
  if (hit) return hit;
  // Keep what distinguishes this document: frequency weighted by how rare the
  // term is across the store. Dropping by raw count would keep 的 and lose the
  // one name that identifies the document.
  const ranked = [...counts].map(([term, count]) => {
    const seen = frequency.get(term) ?? 0;
    return [term, count, count * Math.log(1 + (size - seen + 0.5) / (seen + 0.5))];
  });
  ranked.sort((a, b) => b[2] - a[2] || (a[0] < b[0] ? -1 : 1));
  const kept = ranked.slice(0, profileTerms).map(([term, count]) => [intern(term), count]).sort((a, b) => a[0] - b[0]);
  const ids = new Int32Array(kept.length), tfs = new Int32Array(kept.length);
  let length = 0;
  for (let i = 0; i < kept.length; i += 1) { ids[i] = kept[i][0]; tfs[i] = kept[i][1]; length += kept[i][1]; }
  // Length describes the profile, not the document it was drawn from: scoring
  // truncated counts against the full length would tell BM25 that every
  // document is mostly missing.
  const profile = { ids, tfs, length };
  if (key) {
    if (profiles.size >= CACHE_LIMIT) profiles.clear();
    profiles.set(key, profile);
  }
  return profile;
}

// Profiles are derived from the documents' own text: keeping them across a
// restart is what stops a large store from re-tokenising everything to answer
// its first question. They are still document content -- the terms that
// distinguish one document from the rest -- so whoever persists them owes them
// the same encryption and the same deletion as the pages they came from.
export function profileState(pages, { profileTerms = PROFILE_TERMS } = {}) {
  const kept = [];
  for (const page of pages ?? []) {
    const key = profileKey(page, profileTerms);
    if (key && profiles.has(key)) kept.push(key);
  }
  return kept.sort().join("\n");
}

export function exportProfiles(pages, { profileTerms = PROFILE_TERMS } = {}) {
  const rows = [];
  for (const page of pages ?? []) {
    const key = profileKey(page, profileTerms);
    const profile = key ? profiles.get(key) : null;
    if (!profile) continue;
    // Terms, not ids: ids are this process's interning and mean nothing in the
    // next one.
    const terms = new Array(profile.ids.length);
    for (let index = 0; index < profile.ids.length; index += 1) terms[index] = words[profile.ids[index]];
    rows.push({ owner: page.owner, contentHash: page.contentHash, terms, counts: Array.from(profile.tfs) });
  }
  return rows;
}

// Rows from a previous process. Anything malformed is dropped rather than
// trusted: a profile decides which documents are worth re-reading, and the
// answer is still built from a fresh authorized read of whatever it picks.
export function importProfiles(rows, { profileTerms = PROFILE_TERMS } = {}) {
  let restored = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (typeof row?.owner !== "string" || typeof row?.contentHash !== "string" || !row.owner || !row.contentHash) continue;
    if (!Array.isArray(row.terms) || !Array.isArray(row.counts) || row.terms.length !== row.counts.length) continue;
    if (!row.terms.length || row.terms.length > profileTerms) continue;
    const key = `${row.owner}:${row.contentHash}:${profileTerms}`;
    if (profiles.has(key)) { restored += 1; continue; }
    const pairs = [];
    let usable = true;
    for (let index = 0; index < row.terms.length; index += 1) {
      const term = row.terms[index], count = row.counts[index];
      if (typeof term !== "string" || !term || term.length > 64 || !Number.isSafeInteger(count) || count <= 0) { usable = false; break; }
      pairs.push([intern(term), count]);
    }
    if (!usable) continue;
    // Sorted by id because this process interned them: termAt binary-searches.
    pairs.sort((a, b) => a[0] - b[0]);
    const ids = new Int32Array(pairs.length), tfs = new Int32Array(pairs.length);
    let length = 0;
    for (let index = 0; index < pairs.length; index += 1) { ids[index] = pairs[index][0]; tfs[index] = pairs[index][1]; length += pairs[index][1]; }
    if (profiles.size >= CACHE_LIMIT) profiles.clear();
    profiles.set(key, { ids, tfs, length });
    restored += 1;
  }
  return restored;
}

// Document frequencies -- in how many of this person's documents each term
// appears -- counted over whole documents, together with exactly which documents
// they were counted over.
//
// They used to be recomputed on every build from whatever was at hand: the full
// text of a document not seen before, but only the 800 profile terms of one whose
// profile was cached. So the same store ranked differently depending on whether
// its profiles had been computed in this process or restored from disk -- on
// the evaluation corpus every one of 32 questions got a different top eight after
// a restart, and on a real account the report holding a changed rule stopped
// being chosen at all, so the answer quoted the old one.
let frequencyBase = null;
const memberKey = (page) => `${page.owner}:${page.contentHash}`;
// How many documents may differ from the last counted set before the counts are
// redone from scratch rather than adjusted.
const INCREMENTAL_LIMIT = 64;

export function exportFrequencies() {
  if (!frequencyBase) return null;
  return { members: [...frequencyBase.members.keys()], terms: [...frequencyBase.frequency.entries()] };
}

// Counts written by a previous process. Only used for a build over exactly the
// same documents; anything else is recounted, so a stale or damaged file costs
// time and never correctness.
export function importFrequencies(value) {
  if (!value || !Array.isArray(value.members) || !Array.isArray(value.terms)) return false;
  if (value.members.some((key) => typeof key !== "string" || !key)) return false;
  const frequency = new Map();
  for (const entry of value.terms) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string" || !entry[0] || entry[0].length > 64
      || !Number.isSafeInteger(entry[1]) || entry[1] <= 0 || entry[1] > value.members.length) return false;
    frequency.set(entry[0], entry[1]);
  }
  frequencyBase = { members: new Map(value.members.map((key) => [key, null])), frequency };
  return true;
}

const termAt = (profile, id) => {
  let low = 0, high = profile.ids.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1, value = profile.ids[middle];
    if (value === id) return profile.tfs[middle];
    if (value < id) low = middle + 1; else high = middle - 1;
  }
  return 0;
};

// Choosing which documents are worth a Feishu round-trip does not need every
// chunk of every stored document in memory -- at ten thousand documents that is
// a gigabyte of term maps, rebuilt to answer one question. A document is chosen
// by its own profile; passage-level scoring then runs on the handful that come
// back verified, where it decides which passage to quote.
// Identifiers a question names verbatim -- a contract number, an order code, a
// long account number. Ranking cannot find these in a large table: a ledger of
// three thousand rows holds three thousand codes, a document's profile keeps its
// 800 most distinguishing terms, and the one code asked about is almost never
// among them. Measured: 「合同 QL-HT-2026-2734 的到期日」did not bring a
// 3,000-row ledger into the top eight at all. So an identifier is looked for as
// it is written, in the stored text -- and once the table is read, the passage
// holding it is quoted first (see rankChunks).
const IDENTIFIER = /[A-Za-z0-9]+(?:[-_/][A-Za-z0-9]+)+|[A-Za-z]{1,8}\d{4,}[A-Za-z0-9]*|\d{8,}/gu;
export function questionIdentifiers(query) {
  return [...new Set((String(query ?? "").match(IDENTIFIER) ?? []).filter((value) => /\d/u.test(value) && value.length >= 6))].slice(0, 4);
}
// Names a question mentions -- a person, a department, a project written out --
// that the store holds as a whole table cell. A roster answers to a name: the
// row 「|韩啸|平台研发部|部门经理|」 carries the one word of the question and
// nothing else it says, so ranking never sends it, and a model told who someone
// is in one report takes that for all he is. Measured on 2026-09-21, asked
// whether 韩啸's own request skips a level, the Agent read 「白鹭……负责人韩啸」
// and answered "he is a project lead, not a department head" three times out of
// three, never searching. Semantic search does not reach that row either:
// nothing in it means anything like the question.
//
// There is no list of names to consult and none is needed. A whole cell is what
// a name looks like in a roster; a word the store uses in a handful of
// documents at most is what a name looks like against ordinary words -- 部门、
// 客户、出差 are table cells too, and appear everywhere.
const TABLE_CELL = /^[\u3400-\u9fff]{2,8}$/u;
const cellsFor = new Map();
export function tableCells(pages) {
  const key = pagesSignature(pages ?? []);
  const cached = cellsFor.get(key);
  if (cached) return cached;
  const cells = new Set();
  for (const page of pages ?? []) for (const chunk of page?.chunks ?? []) for (const line of chunk.text.split("\n")) {
    if (!TABLE_ROW.test(line) || TABLE_RULE.test(line)) continue;
    for (const raw of line.split("|").slice(1, -1)) {
      const cell = raw.replace(/^[\s└├─]+/u, "").trim();
      if (TABLE_CELL.test(cell)) cells.add(cell);
    }
  }
  if (cellsFor.size >= INDEX_CACHE) cellsFor.delete(cellsFor.keys().next().value);
  cellsFor.set(key, cells);
  return cells;
}
// How many of `pages` mention `value` anywhere, counting no further than `upTo`.
const holdersOf = (pages, value, upTo) => {
  let held = 0;
  for (const page of pages ?? []) {
    if (!page?.chunks?.some((chunk) => chunk.text.includes(value))) continue;
    held += 1;
    if (held >= upTo) break;
  }
  return held;
};
export function questionCellNames(pages, query, { spread = 3, limit = 3 } = {}) {
  const cells = tableCells(pages), found = new Set();
  for (const run of String(query ?? "").match(/[\u3400-\u9fff]+/gu) ?? []) {
    for (let length = Math.min(8, run.length); length >= 2; length -= 1) {
      for (let at = 0; at + length <= run.length; at += 1) { const part = run.slice(at, at + length); if (cells.has(part)) found.add(part); }
    }
  }
  // The longest reading of a name: 平台研发部, not the 研发部 inside it.
  const whole = [...found].filter((part) => ![...found].some((other) => other !== part && other.includes(part)));
  return whole.filter((part) => holdersOf(pages, part, spread + 1) <= spread)
    .sort((a, b) => b.length - a.length).slice(0, limit);
}
// The table row that names `value` as a cell of its own.
const cellPattern = (value) => new RegExp(`\\|[\\s└├─]*${String(value).replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&")}\\s*\\|`, "u");

// An identifier as a document may write it: 「ql-ht-2026-0198」 typed in lower
// case is still that contract.
const identifierPattern = (value) => new RegExp(String(value).replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&"), "i");
// The stored documents that contain an identifier the question names. One found
// in many documents does not identify anything -- a date is the usual case -- so
// only identifiers held by at most `spread` documents count.
export function pagesContaining(pages, identifiers, { limit = 2, spread = 3 } = {}) {
  if (!identifiers?.length) return [];
  const chosen = [];
  for (const value of identifiers) {
    const pattern = identifierPattern(value), holders = [];
    for (const page of pages ?? []) {
      if (!page.chunks?.some((chunk) => pattern.test(chunk.text))) continue;
      holders.push(page);
      if (holders.length > spread) break;
    }
    if (holders.length > spread) continue;
    for (const page of holders) if (!chosen.includes(page)) chosen.push(page);
  }
  return chosen.slice(0, limit);
}

export function buildDocumentIndex(pages, { profileTerms = PROFILE_TERMS } = {}) {
  const key = `docs:${pagesSignature(pages ?? [])}:${profileTerms}`;
  const cached = indexes.get(key);
  if (cached) { indexes.delete(key); indexes.set(key, cached); return cached; }
  const list = (pages ?? []).filter((page) => page?.chunks?.length);
  const textOf = (page) => `${page.title ?? ""}\n${documentText(page)}`;
  const pending = list.filter((page) => !profiles.has(profileKey(page, profileTerms) ?? ""));
  const built = new Map();
  // Profiles for the pages that have none yet, in batches so that a first build
  // over a large store never holds every document's term counts at once.
  const buildProfiles = (targets, frequency) => {
    for (let at = 0; at < targets.length; at += PROFILE_BATCH) {
      const batch = targets.slice(at, at + PROFILE_BATCH);
      for (const page of batch) built.set(page, profileOf(page, termCounts(textOf(page)), frequency, list.length, profileTerms));
    }
  };
  const base = frequencyBase;
  const members = new Set(list.map(memberKey));
  const added = base ? list.filter((page) => !base.members.has(memberKey(page))) : list;
  const removed = base ? [...base.members].filter(([key]) => !members.has(key)) : [];
  let frequency;
  if (base && !added.length && !removed.length) {
    // The same documents as last time: the same counts.
    frequency = base.frequency;
    buildProfiles(pending, frequency);
  } else if (base && added.length + removed.length <= INCREMENTAL_LIMIT && removed.every(([, page]) => page)) {
    // A few documents came or went: adjust the counts by exactly those.
    frequency = new Map(base.frequency);
    for (const [, page] of removed) {
      for (const term of termCounts(textOf(page)).keys()) {
        const left = (frequency.get(term) ?? 0) - 1;
        if (left > 0) frequency.set(term, left); else frequency.delete(term);
      }
    }
    for (const page of added) for (const term of termCounts(textOf(page)).keys()) frequency.set(term, (frequency.get(term) ?? 0) + 1);
    buildProfiles(pending, frequency);
  } else {
    // Nothing to start from, or too much changed: count every document in full.
    frequency = new Map();
    const pendingSet = new Set(pending);
    for (let at = 0; at < list.length; at += PROFILE_BATCH) {
      const batch = list.slice(at, at + PROFILE_BATCH);
      const counts = batch.map((page) => termCounts(textOf(page)));
      for (const count of counts) for (const term of count.keys()) frequency.set(term, (frequency.get(term) ?? 0) + 1);
      for (let i = 0; i < batch.length; i += 1) if (pendingSet.has(batch[i])) built.set(batch[i], profileOf(batch[i], counts[i], frequency, list.length, profileTerms));
      counts.length = 0;
    }
  }
  frequencyBase = { members: new Map(list.map((page) => [memberKey(page), page])), frequency };
  const entries = [];
  let total = 0;
  for (const page of list) {
    const profile = built.get(page) ?? profileOf(page, null, frequency, list.length, profileTerms);
    entries.push({ page, ...profile });
    total += profile.length;
  }
  const size = entries.length;
  const index = { entries, frequency, size, average: size ? total / size : 0, documents: true };
  if (indexes.size >= INDEX_CACHE) indexes.delete(indexes.keys().next().value);
  indexes.set(key, index);
  return index;
}

// Which documents are worth re-reading, most promising first. Same BM25 and the
// same standing prior as passage-level ranking, so a document another document
// says is repealed still cannot be lifted above one that matched better.
export function rankDocuments(index, query, { prior = null, limit = 20 } = {}) {
  const terms = Array.isArray(query) ? query.slice(0, MAX_QUERY_TERMS) : queryTerms(query);
  if (!terms.length || !index.size) return [];
  const wanted = terms.map((term) => ({ id: dictionary.get(term), weight: idf(index, term) })).filter((item) => item.id !== undefined);
  if (!wanted.length) return [];
  const scored = [];
  for (const entry of index.entries) {
    let score = 0;
    for (const { id, weight } of wanted) {
      const frequency = termAt(entry, id);
      if (frequency) score += weight * frequency * (K1 + 1) / (frequency + K1 * (1 - B + B * entry.length / (index.average || 1)));
    }
    if (score <= 0) continue;
    const standing = prior ? prior(entry.page) : 1;
    scored.push({ page: entry.page, relevance: score, score: score * (Number.isFinite(standing) && standing > 0 ? standing : 1) });
  }
  scored.sort((a, b) => b.score - a.score || (a.page.owner < b.page.owner ? -1 : 1));
  return scored.slice(0, limit);
}

// BM25 over the chunk, plus a bounded contribution for terms in the document
// title. `prior(page)` is the document's standing -- freshness, authority --
// as a multiplier on an otherwise relevance-only score; it can promote a
// document among comparable matches but cannot conjure a match that is not
// there, because it multiplies a score that is zero when nothing matched.
// The words of a question that point at an answer in this particular store: the
// rarest of the ones it actually holds. A word the store does not hold is not
// rare, it is absent, and giving it a place would take one from a name.
function decisiveTerms(index, query, share = DECISIVE_SHARE) {
  const terms = Array.isArray(query) ? query.slice(0, MAX_QUERY_TERMS) : queryTerms(query);
  const present = terms.filter((term) => (index.frequency.get(term) ?? 0) > 0).map((term) => [term, idf(index, term)]);
  return new Map(present.sort((a, b) => b[1] - a[1]).slice(0, Math.max(1, Math.ceil(present.length * share))));
}

// How many passages the identifiers a question names may put ahead of the
// ranking: per identifier, and in all. A contract number repeated through a long
// contract summary must not take the whole excerpt budget.
const NAMED_PER_IDENTIFIER = 2;
const NAMED_TOTAL = 4;

export function rankChunks(index, query, { prior = null, limit = 40, perDocument = 4, coverage = 0, decisiveShare = DECISIVE_SHARE, identifiers = [], cells = [], spread = 3 } = {}) {
  const terms = Array.isArray(query) ? query.slice(0, MAX_QUERY_TERMS) : queryTerms(query);
  if (!terms.length || !index.size) return [];
  const weights = new Map(terms.map((term) => [term, idf(index, term)]));
  // Which words of the question actually point at an answer. A question is
  // mostly common words -- 出差、住宿、报销 -- and BM25 sums over all of them, so a
  // paragraph repeating the common ones outscores the one paragraph carrying
  // 「P6」and「南京」. The rarest terms of this question are kept apart, and a
  // passage is lifted by how many of them it holds.
  // Only words this store actually holds can identify a passage in it. A word
  // that appears nowhere has the highest rarity of all and would otherwise take
  // the places meant for the ones that point somewhere -- which is how "我是下周去"
  // ends up outranking "P6".
  const decisive = decisiveTerms(index, terms, decisiveShare);
  // Counting them equally would let 我/是/下/周 -- rare enough in a small store to
  // make the cut -- stand in for 「P6」and「南京」. What is compared is how much of
  // the question's rarity a passage actually carries.
  let rarity = 0;
  for (const weight of decisive.values()) rarity += weight;
  const scored = [];
  for (const entry of index.entries) {
    let score = 0, found = 0;
    for (const term of terms) {
      const frequency = entry.counts.get(term) ?? 0;
      if (frequency) score += weights.get(term) * frequency * (K1 + 1) / (frequency + K1 * (1 - B + B * entry.length / (index.average || 1)));
      if (entry.title.has(term)) score += TITLE_WEIGHT * weights.get(term);
      if (decisive.has(term) && (frequency || entry.title.has(term))) found += decisive.get(term);
    }
    if (score <= 0) continue;
    if (coverage > 0 && rarity > 0) score *= 1 + coverage * (found / rarity);
    const standing = prior ? prior(entry.page) : 1;
    scored.push({ page: entry.page, chunk: entry.chunk, relevance: score, score: score * (Number.isFinite(standing) && standing > 0 ? standing : 1) });
  }
  // Ties resolve by position in the document, then by the store's own order, so
  // the same corpus and question always produce the same list.
  scored.sort((a, b) => b.score - a.score || a.chunk.start - b.chunk.start);
  // A passage holding an identifier the question names verbatim -- a contract
  // number, an order code -- goes ahead of everything the ranking prefers.
  // Reading the table that holds the code was not enough: its row carries that
  // one word of the question and nothing else, so passages repeating 合同、到期、
  // 状态 filled the excerpt budget and the row was never sent. Measured on a real
  // 121-row ledger: ranked first, verified, and quoted as its first ten rows.
  // An identifier held by passages of more than `spread` documents names
  // nothing in particular -- a date, usually -- and lifts nothing.
  const named = [];
  for (const value of identifiers ?? []) {
    const pattern = identifierPattern(value);
    const holders = scored.filter((hit) => pattern.test(hit.chunk.text));
    if (!holders.length || new Set(holders.map((hit) => hit.page.owner)).size > spread) continue;
    for (const hit of holders.slice(0, NAMED_PER_IDENTIFIER)) if (named.length < NAMED_TOTAL && !named.includes(hit)) named.push(hit);
  }
  // Then the rows that hold each name the question mentions as a cell of its
  // own (questionCellNames): the best one in each document that has one, from
  // at most two documents, within the same four places. One per document,
  // because the same name is a cell in more than one table -- 韩啸 owns items in
  // a project tracker as well as heading a department in the org chart -- and
  // the tracker, which also matches the rest of the question, would otherwise
  // take the place every time.
  for (const value of cells ?? []) {
    const pattern = cellPattern(value), owners = new Set();
    for (const hit of scored) {
      if (owners.size >= 2 || named.length >= NAMED_TOTAL) break;
      if (owners.has(hit.page.owner) || !pattern.test(hit.chunk.text)) continue;
      owners.add(hit.page.owner);
      if (!named.includes(hit)) named.push(hit);
    }
  }
  const perPage = new Map(), picked = [];
  for (const hit of named.length ? [...named, ...scored.filter((item) => !named.includes(item))] : scored) {
    const used = perPage.get(hit.page.owner) ?? 0;
    if (used >= perDocument) continue;
    perPage.set(hit.page.owner, used + 1);
    picked.push(hit);
    if (picked.length >= limit) break;
  }
  return picked;
}

// The passage to quote: the matched chunk, grown to the heading it sits under
// and the table header its rows belong to, then forwards to the end of what it
// was in the middle of. Still an exact slice of the document, so an offset in
// a citation still points at the same characters.
export function excerptSpan(text, span, { maxChars = 1200, backChars = 500 } = {}) {
  const source = String(text);
  const lines = lineSpans(source);
  if (!lines.length) return { start: 0, end: 0, heading: "" };
  let first = lines.findIndex((line) => line.end > span.start);
  if (first < 0) first = lines.length - 1;
  let last = lines.findIndex((line) => line.end >= span.end);
  if (last < 0) last = lines.length - 1;
  let start = lines[first].start, end = lines[last].end, heading = "";
  // Backwards: stop at the heading that introduces this passage (keeping it),
  // at a table header row, or when the budget runs out.
  for (let index = first - 1; index >= 0; index -= 1) {
    const value = lineText(source, lines[index]);
    const room = Math.min(backChars, maxChars - (end - start));
    if (lines[index].end - lines[index].start > room) break;
    if (isBlank(value) && end - start >= CHUNK_MIN) break;
    start = lines[index].start;
    if (isHeading(value)) { heading = value.trim(); break; }
    // The header of the table these rows belong to, and the rule under it.
    if (TABLE_ROW.test(value) && !TABLE_RULE.test(value) && index + 1 < lines.length && TABLE_RULE.test(lineText(source, lines[index + 1]))) break;
  }
  // Forwards: finish the paragraph or the table, never run into the next section.
  for (let index = last + 1; index < lines.length; index += 1) {
    const value = lineText(source, lines[index]);
    if (isHeading(value)) break;
    if (lines[index].end - start > maxChars) break;
    if (isBlank(value) && end - start >= maxChars * 0.6) break;
    end = lines[index].end;
  }
  if (end - start > maxChars) {
    end = start + maxChars;
    if (lowTail(source[end])) end -= 1;
  }
  if (!heading) {
    // Nothing was quoted from above; still name the section this came from.
    for (let index = first; index >= 0; index -= 1) {
      const value = lineText(source, lines[index]);
      if (isHeading(value)) { heading = value.trim(); break; }
    }
  }
  // Rows of a table that starts above the excerpt say nothing without their
  // header, and the header can be far enough up that quoting everything in
  // between would spend the whole budget. It travels with the section label
  // instead, so the excerpt stays an exact slice of the document.
  let header = "";
  const startLine = lines.findIndex((line) => line.start === start);
  if (startLine >= 0 && TABLE_ROW.test(lineText(source, lines[startLine]))) {
    let top = startLine;
    while (top > 0 && TABLE_ROW.test(lineText(source, lines[top - 1]))) top -= 1;
    const first = lineText(source, lines[top]).trim(), rule = lineText(source, lines[top + 1] ?? { start: 0, end: 0 }).trim();
    if (top < startLine && TABLE_ROW.test(first) && TABLE_RULE.test(rule)) header = `${first}\n${rule}`;
  }
  return { start, end, heading: `${heading}${heading && header ? "\n" : ""}${header}`.slice(0, 400) };
}

// What a question is worth sending: the matched passages, grown outwards,
// merged where two matches in one document overlap, and cut off at the budget.
// Overlapping matches are the common case in a long policy -- merging them
// keeps the same rule from being paid for twice.
export function selectExcerpts(hits, { maxChars = 12000, excerptChars = 1200, maxRows = 28, pageText = null } = {}) {
  const texts = new Map();
  const textOf = (page) => {
    if (!texts.has(page)) texts.set(page, pageText ? pageText(page) : page.chunks.map((chunk) => chunk.text).join(""));
    return texts.get(page);
  };
  const perPage = new Map(), rows = [];
  let used = 0;
  for (const hit of hits ?? []) {
    if (rows.length >= maxRows) break;
    const text = textOf(hit.page);
    const span = excerptSpan(text, hit.chunk, { maxChars: excerptChars });
    const existing = (perPage.get(hit.page.owner) ?? []).find((row) => span.start < row.end && span.end > row.start);
    if (existing) {
      const start = Math.min(existing.start, span.start), end = Math.max(existing.end, span.end);
      const growth = (end - start) - (existing.end - existing.start);
      if (growth > 0 && used + growth <= maxChars && end - start <= excerptChars * 2) {
        used += growth;
        Object.assign(existing, { start, end, excerpt: text.slice(start, end) });
      }
      continue;
    }
    const excerpt = text.slice(span.start, span.end);
    if (used + excerpt.length > maxChars) continue;
    used += excerpt.length;
    const row = { page: hit.page, chunk: hit.chunk, score: hit.score, relevance: hit.relevance, start: span.start, end: span.end, heading: span.heading, excerpt };
    rows.push(row);
    perPage.set(hit.page.owner, [...(perPage.get(hit.page.owner) ?? []), row]);
  }
  return rows;
}
