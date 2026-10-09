// What a published site holds that should not be on a page for whoever opens
// it (docs/site-content-safety.md): credentials, identity numbers, bank
// cards, phone numbers, e-mail addresses, and the words an organisation names.
//
// Deterministic and local -- nothing leaves the server for this. A finding
// keeps where it is and a masked sample, never the value: the console and the
// audit trail must not become the place those values are collected. Each also
// carries a fingerprint of the value -- an HMAC under a key of the server's,
// which is never stored beside it, because a phone number has few enough
// possible values that a plain hash of one could be tried back -- so that what
// an administrator has looked at and let through is recognised the next time
// without anything being kept that shows it.
//
// The visible text of the pages and the data -- what a person reading the
// site sees -- is returned as well, bounded, for a reviewer that reads words
// (site-moderation.js).
import { createHash, createHmac } from "node:crypto";

export const SCAN_CATEGORIES = Object.freeze({
  secret: "密钥或凭据",
  idcard: "身份证号",
  bankcard: "银行卡号",
  phone: "手机号",
  email: "邮箱地址",
  keyword: "敏感词",
});
export const SCAN_LIMITS = Object.freeze({ findings: 200, keywords: 200, keywordChars: 40, textChars: 40_000, fileBytes: 12 * 1024 * 1024 });
const TEXT_FILE = /\.(?:html?|js|mjs|css|json|txt|md|svg|csv|xml)$/i;

// Credentials as they are written in code and pages. Each is specific enough
// that a match is a credential, not a long word; the two looser shapes must
// also look random -- a spinner's CSS class can start "sk-" and run long, but
// carries no digits.
const random = (text) => (text.match(/[0-9]/g)?.length ?? 0) >= 2 && (text.match(/[A-Za-z]/g)?.length ?? 0) >= 6;
const SECRETS = [
  { pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/g },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g },                                          // an AWS access key
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },                                 // GitHub
  { pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}/g, check: random },           // OpenAI, Anthropic, MiniMax and their kind
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },                                 // Slack
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g }, // a JSON web token
  { pattern: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{24,}=*/g, check: random },          // an Authorization header written out
  { pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"<>]{1,64}:[^\s/@'"<>]{3,64}@[^\s/'"<>]+/g }, // a URL with its password in it
];
const PHONE = /(?<![0-9])(?:(?:\+|00)86[ -]?)?1[3-9][0-9]{9}(?![0-9])/g;
const IDCARD = /(?<![0-9A-Za-z])[1-9][0-9]{5}(?:18|19|20)[0-9]{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])[0-9]{3}[0-9Xx](?![0-9A-Za-z])/g;
// Contiguous, or in groups of four as cards are printed.
const BANKCARD = /(?<![0-9])(?:[0-9]{13,19}|[0-9]{4}(?:[ -][0-9]{4}){2,3}(?:[ -][0-9]{1,3})?)(?![0-9])/g;
const EMAIL = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}/g;
// "logo@2x.png" is a picture for sharp screens, not an address.
const FILE_ENDING = /\.(?:png|jpe?g|gif|svg|webp|avif|ico|bmp|css|js|mjs|json|html?|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|pdf|txt|md)$/i;

// GB 11643: the eighteenth character is a checksum of the seventeen before it.
export function validIdCard(value) {
  const id = String(value).toUpperCase();
  if (!/^[0-9]{17}[0-9X]$/.test(id)) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const sum = weights.reduce((total, weight, index) => total + weight * Number(id[index]), 0);
  return "10X98765432"[sum % 11] === id[17];
}
export function luhn(digits) {
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
  }
  return sum % 10 === 0;
}
// Issued card numbers, not any long number that happens to pass Luhn: UnionPay
// (62), Visa (4), Mastercard (51-55, 2221-2720), American Express (34, 37), JCB (35).
const CARD_PREFIX = /^(?:62|4|5[1-5]|2(?:2[2-9][1-9]|[3-6][0-9]{2}|7[01][0-9]|720)|3[47]|35)/;
const validCard = (digits) => digits.length >= 13 && digits.length <= 19 && CARD_PREFIX.test(digits) && luhn(digits);

