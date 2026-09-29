import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { makeScheduleCapability, scheduleFeishuRequestAllowed } from "../src/control-plane/schedule-capability.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";

// K1a 的放行/拒绝矩阵：fixture 里是钉住的内置 lark-cli 在假 sidecar 上真实
// 发出的请求序列（scripts/record-cli-read-shapes.js 录制，含来源信息），这里
// 把每个请求逐一交给出口判定器，钉住它当前的行为。K1b 改判定器时必须能指出
// 这张表里哪几格被翻转、为什么；顺手改别的格会在这里炸出来。
const FIXTURE = JSON.parse(await readFile(new URL("./fixtures/schedule-cli-read-shapes.json", import.meta.url), "utf8"));
const LOCK = JSON.parse(await readFile(new URL("../upstreams.lock.json", import.meta.url), "utf8"));
const WHO = { tenantId: "tenant-a", userId: "person-a" };
const { docx: DOCX, sheet: SHEET, sheetSub: SHEET_SUB, base: BASE, baseTable: BASE_TABLE, chat: CHAT } = FIXTURE.provenance.resources;

function capability(resources) {
  return makeScheduleCapability({ feishu: SAAS_FEISHU, who: WHO, validUntil: 2_000_000_000_000, resources }).capability;
}
// 「整本 / 单张」按请求所属的资源族解释：电子表格是工作簿 / 单张工作表，
// 多维表格是整个 Base / 单张数据表。文档没有子资源，只有一列。
const CAPS = {
  document: capability([{ kind: "document", reference: `https://feishu.cn/docx/${DOCX}` }]),
  sheetWhole: capability([{ kind: "sheet", reference: `https://feishu.cn/sheets/${SHEET}` }]),
  sheetSingle: capability([{ kind: "sheet", reference: `https://feishu.cn/sheets/${SHEET}?sheet=${SHEET_SUB}` }]),
  baseWhole: capability([{ kind: "base", reference: `https://feishu.cn/base/${BASE}` }]),
  baseSingle: capability([{ kind: "base", reference: `https://feishu.cn/base/${BASE}?table=${BASE_TABLE}` }]),
  chat: capability([{ kind: "chat", id: CHAT }]),
};

// 还原出口看到的路径：sidecar 透传的 x-mydoubao-feishu-path 带查询串。
function wirePath(request) {
  const query = Object.entries(request.query ?? {}).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  return query ? `${request.path}?${query}` : request.path;
}
function allowed(cap, request) {
  const body = request.body !== undefined ? Buffer.from(JSON.stringify(request.body)) : undefined;
  return scheduleFeishuRequestAllowed(cap, request.method, wirePath(request), body);
}
// 单元格读取按什么指定工作表：sheet_id 能和授权里固化的 ID 对上，名字不能。
function sheetAddress(request) {
  let input = {}; try { input = JSON.parse(request.body?.input ?? "{}"); } catch { /* recorded bodies are JSON */ }
  return input.sheet_id !== undefined ? "id" : input.sheet_name !== undefined ? "name" : "none";
}
const labelOf = request => {
  const query = Object.entries(request.query ?? {}).map(([k, v]) => `${k}=${v}`).join("&");
  return `${request.method} ${request.path}${query ? "?" + query : ""}`;
};

// 每个录制用例属于一个资源族，矩阵列出该族的「整本 / 单张」两列。
function familyOf(name) {
  if (name.startsWith("docs")) return { whole: "document", single: null };
  if (name.startsWith("sheets")) return { whole: "sheetWhole", single: "sheetSingle" };
  if (name.startsWith("base") || name.startsWith("wiki")) return { whole: "baseWhole", single: "baseSingle" };
  // A chat has no sub-resource: one column.
  if (name.startsWith("im")) return { whole: "chat", single: null };
  throw new Error(`没有资源族：${name}`);
}

