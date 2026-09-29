import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelChoiceService, ModelPreferences } from "../src/control-plane/model-choice.js";
import { ModelHealth } from "../src/control-plane/model-health.js";

const ME = { id: "s1", tenantId: "tenant-a", userId: "ou_person_a", authProvider: "feishu", audience: "codex-model-gateway" };
const COLLEAGUE = { ...ME, id: "s2", userId: "ou_person_b" };
const ORDER = ["MiniMax-M3", "GLM-5.3"];

function response() {
  const out = { status: 0, body: "" };
  out.writeHead = (status) => { out.status = status; };
  out.end = (chunk) => { if (chunk !== undefined) out.body += String(chunk); };
  return out;
}
const request = (url, { token = "me", body = {}, method = "POST", headers = {} } = {}) => Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]),
  { method, url, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, resume() {} });
const sessions = { verify: (token) => ({ me: ME, colleague: COLLEAGUE, dev: { ...ME, authProvider: "development" }, wrong: { ...ME, audience: "sandbox-run" } })[token] ?? null };

async function service({ file = null, health = null, allowDevelopment = false } = {}) {
  const preferences = await ModelPreferences.open({ file });
  const made = new ModelChoiceService({ sessions, preferences, models: ORDER, health, allowDevelopment });
  const call = async (url, options) => { const res = response(); const claimed = await made.handle(request(url, options), res); return { claimed, status: res.status, body: res.body ? JSON.parse(res.body) : null }; };
  return { made, call, preferences };
}

test("a person's pick is kept by the server, for them only, and null follows the default again", async () => {
  const { call, made } = await service();
  assert.deepEqual((await call("/v1/models/options")).body,
    { available: ORDER, default: "MiniMax-M3", choice: null, current: "MiniMax-M3", unavailable: [] });
  const chosen = await call("/v1/models/choose", { body: { model: "GLM-5.3" } });
  assert.equal(chosen.status, 200);
  assert.equal(chosen.body.choice, "GLM-5.3");
  assert.equal(chosen.body.current, "GLM-5.3");
  assert.equal((await call("/v1/models/options", { token: "colleague" })).body.current, "MiniMax-M3", "a colleague still follows the default");
  assert.equal(await made.effective({ tenantId: "tenant-a", userId: "ou_person_a" }), "GLM-5.3", "the same answer for their scheduled runs");
  assert.equal((await call("/v1/models/choose", { body: { model: null } })).body.current, "MiniMax-M3");
  const refused = await call("/v1/models/choose", { body: { model: "gpt-5" } });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /不可选/);
});

test("a pick that stops answering is passed over, and says why, without being forgotten", async () => {
  let now = 0;
  const health = new ModelHealth({ order: ORDER, now: () => now });
  const { call } = await service({ health });
  await call("/v1/models/choose", { body: { model: "GLM-5.3" } });
  health.fail("GLM-5.3", "subscription");
  const options = (await call("/v1/models/options")).body;
  assert.equal(options.choice, "GLM-5.3", "the pick is kept");
  assert.equal(options.current, "MiniMax-M3", "the work goes where an answer comes from");
  assert.deepEqual(options.unavailable.map((row) => [row.model, row.reason]), [["GLM-5.3", "subscription"]]);
  now += 11 * 60_000;
  assert.equal((await call("/v1/models/options")).body.current, "GLM-5.3", "and back once it may answer again");
});

test("only the person's own desktop session may read or change it", async () => {
  const { call } = await service();
  assert.equal((await call("/v1/models/options", { token: "nobody" })).status, 401);
  assert.equal((await call("/v1/models/options", { token: "dev" })).status, 403, "a development login on a production server");
  assert.equal((await call("/v1/models/options", { token: "wrong" })).status, 403, "a sandbox run's credential");
  assert.equal((await call("/v1/models/options", { headers: { origin: "https://example.com" } })).status, 403);
  assert.equal((await call("/v1/models/options", { method: "GET" })).status, 405);
  assert.equal((await call("/v1/other")).claimed, false, "and nothing else is claimed");
  const dev = await service({ allowDevelopment: true });
  assert.equal((await dev.call("/v1/models/options", { token: "dev" })).status, 200);
});

test("the file holds hashes and models, written whole, readable only by its owner", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-model-choice-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "nested", "model-preferences.json");
  const first = await service({ file });
  await first.call("/v1/models/choose", { body: { model: "GLM-5.3" } });
  await first.call("/v1/models/choose", { token: "colleague", body: { model: "MiniMax-M3" } });
  const text = await readFile(file, "utf8");
  assert.doesNotMatch(text, /ou_person|tenant-a/, "no one is named in it");
  assert.equal(Object.keys(JSON.parse(text).choices).length, 2);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(path.dirname(file))).filter((name) => name.endsWith(".tmp")), [], "no half-written file left");
  const reopened = await service({ file });
  assert.equal((await reopened.call("/v1/models/options")).body.choice, "GLM-5.3", "kept across a restart");
  assert.equal((await reopened.call("/v1/models/options", { token: "colleague" })).body.choice, "MiniMax-M3");
});
