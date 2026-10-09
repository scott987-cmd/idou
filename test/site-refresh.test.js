import test from "node:test";
import assert from "node:assert/strict";
import { refreshTableSite } from "../src/application/site-refresh.js";
import { TABLE_FULL_READ_MS } from "../src/application/table-sites.js";
import { contractKey } from "../src/application/table-snapshot.js";

// What one refresh of a table site does (docs/sites-phase1.md §1.7): asks the
// table first, reads it again only if it moved -- or it has not yet said the
// same twice, or an hour has passed, or the person asked -- and sends the
// server only what it does not have.
const slice = { kind: "base", token: "bascnABCDEFGHIJ", tableId: "tblOne", fields: ["fldA"], rows: 20_000, refreshSeconds: 60 };
const NOW = 10 * TABLE_FULL_READ_MS;

// A table that says `probe` of itself and reads as `digest` under `schema`
// (its columns, the site's title), and a store that keeps what it is told.
const SCHEMA = { fields: [{ id: "fldA", name: "客户" }], source: { title: "看板" } };
const keyOf = (digest, schema = SCHEMA) => contractKey(schema, { digest });
function harness(site, { probe = "7:20000", digest = "d1", pushFails = false } = {}) {
  const did = [];
  let held = { ...site };
  const table = { probe, digest, schema: SCHEMA };
  // What the site's folder holds: what the last read wrote.
  let folder = { schema: SCHEMA, snapshot: { digest: site.digest } };
  const store = {
    recordCheck: async (id, at) => { did.push(["check"]); held = { ...held, lastReadAt: at }; return { ...held }; },
    recordRead: async (id, read) => { did.push(["read"]); held = { ...held, digest: read.digest, key: read.key, probe: read.probe, probeBefore: read.probeBefore, probeMissed: read.probeMissed, reader: read.reader ?? null, fullReadAt: read.readAt, lastReadAt: read.readAt }; return { ...held }; },
    recordPushed: async (id, value) => { did.push(["pushed", value]); held = { ...held, pushedKey: value }; },
  };
  const tables = {
    unchanged: async (asked, stored) => { did.push(["probe"]); return stored === table.probe; },
    build: async () => { did.push(["build"]); folder = { schema: table.schema, snapshot: { digest: table.digest } }; return { digest: table.digest, key: contractKey(table.schema, { digest: table.digest }), probe: table.probe, readAt: clock.at }; },
  };
  const clock = { at: NOW };
  const refresh = (extra = {}) => refreshTableSite(held, { now: () => clock.at, tables, store, readData: async () => folder,
    push: async (publishedId, data) => { did.push(["push", data.snapshot.digest]); if (pushFails) throw new Error("服务端没答复"); }, ...extra });
  return { did, table, clock, refresh, pushFails: (value) => { pushFails = value; }, get held() { return held; } };
}
const steps = (did) => did.map(([what]) => what);

// Read in full twice, a minute ago, with the table saying the same both times; the server has it.
const settled = { id: "s1", folder: "/sites/s1", name: "看板", slice, publishedId: "p1",
  probe: "7:20000", probeBefore: "7:20000", fullReadAt: NOW - 60_000, digest: "d1", key: keyOf("d1"), pushedKey: keyOf("d1") };

test("a table that has not moved is neither read nor sent", async () => {
  const h = harness(settled);
  await h.refresh();
  assert.deepEqual(steps(h.did), ["probe", "check"]);
});

test("a table that moved is read, and sent once it reads differently", async () => {
  const h = harness(settled, { probe: "8:20000", digest: "d2" });
  await h.refresh();
  assert.deepEqual(h.did, [["probe"], ["build"], ["read"], ["push", "d2"], ["pushed", keyOf("d2")]]);
  // Moved, but not in anything shown -- a field outside the slice: read, not sent.
  const same = harness(settled, { probe: "8:20000", digest: "d1" });
  await same.refresh();
  assert.deepEqual(steps(same.did), ["probe", "build", "read"]);
});

test("after a change it is read once more before it is trusted: Feishu's revision can be ahead of its records", async () => {
  // The read just after a write: the revision had moved, the records not yet.
  const h = harness(settled, { probe: "8:20000", digest: "d1" });
  await h.refresh();
  assert.deepEqual([h.held.probe, h.held.probeBefore], ["8:20000", "7:20000"]);
  // A minute later the records have caught up. The table says what it said, and is read anyway.
  h.table.digest = "d2"; h.clock.at += 60_000; h.did.length = 0;
  await h.refresh();
  assert.deepEqual(steps(h.did), ["build", "read", "push", "pushed"], "not settled: read, not asked");
  assert.equal(h.held.digest, "d2", "what the write left");
  assert.equal(h.held.probeMissed, false, "not a miss: it was waiting to be read again");
  // Said the same twice now: trusted.
  h.clock.at += 60_000; h.did.length = 0;
  await h.refresh();
  assert.deepEqual(steps(h.did), ["probe", "check"]);
  // Read before there were probes (an older build): read in full, twice.
  const older = harness({ ...settled, probe: undefined, probeBefore: undefined });
  await older.refresh();
  assert.equal(older.did[0][0], "build");
});

