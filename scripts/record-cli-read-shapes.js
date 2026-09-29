#!/usr/bin/env node
// K1a recorder: stand in for the lark-cli auth sidecar and log every OpenAPI
// request the pinned CLI plans to send for the read commands a
// scheduled task uses. No Feishu credentials are involved: with
// LARKSUITE_CLI_AUTH_PROXY set the CLI delegates auth to this loopback server,
// which answers with canned envelopes and never forwards anywhere.
//
// Why not --dry-run alone: dry-run prints the planned api[] of a command, but a
// command that resolves a Wiki link before reading could hide that first hop.
// Driving the real wire settles what actually leaves the CLI, in order.
//
// Usage: node scripts/record-cli-read-shapes.js [output.json]
// Default output: test/fixtures/schedule-cli-read-shapes.json -- one name across
// versions, so what an upgrade changed on the wire is that file's diff.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const BINARY = path.join(ROOT, "resources/lark-cli/darwin-arm64/lark-cli");
const OUTPUT = process.argv[2] ?? path.join(ROOT, "test/fixtures/schedule-cli-read-shapes.json");

// Made-up resources of each kind: nothing leaves the loopback server, and what is
// recorded is the request the CLI builds for a link of that kind, which does not
// depend on whose documents they are.
const RES = {
  docx: "njuc0MhsdBNLy3Kx7zGzgTDHA60",
  sheet: "hp86Fs23V4sf0zG0R8ozi2qLABy",
  sheetSub: "20RQ2y",
  base: "pcSmy3eVqx8ktCFRKt4zxEQ7AVy",
  baseTable: "tbl3AMwwOsi0Z7SH",
  wikiDoc: "wy5iJauAY5jVJu7VDoLzjTYnAas",
  wikiSheet: "mxZCJEbv55HIYn7auDwztUjUAS2",
  wikiBase: "ptMCJHTRi5pKJD7BhATzzhjgASS",
  chat: "oc_0123456789abcdef0123456789abcdef",
};
const ORIGIN = "https://exampletenant.feishu.cn";

async function cliVersion() {
  const out = await new Promise((resolve, reject) => {
    const child = spawn(BINARY, ["--version"], { env: { PATH: "/usr/bin:/bin", HOME: os.tmpdir() } });
    let text = ""; child.stdout.on("data", (chunk) => { text += chunk; });
    child.on("error", reject); child.on("close", () => resolve(text));
  });
  const found = out.match(/\b(\d+\.\d+\.\d+)\b/);
  if (!found) throw new Error(`the CLI did not report a version: ${out.slice(0, 200)}`);
  return found[1];
}

// What the pinned CLI is handed in the scheduled-task sandbox (cli-sidecar.js
// baseEnvironment), minus the credentials: the proxy key here signs nothing
// anyone checks, and a throwaway config dir keeps the real Keychain out of it.
function wireEnvironment(proxyAddress, configDir) {
  return {
    LARKSUITE_CLI_AUTH_PROXY: proxyAddress,
    LARKSUITE_CLI_PROXY_KEY: randomBytes(32).toString("base64url"),
    LARKSUITE_CLI_APP_ID: "cli_119f64c614af8232",
    LARKSUITE_CLI_BRAND: "feishu",
    LARKSUITE_CLI_DEFAULT_AS: "user",
    LARKSUITE_CLI_STRICT_MODE: "user",
    LARKSUITE_CLI_REMOTE_META: "off",
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
    LARKSUITE_CLI_CONFIG_DIR: configDir,
    PATH: process.env.PATH,
    HOME: process.env.HOME,
  };
}

const workbook = {
  create_time: "2026-09-18T06:14:44.000Z", modified_time: "2026-09-18T06:14:44.000Z", revision: 0,
  sheets: [{ chart_count: 0, column_count: 20, float_image_count: 0, index: 0, is_hidden: false, merged_cells_count: 0,
    pivot_table_count: 0, resource_type: "sheet", row_count: 200, sheet_id: RES.sheetSub, sheet_name: "Sheet1" }],
  title: "MyDouBao 测试-sheet-勿删", token: RES.sheet,
};
const cellRanges = {
  warning_message: "", has_more: false, revision: 1,
  ranges: [{ actual_range: `${RES.sheetSub}!A1:C2`, row_indices: [1, 2], col_indices: ["A", "B", "C"],
    cells: [[{ value: "名称" }, { value: "数量" }, { value: "备注" }], [{ value: "样例" }, { value: 1 }, { value: null }]] }],
};