export function mask(category, value) {
  const text = String(value);
  if (category === "phone") { const digits = text.replace(/[^0-9]/g, "").slice(-11); return `${digits.slice(0, 3)}****${digits.slice(-4)}`; }
  if (category === "idcard") return `${text.slice(0, 3)}${"*".repeat(Math.max(0, text.length - 7))}${text.slice(-4)}`;
  if (category === "bankcard") { const digits = text.replace(/[^0-9]/g, ""); return `**** ${digits.slice(-4)}（${digits.length} 位）`; }
  if (category === "email") { const [local, domain] = text.split("@"); return `${local.slice(0, 1)}***@${domain}`; }
  if (category === "secret") return `${text.slice(0, 4)}…（${text.length} 个字符）`;
  return text;
}

const fingerprint = (key, category, value) => createHmac("sha256", key || "unkeyed").update(`${category}\n${String(value).replace(/[\s-]/g, "").toLowerCase()}`).digest("hex").slice(0, 32);

// The words an organisation names: trimmed, deduplicated, bounded.
export function cleanKeywords(list) {
  const words = [...new Set((Array.isArray(list) ? list : []).map((word) => String(word ?? "").trim()).filter(Boolean))];
  if (words.length > SCAN_LIMITS.keywords) throw new Error(`敏感词最多 ${SCAN_LIMITS.keywords} 个`);
  for (const word of words) if ([...word].length > SCAN_LIMITS.keywordChars) throw new Error(`敏感词每个最多 ${SCAN_LIMITS.keywordChars} 个字`);
  return words;
}

// One piece of text and where it is. `where` is said in the words the console
// shows: "index.html 第 12 行", "数据第 3 行 · 联系电话".
// `from`: "file" or "data" -- where it was found, for what reads findings; `where`
// is only the words a person reads (a file may be called 数据.html).
function scanText(text, where, { keywords, key, findings, counts }, from) {
  const add = (category, value, at) => {
    counts[category] = (counts[category] ?? 0) + 1;
    if (findings.length < SCAN_LIMITS.findings) findings.push({ category, where: where(at), from, sample: category === "keyword" ? value : mask(category, value), fingerprint: fingerprint(key, category, value) });
  };
  const taken = [];   // spans already reported, so one value is not two findings
  const free = (start, end) => !taken.some(([a, b]) => start < b && end > a);
  for (const { pattern, check } of SECRETS) {
    for (const match of text.matchAll(pattern)) {
      // One credential is one finding: "Bearer eyJ…" is the token already found inside it.
      if ((check && !check(match[0])) || !free(match.index, match.index + match[0].length)) continue;
      taken.push([match.index, match.index + match[0].length]); add("secret", match[0], match.index);
    }
  }
  for (const match of text.matchAll(IDCARD)) if (validIdCard(match[0]) && free(match.index, match.index + 18)) { taken.push([match.index, match.index + 18]); add("idcard", match[0], match.index); }
  for (const match of text.matchAll(BANKCARD)) {
    const digits = match[0].replace(/[ -]/g, "");
    if (validCard(digits) && free(match.index, match.index + match[0].length)) { taken.push([match.index, match.index + match[0].length]); add("bankcard", match[0], match.index); }
  }
  for (const match of text.matchAll(PHONE)) if (free(match.index, match.index + match[0].length)) add("phone", match[0], match.index);
  for (const match of text.matchAll(EMAIL)) if (!FILE_ENDING.test(match[0]) && free(match.index, match.index + match[0].length)) add("email", match[0], match.index);
  if (keywords.length) {
    const lower = text.toLowerCase();
    for (const word of keywords) {
      for (let at = lower.indexOf(word.toLowerCase()); at !== -1; at = lower.indexOf(word.toLowerCase(), at + word.length)) add("keyword", word, at);
    }
  }
}

const lineOf = (text, at) => { let line = 1; for (let index = text.indexOf("\n"); index !== -1 && index < at; index = text.indexOf("\n", index + 1)) line += 1; return line; };
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
// What a reader of the page sees of it: no scripts, no styles, no tags.
export function visibleText(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, name) => name[0] === "#"
      ? String.fromCodePoint(name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1))) : ENTITIES[name.toLowerCase()] ?? whole)
    .replace(/\s+/g, " ").trim();
}

