// Which stored documents are copies of each other.
//
// Measured on the evaluation corpus: a thousand unrelated documents around it
// change nothing — full-evidence coverage stays at 68% and the right document is
// present every time. A few hundred near-duplicates of the same policies take it
// to 11%, with the right document found 14% of the time. Volume is not the
// danger; duplication is. Eight copies of one policy fill the prompt, and no
// ranking can prefer one of them, because the text does not say which copy
// governs.
//
// What this file can honestly do: notice that documents are near-copies, choose
// one to send, and say that the others exist. What it must never do: decide
// which copy is correct and hide the rest. Where a document says in words that
// it replaces another, standing.js reads that and the answer follows it; where
// nothing says anything, this is an ambiguity to report, not to resolve.
import { termCounts, pagesSignature } from "./retrieval.js";

// A bottom-k sketch — the k smallest hashes of a document's terms — estimates
// how much two documents' vocabularies overlap without comparing them directly,
// at one hash per term rather than k. Two copies of a policy with different
// numbers share nearly every term; two unrelated documents in the same company
// share the connective tissue of business Chinese and little else. Measured on
// the 16-document corpus: unrelated pairs sit at 0.31 or below (including the
// 2025 and 2026 travel policies, which are versions of each other but genuinely
// different texts), a copy with changed numbers at 0.91.
export const SKETCH = 64;
// Measured: unrelated documents in the 16-document corpus peak at 0.34 — the
// 2025 and 2026 travel policies included, which are versions of each other but
// genuinely different texts — while a copy with changed numbers sits at 0.98 and
// a copy with an added section at 0.80 or above (a short document moves further
// when a paragraph is added, which is why the threshold is not set at the
// copies' floor). 0.65 keeps a wide margin on both sides.
export const DUPLICATE = 0.65;
// Banding turns "compare everything with everything" into a lookup: documents
// that agree on a whole band are worth comparing, and nothing else is.
const BANDS = 8;
const ROWS = SKETCH / BANDS;
const CACHE_LIMIT = 20_000;
const sketches = new Map();

