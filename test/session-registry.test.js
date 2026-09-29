import test from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry } from "../src/control-plane/sessions.js";

const login = (sessions, extra = {}) => sessions.issue({
  tenantId: "tenant", userId: "user", appId: "cli_app", deviceId: "device",
  authProvider: "feishu", deviceProof: "ed25519-login", ...extra,
});

test("the lease's model-turn token reaches the model gateway but cannot mint any child token", () => {
  const sessions = new SessionRegistry();
  const root = login(sessions);
  const turn = sessions.issueForModelTurn(root.token);
  // Reaches the model gateway: the model scope, under an audience of its own
  // (2026-09-27). With its root's audience, every route that serves the
  // desktop's own session took it too (test/turn-credential-reach.test.js).
  const identity = sessions.verify(turn.token);
  assert.equal(identity.audience, "model-turn");
  assert.deepEqual([...identity.scopes], ["models:responses"]);
  // But it is a child, so every child-minting path refuses it — this is what
  // stops an agent that reads the lease from bypassing the confirmation card.
  for (const mint of [
    () => sessions.issueForMedia(turn.token, "image"),
    () => sessions.issueForDrive(turn.token),
    () => sessions.issueForMcp(turn.token, { connectionId: "conn", policyDigest: "a".repeat(64), tools: ["tool"] }),
    () => sessions.issueForSkills(turn.token),
    () => sessions.issueForApps(turn.token),
    () => sessions.issueForAppReview(turn.token),
    () => sessions.issueForAppRuntime(turn.token, { appId: "app", version: 1 }),
    () => sessions.issueForWiki(turn.token),
    () => sessions.issueForModelTurn(turn.token),
  ]) assert.throws(mint, /required/, "a turn token must not mint any child");
  // The root still mints (the desktop keeps it in memory and mints from it).
  assert.ok(sessions.issueForMedia(root.token, "image").token);
  assert.ok(sessions.issueForDrive(root.token).token);
});

test("issueForModelTurn needs a live root; a fresh one revokes the previous; revoking the root drops it", () => {
  const sessions = new SessionRegistry();
  assert.throws(() => sessions.issueForModelTurn("x".repeat(43)), /required/);
  const root = login(sessions);
  const first = sessions.issueForModelTurn(root.token);
  const second = sessions.issueForModelTurn(root.token);
  assert.equal(sessions.verify(first.token), null, "one turn credential per root");
  assert.ok(sessions.verify(second.token));
  // The turn credential lives exactly as long as its root.
  sessions.revoke(root.token);
  assert.equal(sessions.verify(second.token), null);
});