// The strings in a cell, whatever its kind: its value, how it reads, its items.
function cellStrings(cell, out = []) {
  if (cell === null || cell === undefined) return out;
  if (typeof cell === "string") out.push(cell);
  else if (typeof cell === "number" && Number.isFinite(cell)) out.push(String(cell));
  else if (Array.isArray(cell)) for (const item of cell) cellStrings(item, out);
  else if (typeof cell === "object") for (const [key, value] of Object.entries(cell)) if (key !== "kind" && key !== "style") cellStrings(value, out);
  return out;
}

// A site: `files` [{ path, bytes }] of one version, `data` its table data
// ({ schema, snapshot }) or null. `key`: the server's, for fingerprints.
export function scanSite(site = {}) {
  const run = scanning(site);
  for (;;) { const step = run.next(); if (step.done) return step.value; }
}

// The same, giving the rest of the server a turn every few hundred rows: the
// 20,000 rows a site may hold since docs/sites-phase1.md §1.7 take most of a
// second to scan, and in one piece that second stopped every sign-in, model
// call and page this process answers.
const ROWS_PER_TURN = 500;
export async function scanSiteInTurns(site = {}) {
  const run = scanning(site);
  for (;;) {
    const step = run.next();
    if (step.done) return step.value;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function* scanning({ files = [], data = null, keywords = [], key = "" } = {}) {
  const findings = [], counts = {}, state = { keywords, key, findings, counts };
  const texts = [];
  let scanned = 0;
  for (const file of files) {
    if (!TEXT_FILE.test(file.path)) continue;
    const bytes = Buffer.isBuffer(file.bytes) ? file.bytes : Buffer.from(file.bytes ?? "");
    scanned += bytes.length;
    if (scanned > SCAN_LIMITS.fileBytes) break;
    const text = bytes.toString("utf8");
    scanText(text, (at) => `${file.path} 第 ${lineOf(text, at)} 行`, state, "file");
    if (/\.html?$/i.test(file.path)) texts.push(visibleText(text));
    else if (/\.(?:txt|md)$/i.test(file.path)) texts.push(text);
  }
  const fields = new Map((data?.schema?.fields ?? []).map((field) => [String(field.id), String(field.name ?? field.id)]));
  const rows = Array.isArray(data?.snapshot?.rows) ? data.snapshot.rows : [];
  for (const [index, row] of rows.entries()) {
    if (index && index % ROWS_PER_TURN === 0) yield;
    for (const [id, cell] of Object.entries(row?.values ?? {})) {
      const strings = cellStrings(cell);
      if (!strings.length) continue;
      const text = [...new Set(strings)].join(" ");
      scanText(text, () => `数据第 ${index + 1} 行 · ${fields.get(id) ?? id}`, state, "data");
      texts.push(text);
    }
  }
  const joined = texts.filter(Boolean).join("\n");
  return { findings, counts, total: Object.values(counts).reduce((sum, n) => sum + n, 0),
    text: joined.slice(0, SCAN_LIMITS.textChars), truncated: joined.length > SCAN_LIMITS.textChars,
    textDigest: createHash("sha256").update(joined).digest("hex").slice(0, 32) };
}

// Text an administrator reads to judge a page, with every value this module
// finds replaced by its masked form: the words around it stay, the value does
// not. Bounded.
export function maskedText(text, limit = 3000) {
  let out = String(text ?? "").slice(0, limit * 2);
  for (const { pattern, check } of SECRETS) out = out.replace(pattern, (value) => (check && !check(value) ? value : mask("secret", value)));
  out = out.replace(IDCARD, (value) => (validIdCard(value) ? mask("idcard", value) : value));
  out = out.replace(BANKCARD, (value) => (validCard(value.replace(/[ -]/g, "")) ? mask("bankcard", value) : value));
  out = out.replace(PHONE, (value) => mask("phone", value));
  out = out.replace(EMAIL, (value) => (FILE_ENDING.test(value) ? value : mask("email", value)));
  return out.slice(0, limit);
}

// "1 处身份证号、2 处手机号", for a person: the gravest first, always in the
// same order, whatever order they were found in.
export function countsText(counts) {
  return Object.keys(SCAN_CATEGORIES).filter((category) => counts?.[category] > 0).map((category) => `${counts[category]} 处${SCAN_CATEGORIES[category]}`).join("、");
}
