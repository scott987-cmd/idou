import test from "node:test";
import assert from "node:assert/strict";
import { ScheduleDelivery, DOCUMENT_BYTES, CHAT_CHARS, deliveryKey, deliveryStamp, documentEntry, chatEntry } from "../src/control-plane/schedule-delivery.js";
import { MAX_DELIVERIES, scheduleDeliveries, deliveryRequests } from "../src/control-plane/schedule-deliveries.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";

const OWNER = "ou_1f2e3d4c5b6a7988";
const DOC = { kind: "document", id: "DoxcnAbCdEf123456", reference: "https://tenant.feishu.cn/docx/DoxcnAbCdEf123456", label: "周报汇总" };
const CHAT = { kind: "chat", id: "oc_1234567890abcdef", label: "产品群" };
// 2026-09-28 01:00 UTC is 09:00 in Shanghai.
const NOW = Date.UTC(2026, 8, 28, 1, 0);

const schedule = (over = {}) => ({ tenant: "tenant-a", id: "s-1", owner: OWNER, title: "每天汇总", spec: { timeZone: "Asia/Shanghai" }, deliveries: [DOC, CHAT], ...over });
const WHO = { audience: "codex-model-gateway", authProvider: "feishu", tenantId: "tenant-a", userId: OWNER, cliBridge: true,
  cliDocumentWrites: true, cliMessageWrites: true, appId: "cli_fixture", expiresAt: NOW + 600_000 };

// Everything the delivery touches, recorded. `stored` is what the database
// holds when the run ends -- which is what is written to, not the claim's copy.
function harness({ stored = schedule(), who = WHO, actions = ["document.append", "message.send"], append, send, getFails = false } = {}) {
  const seen = { appends: [], sends: [], sidecars: 0, closed: 0, gets: [] };
  const delivery = new ScheduleDelivery({
    feishu: { client: {} }, controlPlaneOrigin: "https://control.example", now: () => NOW,
    sessions: { verify: (token) => (token === "parent" ? who : null) },
    sourceAccess: { current: (token) => { if (token !== "parent") throw new Error("not bound"); }, cliWriteActions: actions },
    store: { get: async (asked, id) => { seen.gets.push({ asked, id }); if (getFails) throw new Error("database away"); return stored; } },
    push: { sendToChat: async (input) => { seen.sends.push(input); return send ? send(input) : { sent: true, as: "self" }; } },
    createSidecar: (options) => ({ start: async () => { seen.sidecars += 1; seen.sidecarOptions = options;
      return { environment: () => ({}), sessionFingerprint: () => "fp", close: async () => { seen.closed += 1; } }; } }),
    createClient: () => ({ documentAuthoring: { appendToEnd: async (id, markdown, beforeDispatch) => {
      seen.appends.push({ id, markdown });
      if (append) return append(id, markdown, beforeDispatch);
      await beforeDispatch();
      return { documentId: id, title: "周报汇总", revision: "8" };
    } } }),
  });
  return { delivery, seen };
}
const run = (delivery, over = {}) => delivery.deliver({ schedule: schedule(), parentToken: "parent", runId: "run-1", report: Buffer.from("# 要点\n\n1. 上线了\n"), ...over });

test("the places are read again when the run ends: one taken off meanwhile is not written to", async () => {
  // The claim still names both; the person took the document off while the run
  // was going. What is stored now is what is written to.
  const { delivery, seen } = harness({ stored: schedule({ deliveries: [CHAT] }) });
  const lines = await run(delivery);
  assert.deepEqual(lines, ["已发到「产品群」"]);
  assert.equal(seen.appends.length, 0, "the document is not written to");
  assert.equal(seen.sidecars, 0, "and no bridge is started for it");
  assert.deepEqual(seen.gets, [{ asked: { tenantId: "tenant-a", userId: OWNER }, id: "s-1" }], "read as the owner, by the task's id");
});

test("a task that names no place writes nowhere and starts nothing", async () => {
  for (const stored of [schedule({ deliveries: [] }), null, schedule({ owner: "ou_someone_else_12345" })]) {
    const { delivery, seen } = harness({ stored });
    assert.deepEqual(await run(delivery), []);
    assert.equal(seen.sidecars + seen.sends.length + seen.appends.length, 0);
  }
});

