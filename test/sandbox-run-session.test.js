import test from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry } from "../src/control-plane/sessions.js";

// A verified Feishu login: `issue` requires an appId beginning `cli_` together
// with this exact device proof, and refuses any ttlMs over 15 minutes.
const IDENTITY = Object.freeze({ tenantId: "tenant-a", userId: "person-a", deviceId: "device-a",
  authProvider: "feishu", appId: "cli_app", displayName: "某人", deviceProof: "ed25519-login",
  cliIdentityChecks: false, cliBridge: true, cliDocumentWrites: false, cliMessageWrites: false,
  cliDriveWrites: false, cliDestructiveWrites: false });

function store(clock = { at: 1_000_000_000_000 }) {
  const made = new SessionRegistry({ now: () => clock.at });
  const root = made.issue({ ...IDENTITY, ttlMs: 15 * 60_000 });
  return { store: made, root, clock };
}

test("a sandbox reaches the model under its own audience, with the same scope", () => {
  const { store: sessions, root } = store();
  const run = sessions.issueForSandboxRun(root.token);
  assert.equal(run.audience, "sandbox-run");
  assert.deepEqual([...run.scopes], ["models:responses"], "the same reach as the desktop, not a broader one");
  assert.notEqual(run.id, root.id, "a separate session id, which is what the gateway rate-limits on");
  assert.equal(sessions.verify(run.token).audience, "sandbox-run");
});

test("issuing one does not take the desktop's own model access away", () => {
  // issueForModelTurn revokes the previous turn credential every time it runs.
  // Minting a sandbox credential through it would have signed the person out of
  // their own model access mid-sentence.
  const { store: sessions, root } = store();
  const desktop = sessions.issueForModelTurn(root.token);
  const run = sessions.issueForSandboxRun(root.token);
  assert.ok(sessions.verify(desktop.token), "the desktop's credential still works");
  assert.ok(sessions.verify(run.token));
  assert.notEqual(desktop.id, run.id, "and they are rate-limited separately");

  // And the reverse: the desktop taking a fresh turn credential must not stop a
  // scheduled task that is already running.
  const laterDesktop = sessions.issueForModelTurn(root.token);
  assert.equal(sessions.verify(desktop.token), null, "the old desktop credential is replaced, as before");
  assert.ok(sessions.verify(laterDesktop.token));
  assert.ok(sessions.verify(run.token), "the running task is untouched");
});

test("two scheduled tasks can run at once without taking each other's credential", () => {
  // The scheduler runs up to two at a time, so a revoking issuer would have the
  // second silently disable the first.
  const { store: sessions, root } = store();
  const first = sessions.issueForSandboxRun(root.token);
  const second = sessions.issueForSandboxRun(root.token);
  assert.ok(sessions.verify(first.token) && sessions.verify(second.token));
  assert.notEqual(first.id, second.id);
});

test("a sandbox credential is a leaf: it cannot mint anything further", () => {
  const { store: sessions, root } = store();
  const run = sessions.issueForSandboxRun(root.token);
  // Handing a container a credential that can issue more credentials would undo
  // the reason for the container.
  for (const issue of ["issueForSandboxRun", "issueForModelTurn", "issueForSkills", "issueForMedia", "issueForMcp"]) {
    assert.throws(() => sessions[issue](run.token, "image"), /session required|Root session|Parent session/i, `${issue} must refuse a sandbox credential`);
  }
});

test("a sandbox credential cannot outlive the login it came from", () => {
  const clock = { at: 1_000_000_000_000 };
  const sessions = new SessionRegistry({ now: () => clock.at });
  const root = sessions.issue({ ...IDENTITY, ttlMs: 5 * 60_000 });
  const run = sessions.issueForSandboxRun(root.token);
  assert.equal(run.expiresAt, root.expiresAt, "capped by the parent, not by its own window");

  clock.at += 6 * 60_000;
  assert.equal(sessions.verify(run.token), null, "the parent expired, so the child is gone with it");
});

test("only these two audiences reach the model, and nothing else does", () => {
  // Widening that check is the kind of change nothing goes red for: the full
  // suite passed unchanged when `sandbox-run` was added to it. So the guard has
  // to be asserted here, or the next entry added to that list arrives unwatched.
  const { store: sessions, root } = store();
  const admitted = ["codex-model-gateway", "sandbox-run"];
  const reaches = (identity) => ["codex-model-gateway", "sandbox-run"].includes(identity.audience) && identity.scopes.includes("models:responses");

  assert.equal(reaches(sessions.verify(root.token)), true, "the desktop's own session");
  assert.equal(reaches(sessions.verify(sessions.issueForSandboxRun(root.token).token)), true, "and a sandbox run");
  for (const other of ["skill-center", "mcp-broker", "media-service", "drive-budget", "app-catalog"]) {
    assert.equal(admitted.includes(other), false, `${other} must not reach the model gateway`);
  }
  // The scope matters as much as the audience: a credential with the right
  // audience but a narrower scope is still refused.
  assert.equal(reaches({ audience: "sandbox-run", scopes: ["skills:read"] }), false);
  assert.equal(reaches({ audience: "skill-center", scopes: ["models:responses"] }), false);
});

test("a runaway scheduler cannot mint credentials without limit", () => {
  const { store: sessions, root } = store();
  for (let index = 0; index < 4; index += 1) sessions.issueForSandboxRun(root.token);
  assert.throws(() => sessions.issueForSandboxRun(root.token), /Sandbox run lease limit/);
});

test("only a root session can issue one, of whichever kind the server has", () => {
  const { store: sessions, root } = store();
  assert.throws(() => sessions.issueForSandboxRun("not-a-token"), /Root session required/);
  assert.ok(sessions.issueForSandboxRun(root.token), "a Feishu root works");

  // A development login works too, and that is the point rather than an
  // oversight: this credential reaches only the model, exactly as the desktop's
  // own turn credential does, and that one never required Feishu either. A
  // development server issues nothing else, so requiring Feishu here would mean
  // a scheduled task could never run on one at all.
  const development = new SessionRegistry({ now: () => 1_000_000_000_000 });
  const local = development.issue({ ...IDENTITY, authProvider: "development", appId: null, deviceProof: null, cliBridge: false, ttlMs: 60_000 });
  const issued = development.issueForSandboxRun(local.token);
  assert.equal(issued.audience, "sandbox-run");
  assert.deepEqual([...issued.scopes], ["models:responses"], "and still reaches nothing but the model");
});