// Canned Feishu envelopes, keyed loosely by path. Each responder gets the
// request and a per-case call counter so pagination can be answered honestly.
function respond(method, pathname, url, body, calls) {
  const ok = data => ({ status: 200, payload: { code: 0, msg: "success", data } });
  // One message is enough to make the CLI do whatever it does per message --
  // by default it asks for each message's reactions as well.
  if (method === "GET" && pathname === "/open-apis/im/v1/messages") return ok({ has_more: false, page_token: "", items: [{
    message_id: "om_recorder00000000000000000001", msg_type: "text", create_time: "1758000000000", update_time: "1758000000000",
    chat_id: RES.chat, sender: { id: "ou_recorder0000000000000000001", id_type: "open_id", sender_type: "user" },
    body: { content: JSON.stringify({ text: "录制样例" }) } }] });
  let match;
  if (method === "GET" && pathname === "/open-apis/wiki/v2/spaces/get_node") {
    const token = url.searchParams.get("token");
    const target = { [RES.wikiDoc]: ["docx", RES.docx], [RES.wikiSheet]: ["sheet", RES.sheet], [RES.wikiBase]: ["bitable", RES.base] }[token];
    if (!target) return { status: 200, payload: { code: 131005, msg: "node not found" } };
    return ok({ node: { space_id: "spcFake01", node_token: token, obj_token: target[1], obj_type: target[0], title: "录制样例",
      has_child: false, obj_create_time: "1758000000", obj_edit_time: "1758000000", creator: "ou_recorder", owner: "ou_recorder", node_type: "origin" } });
  }
  if (method === "POST" && (match = /^\/open-apis\/sheet_ai\/v2\/spreadsheets\/[A-Za-z0-9_-]+\/tools\/invoke_read$/.exec(pathname))) {
    const tool = body?.tool_name;
    if (tool === "get_workbook_structure") return ok({ output: JSON.stringify(workbook) });
    if (tool === "get_cell_ranges") return ok({ output: JSON.stringify(cellRanges) });
    return { status: 200, payload: { code: 99991672, msg: `recorder does not implement tool ${tool}` } };
  }
  if (method === "POST" && (match = /^\/open-apis\/docs_ai\/v1\/documents\/([A-Za-z0-9_-]+)\/fetch$/.exec(pathname))) {
    return ok({ document: { document_id: match[1], revision_id: "1", content: "<docx><p>录制样例正文</p></docx>" } });
  }
  if (method === "GET" && (match = /^\/open-apis\/base\/v3\/bases\/([A-Za-z0-9_-]+)$/.exec(pathname))) {
    return ok({ base: { app_token: match[1], name: "MyDouBao 测试-base-勿删", revision: 1 } });
  }
  if (method === "GET" && (match = /^\/open-apis\/base\/v3\/bases\/([A-Za-z0-9_-]+)\/tables$/.exec(pathname))) {
    return ok({ has_more: false, total: 1, items: [{ table_id: RES.baseTable, name: "数据表", revision: 1 }] });
  }
  if (method === "GET" && (match = /^\/open-apis\/base\/v3\/bases\/([A-Za-z0-9_-]+)\/tables\/([A-Za-z0-9_-]+)\/fields$/.exec(pathname))) {
    return ok({ has_more: false, total: 2, items: [{ field_id: "fldName01", field_name: "名称", type: 1, ui_type: "Text" }, { field_id: "fldCount1", field_name: "数量", type: 2, ui_type: "Number" }] });
  }
  if (method === "GET" && (match = /^\/open-apis\/base\/v3\/bases\/([A-Za-z0-9_-]+)\/tables\/([A-Za-z0-9_-]+)\/records$/.exec(pathname))) {
    // First page claims more, the second ends it: auto-pagination, if the CLI
    // does any, shows up as a second recorded request.
    const first = (calls.get(`${method} ${pathname}`) ?? 1) === 1;
    return ok({ has_more: first, total: 2, items: [{ record_id: `recPage${first ? "One" : "Two"}`, fields: { 名称: "样例", 数量: 1 } }] });
  }
  if (method === "POST" && /records\/batch_get$/.test(pathname)) {
    return ok({ records: (body?.record_id_list ?? []).map(id => ({ record_id: id, fields: { 名称: "样例", 数量: 1 } })) });
  }
  if (method === "POST" && /records\/search$/.test(pathname)) {
    return ok({ has_more: false, total: 1, items: [{ record_id: "recSearchHit", fields: { 名称: "样例" } }] });
  }
  return { status: 200, payload: { code: 99991672, msg: `recorder has no canned answer for ${method} ${pathname}` } };
}

