// What the components of the control plane report, turned into lines of the
// administration console's audit trail (audit-log.js, docs/admin-console.md §6).
//
// Every component already writes its events to stderr, with identifiers
// hashed: that stream goes to whoever collects the operator's logs, and it
// stays as it is. Beside it, where the component knows who acted, it hands
// that over separately (`context`), and only this file reads it -- so the
// console can say "张三 deleted a document" while the log line still says
// "somebody". What is carried over is who, what kind of action, which object,
// and how it ended. Never a prompt, a message, a document's text, a token.
const clip = (value, max) => String(value ?? "").slice(0, max);
const person = (who) => ({ kind: "person", id: clip(who?.userId, 128), name: clip(who?.displayName ?? who?.name, 64) });

// The Agent's writes to Feishu, through the CLI proxy (feishu-cli-proxy.js).
// One line per write that reached Feishu or was refused before it could.
const CLI_ACTIONS = (action) => action === "cli.delete" ? "feishu.delete"
  : String(action).startsWith("message.") ? "feishu.send"
    : String(action).startsWith("drive.") ? "feishu.upload" : "feishu.write";
export function cliWriteTrail(event, context) {
  const who = context?.who;
  if (!who?.tenantId || !["upstream_finished", "grant_rejected", "outcome_unknown"].includes(event?.kind)) return null;
  const outcome = event.kind === "grant_rejected" ? "refused"
    : event.kind === "outcome_unknown" ? "failed" : Number(event.status) >= 200 && Number(event.status) < 300 ? "ok" : "failed";
  return { category: "feishu", action: CLI_ACTIONS(event.action), outcome, tenant: who.tenantId, source: "feishu-cli", at: event.at,
    actor: person(who), target: { kind: clip(String(event.action).split(".")[0], 32), id: clip(context.resource, 256), name: "" },
    detail: { kind: clip(event.action, 40), ...(event.status ? { status: Number(event.status) } : {}), ...(event.reason ? { reason: clip(event.reason, 80) } : {}) } };
}

// Published sites (site-service.js): publishing, sharing, taking down.
// A version refused by the content checks, or sent to wait for an
// administrator (site-safety.js), is a line of its own.
const SITE_ACTIONS = Object.freeze({ "site-published": "site.publish", "site-share-changed": "site.share", "site-withdrawn": "site.withdraw",
  "site-erased": "site.erase", "site-republished": "site.republish", "site-rolled-back": "site.rollback", "site-address-changed": "site.address",
  "site-refused": "site.refused", "site-review": "site.review" });
export function siteTrail(event, context) {
  const action = SITE_ACTIONS[event?.event], who = context?.who;
  if (!action || !who?.tenantId) return null;
  return { category: "site", action, outcome: event.event === "site-refused" ? "refused" : "ok", tenant: who.tenantId, source: "sites", actor: person(who),
    target: { kind: "site", id: clip(event.siteId, 64), name: clip(context.name, 128) },
    detail: { ...(event.scope ? { scope: event.scope } : {}), ...(event.version ? { version: event.version } : {}), ...(event.trigger ? { trigger: clip(event.trigger, 16) } : {}) } };
}

// Enterprise skills from a skill publisher's desktop (skill-catalog.js):
// submitted for review, put up straight away, taken down.
const SKILL_ACTIONS = Object.freeze({ "skill-submitted": "skill.submit", "skill-published": "skill.publish", "skill-unpublished": "skill.unpublish" });
export function skillTrail(event, context) {
  const action = SKILL_ACTIONS[event?.event], who = context?.who;
  if (!action || !who?.tenantId) return null;
  return { category: "skill", action, outcome: "ok", tenant: who.tenantId, source: "skills", actor: person(who),
    target: { kind: "skill", id: clip(event.skillId, 128), name: clip(context.name, 160) },
    detail: { ...(event.version ? { version: clip(event.version, 32) } : {}), ...(event.digest ? { digest: clip(event.digest, 16) } : {}) } };
}

// Pictures and videos (media-service.js): one line when a paid job is started.
export function mediaTrail(event, context) {
  const who = context?.who;
  if (event?.event !== "media-submitted" || !who?.tenantId) return null;
  return { category: "media", action: event.kind === "video" ? "media.video" : event.kind === "speech" ? "media.speech" : "media.image", outcome: "ok",
    tenant: who.tenantId, source: "media", actor: person(who), target: { kind: "media-job", id: clip(event.job, 64), name: "" }, detail: { model: clip(event.model, 64) } };
}

// The schedule service's own changes (schedule-service.js), by the person.
const SCHEDULE_ROUTES = Object.freeze({ create: "schedule.create", update: "schedule.update", remove: "schedule.delete", runNow: "schedule.run-now",
  state: "schedule.state", unattendedRevoke: "schedule.unattended.revoke", revoke: "schedule.consent.revoke" });
export function scheduleTrail(event, context) {
  const action = SCHEDULE_ROUTES[event?.route], who = context?.who;
  if (!action || !who?.tenantId) return null;
  return { category: "schedule", action, outcome: "ok", tenant: who.tenantId, source: "schedules", actor: person(who),
    target: event.scheduleId ? { kind: "schedule", id: clip(event.scheduleId, 64), name: clip(event.title, 60) } : {},
    detail: { ...(event.state ? { state: clip(event.state, 20) } : {}) } };
}

// A scheduled run as it ended (scheduler.js), done for its owner while
// nobody was there. Who, which task, how it ended -- never what it produced.
export function runTrail(event) {
  const whose = event?.whose;
  if (!whose?.tenant || !["completed", "failed", "suspended", "skipped"].includes(event.kind)) return null;
  return { category: "schedule", action: "schedule.run", outcome: event.kind === "completed" ? "ok" : event.kind === "failed" ? "failed" : "refused",
    tenant: whose.tenant, source: "scheduler", actor: { kind: "agent", id: clip(whose.owner, 128), name: "" },
    target: { kind: "schedule", id: clip(whose.id, 64), name: clip(whose.title, 60) },
    detail: { result: event.kind, ...(event.undelivered ? { undelivered: Number(event.undelivered) } : {}), ...(event.reason ? { reason: clip(event.reason, 120) } : {}) } };
}

// Unattended authorizations (unattended-consent.js).
const UNATTENDED = Object.freeze({ unattended_consent_granted: "schedule.unattended.grant", unattended_consent_revoked: "schedule.unattended.revoke" });
export function unattendedTrail(event, context) {
  const action = UNATTENDED[event?.kind];
  if (!action || !context?.tenantId) return null;
  return { category: "schedule", action, outcome: "ok", tenant: context.tenantId, source: "schedules", at: event.at,
    actor: { kind: "person", id: clip(context.userId, 128), name: "" }, target: {},
    detail: { ...(event.expiresAt ? { until: new Date(event.expiresAt).toISOString().slice(0, 10) } : {}) } };
}