test("fixture 绑定钉住的 CLI：版本与摘要必须和 upstreams.lock.json 一致，升级后必须重录", () => {
  assert.equal(FIXTURE.provenance.cliVersion, LOCK.feishu.version);
  assert.equal(FIXTURE.provenance.binarySha256, LOCK.feishu.bundledArtifacts["darwin-arm64"].sha256);
  assert.ok(FIXTURE.cases.length >= 15, "录制覆盖面收窄了");
  for (const item of FIXTURE.cases) {
    assert.ok(item.requests.length >= 1, `${item.name} 没有录到任何请求`);
    assert.equal(item.requests[0].method + " " + item.requests[0].path, "GET /open-apis/authen/v1/user_info",
      `${item.name} 的第一个请求应当是身份预检（STRICT_MODE=user 的实测行为）`);
  }
});

// 期望矩阵：钉住判定器 K1b 之后的行为。K1b 翻转了三格（列数据表只在整本授权下
// 放行；字段、记录列表的 limit/offset），并按录到的取值放行了会话消息列表。
// 其余拒绝是要继续保持的拒绝。
const EXPECTED = [
  // user_info 预检：无条件放行（判定器第一条规则）。
  { match: r => r.path === "/open-apis/authen/v1/user_info", whole: true, single: true, note: "身份预检，无条件放行" },
  // docs +fetch：docx token 放行；Wiki 节点 token 不放行（能力清单只存固化后的底层 token）。
  { match: r => r.path === `/open-apis/docs_ai/v1/documents/${DOCX}/fetch`, whole: true, single: null, note: "固化后的 docx token" },
  { match: r => /^\/open-apis\/docs_ai\/v1\/documents\/[A-Za-z0-9_-]+\/fetch$/.test(r.path), whole: false, single: null,
    note: "Wiki 节点 token 直接进了 docs_ai：拒绝。docs +fetch 不会自己解析节点（实测）" },
  // sheets：结构查询在单张授权下拒绝（K1b 维持）；带 sheet_id 的读两种都放行。
  { match: r => r.body?.tool_name === "get_workbook_structure", whole: true, single: false,
    note: "整本放行；单张拒绝——入参没有 sheet_id，会暴露整本结构（K1b 设计点 3 维持拒绝）" },
  { match: r => r.body?.tool_name === "get_cell_ranges" && sheetAddress(r) === "id", whole: true, single: true,
    note: "带 sheet_id 的单元格读取：整本/单张都放行。已实测：给 --sheet-id 时 CLI 不会先自发做结构查询" },
  { match: r => r.body?.tool_name === "get_cell_ranges" && sheetAddress(r) === "name", whole: true, single: false,
    note: "按名字指定工作表（1.0.96 起，不给 --sheet-id 时先查结构、再按 sheet_name 读）：整本放行；单张拒绝——名字对不上授权里固化的工作表 ID" },
  // Wiki 节点解析：不在出口放行范围（K1b 不变量：节点链接不进运行上下文）。
  // 1.0.78 用 get_node，1.0.96 起用 node_by_token；判定器没有任何 Wiki 规则，两者都落在默认拒绝。
  { match: r => ["/open-apis/wiki/v2/spaces/get_node", "/open-apis/wiki/v2/spaces/node_by_token"].includes(r.path), whole: false, single: false,
    note: "节点可以被改指，解析节点永远拒绝（get_node / node_by_token）；agent 只能拿固化后的底层链接" },
  // base：元信息整本放行/单张拒绝；列表类请求被两处各别卡住（K1b 目标）。
  { match: r => /^\/open-apis\/base\/v3\/bases\/[A-Za-z0-9_-]+$/.test(r.path), whole: true, single: false, note: "Base 元信息" },
  { match: r => /\/tables$/.test(r.path), whole: true, single: false,
    note: "列数据表：整本授权放行（Base 自身的元数据）；单张授权拒绝——列表会暴露旁边的数据表（K1b）" },
  { match: r => /\/fields$/.test(r.path), whole: true, single: true,
    note: "字段列表：limit/offset 只收十进制整数；授权的那张表整本/单张都放行（K1b）" },
  { match: r => /\/records$/.test(r.path), whole: true, single: true,
    note: "记录列表：同上（K1b）" },
  { match: r => /\/records\/batch_get$/.test(r.path), whole: true, single: true, note: "按 ID 取记录：整本/单张（同一张）都放行" },
  { match: r => /\/records\/search$/.test(r.path), whole: false, single: false,
    note: "记录搜索：判定器没有这条路径的规则。是否放行是 K1b 之外的新决策，先如实记录" },
  { match: r => r.path === "/open-apis/im/v1/messages", whole: true, single: null,
    note: "会话消息列表：CLI 每次都带 card_msg_content_type/only_thread_root_messages/with_sender_name，按录到的取值放行（K1b）" },
  { match: r => r.path === "/open-apis/im/v1/messages/reactions/batch_query", whole: false, single: null,
    note: "表情回应：请求体只有消息 ID，出口无法确认它们属于授权的会话，维持拒绝；资源段要求 --no-reactions" },
];