test("a document gets the result at its end, headed with the task and its time; the chat gets the words and the link", async () => {
  const { delivery, seen } = harness();
  const lines = await run(delivery);
  assert.deepEqual(lines, ["已追加到文档《周报汇总》", "已发到「产品群」"]);
  assert.equal(seen.appends.length, 1);
  assert.equal(seen.appends[0].id, DOC.id, "the stored document id, never one from the run");
  assert.equal(seen.appends[0].markdown, "## 每天汇总 · 2026-09-28 09:00\n\n# 要点\n\n1. 上线了\n", "in the task's own time zone");
  assert.equal(seen.sidecars, 1); assert.equal(seen.closed, 1, "the bridge is closed again");
  assert.equal(seen.sidecarOptions.appId, "cli_fixture");
  const session = await seen.sidecarOptions.getSession();
  assert.equal(session.token, "parent", "as the run's own owner session");
  assert.equal(session.serverUrl, "https://control.example");
  const [sent] = seen.sends;
  assert.equal(sent.chatId, CHAT.id);
  assert.equal(sent.key, deliveryKey("run-1", CHAT.id));
  assert.equal(sent.runId, "run-1");
  assert.equal(sent.text, `定时任务「每天汇总」2026-09-28 09:00 的结果\n\n# 要点\n\n1. 上线了\n\n全文已追加到文档《周报汇总》：${DOC.reference}`);
});

test("a run whose identity is not the owner's, or no longer bound, writes nothing", async () => {
  for (const who of [{ ...WHO, userId: "ou_someone_else_12345" }, { ...WHO, tenantId: "tenant-b" }, { ...WHO, authProvider: "development" },
    { ...WHO, audience: "sandbox" }, { ...WHO, cliBridge: false }, null]) {
    const { delivery, seen } = harness({ who });
    const lines = await run(delivery);
    assert.deepEqual(lines, ["没有追加到文档《周报汇总》：这次运行的身份没有获准写入飞书", "没有发到「产品群」：这次运行的身份没有获准写入飞书"]);
    assert.equal(seen.sidecars + seen.sends.length, 0);
  }
  const { delivery, seen } = harness();
  assert.equal((await run(delivery, { parentToken: "someone-else" })).length, 2);
  assert.equal(seen.sidecars + seen.sends.length, 0);
});

test("a server or login without one kind of write says so for that kind, and still writes the other", async () => {
  const noDocuments = harness({ actions: ["message.send"] });
  assert.deepEqual(await run(noDocuments.delivery), ["没有追加到文档《周报汇总》：这个服务端或你的登录没有开启飞书文档写入", "已发到「产品群」"]);
  assert.equal(noDocuments.seen.sidecars, 0);
  // Nothing was appended, so the message carries the words and no link.
  assert.doesNotMatch(noDocuments.seen.sends[0].text, /全文已追加/);
  const noMessages = harness({ who: { ...WHO, cliMessageWrites: false } });
  assert.deepEqual(await run(noMessages.delivery), ["已追加到文档《周报汇总》", "没有发到「产品群」：这个服务端或你的登录没有开启飞书发消息"]);
  assert.equal(noMessages.seen.sends.length, 0);
});

test("an append that was sent and never answered is uncertain, said so, and not sent again", async () => {
  const { delivery, seen } = harness({ append: async (id, markdown, beforeDispatch) => { await beforeDispatch(); throw new Error("lark-cli timed out"); } });
  const lines = await run(delivery);
  assert.equal(lines[0], "追加到文档《周报汇总》的结果不确定，请打开文档核查；系统不会重试（lark-cli timed out）");
  assert.equal(seen.appends.length, 1, "one attempt");
  assert.doesNotMatch(seen.sends[0].text, /全文已追加/, "an uncertain append is not linked as done");
  assert.equal(seen.closed, 1);
});

test("an append refused before it was sent says why", async () => {
  const { delivery } = harness({ append: async () => { throw new Error("读不到这份文档的当前版本"); } });
  const lines = await run(delivery);
  assert.equal(lines[0], "没有追加到文档《周报汇总》：读不到这份文档的当前版本");
  assert.equal(lines[1], "已发到「产品群」");
});