// Every read a scheduled task is known or expected to reach for, on both direct
// and Wiki-node links. Command text is recorded verbatim for provenance.
const CASES = [
  { name: "docs +fetch（docx 直链）", args: ["docs", "+fetch", "--doc", `${ORIGIN}/docx/${RES.docx}`, "--as", "user", "--doc-format", "xml", "--detail", "simple", "--format", "json"] },
  { name: "docs +fetch（Wiki 文档节点链接）", args: ["docs", "+fetch", "--doc", `${ORIGIN}/wiki/${RES.wikiDoc}`, "--as", "user", "--doc-format", "xml", "--detail", "simple", "--format", "json"] },
  { name: "sheets +workbook-info（表格直链）", args: ["sheets", "+workbook-info", "--url", `${ORIGIN}/sheets/${RES.sheet}`, "--as", "user", "--format", "json"] },
  { name: "sheets +workbook-info（Wiki 表格节点链接）", args: ["sheets", "+workbook-info", "--url", `${ORIGIN}/wiki/${RES.wikiSheet}`, "--as", "user", "--format", "json"] },
  { name: "sheets +cells-get（直链，带 --sheet-id）", args: ["sheets", "+cells-get", "--url", `${ORIGIN}/sheets/${RES.sheet}`, "--sheet-id", RES.sheetSub, "--range", "A1:C10", "--as", "user", "--format", "json"] },
  { name: "sheets +cells-get（直链，不给工作表定位）", args: ["sheets", "+cells-get", "--url", `${ORIGIN}/sheets/${RES.sheet}`, "--range", "A1:C10", "--as", "user", "--format", "json"] },
  { name: "sheets +cells-get（Wiki 节点链接，带 --sheet-id）", args: ["sheets", "+cells-get", "--url", `${ORIGIN}/wiki/${RES.wikiSheet}`, "--sheet-id", RES.sheetSub, "--range", "A1:C10", "--as", "user", "--format", "json"] },
  { name: "wiki +node-get（Wiki 文档节点链接）", args: ["wiki", "+node-get", "--node-token", `${ORIGIN}/wiki/${RES.wikiDoc}`, "--as", "user", "--format", "json"] },
  { name: "base +url-resolve（Wiki 多维表格节点链接）", args: ["base", "+url-resolve", "--url", `${ORIGIN}/wiki/${RES.wikiBase}`, "--as", "user", "--format", "json"] },
  { name: "base +url-resolve（多维表格直链）", args: ["base", "+url-resolve", "--url", `${ORIGIN}/base/${RES.base}`, "--as", "user", "--format", "json"] },
  { name: "base +base-get", args: ["base", "+base-get", "--base-token", RES.base, "--as", "user", "--format", "json"] },
  { name: "base +table-list", args: ["base", "+table-list", "--base-token", RES.base, "--as", "user", "--format", "json"] },
  { name: "base +field-list", args: ["base", "+field-list", "--base-token", RES.base, "--table-id", RES.baseTable, "--as", "user", "--format", "json"] },
  { name: "base +record-list", args: ["base", "+record-list", "--base-token", RES.base, "--table-id", RES.baseTable, "--as", "user", "--format", "json"] },
  { name: "base +record-get", args: ["base", "+record-get", "--base-token", RES.base, "--table-id", RES.baseTable, "--record-id", "recFake000001", "--as", "user", "--format", "json"] },
  { name: "base +record-search", args: ["base", "+record-search", "--base-token", RES.base, "--table-id", RES.baseTable, "--keyword", "测试", "--search-field", "名称", "--as", "user", "--format", "json"] },
  // Chats were missing from the first recording, and the gap was real: the
  // message list carries three query parameters egress did not allow.
  { name: "im +chat-messages-list（默认）", args: ["im", "+chat-messages-list", "--chat-id", RES.chat, "--as", "user", "--format", "json"] },
  { name: "im +chat-messages-list --no-reactions", args: ["im", "+chat-messages-list", "--chat-id", RES.chat, "--no-reactions", "--as", "user", "--format", "json"] },
];

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(BINARY, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

const configDir = await mkdtemp(path.join(os.tmpdir(), "k1a-cli-config-"));
const requests = [];
const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", chunk => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, "http://recorder.invalid");
    let parsed = null;
    if (body.length) { try { parsed = JSON.parse(body.toString("utf8")); } catch { parsed = null; } }
    const key = `${req.method} ${url.pathname}`, count = requests.filter(r => r.key === key).length + 1;
    requests.push({ key, seq: requests.length + 1, method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), ...(parsed !== null ? { body: parsed } : body.length ? { bodyRawLength: body.length } : {}) });
    const answer = respond(req.method, url.pathname, url, parsed, new Map([[key, count]]));
    const payload = Buffer.from(JSON.stringify(answer.payload));
    res.writeHead(answer.status, { "content-type": "application/json", "content-length": String(payload.length) });
    res.end(payload);
  });
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });

