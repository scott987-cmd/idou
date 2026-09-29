import assert from "node:assert/strict";
import test from "node:test";
import { SaasFeishuCliProvider } from "../src/providers/feishu/saas-cli-provider.js";
import { feishuFailure } from "../src/providers/feishu/document-errors.js";

function fakeRunner(responses, calls) {
  return async (binary, args) => {
    calls.push({ binary, args });
    return responses.shift();
  };
}

test("reads version and embedded skills through the provider boundary", async () => {
  const calls = [];
  const provider = new SaasFeishuCliProvider(
    { binary: process.execPath, profile: "tenant-a" },
    fakeRunner(
      [
        { code: 0, stdout: "lark-cli version 1.0.78\n", stderr: "" },
        { code: 0, stdout: JSON.stringify({ ok: true, skills: [{ name: "lark-doc" }] }), stderr: "" },
      ],
      calls,
    ),
  );

  assert.equal(await provider.version(), "1.0.78");
  assert.deepEqual(await provider.listSkills(), [{ name: "lark-doc" }]);
  assert.deepEqual(calls[0], { binary: process.execPath, args: ["--version", "--profile", "tenant-a"] });
});

test("blocks profile injection and unconfirmed high-risk flags", async () => {
  const provider = new SaasFeishuCliProvider({}, async () => ({ code: 0, stdout: "", stderr: "" }));
  await assert.rejects(provider.invoke(["--profile", "other"]), /profile is owned/);
  await assert.rejects(provider.invoke(["approval", "approve", "--yes"]), /explicit confirmation/);
});

test("rejects skill path traversal", async () => {
  const provider = new SaasFeishuCliProvider({}, async () => ({ code: 0, stdout: "", stderr: "" }));
  await assert.rejects(provider.readSkill("lark-doc/../secret"), /invalid Feishu skill path/);
});

// Keyword search is how a document gets picked by name instead of by link, so
// the projection has to be as strict as the reader's: a row the application
// could not open must never appear as something the user can click.
function searchProvider(rows, { hasMore = false, pageToken = undefined, user = "ou_fixture" } = {}) {
  const calls = [];
  const provider = new SaasFeishuCliProvider({ binary: process.execPath, profile: null, environment: () => ({}) }, async (binary, args) => {
    calls.push(args);
    if (args[0] === "api") return { code: 0, stdout: JSON.stringify({ ok: true, identity: "user", data: { open_id: typeof user === "function" ? user(calls.length) : user, tenant_key: "tenant_fixture" } }), stderr: "" };
    return { code: 0, stdout: JSON.stringify({ ok: true, identity: "user", data: { results: rows, has_more: hasMore, ...(pageToken === undefined ? {} : { page_token: pageToken }) } }), stderr: "" };
  });
  return { provider, calls };
}
// The live endpoint returns {entity_type, result_meta:{...}, title_highlighted,
// summary_highlighted}; the CLI's own table describes its pretty output, not this.
const searchRow = (url, { title = "季度方案", summary, meta = {} } = {}) => ({
  entity_type: "DOC", title_highlighted: title, ...(summary === undefined ? {} : { summary_highlighted: summary }),
  result_meta: { url, token: "SearchToken123", doc_types: "DOCX", owner_name: "测试用户",
    update_time_iso: "2026-09-01T10:00:00+08:00", is_cross_tenant: false, ...meta },
});

