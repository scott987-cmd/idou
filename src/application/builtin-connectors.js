import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { normalizeMcpConnection } from "./mcp-connections.js";

// The app-shipped MCP capabilities the coding agent can use — the "hands" a
// coding task gets beyond the shell. Each entry is a single stdio server the app
// spawns (via `process.execPath <script>`); enabling one in 技能中心 makes its
// tools ride along on every coding task, and its calls are still gated by the
// MCP approval card -- once per call, or once per grant for the turn, by the
// task's permission (mcp-approval-policy.js). Unlike a user-imported connection these are
// app-owned, so they are surfaced as a fixed, one-click catalog rather than a
// command the person types.
//
// The ids match the MCP-connection id rules (`/^[a-z][a-z0-9_-]{0,39}$/`) and
// never the reserved `codex_apps`.
const CATALOG = Object.freeze([
  Object.freeze({
    key: "web-fetch",
    id: "web-fetch",
    title: "联网搜索与抓取",
    description: "让编程 agent 用关键词搜索网页、并抓取 http/https 网页正文，用于查阅文档和 API 说明。搜索走 DuckDuckGo、无需任何 key；返回内容会被标注为不可信的外部数据，且拒绝私有/内网地址。",
    module: "../../bin/mcp/web-fetch.js",
    tools: Object.freeze([
      Object.freeze({ name: "web_search", summary: "用关键词搜索网页，返回标题+链接" }),
      Object.freeze({ name: "fetch_url", summary: "抓取一个网页并返回可读文本" }),
    ]),
  }),
  Object.freeze({
    key: "browser",
    id: "browser",
    title: "浏览器操作",
    description: "让编程 agent 用无头浏览器打开页面、读文本、点击、输入、截图、看 console，用于自测网页；也能直接打开本任务自己生成的成果页面自测。除本任务成果外，拒绝私有/内网地址。",
    module: "../../bin/mcp/browser.js",
    tools: Object.freeze([
      Object.freeze({ name: "browser_navigate", summary: "打开一个网页" }),
      Object.freeze({ name: "browser_preview", summary: "打开本任务生成的页面自测" }),
      Object.freeze({ name: "browser_read", summary: "读取页面可见文本" }),
      Object.freeze({ name: "browser_click", summary: "按文本或选择器点击" }),
      Object.freeze({ name: "browser_type", summary: "在输入框填入文本" }),
      Object.freeze({ name: "browser_console", summary: "读取 console 输出" }),
      Object.freeze({ name: "browser_screenshot", summary: "截图（需视觉模型）" }),
    ]),
  }),
  Object.freeze({
    key: "computer",
    id: "computer",
    title: "电脑操作",
    description: "让编程 agent 看这台电脑的窗口并操作：列应用、列窗口、截屏，以及在指定应用里点击、输入、按键。这是权限最大的一项——它操作的是真实桌面而不是沙箱。出于安全，它不会操作 i豆 自己、终端和脚本工具、其它 Agent 应用、系统设置和密码类应用。逐步确认下每次调用都先问你；标准和自动下每个应用每一轮先问一次，截整个屏幕另问；完全访问不再询问。需要在「系统设置 → 隐私与安全性」里给本应用授予「辅助功能」和「屏幕录制」权限，否则只能列出应用名。",
    module: "../../bin/mcp/computer.js",
    tools: Object.freeze([
      Object.freeze({ name: "computer_apps", summary: "列出在运行的应用" }),
      Object.freeze({ name: "computer_windows", summary: "列出某个应用的窗口" }),
      Object.freeze({ name: "computer_screenshot", summary: "截屏（需视觉模型）" }),
      Object.freeze({ name: "computer_click", summary: "在指定应用窗口内点击" }),
      Object.freeze({ name: "computer_type", summary: "在指定应用里输入文本" }),
      Object.freeze({ name: "computer_key", summary: "在指定应用里按键" }),
    ]),
  }),
]);

export function builtinCatalog() {
  return CATALOG.map((entry) => ({ key: entry.key, id: entry.id, title: entry.title, description: entry.description, tools: entry.tools.map((tool) => ({ ...tool })) }));
}

// The normalized MCP connection row for a built-in — an absolute `command` (the
// current runtime) plus the bundled server script. The browser additionally
// takes the task's own preview base URL on argv: that is the one loopback
// address its SSRF guard will let the agent open, and it is passed here rather
// than as a tool argument so the model can never name a localhost target itself.
// Run through the same validator as a user connection so the shape stays exact.
export function builtinConnectionRow(key, { execPath = process.execPath, previewBase } = {}) {
  const entry = CATALOG.find((candidate) => candidate.key === key);
  if (!entry) return null;
  const script = fileURLToPath(new URL(entry.module, import.meta.url));
  const args = entry.key === "browser" && previewBase ? [script, "--preview-base", previewBase] : [script];
  return normalizeMcpConnection({ id: entry.id, title: entry.title, transport: "stdio", command: execPath, args, enabledTools: entry.tools.map((tool) => tool.name) });
}

export class BuiltinConnectors {
  constructor({ file, execPath = process.execPath } = {}) {
    this.file = file; this.execPath = execPath; this.enabled = new Set();
  }
  async load() {
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8"));
      this.enabled = new Set((Array.isArray(raw?.enabled) ? raw.enabled : []).filter((key) => CATALOG.some((entry) => entry.key === key)));
    } catch { this.enabled = new Set(); }
    return this;
  }
  async setEnabled(key, on) {
    if (!CATALOG.some((entry) => entry.key === key)) throw new Error("未知的内置能力");
    if (on) this.enabled.add(key); else this.enabled.delete(key);
    await mkdir(path.dirname(this.file), { recursive: true });
    const staging = `${this.file}.next`;
    await writeFile(staging, JSON.stringify({ enabled: [...this.enabled].sort() }), { mode: 0o600 });
    await rename(staging, this.file);
    return this.list();
  }
  list() {
    return CATALOG.map((entry) => ({ key: entry.key, id: entry.id, title: entry.title, description: entry.description, tools: entry.tools.map((tool) => ({ ...tool })), enabled: this.enabled.has(entry.key) }));
  }
  // The connection rows for every enabled built-in, ready to prepend to a coding
  // task's `config.mcpConnections`.
  enabledRows({ previewBase } = {}) {
    return [...this.enabled].map((key) => builtinConnectionRow(key, { execPath: this.execPath, previewBase })).filter(Boolean);
  }
}