try {
  const address = `http://127.0.0.1:${server.address().port}`;
  const cases = [];
  for (const item of CASES) {
    const before = requests.length;
    const result = await runCli(item.args, wireEnvironment(address, configDir));
    const sequence = requests.slice(before).map(({ key, seq, ...rest }) => rest);
    let outcome = null;
    try { outcome = JSON.parse(result.stdout); } catch { /* validation errors print JSON too; keep raw on mismatch */ }
    cases.push({ name: item.name, command: `lark-cli ${item.args.join(" ")}`, exitCode: result.code,
      cliOk: outcome?.ok ?? null, cliError: outcome?.error?.message ?? (result.code !== 0 ? result.stderr.trim().slice(0, 300) : null),
      requests: sequence });
    process.stdout.write(`${result.code === 0 ? "ok" : `exit ${result.code}`}  ${item.name}  → ${sequence.map(r => `${r.method} ${r.path}`).join(" ; ") || "（无请求）"}\n`);
  }
  const fixture = {
    provenance: {
      purpose: "K1a：定时任务可用的飞书读取命令，内置 lark-cli 实际发出的 OpenAPI 请求序列",
      recordedAt: new Date().toISOString(),
      // What the binary says it is, not what the lock expects: the test holds the two together.
      cliVersion: await cliVersion(),
      binarySha256: createHash("sha256").update(await import("node:fs/promises").then(fs => fs.readFile(BINARY))).digest("hex"),
      method: "node scripts/record-cli-read-shapes.js（loopback 假 sidecar 录制；无真实飞书调用、无凭据）",
      sidecarEnvironment: "与 bin/sandbox/run.js 相同（LARKSUITE_CLI_AUTH_PROXY 等，见 cli-sidecar.js baseEnvironment）",
      resources: { origin: ORIGIN, ...RES, note: "虚构的资源：录制只经本机回环，录下的是 CLI 为每种链接构造的请求" },
    },
    cases,
  };
  await writeFile(OUTPUT, `${JSON.stringify(fixture, null, 2)}\n`);
  process.stdout.write(`\n已写入 ${path.relative(ROOT, OUTPUT)}（${cases.length} 个命令，${requests.length} 个请求）\n`);
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(configDir, { recursive: true, force: true });
}
