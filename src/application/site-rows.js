// The list in 文档网站 (docs/sites-phase0.md §0.5): this computer's sites, and
// the ones the server keeps for this person that this computer has no folder
// for -- published from another computer, or moved out of this list while up.
// Until 2026-10-03 the list was only this computer's, and a site published
// elsewhere had nowhere to be taken down, shared differently or deleted.

// A site only the server has is named by its id there.
export const REMOTE_SITE = /^remote:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
export const remoteSiteId = (serverId) => `remote:${serverId}`;

// `local`: the sites this computer keeps (site-store.js); `remote`: the
// server's rows for this person, or null when it could not be asked -- then
// the list is what this computer knows, as it last knew it.
// A local site matches its server row by the id it was published under, or by
// the id kept for a first publish whose answer never came.
export function mergeSiteLists(local, remote) {
  const server = new Map((remote ?? []).map((row) => [row.id, row]));
  const known = new Set(local.flatMap((site) => [site.publishedId, site.publishingId]).filter(Boolean));
  const paired = (site) => ({ site, server: (site.publishedId && server.get(site.publishedId)) || null });
  return {
    here: local.filter((site) => site.hidden !== true).map(paired),
    hidden: local.filter((site) => site.hidden === true).map(paired),
    elsewhere: (remote ?? []).filter((row) => !known.has(row.id)),
  };
}

// A table site whose automatic reading keeps failing (docs/sites-phase0.md
// §0.7), kept while the application is open: said on its row with the reason,
// and told once, at the third failure in a row. A success ends the streak.
// Tried again later each time -- its interval, then twice that, up to half an
// hour: a failure is not a reason to read the table every 15 seconds and
// redraw the list each time (review of phase 0, 2026-10-03).
export const REFRESH_BACKOFF_MAX_MS = 30 * 60_000;
export class RefreshTrouble {
  #sites = new Map();
  failed(id, error, now = Date.now(), intervalMs = 60_000) {
    const before = this.#sites.get(id);
    const reason = String(error?.message ?? error ?? "").replace(/\s+/g, " ").trim().slice(0, 160) || "原因不明";
    const failures = (before?.failures ?? 0) + 1;
    const retryAt = now + Math.min(REFRESH_BACKOFF_MAX_MS, intervalMs * 2 ** (failures - 1));
    this.#sites.set(id, { failures, reason, since: before?.since ?? now, at: now, retryAt });
    return { failures, tell: failures === 3, first: failures === 1 };
  }
  // Whether it is time to try this one again.
  due(id, now = Date.now()) { return (this.#sites.get(id)?.retryAt ?? 0) <= now; }
  succeeded(id) { this.#sites.delete(id); }
  of(id) { const row = this.#sites.get(id); return row ? { ...row } : null; }
}
