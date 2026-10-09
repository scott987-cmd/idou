import test from "node:test";
import assert from "node:assert/strict";
import { mergeSiteLists, RefreshTrouble, remoteSiteId, REMOTE_SITE } from "../src/application/site-rows.js";

// 文档网站's list (docs/sites-phase0.md §0.5). Found in the 2026-10-03
// benchmark: the list was only this computer's, so a site published from
// another computer -- or moved out of this list while still up -- had nowhere
// to be taken down, shared differently or deleted.
test("the list is this computer's sites and the server's others, each exactly once", () => {
  const local = [
    { id: "a", publishedId: "s1" },
    // A first publish whose answer never came: its kept id is the server's.
    { id: "b", publishedId: null, publishingId: "s2" },
    { id: "c", publishedId: "s3", hidden: true },
    { id: "d", publishedId: null },
  ];
  const remote = [{ id: "s1", name: "看板" }, { id: "s2", name: "游戏" }, { id: "s3", name: "周报" }, { id: "s4", name: "别的电脑上的" }];
  const merged = mergeSiteLists(local, remote);
  assert.deepEqual(merged.here.map((row) => [row.site.id, row.server?.id ?? null]), [["a", "s1"], ["b", null], ["d", null]]);
  assert.deepEqual(merged.hidden.map((row) => [row.site.id, row.server?.id ?? null]), [["c", "s3"]], "hidden here, still up there");
  assert.deepEqual(merged.elsewhere.map((row) => row.id), ["s4"], "only what this computer has no folder for");
});

test("with no answer from the server, the list is what this computer knows", () => {
  const merged = mergeSiteLists([{ id: "a", publishedId: "s1" }, { id: "c", publishedId: "s3", hidden: true }], null);
  assert.deepEqual(merged.here.map((row) => [row.site.id, row.server]), [["a", null]]);
  assert.deepEqual(merged.hidden.map((row) => row.site.id), ["c"]);
  assert.deepEqual(merged.elsewhere, []);
});

test("a site only the server has is named by its id there, and nothing else passes for one", () => {
  const id = "6f0d2c1e-0000-4000-8000-0000000000ee";
  assert.equal(remoteSiteId(id), `remote:${id}`);
  assert.equal(REMOTE_SITE.exec(remoteSiteId(id))[1], id);
  for (const other of ["remote:", "remote:../x", `remote:${id}/x`, id, `remote:${id.toUpperCase()}`]) assert.equal(REMOTE_SITE.test(other), false, other);
});

// A table site whose automatic reading keeps failing (docs/sites-phase0.md
// §0.7): its row says so with the reason, and the person is told once, at the
// third failure in a row -- a page quietly showing old numbers is the failure
// nobody notices. A success ends the streak.
test("refresh trouble is counted per site, told once at the third failure, and ended by a success", () => {
  const trouble = new RefreshTrouble();
  assert.equal(trouble.of("a"), null);
  const tells = (result) => [result.failures, result.tell];
  assert.deepEqual(tells(trouble.failed("a", new Error("飞书返回：没有权限"), 1000)), [1, false]);
  assert.deepEqual(tells(trouble.failed("a", new Error("飞书返回：没有权限"), 2000)), [2, false]);
  assert.deepEqual(tells(trouble.failed("b", new Error("连不上服务端"), 2500)), [1, false], "each site its own");
  assert.deepEqual(tells(trouble.failed("a", new Error("飞书返回：没有权限"), 3000)), [3, true]);
  assert.deepEqual(tells(trouble.failed("a", new Error("飞书返回：没有权限"), 4000)), [4, false], "told once a streak");
  const { retryAt, ...row } = trouble.of("a");
  assert.deepEqual(row, { failures: 4, reason: "飞书返回：没有权限", since: 1000, at: 4000 });
  assert.equal(retryAt, 4000 + 8 * 60_000, "its interval, doubled each time");
  trouble.succeeded("a");
  assert.equal(trouble.of("a"), null);
  assert.equal(trouble.failed("a", new Error("x"), 5000).failures, 1, "a new streak starts over");
  // A reason is one line, and not a page of it.
  trouble.failed("c", new Error(`第一行\n${"很长".repeat(200)}`), 6000);
  assert.ok(trouble.of("c").reason.length <= 160 && !trouble.of("c").reason.includes("\n"));
});

// Found reviewing phase 0 (2026-10-03): a table that kept failing was read
// again every 15 seconds and the whole list redrawn each time, and "three in a
// row" came after 45 seconds even for a site read hourly.
test("a failing table is tried again later each time, up to half an hour", () => {
  const trouble = new RefreshTrouble();
  trouble.failed("a", new Error("x"), 0, 60_000);
  assert.equal(trouble.due("a", 59_999), false);
  assert.equal(trouble.due("a", 60_000), true);
  trouble.failed("a", new Error("x"), 60_000, 60_000);
  assert.equal(trouble.due("a", 60_000 + 119_999), false, "twice the interval");
  for (let at = 0; at < 10; at += 1) trouble.failed("a", new Error("x"), 1_000_000, 60_000);
  assert.equal(trouble.of("a").retryAt, 1_000_000 + 30 * 60_000, "never more than half an hour");
  assert.equal(trouble.due("b", 0), true, "a site with no trouble is due as usual");
});
