import test from "node:test";
import assert from "node:assert/strict";
import { ScheduleConsent } from "../src/control-plane/schedule-consent.js";

const ME = { id: "s1", tenantId: "tenant-a", userId: "person-a", authProvider: "feishu", expiresAt: 2_000_000_000_000 };
const COLLEAGUE = { id: "s2", tenantId: "tenant-a", userId: "person-b", authProvider: "feishu", expiresAt: 2_000_000_000_000 };

// A registry whose sessions can be revoked and rotated, the way the real one is.
function sessions(initial = { me: ME, colleague: COLLEAGUE }) {
  const live = new Map(Object.entries(initial));
  return { live, verify: (token) => live.get(token) ?? null,
    revoke: (token) => live.delete(token),
    rotate: (token, next) => live.set(token, next) };
}

test("a person hands over an identity for their unattended runs, and can take it back", () => {
  const registry = sessions();
  const consent = new ScheduleConsent({ sessions: registry });
  assert.equal(consent.live("tenant-a", "person-a"), null, "nothing is authorized until it is");

  const granted = consent.grant("me");
  assert.equal(granted.expiresAt, ME.expiresAt, "it cannot outlive the login it came from");
  assert.equal(consent.live("tenant-a", "person-a").token, "me");
  assert.deepEqual(consent.status(ME), { authorized: true, expiresAt: ME.expiresAt });

  assert.equal(consent.revoke(ME), true);
  assert.equal(consent.live("tenant-a", "person-a"), null, "and it stops being usable at once");
  assert.equal(consent.revoke(ME), false, "revoking twice changes nothing");
});

test("a revoked or expired login stops an unattended run at the next turn", () => {
  // Checked on every read rather than trusted from when it was granted: waiting
  // for a restart would let a signed-out person's schedules keep acting as them.
  const registry = sessions();
  const consent = new ScheduleConsent({ sessions: registry });
  consent.grant("me");
  registry.revoke("me");
  assert.equal(consent.live("tenant-a", "person-a"), null);
  assert.equal(consent.granted.size, 0, "and the dead entry is dropped rather than kept");
});

test("a rotated session is a different session, and the old consent does not carry over", () => {
  const registry = sessions();
  const consent = new ScheduleConsent({ sessions: registry });
  consent.grant("me");
  // The registry rotates a token by issuing a new session id for the same person.
  registry.rotate("me", { ...ME, id: "s1-rotated" });
  assert.equal(consent.live("tenant-a", "person-a"), null, "the desktop has to re-grant, which it does while open");
});

test("only a real, primary Feishu login can authorize", () => {
  const registry = sessions({ me: ME, dev: { ...ME, authProvider: "development" }, derived: { ...ME, parentKey: "abc" } });
  const consent = new ScheduleConsent({ sessions: registry });
  assert.throws(() => consent.grant("nobody"), /有效的登录/);
  assert.throws(() => consent.grant("dev"), /飞书登录/);
  // A derived token cannot mint others, so authorizing with one would create a
  // scheduled identity weaker than the schedule needs -- refused rather than
  // half-working.
  assert.throws(() => consent.grant("derived"), /主登录/);
});

test("one identity per person, and one person's consent is not another's", () => {
  const registry = sessions();
  const consent = new ScheduleConsent({ sessions: registry });
  consent.grant("me");
  consent.grant("colleague");
  assert.equal(consent.live("tenant-a", "person-a").token, "me");
  assert.equal(consent.live("tenant-a", "person-b").token, "colleague");
  assert.equal(consent.revoke(ME), true);
  assert.equal(consent.live("tenant-a", "person-b").token, "colleague", "revoking mine leaves theirs alone");
});

test("what the audit records is that consent happened, never the token", () => {
  const seen = [];
  const registry = sessions();
  const consent = new ScheduleConsent({ sessions: registry, audit: (entry) => seen.push(entry) });
  consent.grant("me");
  consent.revoke(ME);
  assert.deepEqual(seen.map((entry) => entry.kind), ["schedule_consent_granted", "schedule_consent_revoked"]);
  const text = JSON.stringify(seen);
  assert.equal(text.includes("\"me\""), false, "the token is not in the audit");
  assert.equal(text.includes("person-a"), false, "and neither is the raw identifier");
  assert.match(seen[0].userHash, /^[a-f0-9]{64}$/);
});

test("pruning drops what is no longer live without touching what is", () => {
  const registry = sessions();
  const consent = new ScheduleConsent({ sessions: registry });
  consent.grant("me");
  consent.grant("colleague");
  registry.revoke("colleague");
  consent.prune();
  assert.equal(consent.granted.size, 1);
  assert.equal(consent.live("tenant-a", "person-a").token, "me");
});
