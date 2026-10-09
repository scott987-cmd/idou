// One refresh of a site built on a table: read it again if it may have moved,
// and give the server what it does not have yet.
//
// Reading the same slice again is not a new disclosure: it was confirmed once
// and nothing about what may be shown has changed.
//
// A table of 20,000 rows is 100 pages (docs/sites-phase1.md §1.7), so a
// refresh first asks the table how it stands (table-sites.js `unchanged`) and
// leaves the read as it was when nothing moved. That answer is relied on
// carefully, because a Base says it late: its revision and its records both
// show a write a second or two after it (measured live, docs/feishu-base.md),
// and knowing the revision did not stop the records being read stale. So:
//
//   - it is relied on only once two full reads in a row found the table saying
//     the same of itself -- the second one, at least a refresh interval after a
//     change, reads what the change left;
//   - the table is read in full at least every hour regardless, and a site
//     whose hourly read finds what is shown changed while the table said it had
//     not moved is never skipped again (the tables a link or a formula reads
//     from are asked too, table-snapshot.js probeBaseSlice; this is for what
//     still escapes that);
//   - 重新读取 (`force`) always reads.
import { TABLE_FULL_READ_MS } from "./table-sites.js";
import { contractKey } from "./table-snapshot.js";

// `tables`: TableSites. `store`: SiteStore. `readData(folder)`: the data the
// folder holds (table-contract.js readContract). `push(publishedId, data)`:
// hands it to the server.
export async function refreshTableSite(site, { force = false, now = Date.now, tables, store, readData, push }) {
  if (!site?.slice) throw new Error("这个网站没有接表格，没有可刷新的数据");
  const hourly = now() - (site.fullReadAt ?? 0) >= TABLE_FULL_READ_MS;
  const settled = typeof site.probe === "string" && site.probe === site.probeBefore && site.probeMissed !== true;
  let recorded;
  if (!force && !hourly && settled && await tables.unchanged(site.slice, site.probe)) {
    recorded = await store.recordCheck(site.id, now());
  } else {
    const built = await tables.build(site.folder, site.slice, { title: site.name });
    // Only between two reads by the same reader: one that makes more of the
    // same table (a link named, a date read) is not the table moving.
    const missed = !force && hourly && settled && built.probe === site.probe && typeof site.digest === "string" && built.digest !== site.digest &&
      (site.reader ?? null) === (built.reader ?? null);
    recorded = await store.recordRead(site.id, { ...built, probeBefore: site.probe ?? null, probeMissed: site.probeMissed === true || missed });
  }
  // A published site shows what it was last given, so a refresh here is only
  // half the job until the server has the same numbers. What it was already
  // given -- columns, title and values (contractKey) -- is not sent again,
  // 13 MB at 20,000 rows of eight fields; what did not get there last time is.
  if (site.publishedId && (force || !recorded.key || recorded.key !== site.pushedKey)) {
    const data = await readData(site.folder);
    if (data) {
      await push(site.publishedId, data).catch((error) => { throw new Error(`本机已更新，但推送到线上失败：${error.message}`); });
      await store.recordPushed(site.id, contractKey(data.schema, data.snapshot));
    }
  }
  return recorded;
}
