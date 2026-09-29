import test from "node:test";
import assert from "node:assert/strict";
import { byteRange } from "../src/apps/byte-range.js";

// The pieces a video player asks for (RFC 9110 §14): one range, answered in part;
// past the end, unsatisfiable; anything else, the whole file.
test("a single byte range is read the way a player means it", () => {
  assert.deepEqual(byteRange("bytes=0-1", 64), { start: 0, end: 1 }, "Safari's first question");
  assert.deepEqual(byteRange("bytes=10-", 64), { start: 10, end: 63 });
  assert.deepEqual(byteRange("bytes=-4", 64), { start: 60, end: 63 }, "the last four bytes");
  assert.deepEqual(byteRange("bytes=-100", 64), { start: 0, end: 63 }, "more than there is is all of it");
  assert.deepEqual(byteRange("bytes=60-100", 64), { start: 60, end: 63 }, "an end past the file stops at it");
  assert.deepEqual(byteRange(" Bytes = 2 - 3 ", 64), { start: 2, end: 3 });
});

test("past the end cannot be served, and anything else gets the whole file", () => {
  assert.equal(byteRange("bytes=64-", 64), "unsatisfiable");
  assert.equal(byteRange("bytes=64-70", 64), "unsatisfiable");
  assert.equal(byteRange("bytes=0-", 0), "unsatisfiable", "an empty file has no bytes to give");
  for (const header of [undefined, "", "bytes=", "bytes=-", "bytes=5-2", "bytes=0-1,4-5", "items=0-1", "bytes=a-b", "bytes=-0"]) {
    assert.equal(byteRange(header, 64), null, String(header));
  }
});