test("at least every hour it is read in full; a table whose shown values moved without saying so is never skipped again", async () => {
  const stale = { ...settled, fullReadAt: NOW - TABLE_FULL_READ_MS };
  const quiet = harness(stale);
  await quiet.refresh();
  assert.deepEqual(steps(quiet.did), ["build", "read"], "not asked: read; nothing new, nothing sent");
  assert.equal(quiet.held.probeMissed, false);
  // A formula moved what is shown; the revision and the row count did not.
  const h = harness(stale, { digest: "d2" });
  await h.refresh();
  assert.equal(h.held.probeMissed, true);
  h.clock.at += 60_000; h.did.length = 0;
  await h.refresh();
  assert.equal(h.did[0][0], "build", "a probe that missed a change is not relied on again");
  h.clock.at += 60_000; h.did.length = 0;
  await h.refresh();
  assert.equal(h.did[0][0], "build");
  // The revision moved too: the probe saw it, and stays trusted.
  const seen = harness(stale, { probe: "9:20000", digest: "d2" });
  await seen.refresh();
  assert.equal(seen.held.probeMissed, false);
});

test("a column renamed in Feishu, or the site renamed here, is sent though no value moved", async () => {
  // Renaming a field moves the table's revision (measured on a real Base, 2026-10-04).
  const h = harness(settled, { probe: "8:20000", digest: "d1" });
  h.table.schema = { ...SCHEMA, fields: [{ id: "fldA", name: "客户名称" }] };
  await h.refresh();
  assert.deepEqual(h.did, [["probe"], ["build"], ["read"], ["push", "d1"], ["pushed", keyOf("d1", h.table.schema)]]);
  // Read before this was kept (an older build): sent once.
  const older = harness({ ...settled, key: undefined, pushedKey: undefined }, { probe: "8:20000" });
  await older.refresh();
  assert.deepEqual(steps(older.did), ["probe", "build", "read", "push", "pushed"]);
});

test("重新读取 reads and sends, whatever the table and the server already have", async () => {
  const h = harness(settled);
  await h.refresh({ force: true });
  assert.deepEqual(steps(h.did), ["build", "read", "push", "pushed"]);
});

test("data that did not reach the server is sent at the next refresh, even if the table has not moved", async () => {
  const h = harness(settled, { probe: "8:20000", digest: "d2", pushFails: true });
  await assert.rejects(() => h.refresh(), /本机已更新，但推送到线上失败：服务端没答复/);
  assert.equal(h.held.pushedKey, keyOf("d1"), "not remembered as sent");
  h.pushFails(false); h.clock.at += 60_000; h.did.length = 0;
  await h.refresh();
  assert.deepEqual(h.did.slice(-2), [["push", "d2"], ["pushed", keyOf("d2")]]);
});

test("an unpublished site is refreshed here and sent nowhere", async () => {
  const h = harness({ ...settled, publishedId: null }, { probe: "8:20000", digest: "d2" });
  await h.refresh();
  assert.deepEqual(steps(h.did), ["probe", "build", "read"]);
  await assert.rejects(() => refreshTableSite({ ...settled, slice: null }, {}), /没有接表格/);
});

// A site published by a build whose reader left something out -- every date
// of a real Base, until 10-06 (table-snapshot.js contractKey) -- holds a key
// this build no longer makes. Its table has not moved, so the hourly read is
// the first to look: it sends the site what it lacks, once, and the site is
// not taken for one whose table moves without saying so.
test("a site sent its data by an earlier reader gets this reader's at the hourly read, once", async () => {
  const earlier = { ...settled, fullReadAt: NOW - TABLE_FULL_READ_MS, key: "earlier-reader", pushedKey: "earlier-reader" };
  const h = harness(earlier);
  await h.refresh();
  assert.deepEqual(h.did, [["build"], ["read"], ["push", "d1"], ["pushed", keyOf("d1")]]);
  assert.equal(h.held.probeMissed, false, "the table said it had not moved, and it had not");
  h.clock.at += 60_000; h.did.length = 0;
  await h.refresh();
  assert.deepEqual(steps(h.did), ["probe", "check"], "and from then on, as before");
});

// A reader that makes more of the same table -- a link named, a time kept, a
// column in its place (table-snapshot.js READER) -- changes what the hourly
// read finds while the table said it had not moved. That is not the table
// moving unannounced, and the site is not to be read in full ever after for it.
test("what a newer reader makes of an unmoved table is not taken for the table moving", async () => {
  const earlier = { ...settled, fullReadAt: NOW - TABLE_FULL_READ_MS, reader: 1 };
  const h = harness(earlier, { digest: "d2" });
  const build = h.refresh;
  await build({ tables: { unchanged: async () => true, build: async () => ({ digest: "d2", key: keyOf("d2"), probe: "7:20000", readAt: NOW, reader: 2 }) } });
  assert.equal(h.held.probeMissed, false, "read by another reader");
  assert.equal(h.held.reader, 2);
  // The same reader, an hour later, finding it changed: that is a miss.
  const later = harness({ ...earlier, reader: 2, digest: "d2" }, { digest: "d3" });
  await later.refresh({ tables: { unchanged: async () => true, build: async () => ({ digest: "d3", key: keyOf("d3"), probe: "7:20000", readAt: NOW, reader: 2 }) } });
  assert.equal(later.held.probeMissed, true);
});