test("document search returns only openable rows and strips server highlight markup", async () => {
  const { provider, calls } = searchProvider([
    searchRow("https://fixture.feishu.cn/docx/SearchDocOne#doxcnMatchedBlock", { title: "<h>季度</h>方案", summary: "第一段 <hb>方案</hb> 摘要" }),
    searchRow("https://fixture.feishu.cn/docx/SearchDocOne"),
    searchRow("https://fixture.feishu.cn/base/SearchBaseOne"),
    searchRow("ftp://fixture.feishu.cn/docx/SearchDocTwo"),
    searchRow("https://fixture.feishu.cn/docx/SearchOtherTenant", { meta: { is_cross_tenant: true } }),
    searchRow("https://fixture.feishu.cn/wiki/SearchWikiOne", { title: "研发规范" }),
  ]);
  const result = await provider.searchDocuments({ query: "方案" });
  // The matched-block anchor is dropped so a picked result opens the whole document.
  assert.deepEqual(result.documents.map(row => row.url), [
    "https://fixture.feishu.cn/docx/SearchDocOne", "https://fixture.feishu.cn/wiki/SearchWikiOne"]);
  assert.equal(result.documents[0].title, "季度方案");
  assert.equal(result.documents[0].summary, "第一段 方案 摘要");
  assert.equal(result.documents[0].editedAt, "2026-09-01T10:00:00+08:00");
  assert.equal(result.documents[0].owner, "测试用户");
  assert.equal(result.documents[0].type, "docx");
  assert.equal(result.next, null); assert.equal(result.excluded, 4);
  const search = calls.find(args => args[1] === "+search");
  assert.deepEqual(search, ["drive", "+search", "--query", "方案", "--doc-types", "docx,doc,wiki",
    "--page-size", "15", "--sort", "edit_time", "--as", "user", "--format", "json"]);
});

test("resource search also returns openable Base rows through the same provider contract", async () => {
  const { provider, calls } = searchProvider([
    searchRow("https://fixture.feishu.cn/base/SearchBaseOne?table=tblSales123", { title: "销售看板", meta: { doc_types: "BITABLE" } }),
    searchRow("https://fixture.feishu.cn/docx/SearchDocOne"),
  ]);
  const result = await provider.searchDocuments({ query: "销售", kind: "base" });
  assert.deepEqual(result.documents.map(row => ({ kind: row.kind, url: row.url, title: row.title })), [
    { kind: "base", url: "https://fixture.feishu.cn/base/SearchBaseOne?table=tblSales123", title: "销售看板" },
  ]);
  assert.equal(result.excluded, 1);
  assert.deepEqual(calls.find(args => args[1] === "+search"), ["drive", "+search", "--query", "销售", "--doc-types", "bitable",
    "--page-size", "15", "--sort", "edit_time", "--as", "user", "--format", "json"]);
});

test("document search refuses an unusable query, page and paging response, and a changed identity", async () => {
  for (const query of ["", "   ", "方".repeat(31), `控制符${String.fromCharCode(7)}`]) {
    const { provider } = searchProvider([]);
    await assert.rejects(provider.searchDocuments({ query }), /关键词/);
  }
  const { provider: sized } = searchProvider([]);
  await assert.rejects(sized.searchDocuments({ query: "方案", pageSize: 21 }), /分页大小/);
  await assert.rejects(sized.searchDocuments({ query: "方案", pageToken: "带 空格" }), /翻页标记/);
  await assert.rejects(sized.searchDocuments({ query: "方案", kind: "bitable" }), /内容类型/);

  // has_more without a usable token would silently truncate the user's results.
  const { provider: truncated } = searchProvider([searchRow("https://fixture.feishu.cn/docx/SearchDocOne")], { hasMore: true });
  await assert.rejects(truncated.searchDocuments({ query: "方案" }), /分页不完整/);

  const { provider: switched } = searchProvider([searchRow("https://fixture.feishu.cn/docx/SearchDocOne")],
    { user: index => index === 1 ? "ou_fixture" : "ou_other" });
  await assert.rejects(switched.searchDocuments({ query: "方案" }), /身份已变化/);
});

