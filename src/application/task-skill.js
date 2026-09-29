import { constants } from "node:fs";
import { mkdtemp, mkdir, writeFile, open, realpath, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { normalizeSkill, skillDigest } from "../skills/catalog-format.js";
import { normalizeMcpConnection } from "./mcp-connections.js";

export function skillReference(value) {
  if (!value || typeof value.id !== "string" || !/^(?:enterprise|local)-[a-z0-9][a-z0-9-]{0,63}$/.test(value.id) || typeof value.version !== "string" || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value.version) || typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest)) throw new Error("技能引用无效");
  return { id: value.id, version: value.version, digest: value.digest, title: typeof value.title === "string" ? value.title.slice(0, 160) : value.id };
}
export function skillMcpRequirements(skill) {
  if (!skill.compatible) throw new Error("技能未声明兼容当前版本，暂不可用于任务");
  // Sidecar-driven tool/dependency auto-configuration is not yet authorized.
  if (skill.files.some((file) => file.path.toLowerCase() === "skill.json")) throw new Error("此技能包含尚未支持的 SKILL.json 配置，仅可预览");
  const requirements = new Map();
  for (const tool of skill.requiredTools) {
    if (tool === "cli:local-files") continue;
    const match = /^mcp:([a-z][a-z0-9_-]{0,39}):([A-Za-z0-9_.-]{1,100})$/.exec(tool);
    if (!match || match[1] === "codex_apps") throw new Error("此技能需要尚未接通或授权的工具；MCP 需声明 mcp:连接ID:工具名");
    const names = requirements.get(match[1]) || []; names.push(match[2]); requirements.set(match[1], names);
  }
  if (requirements.size > 1) throw new Error("此技能需要多个 MCP 连接，当前任务仅支持一个；尚未授权执行");
  return [...requirements].map(([id, enabledTools]) => ({ id, enabledTools: [...new Set(enabledTools)].sort() }));
}
export function skillMcpConnections(skill, connections = []) {
  const requirements = skillMcpRequirements(skill);
  if (!requirements.length) {
    if (connections.length) throw new Error("此技能未声明 MCP 依赖，不接受附加连接");
    return [];
  }
  const required = requirements[0];
  if (connections.length !== 1) throw new Error("请先选择并确认技能所需的 MCP 连接");
  const row = normalizeMcpConnection(connections[0]);
  if (row.id !== required.id || required.enabledTools.some((tool) => !row.enabledTools.includes(tool))) throw new Error("所选 MCP 连接与技能声明不匹配或未允许所需工具");
  return [{ ...row, enabledTools: required.enabledTools }];
}
export function requireUsableSkill(skill, connections = []) {
  skillMcpConnections(skill, connections);
  return skill;
}

export async function stageTaskSkill(skill, connections = []) {
  requireUsableSkill(skill, connections);
  const keys = ["id", "version", "title", "description", "publisher", "requiredTools", "runtimeVersions", "files"];
  const bundle = normalizeSkill(Object.fromEntries(keys.map((key) => [key, skill[key]])));
  if (skillDigest(bundle) !== skill.digest) throw new Error("技能内容与确认版本不一致");
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-task-skill-")), root = await realpath(directory);
  const skillPath = path.join(root, "SKILL.md");
  let closed = false;
  const close = async () => { if (!closed) { await rm(root, { recursive: true, force: true }); closed = true; } };
  try {
    for (const file of bundle.files) {
      const filename = path.join(root, file.path);
      await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      await writeFile(filename, file.text, { flag: "wx", mode: 0o400 });
    }
    return { root, path: skillPath, reference: skillReference(skill),
      async verify() {
        if (closed || await realpath(root) !== root) throw new Error("技能临时目录已失效");
        for (const file of bundle.files) {
          const filename = path.join(root, file.path);
          if (await realpath(path.dirname(filename)) !== path.dirname(filename)) throw new Error("技能目录已变化");
          const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          try { const info = await handle.stat(); if (!info.isFile() || info.size !== Buffer.byteLength(file.text) || await handle.readFile("utf8") !== file.text) throw new Error("技能文件已变化，未交给 Agent"); }
          finally { await handle.close(); }
        }
      }, close };
  } catch (error) { await close(); throw error; }
}

export class TaskSkillRunner {
  constructor(client, resolveMcp = async (reference) => { if (reference) throw new Error("当前连接不能核验 MCP 依赖"); return []; }) { this.client = client; this.resolveMcp = resolveMcp; }
  async prepare(reference, signal, mcpReference) {
    const ref = skillReference(reference);
    const binding = mcpReference ? structuredClone(mcpReference) : undefined;
    const fresh = await this.client.read(ref), connections = skillMcpConnections(fresh, await this.resolveMcp(binding)); signal?.throwIfAborted();
    const lease = await stageTaskSkill(fresh, connections);
    if (signal?.aborted) { await lease.close(); signal.throwIfAborted(); }
    return { ...lease, mcpConnections: connections, beforeTurn: async () => { requireUsableSkill(await this.client.read(ref), await this.resolveMcp(binding)); signal?.throwIfAborted(); await lease.verify(); } };
  }
}

export async function registerTaskSkill(client, cwd, lease) {
  await lease.verify();
  await client.request("skills/extraRoots/set", { extraRoots: [lease.root] });
  const result = await client.request("skills/list", { cwds: [cwd], forceReload: true });
  const found = result.data?.flatMap((entry) => entry.skills || []).filter((skill) => skill.path === lease.path && skill.name === lease.reference.id && skill.enabled);
  if (found?.length !== 1 || found[0].dependencies?.tools?.length) throw new Error("Codex 未能识别所选技能或技能声明了额外依赖；请检查 SKILL.md 与运行时版本");
  return { type: "skill", name: lease.reference.id, path: lease.path };
}