const hash = (term, seed) => {
  let value = 0x811c9dc5 ^ seed;
  for (let index = 0; index < term.length; index += 1) {
    value ^= term.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
};

// The document's own text, as the sketch sees it: terms only, so formatting and
// ordering do not matter, and numbers are only part of the picture.
export function sketchOf(page) {
  const key = page.contentHash ? `${page.owner}:${page.contentHash}` : null;
  const hit = key && sketches.get(key);
  if (hit) return hit;
  const terms = termCounts(`${page.title ?? ""}\n${page.chunks.map((chunk) => chunk.text).join("")}`);
  const values = [];
  for (const term of terms.keys()) values.push(hash(term, 0));
  values.sort((a, b) => a - b);
  // Distinct values only: a repeated hash would count one term twice.
  const sketch = new Int32Array(Math.min(SKETCH, values.length));
  let taken = 0;
  for (let index = 0; index < values.length && taken < sketch.length; index += 1) {
    if (index && values[index] === values[index - 1]) continue;
    sketch[taken] = values[index] | 0;
    taken += 1;
  }
  const trimmed = taken === sketch.length ? sketch : sketch.slice(0, taken);
  if (key) {
    if (sketches.size >= CACHE_LIMIT) sketches.clear();
    sketches.set(key, trimmed);
  }
  return trimmed;
}

// The bottom-k estimator: over the k smallest hashes of the two sketches
// combined, how many belong to both.
export function similarity(one, two) {
  const size = Math.min(one.length, two.length, SKETCH);
  if (!size) return 0;
  const merged = [...new Set([...one.slice(0, size), ...two.slice(0, size)])].sort((a, b) => a - b).slice(0, size);
  const first = new Set(one.slice(0, size)), second = new Set(two.slice(0, size));
  let shared = 0;
  for (const value of merged) if (first.has(value) && second.has(value)) shared += 1;
  return shared / size;
}

// Bands over the sketch: documents that agree on a whole band are worth
// comparing, and nothing else is.
const band = (sketch, index) => {
  let value = 0x811c9dc5 ^ index;
  for (let row = 0; row < ROWS; row += 1) {
    const at = index * ROWS + row;
    value ^= at < sketch.length ? sketch[at] : 0;
    value = Math.imul(value, 0x01000193);
  }
  return `${index}:${value >>> 0}`;
};

// Which copy of a group is the one to send. Deliberately explainable, and never
// a judgement about which is correct: a copy that failed its last check goes
// last, then one another document says is repealed, then one whose own title says
// it is an archive, then the one that states the later date, then the one this
// person actually opened, then the fuller text.
// Ties break on id so the same store always gives the same answer.
//
// Readability outranks everything because the rest of the group is held back for
// the representative: a copy that cannot be re-read would take the whole group
// out of the answer, while a repealed one still arrives and is labelled.
// A title that says the document is a copy of something else. Measured need: a
// store filled by pasting links or by automatic discovery has no reading to go
// on, and without this the original and its archive are separated only by their
// ids -- a coin flip, which lost the current policy in 7 of 16 cases.
const ARCHIVED = /归档|存档|旧版|历史版本|备份|副本|作废|过期/u;

function representative(pages, standing) {
  const score = (page) => {
    const record = standing?.get(page.owner);
    const retired = record && ["superseded", "self-void"].includes(record.state) ? 1 : 0;
    return [page.staleCount > 0 ? 1 : 0, retired, ARCHIVED.test(page.title ?? "") ? 1 : 0, record?.date?.value ?? "",
      Number.isSafeInteger(page.localReadAt) ? page.localReadAt : 0,
      page.chunks.reduce((total, chunk) => total + chunk.text.length, 0), page.id];
  };
  return [...pages].sort((a, b) => {
    const one = score(a), two = score(b);
    if (one[0] !== two[0]) return one[0] - two[0];
    if (one[1] !== two[1]) return one[1] - two[1];
    if (one[2] !== two[2]) return one[2] - two[2];
    if (one[3] !== two[3]) return one[3] < two[3] ? 1 : -1;
    if (one[4] !== two[4]) return two[4] - one[4];
    if (one[5] !== two[5]) return two[5] - one[5];
    return one[6] < two[6] ? -1 : 1;
  })[0];
}

// Groups of near-copies, keyed by the owner of every page in one. A page with no
// copies is not in the result at all: most stores are mostly unique documents,
// and this has to stay cheap for them.
const cached = new Map();
const GROUP_CACHE = 4;

export function duplicateGroups(pages, standing = null, { threshold = DUPLICATE } = {}) {
  // Same content, same grouping: a search re-reads documents that have usually
  // not changed, and comparing the store with itself for every question would
  // undo the point of doing this at all.
  const key = `${pagesSignature(pages ?? [])}:${threshold}`;
  const hit = cached.get(key);
  if (hit) { cached.delete(key); cached.set(key, hit); return hit; }
  const list = (pages ?? []).filter((page) => page?.chunks?.length);
  const groups = new Map();
  if (list.length < 2) return groups;
  const sketched = list.map((page) => ({ page, sketch: sketchOf(page) }));
  // Candidate pairs from shared bands, so a store of unique documents costs one
  // pass and no comparisons.
  const buckets = new Map();
  for (const entry of sketched) {
    for (let index = 0; index < BANDS; index += 1) {
      const key = band(entry.sketch, index);
      const bucket = buckets.get(key);
      if (bucket) bucket.push(entry); else buckets.set(key, [entry]);
    }
  }
  const parent = new Map(list.map((page) => [page.owner, page.owner]));
  const find = (owner) => { let root = owner; while (parent.get(root) !== root) root = parent.get(root); while (parent.get(owner) !== root) { const next = parent.get(owner); parent.set(owner, root); owner = next; } return root; };
  const union = (a, b) => { const one = find(a), two = find(b); if (one !== two) parent.set(one, two); };
  const compared = new Set();
  for (const bucket of buckets.values()) {
    if (bucket.length < 2 || bucket.length > 200) continue;
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const key = bucket[i].page.owner < bucket[j].page.owner ? `${bucket[i].page.owner}|${bucket[j].page.owner}` : `${bucket[j].page.owner}|${bucket[i].page.owner}`;
        if (compared.has(key)) continue;
        compared.add(key);
        if (similarity(bucket[i].sketch, bucket[j].sketch) >= threshold) union(bucket[i].page.owner, bucket[j].page.owner);
      }
    }
  }
  const members = new Map();
  for (const page of list) {
    const root = find(page.owner);
    const found = members.get(root);
    if (found) found.push(page); else members.set(root, [page]);
  }
  if (cached.size >= GROUP_CACHE) cached.delete(cached.keys().next().value);
  cached.set(key, groups);
  for (const family of members.values()) {
    if (family.length < 2) continue;
    const chosen = representative(family, standing);
    const others = family.filter((page) => page.owner !== chosen.owner)
      .map((page) => ({ id: page.id, title: page.title, sourceUrl: page.sourceUrl }));
    for (const page of family) {
      groups.set(page.owner, { representative: chosen, copies: family.length,
        others: page.owner === chosen.owner ? others : [{ id: chosen.id, title: chosen.title, sourceUrl: chosen.sourceUrl }, ...others.filter((item) => item.id !== page.id)] });
    }
  }
  return groups;
}
