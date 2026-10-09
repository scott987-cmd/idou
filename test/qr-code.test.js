// The QR codes a site's link is shown as (docs/sites-phase1.md §1.4). Each
// matrix pinned here was read back exactly by macOS's own reader
// (scripts/check-qr-codes.swift, 2026-10-04) -- versions 1 to 10 and all eight
// masks -- so a change to the encoder that would make a code unreadable shows
// up here, without a reader.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { qrMatrix, qrSvg } from "../src/application/qr-code.js";

const digest = (modules) => createHash("sha256").update(modules.map((row) => row.map((dark) => (dark ? 1 : 0)).join("")).join("\n")).digest("hex").slice(0, 24);
const SHORT = "HELLO";
const NAMED = `https://sites.example/s/${encodeURIComponent("销售周报")}/?from=qr`;
const LONG = "https://sites.example/s/6f0d2c1e-0000-4000-8000-0000000000ee/?from=qr".padEnd(130, "y");

test("the codes are the ones a reader read back", () => {
  for (const [text, version, mask, pinned] of [[SHORT, 1, 4, "c346c75add5698735afe3f7e"], [NAMED, 5, 4, "601c0dd8dfedaf51ef5c551d"], [LONG, 8, 6, "056a9f8477f731370110606d"]]) {
    const code = qrMatrix(text);
    assert.deepEqual([code.version, code.mask, code.size, digest(code.modules)], [version, mask, 17 + version * 4, pinned], text.slice(0, 30));
  }
  // Every mask, on a code with version information and alignment patterns on the timing lines.
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map((mask) => digest(qrMatrix(LONG, { mask }).modules)),
    ["63347e657ca2c86ad0190985", "8fd42d6cc2ba705fecdff6bd", "2ca10a3e2a68cd8035e4a4ee", "1597c04cd4e3812043cc0c52",
      "5e843d9d249108cf85a00bab", "2cf77622c9ead1db1891fee6", "056a9f8477f731370110606d", "febda6d0045e568898165f7e"]);
});

test("the finders are where readers look, and what does not fit is said", () => {
  const { modules, size } = qrMatrix(NAMED);
  for (const [top, left] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    const ring = (r, c) => modules[top + r][left + c];
    assert.deepEqual([ring(0, 0), ring(1, 1), ring(3, 3), ring(6, 6)], [true, false, true, true], `finder at ${top},${left}`);
  }
  assert.equal(modules[size - 8][8], true, "the dark module");
  assert.throws(() => qrMatrix("x".repeat(300)), /太长/);
  const svg = qrSvg(NAMED);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 45 45"/, "four modules of quiet zone each side");
  assert.doesNotMatch(svg, /<script|href=/);
});