// A refused scope is the one failure an operator can fix in a minute, but only
// if the message says which permission is missing.
test("a refused scope names the permissions Feishu asked for, and ignores malformed ones", () => {
  const refusal = missing => ({ code: 3, stdout: "", stderr: JSON.stringify({ ok: false, error: { type: "authorization", subtype: "missing_scope", code: 99991679, message: "unauthorized", ...(missing ? { missing_scopes: missing } : {}) } }) });
  assert.match(feishuFailure(refusal(["search:docs:read"])).message, /缺少 search:docs:read.*FEISHU_CLI_SCOPES/s);
  assert.match(feishuFailure(refusal(["im:chat:read", "im:chat"])).message, /缺少 im:chat:read 或 im:chat/);
  for (const bad of [undefined, [], ["坏 名字"], [{}], ["x".repeat(200)]]) {
    const message = feishuFailure(refusal(bad)).message;
    assert.match(message, /授权范围不足/);
    assert.doesNotMatch(message, /缺少/);
  }
});

// Found live: `drive +upload` prints progress lines before its JSON envelope, so
// parsing the whole output lost Feishu's reason, and a tenant's size refusal
// (1061043 at upload_prepare) read as a login, network or permission failure.
test("a refusal printed after CLI progress lines still carries Feishu's reason", () => {
  const envelope = { ok: false, identity: "user", error: { type: "api", subtype: "quota_exceeded", code: 1061043, message: "file size beyond limit.", hint: "reduce the request volume or free quota" } };
  const stderr = `Uploading: mydoubao-x.mp4 (20.0 MB) -> folder fldc...der1\nFile exceeds 20MB, using multipart upload\n${JSON.stringify(envelope, null, 2)}\n`;
  const sized = feishuFailure({ code: 1, stdout: "", stderr }).message;
  assert.match(sized, /单个文件大小/);
  assert.match(sized, /file size beyond limit/);
  assert.doesNotMatch(sized, /登录、网络/);
  const other = feishuFailure({ code: 1, stdout: "", stderr: `progress\n${JSON.stringify({ ok: false, error: { type: "api", subtype: "quota_exceeded", code: 99991400, message: "request trigger frequency limit" } })}` }).message;
  assert.match(other, /配额或大小上限/);
  assert.match(other, /frequency limit/);
  // Output that never becomes JSON still gets the generic sentence.
  assert.match(feishuFailure({ code: 1, stdout: "", stderr: "Uploading…\nnot json {" }).message, /飞书服务调用失败/);
});

// 2026-09-24, reproduced on a live document with the pinned 1.0.96: an edit
// aimed at a block that had been replaced since it was read -- and a str_replace
// whose text was gone -- exits 1 with no error field at all, only
// result "failed" and degrade_code=1011 in a warning. Read for an error field,
// it said to check the login, network and permissions.
test("an edit that changed nothing says the document moved on, not that the login failed", () => {
  const recorded = {"ok": false, "identity": "user", "data": {"document": {"revision_id": 4, "url": "https://tenant.feishu.cn/docx/SyntheticDocument123"}, "result": "failed", "warnings": ["degrade_code=1011,msg=Instruction produced no document changes. The instruction content may be identical to the current document, or the format is unexpected; check the instruction content and retry"]}};
  const stale = feishuFailure({ code: 1, stdout: JSON.stringify(recorded, null, 2), stderr: "" }).message;
  assert.match(stale, /文档读取之后又被改过/);
  assert.match(stale, /重新读取文档/);
  assert.match(stale, /没有写入任何内容/);
  assert.match(stale, /degrade_code=1011/, "Feishu's own words ride along");
  assert.doesNotMatch(stale, /登录、网络/);
  // Another warning on a failed edit is still Feishu's reason, not the generic sentence.
  const other = { ...recorded, data: { ...recorded.data, warnings: ["degrade_code=2001,msg=something else"] } };
  assert.match(feishuFailure({ code: 1, stdout: JSON.stringify(other), stderr: "" }).message, /没有完成这次修改.*degrade_code=2001/s);
  // A success with a warning is not a failure this sentence is for.
  const succeeded = { ...recorded, ok: true, data: { ...recorded.data, result: "success" } };
  assert.match(feishuFailure({ code: 1, stdout: JSON.stringify(succeeded), stderr: "" }).message, /飞书服务调用失败/);
});

