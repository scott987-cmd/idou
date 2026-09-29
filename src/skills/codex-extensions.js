import { readFile } from "node:fs/promises";
import path from "node:path";
import { runProcess } from "../providers/process-runner.js";
import { CodexAppServerClient } from "../providers/codex/app-server-client.js";
import { resolveCodexRuntime } from "../providers/codex/bundled-codex.js";

// The only supported way to write a single config key. A short-lived app server
// costs about a second, which is the right price for not hand-editing the TOML
// file Codex owns.
async function appServerConfigWrite(binary, env, params) {
  const client = new CodexAppServerClient({ binary, cwd: process.cwd(), env });
  await client.start();
  try {
    const result = await client.request("config/value/write", params);
    if (result?.status !== "ok") throw new Error("Codex 未确认这次配置写入");
    return result;
  } finally { await client.stop().catch(() => {}); }
}

// Skills, MCP servers and plugin marketplaces are Codex's own features, and
// Codex is the upstream runtime we integrate with rather than reimplement. So
// none of this keeps its own registry, format or version history: it drives
// `codex plugin` / `codex mcp` against the product's own CODEX_HOME and reads
// back what Codex says. Whatever a future Codex version supports, the person
// gets, without a second catalogue here drifting out of step with it.
//
// The one thing not taken from Codex is trust. Adding an MCP server names a
// program to run; adding a marketplace names code to fetch; installing a plugin
// can bring both. Each of those is a real grant, so the caller confirms it
// before these methods are reached — this module refuses malformed input, it
// does not decide what is safe.

const MARKETPLACE_MANIFESTS = [".agents/plugins/marketplace.json", ".claude-plugin/marketplace.json", ".cursor-plugin/marketplace.json"];
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
// `name@marketplace`, the identifier Codex itself prints and accepts.
const PLUGIN_ID = /^([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})@([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})$/;

// Anything that could be read as an option instead of a value is refused rather
// than escaped. Arguments never reach a shell (`runProcess` spawns directly),
// so this is about not letting a name become a flag.
const value = (text, label, pattern) => {
  if (typeof text !== "string" || !text.trim()) throw new Error(`请填写${label}`);
  const trimmed = text.trim();
  if (trimmed.startsWith("-")) throw new Error(`${label}不能以「-」开头`);
  if (pattern && !pattern.test(trimmed)) throw new Error(`${label}只能使用字母、数字、点、下划线和短横线，最多 64 个字符`);
  return trimmed;
};

export const pluginId = (text) => {
  const id = value(text, "插件标识");
  if (!PLUGIN_ID.test(id)) throw new Error("插件标识应当形如 插件名@市场名");
  return id;
};

// A marketplace source is a local absolute path, `owner/repo[@ref]`, or an
// https/ssh Git URL — the four shapes Codex documents. A local path is resolved
// here so the person sees the same directory Codex will read.
export function marketplaceSource(text) {
  const source = value(text, "市场地址");
  if (source.startsWith("/") || source.startsWith("~")) return { kind: "local", source: source.startsWith("~") ? path.join(process.env.HOME || "", source.slice(1)) : source };
  if (/^https:\/\/[^\s]+$/.test(source)) return { kind: "git", source };
  if (/^(?:ssh:\/\/|git@)[^\s]+$/.test(source)) return { kind: "git", source };
  // Both halves must start with a letter or digit, so `./market` and `../x` are
  // read as the relative paths they are rather than as an owner called `.`.
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*(?:@[A-Za-z0-9][A-Za-z0-9._\/-]*)?$/.test(source)) return { kind: "git", source };
  throw new Error("市场地址必须是本地绝对路径、owner/repo、https:// 或 ssh 的 Git 地址");
}

export class CodexExtensions {
  constructor({ binary = "codex", env = process.env, timeoutMs = 120_000, writeConfig } = {}) {
    this.binary = binary; this.env = env; this.timeoutMs = timeoutMs;
    this.writeConfig = writeConfig ?? ((params) => appServerConfigWrite(this.binary, this.env, params));
  }