test("a chat the control plane or Feishu refused is said in the words the notification uses", async () => {
  const { delivery } = harness({ send: () => ({ sent: false, reason: "403 feishu_cli_write_not_enabled" }) });
  assert.deepEqual((await run(delivery)).slice(1), ["没有发到「产品群」：服务端拒绝了这次发送（403 feishu_cli_write_not_enabled）"]);
});

test("a run stopped on the way writes nothing more", async () => {
  const controller = new AbortController();
  const { delivery, seen } = harness({ append: async () => { controller.abort(); throw new Error("aborted"); } });
  const lines = await run(delivery, { signal: controller.signal });
  assert.equal(lines[1], "没有发到「产品群」：任务已取消");
  assert.equal(seen.sends.length, 0);
});

test("a delivery never throws: a database that is away is one line in the record", async () => {
  const { delivery } = harness({ getFails: true });
  assert.deepEqual(await run(delivery), ["结果没有写到任务指定的地方：database away"]);
});

test("what is written is stripped of what could disguise it, and cut to what fits", async () => {
  const hostile = `正常‮伪装\u0007的内容\r\n第二行`;
  assert.equal(documentEntry({ title: "t", at: "a", report: hostile.replace(/[‮\u0007]/g, "") }).includes("‮"), false);
  const { delivery, seen } = harness();
  await run(delivery, { report: Buffer.from(hostile) });
  for (const written of [seen.appends[0].markdown, seen.sends[0].text]) {
    assert.doesNotMatch(written, /[‮\u0007\r]/, "no control or direction characters, no carriage returns");
    assert.match(written, /正常伪装的内容\n第二行/);
  }
  // A long report: the document gets what fits under its limit, on a character
  // boundary, and says it was cut; the message says so too.
  const long = "汇".repeat(40_000);
  const entry = documentEntry({ title: "每天汇总", at: "2026-09-28 09:00", report: long });
  assert.ok(Buffer.byteLength(entry, "utf8") <= DOCUMENT_BYTES, "under the document limit");
  assert.match(entry, /（内容较长，只追加了前面部分。）\n$/);
  assert.doesNotMatch(entry, /�/, "no character cut in half");
  const message = chatEntry({ title: "每天汇总", at: "2026-09-28 09:00", report: long });
  assert.ok(message.length < CHAT_CHARS + 100);
  assert.match(message, /汇…\n\n（内容较长，已截断。）$/);
  const emoji = chatEntry({ title: "t", at: "a", report: `${"a".repeat(CHAT_CHARS - 1)}😀tail` });
  assert.doesNotMatch(emoji, /[\ud800-\udbff](?![\udc00-\udfff])/, "never half of a surrogate pair");
});

test("the message key is the run and the chat, and a valid Feishu uuid", () => {
  const key = deliveryKey("run-1", CHAT.id);
  assert.match(key, /^[A-Za-z0-9-]{1,50}$/);
  assert.equal(key, deliveryKey("run-1", CHAT.id), "the same run to the same chat is the same message");
  assert.notEqual(key, deliveryKey("run-2", CHAT.id));
  assert.notEqual(key, deliveryKey("run-1", "oc_0000000000000000"));
});

test("the time is the task's own, and a zone that is not one is Shanghai", () => {
  assert.equal(deliveryStamp(NOW, "Asia/Shanghai"), "2026-09-28 09:00");
  assert.equal(deliveryStamp(NOW, "Europe/London"), "2026-09-28 02:00");
  assert.equal(deliveryStamp(NOW, "Not/AZone"), "2026-09-28 09:00");
  assert.equal(deliveryStamp(NOW, undefined), "2026-09-28 09:00");
});