test("放行/拒绝矩阵：录制到的每个请求 × 整本/单张授权", t => {
  const rows = [];
  for (const item of FIXTURE.cases) {
    const family = familyOf(item.name);
    for (const request of item.requests) {
      const label = labelOf(request);
      const row = { case: item.name, request: label, whole: allowed(CAPS[family.whole], request),
        single: family.single ? allowed(CAPS[family.single], request) : null };
      const expected = EXPECTED.find(entry => entry.match(request));
      assert.ok(expected, `录到了判定器矩阵没有覆盖的请求：${item.name} → ${label}；先把它登记进矩阵再评估`);
      assert.equal(row.whole, expected.whole, `${label}（整本）`);
      if (row.single !== null) assert.equal(row.single, expected.single, `${label}（单张）`);
      // 同一资源族里同一请求在不同用例里结论必须一致，否则矩阵没法画。
      // invoke_read 由请求体里的 tool_name 分流，一致性键也得带上它。
      const key = `${family.whole}|${request.method} ${request.path}|${request.body?.tool_name ?? ""}|${sheetAddress(request)}`;
      const prior = rows.find(r => r.key === key);
      if (prior) assert.deepEqual([row.whole, row.single], [prior.whole, prior.single], `${label} 的结论随用例变了`);
      rows.push({ ...row, key, note: expected.note });
    }
  }
  // 交付物：矩阵本身。跑这个测试即重新生成。
  const lines = ["| 用例 | 请求 | 整本 | 单张 | 说明 |", "| --- | --- | --- | --- | --- |"];
  for (const row of rows) lines.push(`| ${row.case} | \`${row.request}\` | ${row.whole ? "放行" : "拒绝"} | ${row.single === null ? "—" : row.single ? "放行" : "拒绝"} | ${row.note} |`);
  t.diagnostic(`\n${lines.join("\n")}\n`);
});

// 每条读取链都按资源段写给 agent 的那条命令走一遍：除了身份预检，业务请求要么
// 全部放行，要么在该拒的地方拒。读法和资源段一字不差，见 scheduled-run.js。
const business = (name) => FIXTURE.cases.find(c => c.name === name).requests.filter(r => r.path !== "/open-apis/authen/v1/user_info");
test("资源段里写给 agent 的每条读法，在判定器上整条走得通", () => {
  assert.deepEqual(business("sheets +cells-get（直链，带 --sheet-id）").map(r => allowed(CAPS.sheetSingle, r)), [true]);
  assert.deepEqual(business("sheets +workbook-info（表格直链）").map(r => allowed(CAPS.sheetWhole, r)), [true]);
  for (const cap of [CAPS.baseWhole, CAPS.baseSingle]) assert.deepEqual(business("base +record-list").map(r => allowed(cap, r)), [true]);
  assert.deepEqual(business("base +table-list").map(r => allowed(CAPS.baseWhole, r)), [true]);
  assert.deepEqual(business("docs +fetch（docx 直链）").map(r => allowed(CAPS.document, r)), [true]);
  assert.deepEqual(business("im +chat-messages-list --no-reactions").map(r => allowed(CAPS.chat, r)), [true]);
  // 不按资源段读的，照样拒：Wiki 链接、单张授权下列表、默认带回应。
  assert.deepEqual(business("docs +fetch（Wiki 文档节点链接）").map(r => allowed(CAPS.document, r)), [false]);
  assert.deepEqual(business("base +table-list").map(r => allowed(CAPS.baseSingle, r)), [false]);
  assert.deepEqual(business("im +chat-messages-list（默认）").map(r => allowed(CAPS.chat, r)), [true, false]);
});

