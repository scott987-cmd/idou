import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { adoptAccountData, previousAccountNames } from "../src/desktop/account-migration.js";
import { accountNamespace, legacyAccountNamespace } from "../src/application/desktop-auth.js";

const identity = { provider: "feishu", appId: "cli_fixture", tenantId: "tenant_a", userId: "ou_a", deviceProof: "ed25519-login" };
const OLD_SERVER = "http://127.0.0.1:3041", NEW_SERVER = "https://mydoubao.example";
const current = accountNamespace({ serverUrl: NEW_SERVER, identity });
const legacy = legacyAccountNamespace({ serverUrl: OLD_SERVER, identity });
const exists = (target) => stat(target).then(() => true, () => false);

async function machine(t) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "account-migration-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  await mkdir(path.join(dataRoot, "accounts", legacy, "tasks"), { recursive: true });
  await writeFile(path.join(dataRoot, "accounts", legacy, "tasks", "a.json"), "{\"id\":\"a\"}");
  await mkdir(path.join(dataRoot, "Partitions", `feishu-web-${legacy}`), { recursive: true });
  await writeFile(path.join(dataRoot, "Partitions", `feishu-web-${legacy}`, "Cookies"), "cookies");
  await writeFile(path.join(dataRoot, "feishu-web-legacy.json"), JSON.stringify({ namespace: legacy }));
  const cleared = [];
  return { dataRoot, cleared, resumeStore: { clear: async (name) => { cleared.push(name); } } };
}

// The case that made this necessary: the same person signs in to the same
// deployment at a new address, and everything they had comes with them.
test("a deployment that moved keeps the account's tasks, Feishu sign-in and nothing stale", async (t) => {
  const m = await machine(t);
  const from = previousAccountNames({ serverUrl: NEW_SERVER, identity, pointer: { namespace: legacy, serverUrl: OLD_SERVER } });
  assert.ok(from.includes(legacy), "the pointer is proven to be this account's");
  assert.equal(await adoptAccountData({ dataRoot: m.dataRoot, to: current, from, resumeStore: m.resumeStore }), legacy);
  assert.equal(await readFile(path.join(m.dataRoot, "accounts", current, "tasks", "a.json"), "utf8"), "{\"id\":\"a\"}");
  assert.equal(await exists(path.join(m.dataRoot, "accounts", legacy)), false);
  assert.equal(await readFile(path.join(m.dataRoot, "Partitions", `feishu-web-${current}`, "Cookies"), "utf8"), "cookies");
  assert.deepEqual(JSON.parse(await readFile(path.join(m.dataRoot, "feishu-web-legacy.json"), "utf8")), { namespace: current });
  assert.deepEqual(m.cleared, [legacy]);
  // Done once: a second activation finds the account where it now belongs.
  assert.equal(await adoptAccountData({ dataRoot: m.dataRoot, to: current, from, resumeStore: m.resumeStore }), null);
});

test("an account that already has data under its current name keeps exactly that", async (t) => {
  const m = await machine(t);
  await mkdir(path.join(m.dataRoot, "accounts", current), { recursive: true });
  await writeFile(path.join(m.dataRoot, "accounts", current, "marker"), "newer");
  assert.equal(await adoptAccountData({ dataRoot: m.dataRoot, to: current, from: [legacy], resumeStore: m.resumeStore }), null);
  assert.equal(await readFile(path.join(m.dataRoot, "accounts", current, "marker"), "utf8"), "newer");
  assert.equal(await exists(path.join(m.dataRoot, "accounts", legacy, "tasks", "a.json")), true, "the old data is left alone, not merged or deleted");
  assert.deepEqual(m.cleared, []);
});

test("nothing is taken from another account, from the directory in use, or from a name that is not one", async (t) => {
  const m = await machine(t);
  // A pointer another person left behind proves nothing about this one.
  const someone = { ...identity, userId: "ou_someone_else" };
  assert.deepEqual(previousAccountNames({ serverUrl: NEW_SERVER, identity: someone, pointer: { namespace: legacy, serverUrl: OLD_SERVER } }),
    [legacyAccountNamespace({ serverUrl: NEW_SERVER, identity: someone })]);
  assert.equal(await adoptAccountData({ dataRoot: m.dataRoot, to: current, from: [legacy], active: path.join(m.dataRoot, "accounts", legacy) }), null);
  assert.equal(await adoptAccountData({ dataRoot: m.dataRoot, to: current, from: ["../../etc", "", current] }), null);
  await assert.rejects(adoptAccountData({ dataRoot: m.dataRoot, to: "../x", from: [legacy] }), /Invalid account namespace/);
  assert.equal(await exists(path.join(m.dataRoot, "accounts", legacy, "tasks", "a.json")), true);
});

test("the same address, only a newer build: the old name at this address is found without a pointer", async (t) => {
  const m = await machine(t);
  const from = previousAccountNames({ serverUrl: OLD_SERVER, identity });
  assert.deepEqual(from, [legacy]);
  assert.equal(await adoptAccountData({ dataRoot: m.dataRoot, to: accountNamespace({ serverUrl: OLD_SERVER, identity }), from }), legacy);
});
