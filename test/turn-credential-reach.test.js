// The coding agent's turn credential reaches the model gateway and nothing else.
//
// The desktop writes it into the agent's lease file, which the agent can read.
// Until 2026-09-27 it carried its root's audience, and the routes that serve
// the desktop's own session took it: an agent (prompt-injected, in standard
// mode, with the network on) could publish, share or erase sites, create and
// delete schedules, or -- for a skill administrator -- publish a skill to the
// whole tenant, with none of the cards the desktop shows for those.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { readdir, readFile } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { MemoryStateStore } from "../src/control-plane/state-store.js";
import { MODEL_TURN, SessionRegistry } from "../src/control-plane/sessions.js";
import { SiteService } from "../src/control-plane/site-service.js";
import { ScheduleService } from "../src/control-plane/schedule-service.js";
import { EnterpriseSkillCatalog } from "../src/control-plane/skill-catalog.js";
import { ModelChoiceService, ModelPreferences } from "../src/control-plane/model-choice.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";

const PERSON = { tenantId: "tenant_a", userId: "ou_person", deviceId: "device", authProvider: "feishu", appId: "cli_test", deviceProof: "ed25519-login" };

async function serve(t, handler) {
  const server = createServer(async (req, res) => { if (!await handler(req, res)) { res.writeHead(404); res.end(); } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.close(); server.closeAllConnections?.(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return (route, token, body = {}) => fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
}

test("the turn credential is its own kind of session: a child of the login, with an audience of its own", () => {
  const sessions = new SessionRegistry();
  const root = sessions.issue(PERSON);
  const turn = sessions.issueForModelTurn(root.token);
  const seen = sessions.verify(turn.token);
  assert.equal(seen.audience, MODEL_TURN);
  assert.ok(seen.parentKey, "derived from the login");
  assert.deepEqual(seen.scopes, ["models:responses"], "the model, and nothing more");
  assert.throws(() => sessions.issueForModelTurn(turn.token), /Root session required/, "and it mints nothing");
});

test("what the turn credential is for still works: the model gateway answers it", async (t) => {
  const sessions = new SessionRegistry();
  const root = sessions.issue(PERSON), turn = sessions.issueForModelTurn(root.token);
  const server = createModelGateway({ apiKey: "provider-secret-fixture", sessions,
    fetchImpl: async () => new Response(JSON.stringify({ output_text: "fixture reply" }), { headers: { "content-type": "application/json" } }) });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.close(); server.closeAllConnections(); });
  const answer = await fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${turn.token}` }, body: JSON.stringify({ model: "MiniMax-M3", input: "fixture" }) });
  assert.equal(answer.status, 200);
  assert.equal((await answer.json()).output_text, "fixture reply");
});

test("a turn credential written before it had its own audience is read as a turn credential", async () => {
  const state = new MemoryStateStore();
  const writer = new SessionRegistry({ state });
  const root = writer.issue(PERSON), turn = writer.issueForModelTurn(root.token);
  await writer.flush();
  // As a build from before 2026-09-27 wrote it: the root's audience.
  const [stored] = (await state.list("session")).filter((row) => row.value.id === writer.verify(turn.token).id);
  await state.put("session", stored.key, { ...stored.value, audience: "codex-model-gateway" }, { parent: stored.parent ?? null, owner: stored.owner ?? null });
  const reader = new SessionRegistry({ state });
  await reader.ensure(turn.token);
  assert.equal(reader.verify(turn.token, { shared: true })?.audience, MODEL_TURN);
  await Promise.all([writer.flush(), reader.flush()]); writer.close(); reader.close();
});

test("the routes that do what the desktop shows a card for refuse the turn credential, and take the login", async (t) => {
  const sessions = new SessionRegistry();
  const root = sessions.issue(PERSON), turn = sessions.issueForModelTurn(root.token);
  const refused = async (call, routes, label) => {
    for (const route of routes) {
      const withTurn = await call(route, turn.token);
      assert.ok([401, 403].includes(withTurn.status), `${label} ${route}: the turn credential is refused (${withTurn.status} ${await withTurn.text()})`);
      const withRoot = await call(route, root.token);
      assert.ok(![401, 403].includes(withRoot.status), `${label} ${route}: the login itself is let through (${withRoot.status})`);
    }
  };

  const registry = { list: () => [], get: () => null };
  const sites = new SiteService({ sessions, registry, origin: "https://sites.example", notify: () => {}, audit: () => {} });
  await refused(await serve(t, (req, res) => sites.handle(req, res)), ["/v1/sites/list", "/v1/sites/publish", "/v1/sites/share", "/v1/sites/erase", "/v1/sites/data"], "sites");

  const store = { list: () => [], latestRuns: () => new Map(), limits: { perUser: 50 }, get: () => null, recentRuns: () => [], resume: () => 0 };
  const schedules = new ScheduleService({ sessions, store, allowDevelopment: false });
  await refused(await serve(t, (req, res) => schedules.handle(req, res)), ["/v1/schedules", "/v1/schedules/create", "/v1/schedules/delete", "/v1/schedules/state", "/v1/schedules/run-now", "/v1/schedules/unattended/revoke"], "schedules");

  const privateKey = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" });
  const skills = new EnterpriseSkillCatalog({ origin: "https://agent.example", sessions, privateKey, catalog: { schemaVersion: 1, revision: 1, tenants: [{ tenantId: "tenant_a", skills: [] }] } });
  await refused(await serve(t, (req, res) => skills.handle(req, res)), ["/v1/skills/manage", "/v1/skills/publish", "/v1/skills/unpublish"], "skills");

  const choice = new ModelChoiceService({ sessions, preferences: await ModelPreferences.open({ file: null }), models: ["MiniMax-M3", "GLM-5.3"], health: null });
  await refused(await serve(t, (req, res) => choice.handle(req, res)), ["/v1/models/options"], "model choice");
});

// The two rules that keep this from coming back, over every service rather
// than the four above: nothing but the model gateway names the turn
// credential's audience, and nothing that verifies a bearer in a request
// handler forgets to check which kind of session it was given -- the sites
// service checked none, and took any session at all.
test("only the model gateway takes the turn credential, and every service checks the kind of session it is given", async () => {
  const directory = new URL("../src/control-plane/", import.meta.url);
  const files = (await readdir(directory)).filter((name) => name.endsWith(".js"));
  for (const name of files) {
    const text = await readFile(new URL(name, directory), "utf8");
    if (/MODEL_TURN|"model-turn"/.test(text)) assert.ok(["sessions.js", "model-gateway.js"].includes(name), `${name} accepts the turn credential`);
    const handles = /\basync handle\(req, res\)|\bhandle\(req, res\) \{/.test(text);
    const verifies = /sessions\.verify\(/.test(text);
    if (name !== "sessions.js" && handles && verifies) assert.match(text, /\.audience\b/, `${name} verifies a bearer without checking what kind of session it is`);
  }
});