test("a stored list is checked wherever it is read: kinds, ids, links, how many, and nothing extra", () => {
  assert.deepEqual(scheduleDeliveries(null), []);
  assert.deepEqual(scheduleDeliveries([CHAT, DOC, { ...CHAT, label: "重复" }]), [DOC, CHAT], "sorted, and one of each place");
  assert.equal(scheduleDeliveries([{ ...CHAT, label: "  产品\n群 " }])[0].label, "产品 群");
  assert.equal(scheduleDeliveries([{ ...CHAT, label: "" }])[0].label, CHAT.id, "unnamed shows its id");
  assert.throws(() => scheduleDeliveries([DOC, CHAT, { ...CHAT, id: "oc_2222222222222222" }, { ...CHAT, id: "oc_3333333333333333" }]), /最多写到 3 个地方/);
  assert.equal(MAX_DELIVERIES, 3);
  for (const bad of [{ ...DOC, id: "../x" }, { ...DOC, reference: "http://tenant.feishu.cn/docx/x" }, { ...DOC, reference: "https://u:p@tenant.feishu.cn/docx/x" },
    { ...DOC, extra: 1 }, { ...CHAT, id: "ou_1f2e3d4c5b6a7988" }, { ...CHAT, reference: DOC.reference }, { kind: "sheet", id: "x" }, "oc_1234567890abcdef"]) {
    assert.throws(() => scheduleDeliveries([bad]), undefined, JSON.stringify(bad));
  }
});

test("what a desktop or a draft asks for is a document by its link and a chat by its id", () => {
  assert.deepEqual(deliveryRequests([{ kind: "document", reference: DOC.reference, label: "周报" }, { kind: "chat", id: CHAT.id }]),
    [{ kind: "document", reference: DOC.reference, label: "周报" }, { kind: "chat", id: CHAT.id, label: "" }]);
  assert.deepEqual(deliveryRequests(undefined), []);
  for (const bad of [[{ kind: "document", id: DOC.id }], [{ kind: "document", reference: "http://x" }], [{ kind: "chat", id: "x" }],
    [{ kind: "base", reference: DOC.reference }], "x", new Array(4).fill({ kind: "chat", id: CHAT.id })]) {
    assert.throws(() => deliveryRequests(bad), undefined, JSON.stringify(bad));
  }
});

test("the delivery cannot be built without what it writes through", () => {
  assert.throws(() => new ScheduleDelivery({ feishu: SAAS_FEISHU }), /投递需要/);
});

test("after a run: the report is saved, then the places are written, and the record says both", async () => {
  const { afterRun } = await import("../src/control-plane/scheduled-tasks.js");
  const { ScheduleArchiveError } = await import("../src/control-plane/schedule-report-archive.js");
  const finished = { schedule: schedule(), parentToken: "parent", runId: "run-1", report: Buffer.from("r") };
  const artifact = { state: "verified", fileToken: "FileToken0001" };
  const saving = async () => ({ detail: "报告已保存到飞书云盘：https://x", artifact });
  const delivering = (lines, seen = []) => ({ deliver: async (input) => { seen.push(input); return lines; } });

  const both = await afterRun({ archive: saving, delivery: delivering(["已发到「产品群」"]) })(finished);
  assert.deepEqual(both, { detail: "报告已保存到飞书云盘：https://x\n已发到「产品群」", artifact });
  const saved = await saving();
  assert.deepEqual(await afterRun({ archive: saving, delivery: delivering([]) })(finished), saved, "a task with no places reads as before");
  assert.deepEqual(await afterRun({ archive: saving })(finished), saved, "and so does a server without the bridge");

  // A report that could not be saved: the places are still written, and the
  // failure keeps its receipt and says what happened at each.
  const unsure = new ScheduleArchiveError("报告上传结果不确定", { state: "unknown" });
  const failing = async () => { throw unsure; };
  await assert.rejects(afterRun({ archive: failing, delivery: delivering(["已追加到文档《周报》"]) })(finished), (error) =>
    error instanceof ScheduleArchiveError && error.message === "报告上传结果不确定\n已追加到文档《周报》" && error.artifact.state === "unknown");
  await assert.rejects(afterRun({ archive: failing, delivery: delivering([]) })(finished), (error) => error === unsure, "unchanged when nothing else happened");

  // A run that was stopped writes nowhere.
  const controller = new AbortController(); controller.abort();
  const seen = [];
  await afterRun({ archive: saving, delivery: delivering(["不该有"], seen) })({ ...finished, signal: controller.signal });
  assert.equal(seen.length, 0);
});
