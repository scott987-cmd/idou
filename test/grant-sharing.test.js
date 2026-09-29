// What goes with a signed-in session -- its Feishu access and renewal grants --
// kept in the shared store beside it (docs/scaling-plan.md §2.4), so that the
// coordinator restarting signs nobody out. Each "process" here is a session
// registry with its Feishu access and renewal services, on one PostgreSQL.
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import pg from "pg";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { PostgresStateStore } from "../src/control-plane/state-store.js";
import { FeishuSourceAccess } from "../src/control-plane/feishu-source-access.js";
import { SessionRenewal } from "../src/control-plane/session-renewal.js";
import { renewalProofMessage } from "../src/control-plane/login-proof.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";
import { testPostgres } from "./helpers/postgres.js";

const APP = "cli_grant_fixture", ORIGIN = "https://control.example";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function database(t) {
  const server = await testPostgres(t), config = await server.database();
  const key = randomBytes(32), routeKey = randomBytes(32);
  const admin = new pg.Client(config); await admin.connect(); server.closeFirst(() => admin.end());
  // One coordinator process: its sessions, Feishu access and renewal, with
  // the loaders bin/server.js adds.
  const start = async ({ loaders = true } = {}) => {
    const pool = new pg.Pool({ ...config, max: 4 }); pool.on("error", () => {});
    const state = await PostgresStateStore.open({ pool, key, connect: async () => { const client = new pg.Client(config); await client.connect(); return client; } });
    const sessions = new SessionRegistry({ state, routeKey });
    const access = new FeishuSourceAccess({ feishu: SAAS_FEISHU, sessions, appId: APP, state });
    const diagnostics = [];
    const renewal = new SessionRenewal({ sessions, state, transferSource: (token, issued) => access.transfer(token, issued),
      checkIdentity: async () => ({ ...process.identity }), diagnostic: (line) => diagnostics.push(line) });
    if (loaders) { sessions.addLoader((root) => access.load(root.id)); sessions.addLoader((root) => renewal.load(root.id)); }
    let stopped = false;
    const stop = async () => {
      if (stopped) return; stopped = true;
      access.close(); renewal.close(); await access.flush(); await renewal.flush();
      sessions.close(); await sessions.flush(); await state.close(); await pool.end();
    };
    server.closeFirst(stop);
    const process = { sessions, access, renewal, state, stop, identity: null, diagnostics };
    return process;
  };
  return { start, admin };
}

// A sign-in as FeishuLoginService completes one: Feishu access and a renewal
// grant bound to a fresh root session, persisted before the token goes out.
async function signIn(process, userId = "user-1") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const identity = { authProvider: "feishu", appId: APP, tenantId: "tenant_fixture", userId, displayName: userId, expiresAt: Date.now() + 3_600_000 };
  process.identity = identity;
  process.access.remember(identity, `feishu-access-${userId}`);
  process.renewal.remember(identity, `feishu-access-${userId}`);
  const issued = process.sessions.issue({ ...identity, deviceId: `device-${userId}`, deviceProof: "ed25519-login", ttlMs: 110_000 });
  process.access.bind(identity, issued); process.renewal.bind(identity, issued, publicKey);
  await process.sessions.persisted(issued.token);
  assert.equal(await process.access.persisted(issued.id), true);
  assert.equal(await process.renewal.persisted(issued.id), true);
  return { issued, privateKey, identity };
}

test("the coordinator restarts: its sessions come back with their Feishu access and renewal, and renew there", { timeout: 60_000 }, async (t) => {
  const { start, admin } = await database(t);
  const a = await start();
  const { issued, privateKey, identity } = await signIn(a);
  const namespaces = (await admin.query("SELECT namespace, count(*)::int AS n FROM idou_state GROUP BY 1 ORDER BY 1")).rows;
  assert.deepEqual(namespaces, [{ namespace: "renewal-grant", n: 1 }, { namespace: "session", n: 1 }, { namespace: "source-grant", n: 1 }]);
  for (const { value } of (await admin.query("SELECT value FROM idou_state")).rows) {
    assert.equal(value.includes(Buffer.from("feishu-access-user-1")), false, "the Feishu token is sealed");
  }
  await a.stop();
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM idou_state WHERE namespace <> 'session'")).rows[0].n, 2, "stopping took nothing out of the store");

  const b = await start();
  b.identity = identity;
  await b.sessions.ensure(issued.token);
  const who = b.sessions.verify(issued.token);
  assert.equal(who?.id, issued.id, "every service takes it, not just the model gateway");
  assert.equal(b.access.current(issued.token).grant.token.toString(), "feishu-access-user-1");
  assert.equal(b.access.signedIn, 1);
  assert.ok(b.renewal.metadata(who).renewal, "and it can still be renewed");
  // Renewed on the replica that read it (a renewal is only offered in its last two minutes).
  let challenge;
  try { challenge = b.renewal.begin(issued.token); } catch (error) { throw new Error(`${error.message}: ${b.diagnostics.join(" / ")}`); }
  const signature = sign(null, renewalProofMessage(ORIGIN, issued.id, challenge.challengeId, challenge.nonce), privateKey).toString("base64url");
  const next = await b.renewal.renew(ORIGIN, issued.token, { challengeId: challenge.challengeId, signature });
  await b.sessions.persisted(next.token);
  assert.equal(await b.access.persisted(next.id), true); assert.equal(await b.renewal.persisted(next.id), true);
  await b.stop();

  // ...and what the renewal made comes back on the next one.
  const c = await start();
  await c.sessions.ensure(next.token);
  assert.equal(c.sessions.verify(next.token)?.id, next.id);
  assert.equal(c.access.current(next.token).grant.token.toString(), "feishu-access-user-1");
  await c.sessions.ensure(issued.token);
  assert.throws(() => c.renewal.begin(issued.token), /sign in again/, "the grant the renewal spent is spent everywhere");
});

test("a sign-out takes its grants out of the store; a session without them serves the model gateway only", { timeout: 60_000 }, async (t) => {
  const { start, admin } = await database(t);
  const a = await start();
  const { issued } = await signIn(a);
  await a.sessions.revoke(issued.token);
  for (const until = Date.now() + 3000; Date.now() < until; await wait(20)) {
    if ((await admin.query("SELECT count(*)::int AS n FROM idou_state")).rows[0].n === 0) break;
  }
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM idou_state")).rows[0].n, 0, "session and both grants gone");

  // Signed in before grants were kept: the session is in the store, its grants are not.
  const legacy = await signIn(a, "user-2");
  await admin.query("DELETE FROM idou_state WHERE namespace <> 'session'");
  await a.stop();
  const b = await start();
  await b.sessions.ensure(legacy.issued.token);
  assert.equal(b.sessions.verify(legacy.issued.token), null, "answered as unknown, so the desktop signs back in");
  assert.equal(b.sessions.verify(legacy.issued.token, { shared: true })?.id, legacy.issued.id, "while the model still answers");
  assert.throws(() => b.access.current(legacy.issued.token), /feishu_source_access_denied/);
});

test("a replica with nothing else to read takes a session from the store everywhere", { timeout: 60_000 }, async (t) => {
  const { start } = await database(t);
  const a = await start();
  const { issued } = await signIn(a);
  const plain = await start({ loaders: false });
  await plain.sessions.ensure(issued.token);
  assert.equal(plain.sessions.verify(issued.token)?.id, issued.id);
});