// 2026-09-26: the control plane restarted under a running site refresh. What
// the person read was 「飞书服务调用失败……飞书返回：HTTP 502: <html>…nginx…」 and
// then 「飞书拒绝了这次操作……飞书返回：feishu_cli_proxy_denied」 -- neither came
// from Feishu. The envelopes are what the pinned CLI (1.0.96) printed, recorded
// against a local stand-in answering as nginx and as the control plane's proxy.
test("our own server's refusals and gateway pages are not said to be Feishu's", () => {
  const cli = (error) => ({ code: 1, stdout: "", stderr: `${JSON.stringify({ ok: false, identity: "user", error }, null, 2)}\n` });
  const page = feishuFailure(cli({ type: "network", subtype: "server_error", code: 502,
    message: "HTTP 502: <html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n<hr><center>nginx/1.22.1</center>\r\n</body>\r\n</html>" })).message;
  assert.match(page, /网关返回了错误页（HTTP 502）/);
  assert.match(page, /i豆 服务端正在重启/);
  assert.doesNotMatch(page, /<|nginx|飞书返回/, "no page, and not Feishu's words");
  const denied = feishuFailure(cli({ type: "api", subtype: "unknown", code: 403, message: "feishu_cli_proxy_denied" })).message;
  assert.match(denied, /i豆 服务端没有放行/);
  assert.match(denied, /自动重新连接/);
  assert.doesNotMatch(denied, /飞书拒绝|飞书返回/);
  assert.match(feishuFailure(cli({ type: "api", subtype: "unknown", code: 429, message: "feishu_cli_proxy_busy" })).message, /代办的飞书调用太多/);
  assert.match(feishuFailure(cli({ type: "api", subtype: "unknown", code: 502, message: "feishu_cli_proxy_unavailable" })).message, /没能连上飞书/);
  const method = feishuFailure(cli({ type: "api", subtype: "unknown", code: 405, message: "feishu_cli_method_denied" })).message;
  assert.match(method, /按安全规则拒绝.*feishu_cli_method_denied/);
  assert.doesNotMatch(method, /飞书拒绝/);
  // Feishu's own refusals are still Feishu's.
  assert.match(feishuFailure(cli({ type: "authorization", code: 99991663, message: "permission denied: no access" })).message, /飞书拒绝了这次操作.*飞书返回：permission denied/s);
});

// Feishu returns null for an empty collection. Treating that as a broken
// response made every no-results search look like an integration failure.
test("an empty result set comes back as no results, not as a broken response", async () => {
  const empty = (data, extra = {}) => {
    const provider = new SaasFeishuCliProvider({ binary: process.execPath, profile: null, environment: () => ({}) }, async (binary, args) => {
      if (args[0] === "api" || args[0] === "auth") return { code: 0, stdout: JSON.stringify({ ok: true, identity: "user", data: { open_id: "ou_fixture", tenant_key: "tenant_fixture" } }), stderr: "" };
      return { code: 0, stdout: JSON.stringify({ ok: true, identity: "user", data }), stderr: "" };
    });
    return Object.assign(provider, extra);
  };
  const documents = await empty({ results: null, has_more: false }).searchDocuments({ query: "方案" });
  assert.deepEqual(documents.documents, []); assert.equal(documents.excluded, 0); assert.equal(documents.next, null);

  const groups = await empty({ chats: null, has_more: false }).messages.searchGroups("测试");
  assert.deepEqual(groups.groups, []); assert.equal(groups.excluded, 0);

  const people = await empty({ users: null, has_more: false }).messages.search("张三");
  assert.deepEqual(people.users, []); assert.equal(people.excluded, 0);

  const chats = await empty({ chats: null, has_more: false }).chatReader.list(null, undefined);
  assert.deepEqual(chats.chats, []);

  // A collection that is present but not a list is still a broken response.
  await assert.rejects(empty({ results: "nope", has_more: false }).searchDocuments({ query: "方案" }), /格式不兼容/);
  await assert.rejects(empty({ chats: "nope", has_more: false }).messages.searchGroups("测试"), /格式不兼容/);
});
