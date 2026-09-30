import { constants } from "node:fs";
import { open, mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { validateServerUrl } from "../control-plane/client-session.js";
import { nodeRuntime } from "../providers/node-runtime.js";

const ID = /^[a-z][a-z0-9_-]{0,39}$/;
const text = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value);
export function normalizeMcpConnection(value) {
  const keys = value?.transport === "stdio" ? ["id", "title", "transport", "command", "args", "enabledTools"] : value?.transport === "enterprise" ? ["id", "title", "transport", "policyDigest", "enabledTools"] : ["id", "title", "transport", "url", "enabledTools"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key)) || typeof value.id !== "string" || !ID.test(value.id) || value.id === "codex_apps" || !text(value.title, 100)) throw new Error("MCP 配置字段无效；不接受密钥、环境变量或自定义请求头");
  if (!Array.isArray(value.enabledTools) || value.enabledTools.length < 1 || value.enabledTools.length > 32 || new Set(value.enabledTools).size !== value.enabledTools.length || value.enabledTools.some((name) => !text(name, 100) || !/^[a-zA-Z0-9_.-]+$/.test(name))) throw new Error("请明确列出 1–32 个 MCP 工具名称");
  const common = { id: value.id, title: value.title, transport: value.transport, enabledTools: [...value.enabledTools].sort() };
  if (value.transport === "enterprise") {
    if (typeof value.policyDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.policyDigest)) throw new Error("企业 MCP 策略指纹无效");
    return { ...common, policyDigest: value.policyDigest };
  }
  if (value.transport === "stdio") {
    if (!text(value.command, 1024) || !path.isAbsolute(value.command) || !Array.isArray(value.args) || value.args.length > 32 || value.args.some((arg) => typeof arg !== "string" || arg.length > 2048 || /[\u0000-\u001f]/.test(arg))) throw new Error("stdio MCP 需要已安装程序的绝对路径和参数数组");
    return { ...common, command: value.command, args: [...value.args] };
  }
  if (value.transport !== "http" || !text(value.url, 2048)) throw new Error("不支持的 MCP 传输方式");
  let url; try { url = new URL(value.url); } catch { throw new Error("MCP 地址无效"); }
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)))) throw new Error("MCP 仅接受 HTTPS 或本机 HTTP；地址中不能包含凭据、查询参数或片段");
  return { ...common, url: url.href };
}
const digest = (connection) => createHash("sha256").update(JSON.stringify(normalizeMcpConnection(connection))).digest("hex");
export function mcpReference(connection) { return { id: connection.id, title: connection.title, digest: digest(connection) }; }
export async function readMcpImport(filename) {
  let file;
  try {
    file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await file.stat(); if (!info.isFile() || info.size > 32768) throw new Error();
    const bytes = await file.readFile(); if (bytes.length > 32768) throw new Error();
    const row = normalizeMcpConnection(JSON.parse(bytes.toString("utf8")));
    if (row.transport === "enterprise") throw new Error("企业连接必须从服务端获取");
    return row;
  } catch { throw new Error("无法导入 MCP 配置：需要不含密钥的有效连接 JSON（最大 32 KiB）"); }
  finally { await file?.close(); }
}