  async #run(args, { timeoutMs = this.timeoutMs } = {}) {
    const { binary } = await resolveCodexRuntime(this.binary);
    const result = await runProcess(binary, args, { env: this.env, timeoutMs, maxOutputBytes: 4 * 1024 * 1024 })
      .catch((error) => { throw new Error(error?.code === "ENOENT" ? `找不到 codex 可执行文件（${this.binary}）` : error.message); });
    if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ").slice(0, 300) || "codex 命令执行失败");
    return result.stdout;
  }

  async #json(args, options) {
    const output = await this.#run(args, options);
    // Codex prints the JSON document alone, but a warning line ahead of it must
    // not turn a working command into an unexplained failure.
    const start = output.search(/[[{]/);
    if (start < 0) throw new Error("codex 没有返回可解析的结果");
    try { return JSON.parse(output.slice(start)); }
    catch { throw new Error("codex 返回的结果无法解析"); }
  }

  // ---- MCP servers -------------------------------------------------------
  async listMcp() {
    const rows = await this.#json(["mcp", "list", "--json"]);
    return (Array.isArray(rows) ? rows : []).map((row) => ({
      name: row.name, enabled: row.enabled !== false, disabledReason: row.disabled_reason || null,
      transport: row.transport?.type === "stdio"
        ? { kind: "command", command: row.transport.command, args: row.transport.args || [] }
        : { kind: "url", url: row.transport?.url || "" },
      authStatus: row.auth_status || "unsupported",
    }));
  }

  // The command and its arguments are passed after `--`, so a value that looks
  // like a flag is an argument to the server, never to Codex.
  async addMcpCommand(name, command, args = []) {
    if (!Array.isArray(args)) throw new Error("启动参数必须是一组字符串");
    if (args.some((arg) => typeof arg !== "string")) throw new Error("启动参数必须是一组字符串");
    await this.#run(["mcp", "add", value(name, "服务名称", NAME), "--", value(command, "启动命令"), ...args]);
    return this.listMcp();
  }

  async addMcpUrl(name, url) {
    const address = value(url, "服务地址");
    if (!/^https:\/\/[^\s]+$/.test(address)) throw new Error("远程 MCP 地址必须是 https:// 开头");
    await this.#run(["mcp", "add", value(name, "服务名称", NAME), "--url", address]);
    return this.listMcp();
  }

  async removeMcp(name) {
    await this.#run(["mcp", "remove", value(name, "服务名称", NAME)]);
    return this.listMcp();
  }

  // OAuth opens a browser window owned by Codex; it can sit waiting, so it gets
  // a longer budget than an ordinary command and is still bounded.
  async loginMcp(name) { await this.#run(["mcp", "login", value(name, "服务名称", NAME)], { timeoutMs: 300_000 }); return this.listMcp(); }
  async logoutMcp(name) { await this.#run(["mcp", "logout", value(name, "服务名称", NAME)]); return this.listMcp(); }

  // ---- Marketplaces ------------------------------------------------------
  async listMarketplaces() {
    const result = await this.#json(["plugin", "marketplace", "list", "--json"]);
    return (result?.marketplaces || []).map((row) => ({
      name: row.name, root: row.root,
      kind: row.marketplaceSource?.sourceType === "local" ? "local" : "git",
      source: row.marketplaceSource?.source || row.root,
    }));
  }

  async addMarketplace(text, { ref } = {}) {
    const { source } = marketplaceSource(text);
    await this.#run(["plugin", "marketplace", "add", source, ...(ref ? ["--ref", value(ref, "Git 分支或标签")] : []), "--json"], { timeoutMs: 300_000 })
      .catch((error) => {
        // Codex answers this one in English, about a field the person wrote in
        // their own manifest. Saying which field and what it accepts is the
        // difference between a fixable mistake and a dead end.
        if (/invalid marketplace name/i.test(error.message)) throw new Error("市场名只能用英文字母、数字、下划线和短横线。请改 marketplace.json 里的 name 字段；owner、描述和技能内容可以是中文。");
        throw error;
      });
    return this.listMarketplaces();
  }

  async removeMarketplace(name) {
    await this.#run(["plugin", "marketplace", "remove", value(name, "市场名称", NAME)]);
    return this.listMarketplaces();
  }

  async upgradeMarketplaces() { await this.#run(["plugin", "marketplace", "upgrade"], { timeoutMs: 300_000 }); return this.listMarketplaces(); }

  // ---- Plugins -----------------------------------------------------------
  // What a marketplace offers is read from its own manifest — the same file
  // Codex reads, and the only listing that keeps a plugin Codex would silently
  // omit (a non-ASCII name). What is installed comes from Codex itself.
  async #manifest(root) {
    for (const relative of MARKETPLACE_MANIFESTS) {
      try { return JSON.parse(await readFile(path.join(root, relative), "utf8")); } catch { /* try the next supported location */ }
    }
    return null;
  }

  // Reads the status Codex reports, rather than guessing it from config:
  // `plugin list --json` answers with `installed[]` entries carrying pluginId,
  // version, installed and enabled. Until 0.155 it printed nothing there and
  // this parsed a text table instead, by a header whose last column was PATH --
  // it is SOURCE now, and matching it is what made every installed plugin read
  // as not installed after the upgrade. The version is pinned, and the real
  // binary is driven by test/codex-extensions.test.js on every upgrade, so one
  // shape is read and a change to it fails there rather than in someone's hands.
  async #installedIds() {
    const rows = new Map();
    const listed = await this.#json(["plugin", "list", "--json"]).catch(() => null);
    for (const entry of Array.isArray(listed?.installed) ? listed.installed : []) {
      if (typeof entry?.pluginId !== "string" || !PLUGIN_ID.test(entry.pluginId)) continue;
      rows.set(entry.pluginId, { installed: entry.installed !== false, enabled: entry.enabled === true,
        version: typeof entry.version === "string" && entry.version ? entry.version : null });
    }
    return rows;
  }

  async listPlugins() {
    const [marketplaces, installed] = await Promise.all([this.listMarketplaces(), this.#installedIds()]);
    const rows = [];
    for (const marketplace of marketplaces) {
      const manifest = await this.#manifest(marketplace.root);
      for (const plugin of manifest?.plugins || []) {
        if (typeof plugin?.name !== "string" || !plugin.name.trim()) continue;
        const name = plugin.name.trim();
        const description = typeof plugin.description === "string" ? plugin.description.slice(0, 400) : "";
        // Codex requires ASCII identifiers and simply omits anything else from
        // its own listing. Dropping those here too would show somebody who named
        // their plugin in Chinese an empty list with no reason given, so they
        // are listed with the reason they cannot be installed.
        if (!NAME.test(name)) {
          rows.push({ id: `${name}@${marketplace.name}`, name, marketplace: marketplace.name, marketplaceKind: marketplace.kind,
            description, version: null, installed: false, enabled: false,
            unusable: "插件名只能用英文字母、数字、点、下划线和短横线。改名后重新加一次市场即可；说明和技能内容可以是中文。" });
          continue;
        }
        const id = `${name}@${marketplace.name}`;
        const state = installed.get(id);
        rows.push({ id, name, marketplace: marketplace.name, marketplaceKind: marketplace.kind, description,
          version: state?.version || (typeof plugin.version === "string" ? plugin.version : null),
          installed: Boolean(state?.installed), enabled: Boolean(state?.enabled) });
      }
    }
    return rows.sort((a, b) => Number(b.installed) - Number(a.installed) || a.id.localeCompare(b.id));
  }

  async installPlugin(id) { await this.#run(["plugin", "add", pluginId(id), "--json"], { timeoutMs: 300_000 }); return this.listPlugins(); }
  async removePlugin(id) { await this.#run(["plugin", "remove", pluginId(id)]); return this.listPlugins(); }

  // Codex has no enable/disable subcommand, so this goes through the app
  // server's own config writer — one key, `replace`, nothing else touched. A
  // disabled plugin stays installed, which is the point: turning something off
  // to see whether it was the cause should not throw the download away.
  async setPluginEnabled(id, enabled) {
    if (typeof enabled !== "boolean") throw new Error("启用状态必须是布尔值");
    const plugin = pluginId(id);
    const known = await this.listPlugins();
    if (!known.some((row) => row.id === plugin && row.installed)) throw new Error("这个插件还没有安装");
    await this.writeConfig({ keyPath: `plugins.${JSON.stringify(plugin)}.enabled`, value: enabled, mergeStrategy: "replace" });
    return this.listPlugins();
  }
}
