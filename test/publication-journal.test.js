import test from "node:test";
import assert from "node:assert/strict";
import { compactPublications } from "../src/knowledge/publication-journal.js";

// The knowledge publisher's journal (publication-journal.js). Found in the
// long-running review (2026-09-29): every operation stayed, and at up to 200
// source digests each the 2 MiB journal filled after about a hundred
// publications and refused every one after. A shard's publications that a newer
// published one superseded go; nothing that is not published ever does.
test("only a shard's newest published operation is kept, and nothing unpublished is ever let go", () => {
  const row = (id, owner, shardKey, expectedGeneration, state = "published") => ({ id, owner, shardKey, expectedGeneration, state });
  const entries = [
    row("a1", "alice", "s1", 0), row("a2", "alice", "s1", 1), row("a3", "alice", "s1", 2),
    row("a4", "alice", "s1", 3, "dispatching"), row("a5", "alice", "s1", 1, "recorded"),
    row("b1", "bob", "s1", 0), row("a6", "alice", "s2", 0), row("a7", "alice", "s2", 4, "created"),
  ];
  assert.deepEqual(compactPublications(entries).map((entry) => entry.id), ["a3", "a4", "a5", "b1", "a6", "a7"]);
  assert.deepEqual(compactPublications(compactPublications(entries)), compactPublications(entries), "a second pass lets nothing more go");
  assert.deepEqual(compactPublications([]), []);
});