// 负行：从录到的请求出发做一处改动。每一行都对应一个放宽的方式，删掉对应的校验
// 就会在这里炸出来。
test("收窄的边界：只放行录到的参数、录到的取值、授权的会话", () => {
  const messages = FIXTURE.cases.find(c => c.name === "im +chat-messages-list --no-reactions").requests.find(r => r.path === "/open-apis/im/v1/messages");
  const tables = FIXTURE.cases.find(c => c.name === "base +table-list").requests.find(r => /\/tables$/.test(r.path));
  const records = FIXTURE.cases.find(c => c.name === "base +record-list").requests.find(r => /\/records$/.test(r.path));
  const tweak = (request, change) => ({ ...request, ...change(request) });
  const withQuery = (request, query) => tweak(request, r => ({ query: { ...r.query, ...query } }));
  const deny = (cap, request, why) => assert.equal(allowed(cap, request), false, why);
  deny(CAPS.chat, withQuery(messages, { container_id: "oc_fedcba9876543210fedcba9876543210" }), "别的会话");
  deny(CAPS.chat, withQuery(messages, { card_msg_content_type: "user_card_content" }), "没录到的卡片格式");
  deny(CAPS.chat, withQuery(messages, { with_sender_name: "yes" }), "没录到的取值");
  deny(CAPS.chat, withQuery(messages, { only_thread_root_messages: "1" }), "没录到的取值");
  assert.equal(scheduleFeishuRequestAllowed(CAPS.chat, "GET",
    `/open-apis/im/v1/messages?container_id_type=chat&container_id=${CHAT}&with_sender_name=true`), true, "对照：参数只出现一次时放行");
  assert.equal(scheduleFeishuRequestAllowed(CAPS.chat, "GET",
    `/open-apis/im/v1/messages?container_id_type=chat&container_id=${CHAT}&with_sender_name=true&with_sender_name=false`), false, "重复参数");
  for (const value of ["-1", "1.5", "1e3", "", "0x10", "1234567890"]) {
    deny(CAPS.baseWhole, withQuery(tables, { limit: value }), `limit=${value}`);
    deny(CAPS.baseWhole, withQuery(records, { offset: value }), `offset=${value}`);
  }
  deny(CAPS.baseWhole, withQuery(tables, { page_size: "50" }), "列数据表只收 limit/offset");
  deny(CAPS.baseWhole, { ...tables, method: "POST" }, "列数据表只收 GET");
  // limit/offset 只加在 base/v3 规则上。
  assert.equal(scheduleFeishuRequestAllowed(CAPS.baseWhole, "GET", `/open-apis/bitable/v1/apps/${BASE}/tables/${BASE_TABLE}/records?limit=1`), false, "bitable/v1");
  assert.equal(scheduleFeishuRequestAllowed(CAPS.document, "GET", `/open-apis/docx/v1/documents/${DOCX}/raw_content?limit=1`), false, "docx");
  assert.equal(scheduleFeishuRequestAllowed(CAPS.sheetWhole, "GET", `/open-apis/sheets/v3/spreadsheets/${SHEET}?offset=0`), false, "sheets");
  deny(CAPS.chat, withQuery(messages, { limit: "1" }), "im");
  // 1.0.96 起 CLI 会按名字读工作表。单张授权钉住的是工作表 ID，名字可能指向任何一张，
  // 所以按名字的读取在单张授权下必须拒绝，整本授权下才放行。
  const byId = FIXTURE.cases.find(c => c.name === "sheets +cells-get（直链，带 --sheet-id）").requests.find(r => r.body?.tool_name === "get_cell_ranges");
  const named = (name) => tweak(byId, r => {
    const { sheet_id: _id, ...rest } = JSON.parse(r.body.input);
    return { body: { ...r.body, input: JSON.stringify({ ...rest, sheet_name: name }) } };
  });
  deny(CAPS.sheetSingle, named("Sheet2"), "按名字读另一张工作表");
  deny(CAPS.sheetSingle, named("Sheet1"), "名字即便碰巧是授权那张也拒：出口核不了");
  assert.equal(allowed(CAPS.sheetWhole, named("Sheet2")), true, "对照：整本授权下按名字读放行");
  assert.equal(allowed(CAPS.sheetSingle, byId), true, "对照：按授权的 sheet_id 读放行");
});
