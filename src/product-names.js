// i豆 (idou) was called 我的豆包 (MyDouBao) until September 2026, and names
// that leave a program were spelled `mydoubao`: file names in a person's
// Feishu Drive, refs in their repositories, labels on containers, the headers
// and paths one program sends another. Whatever reads such a name accepts both
// spellings, for what was written before and for a program not yet updated.
// Whatever writes one wrote the old spelling until every reader accepted both
// (0.1.0-20260929.257), and the new one since.
//
// Labels that are part of a sealed or signed format (`mydoubao-feishu-login-v1`
// and the like) are not names in this sense and never change: see
// test/product-names.test.js.
export const SPELLINGS = Object.freeze(["idou", "mydoubao"]);
export const WRITTEN = "idou";
// For a regular expression: either spelling, and nothing else.
export const EITHER = "(?:idou|mydoubao)";

// One of our own headers, `x-<spelling>-<suffix>`, under whichever spelling was
// sent. Sent under both, the two have to say the same thing: a request that
// says two things is refused rather than read one way here and the other way
// by whatever it is passed on to.
export function ownHeader(headers, suffix) {
  const values = SPELLINGS.map((name) => headers?.[`x-${name}-${suffix}`]).filter((value) => value !== undefined);
  if (values.some((value) => value !== values[0])) throw new ConflictingHeader(suffix);
  return values[0];
}
export const ownHeaderName = (suffix) => `x-${WRITTEN}-${suffix}`;

export class ConflictingHeader extends Error {
  constructor(suffix) { super(`x-*-${suffix} was sent twice with different values`); this.name = "ConflictingHeader"; }
}

// One of our files in a person's Drive: `<spelling>-<id>.<kind>`, written under
// WRITTEN. Found again, it may carry either spelling -- one written before the
// rename keeps its name -- and nothing else about it may differ.
export const ownFileName = (rest) => `${WRITTEN}-${rest}`;
const OWN_FILE = /^(?:idou|mydoubao)-(.+)$/s;
export function sameFileName(actual, expected) {
  if (actual === expected) return typeof actual === "string";
  const found = OWN_FILE.exec(actual ?? ""), wanted = OWN_FILE.exec(expected ?? "");
  return Boolean(found && wanted && found[1] === wanted[1]);
}
