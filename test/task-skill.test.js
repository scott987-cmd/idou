import test from "node:test";
import assert from "node:assert/strict";
import { access, chmod, writeFile, readFile, unlink, symlink, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { TaskSkillRunner, stageTaskSkill, registerTaskSkill, requireUsableSkill, skillMcpConnections, skillMcpRequirements } from "../src/application/task-skill.js";
import { McpConnections, mcpReference } from "../src/application/mcp-connections.js";
import { skillDigest, normalizeSkill } from "../src/skills/catalog-format.js";
import { skillFixture } from "../scripts/fixtures/skill-catalog.js";

const fixture = () => { const bundle = skillFixture(); return { ...bundle, digest: skillDigest(bundle), compatible: true }; };
test("task skill stages exact versioned files in a private independent lease and removes only its own files", async () => {
  const skill = fixture(), a = await stageTaskSkill(skill), b = await stageTaskSkill(skill);
  try {
    assert.notEqual(a.root, b.root); await a.verify(); assert.equal(await readFile(a.path, "utf8"), skill.files[0].text);
    await a.close(); await assert.rejects(access(a.path), { code: "ENOENT" }); await b.verify(); await a.close();
  } finally { await a.close(); await b.close(); }
});
test("modified files, symlinks and a changed digest cannot pass the pre-turn integrity check", async () => {
  const skill = fixture(); await assert.rejects(stageTaskSkill({ ...skill, digest: "0".repeat(64) }), /确认版本/);
  const lease = await stageTaskSkill(skill), dir = await mkdtemp(path.join(os.tmpdir(), "idou-skill-symlink-test-"));
  try {
    await chmod(lease.path, 0o600); await writeFile(lease.path, "changed"); await assert.rejects(lease.verify(), /文件已变化/);
    await writeFile(path.join(dir, "outside.md"), skill.files[0].text); await unlink(lease.path); await symlink(path.join(dir, "outside.md"), lease.path);
    await assert.rejects(lease.verify());
  } finally { await lease.close(); await rm(dir, { recursive: true, force: true }); }
});
test("unsupported dependencies, incompatible versions and sidecar auto-configuration cannot become executable task skills", () => {
  assert.throws(() => requireUsableSkill({ ...fixture(), compatible: false }), /兼容/);
  assert.throws(() => requireUsableSkill({ ...fixture(), requiredTools: ["mcp:external"] }), /尚未接通/);
  const skill = fixture(); skill.files.push({ path: "skill.json", text: "{}" }); assert.throws(() => requireUsableSkill(skill), /SKILL.json/);
});
test("registration requires exact enabled path/name discovered by Codex, never fallback to another skill name", async () => {
  const lease = await stageTaskSkill(fixture()), calls = [];
  try {
    const client = { request: async (method, params) => { calls.push({ method, params }); return method === "skills/list" ? { data: [{ skills: [{ name: lease.reference.id, path: lease.path, enabled: true }] }] } : {}; } };
    assert.deepEqual(await registerTaskSkill(client, "/fixture/work", lease), { type: "skill", name: lease.reference.id, path: lease.path });
    assert.deepEqual(calls[0], { method: "skills/extraRoots/set", params: { extraRoots: [lease.root] } });
    client.request = async () => ({ data: [{ skills: [{ name: lease.reference.id, path: "/other/SKILL.md", enabled: true }] }] });
    await assert.rejects(registerTaskSkill(client, "/fixture/work", lease), /未能识别/);
  } finally { await lease.close(); }
});
test("task skill preparation and pre-turn revalidation honor cancellation and withdrawal", async () => {
  const skill = fixture(), controller = new AbortController(); let reads = 0;
  const runner = new TaskSkillRunner({ read: async () => { if (++reads > 1) throw new Error("withdrawn"); return skill; } });
  const lease = await runner.prepare(skill, controller.signal);
  try { await assert.rejects(lease.beforeTurn(), /withdrawn/); }
  finally { await lease.close(); }
  const canceled = new TaskSkillRunner({ read: async () => { controller.abort(); return skill; } });
  await assert.rejects(canceled.prepare(skill, controller.signal), /abort/i);
});

const mcpFixture = () => { const bundle = { ...skillFixture(), requiredTools: ["cli:local-files", "mcp:demo:echo"] }; return { ...bundle, digest: skillDigest(bundle), compatible: true }; };
const connectionFixture = () => ({ id: "demo", title: "Synthetic", transport: "stdio", command: process.execPath, args: [], enabledTools: ["echo", "not_allowed"] });
test("signed MCP requirements bind exact server/tools and narrow the reviewed connection without mutation", async () => {
  const skill = mcpFixture(), row = connectionFixture();
  assert.deepEqual(skillMcpRequirements(skill), [{ id: "demo", enabledTools: ["echo"] }]);
  const narrowed = skillMcpConnections(skill, [row]); assert.deepEqual(narrowed[0].enabledTools, ["echo"]); assert.deepEqual(row.enabledTools, ["echo", "not_allowed"]);
  assert.throws(() => requireUsableSkill(skill), /先选择/);
  assert.throws(() => requireUsableSkill(skill, [{ ...row, id: "other" }]), /不匹配/);
  assert.throws(() => requireUsableSkill(skill, [{ ...row, enabledTools: ["not_allowed"] }]), /未允许/);
  assert.throws(() => requireUsableSkill(fixture(), [row]), /未声明/);
  assert.throws(() => requireUsableSkill({ ...skill, requiredTools: ["mcp:demo:echo", "mcp:other:echo"] }, [row]), /多个/);
  assert.throws(() => requireUsableSkill({ ...skill, requiredTools: ["mcp:codex_apps:echo"] }, [row]), /尚未接通/);
  assert.throws(() => requireUsableSkill({ ...skill, requiredTools: ["mcp:demo:*"] }, [row]), /尚未接通/);
  const lease = await stageTaskSkill(skill, narrowed); try { await lease.verify(); } finally { await lease.close(); }
});
test("catalog preserves standard case-sensitive MCP tool names and rejects oversized or wildcard declarations", () => {
  const label = `mcp:${"s".repeat(40)}:${"T".repeat(100)}`;
  assert.deepEqual(normalizeSkill({ ...skillFixture(), requiredTools: [label] }).requiredTools, [label]);
  assert.throws(() => normalizeSkill({ ...skillFixture(), requiredTools: [`${label}x`] }));
  assert.throws(() => normalizeSkill({ ...skillFixture(), requiredTools: ["mcp:demo:*"] }));
});
test("MCP dependency preparation revalidates registry digest before staging and again after runtime startup", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-skill-mcp-test-")), skill = mcpFixture(), row = connectionFixture();
  const registry = new McpConnections(path.join(directory, "connections.json")), binding = mcpReference(row); let lease;
  try {
    await registry.put(row);
    const runner = new TaskSkillRunner({ read: async () => skill }, (reference) => registry.resolve(reference));
    lease = await runner.prepare(skill, undefined, binding); assert.deepEqual(lease.mcpConnections[0].enabledTools, ["echo"]);
    await lease.beforeTurn();
    await registry.put({ ...row, args: ["changed"] });
    await assert.rejects(lease.beforeTurn(), /移除或变化/);
    await assert.rejects(runner.prepare(skill, undefined, binding), /移除或变化/);
    await assert.rejects(runner.prepare(skill), /先选择/);
    const foreign = new McpConnections(path.join(directory, "other-account.json"));
    await assert.rejects(new TaskSkillRunner({ read: async () => skill }, (ref) => foreign.resolve(ref)).prepare(skill, undefined, binding), /移除或变化/);
  } finally { await lease?.close(); await rm(directory, { recursive: true, force: true }); }
});
