// What this server holds about one person, and letting it go when they leave
// the organisation (bin/forget-person.js, docs/server-administration.md).
//
// Found in the long-running review (2026-09-29): nothing could take a person's
// data off the server. When somebody left, their tasks were suspended once
// Feishu refused to renew, and everything else -- the tasks themselves, every
// run, the unattended authorization, their model choice, the sites they
// published -- stayed for good.
//
// What goes, as the operator decided on 2026-09-30:
//   their scheduled tasks and every run of theirs (those of tasks already
//   deleted too), the unattended authorization, their model choice, and the
//   Drive ledger's rows for them (what they uploaded is theirs in Drive, which
//   Feishu handles when an account is removed);
// what is taken offline but kept:
//   the sites they published -- a colleague may depend on one; the link stops
//   working at once, and the files stay for an administrator to decide about;
// what stays:
//   the usage counts, which are the organisation's accounting.
import { ownerWantsUp } from "./site-registry.js";
import path from "node:path";
import { dataHome } from "../install-names.js";

// Where the file-backed stores live unless a setting moves them: the same
// places bin/server.js opens, taken from here by both so the two cannot drift.
export function storePlaces(env = process.env, home = dataHome()) {
  return Object.freeze({
    scheduledTasks: env.IDOU_SCHEDULED_TASKS_DIR || path.join(home, "scheduled-tasks"),
    modelPreferences: path.join(home, "model-preferences.json"),
    sites: (configured) => configured || path.join(home, "sites"),
  });
}

const ledgerIdentity = (who) => ({ authProvider: "feishu", tenantId: who.tenantId, appId: who.appId, userId: who.userId });
// A ledger with no policy for this tenant holds nothing of theirs.
const ofLedger = async (ledger, who, work) => {
  if (!ledger || !who.appId) return null;
  try { ledger.policy(ledgerIdentity(who)); } catch { return null; }
  return work(ledgerIdentity(who));
};

// What there is, read only. `who`: { tenantId, userId, appId }.
// Which of a departing person's sites offboarding takes down: those whose owner
// wants them up -- up now, or waiting for review or held, which an approval or
// a release would otherwise put back up. One they already took down is left.
// Read from the record itself (site-registry.js ownerWantsUp); the preview
// counts by the same rule (fifth and sixth review before .270).
export const goesOffline = (sites, site) => ownerWantsUp(sites.get?.(site.id) ?? site);

export async function personInventory({ who, schedules = null, credentials = null, preferences = null, sites = null, ledger = null }) {
  const credential = credentials ? await credentials.read(who.tenantId, who.userId) : null;
  return {
    tasks: schedules ? await schedules.ownerData(who.tenantId, who.userId) : null,
    credential: credential ? { state: credential.state, expiresAt: credential.expiresAt ?? null } : null,
    model: preferences ? preferences.get(who) : null,
    sites: sites ? sites.list({ ownerId: who.userId, tenantId: who.tenantId }).map((site) => ({ id: site.id, name: site.name, offline: site.offline === true, withdrawn: goesOffline(sites, site) })) : [],
    reservations: await ofLedger(ledger, who, (identity) => ledger.ownerRows(identity)),
  };
}

// And all of it let go, as above. Run with the coordinator stopped: it keeps
// the sites and the model choices in memory and writes them back whole.
export async function forgetPerson({ who, schedules = null, credentials = null, preferences = null, sites = null, ledger = null }) {
  const done = { tasks: null, credential: false, model: false, reservations: null, sitesOffline: [] };
  if (schedules) done.tasks = await schedules.forgetOwner(who.tenantId, who.userId);
  if (credentials) done.credential = await credentials.remove(who.tenantId, who.userId);
  if (preferences && preferences.get(who) !== null) { await preferences.set(who, null); done.model = true; }
  done.reservations = await ofLedger(ledger, who, (identity) => ledger.forgetOwner(identity));
  if (sites) {
    // A publish of theirs that passed its checks before they were disabled may
    // still be on its way into the records: let it land, then take it down too.
    // One that comes after is refused when it is written (site-service.js).
    await sites.settled?.();
    for (const site of sites.list({ ownerId: who.userId, tenantId: who.tenantId })) {
      if (!goesOffline(sites, site)) continue;
      await sites.withdraw(site.id, { ownerId: who.userId });
      done.sitesOffline.push({ id: site.id, name: site.name });
    }
  }
  return done;
}

// The same, while the server runs (the administration console, admin-api.js):
// the person has already been disabled, so no new run or session of theirs can
// start. Their runs in flight are stopped, the unattended authorization is
// revoked through the consent that caches its token, every session of theirs
// ends on every replica, and then the inventory is let go through the same
// live objects that hold it -- the site registry and the model choices are in
// memory, and going around them is why the command line needs the coordinator
// stopped. Pages still open on their sites are closed.
export async function offboardLive({ who, scheduled = null, sessions, preferences = null, sites = null, ledger = null, siteServer = null }) {
  if (!sessions?.revokePerson) throw new Error("离职清理需要会话注册表");
  if (scheduled) {
    for (const row of await Promise.resolve(scheduled.store.list(who, { mine: true })).catch(() => [])) {
      if (row.owner === who.userId) scheduled.scheduler?.cancel?.(who.tenantId, row.id);
    }
  }
  const revoked = scheduled?.unattended ? await scheduled.unattended.revoke(who).catch(() => false) : false;
  const ended = await sessions.revokePerson(who.tenantId, who.userId);
  const done = await forgetPerson({ who, schedules: scheduled?.store ?? null, credentials: scheduled?.unattended?.store ?? null, preferences, sites, ledger });
  for (const site of done.sitesOffline) siteServer?.forgetSite?.(site.id);
  return { ...done, credential: revoked === true || done.credential === true, sessions: ended };
}