// Account-local reviewed connection configuration, not a server-admin policy.
export class McpConnections {
  constructor(filename) { this.filename = filename; this.queue = Promise.resolve(); }
  async list() {
    let rows;
    try { rows = JSON.parse(await readFile(this.filename, "utf8")); } catch (error) { if (error.code === "ENOENT") return []; throw new Error("MCP 连接记录损坏，原文件未修改"); }
    if (!Array.isArray(rows) || rows.length > 16) throw new Error("MCP 连接记录无效");
    const result = rows.map(normalizeMcpConnection);
    if (new Set(result.map((row) => row.id)).size !== result.length) throw new Error("MCP 连接 ID 重复");
    return result;
  }
  change(update) {
    const next = this.queue.catch(() => {}).then(async () => {
      const rows = update(await this.list()); if (rows.length > 16) throw new Error("最多配置 16 个 MCP 连接");
      await mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
      const temporary = `${this.filename}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, JSON.stringify(rows), { flag: "wx", mode: 0o600 }); await rename(temporary, this.filename); }
      finally { await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
    }); this.queue = next; return next;
  }
  put(value) { const row = normalizeMcpConnection(value); return this.change((rows) => [...rows.filter((item) => item.id !== row.id), row]); }
  remove(reference) { return this.change((rows) => { const row = rows.find((item) => item.id === reference?.id); if (!row || digest(row) !== reference.digest) throw new Error("MCP 连接已变化，请刷新后重试"); return rows.filter((item) => item !== row); }); }
  async resolve(reference) {
    if (!reference) return [];
    const row = (await this.list()).find((item) => item.id === reference.id);
    if (!row || digest(row) !== reference.digest) throw new Error("任务绑定的 MCP 连接已移除或变化，请重新确认并新建任务");
    return [row];
  }
}

// A built-in connector runs its bundled script on the application's Node
// (builtin-connectors.js, node-runtime.js). In development under Electron that
// is the Electron binary, which ignores a script argument and starts the
// application again -- a second instance that quits at once -- unless it is
// told to act as Node; Codex hands an MCP server none of its own environment
// (env_vars: []), so what that Node needs is said here. 2026-09-23: in the
// packaged app, which then still ran Electron as Node, every built-in
// connector failed its handshake ("connection closed"), and a connector being
// required, every coding task failed to start while one was switched on. A
// packaged app now runs them on the Node it carries, which needs nothing.
function runtimeEnv(command, node) {
  return command === node.command && Object.keys(node.env).length ? { env: { ...node.env } } : {};
}
export function mcpOverrides(connections = [], cwd, brokerLeases = {}, node = nodeRuntime()) {
  return Object.fromEntries(connections.map((input) => {
    const row = normalizeMcpConnection(input);
    const lease = brokerLeases[row.id];
    if (row.transport === "enterprise" && (!lease || lease.connectionId !== row.id || lease.policyDigest !== row.policyDigest || lease.envName !== "IDOU_MCP_BROKER_TOKEN")) throw new Error("企业 MCP 短期授权尚未核验");
    return [row.id, { ...(row.transport === "stdio" ? { command: row.command, args: row.args, cwd, env_vars: [], ...runtimeEnv(row.command, node) } : row.transport === "enterprise" ? { url: `${validateServerUrl(lease.origin)}/v1/mcp/${row.id}`, bearer_token_env_var: lease.envName } : { url: row.url }),
      enabled: true, required: true, enabled_tools: row.enabledTools, default_tools_approval_mode: "prompt", startup_timeout_sec: 15, tool_timeout_sec: 60 }];
  }));
}

export async function inspectTaskMcp(client, threadId, connections) {
  const response = await client.request("mcpServerStatus/list", { threadId, detail: "toolsAndAuthOnly", limit: 100 });
  if (response.nextCursor || !Array.isArray(response.data)) throw new Error("MCP 状态超出支持范围");
  return connections.map((row) => {
    const status = response.data.find((item) => item.name === row.id);
    const names = Object.values(status?.tools || {}).map((tool) => tool.name);
    // The pinned 0.147.0 binary returns serverInfo + tools, without runtimeStatus.
    // In a fresh per-turn process, successful handshake metadata and all selected
    // tools establish discovery; never infer success from authStatus alone.
    const discovered = status?.runtimeStatus === undefined ? typeof status?.serverInfo?.name === "string" && typeof status.serverInfo.version === "string" : status.runtimeStatus === "connected";
    if (!discovered || status.toolsError || row.enabledTools.some((name) => !names.includes(name))) throw new Error(`MCP ${row.title} 未连接或缺少所选工具，未发送模型请求`);
    return { id: row.id, title: row.title, status: "connected", tools: [...row.enabledTools], checkedAt: Date.now() };
  });
}
