// Links in an answer, checked against the documents that answer was given.
//
// A model copying a Feishu address into its reply sometimes gets it slightly
// wrong -- measured in two live rounds: the tenant's subdomain lost its last
// three letters once, and a 27-character document token came back with one
// character changed the next time. The link then opens nothing, or the wrong thing, while
// the answer around it is right. The documents that were actually sent with the
// question are recorded on it, so a link that is *nearly* one of them can be
// pointed at the real address.
//
// The rule is deliberately narrow, because redirecting a link to a different
// legitimate document would be worse than leaving it broken: the kind of
// document must match, the host must be the same or a few characters off, and
// the token must be identical or within two characters of exactly one source,
// with every other source far away. Anything else is left exactly as written.
// Pure functions, no DOM: the renderer applies them, the tests call them.

const KINDS = /^\/(docx|doc|wiki|sheets|base|file|mindnotes|slides)\/([A-Za-z0-9]{8,64})\/?$/u;
const NEAR_TOKEN = 2;
const FAR_TOKEN = 5;
const NEAR_HOST = 3;

function parts(href) {
  try {
    const url = new URL(String(href ?? ""));
    if (url.protocol !== "https:") return null;
    const match = KINDS.exec(url.pathname);
    return match ? { host: url.hostname.toLowerCase(), kind: match[1], token: match[2] } : null;
  } catch { return null; }
}

// Levenshtein distance, stopping as soon as it cannot come in under `limit`.
function distance(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, current[j]);
    }
    if (best > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length];
}

// The recorded source this link was meant to be, if it can be told for certain.
// Returns { source, corrected } -- corrected is false for an exact address.
export function matchSource(href, sources) {
  const link = parts(href);
  if (!link) return null;
  const candidates = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    const known = parts(source?.sourceUrl);
    if (!known || known.kind !== link.kind) continue;
    const hostOff = known.host === link.host ? 0 : distance(known.host, link.host, NEAR_HOST);
    const tokenOff = known.token === link.token ? 0 : distance(known.token, link.token, FAR_TOKEN);
    candidates.push({ source, hostOff, tokenOff });
  }
  const exact = candidates.find((item) => item.hostOff === 0 && item.tokenOff === 0);
  if (exact) return { source: exact.source, corrected: false };
  const near = candidates.filter((item) => item.hostOff <= NEAR_HOST && item.tokenOff <= NEAR_TOKEN);
  if (near.length !== 1) return null;
  // Another source almost as close means the typo could have been either.
  if (candidates.some((item) => item !== near[0] && item.tokenOff < FAR_TOKEN)) return null;
  return { source: near[0].source, corrected: true };
}

// Which recorded sources an answer points at through an address it wrote, even
// a slightly wrong one.
const ADDRESS = /https:\/\/[^\s<>()（）[\]「」"'`]+/gu;
export function citedByLink(text, sources) {
  const cited = new Set();
  for (const match of String(text ?? "").matchAll(ADDRESS)) {
    const found = matchSource(match[0].replace(/[。，；、.,;:]+$/u, ""), sources);
    if (found) cited.add(found.source.sourceUrl);
  }
  return cited;
}
