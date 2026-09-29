import test from "node:test";
import assert from "node:assert/strict";
import { makeScheduleCapability, scheduleFeishuRequestAllowed, validateScheduleCapability, makeDenyAllScheduleCapability, modelCallsFor } from "../src/control-plane/schedule-capability.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";

const WHO = { tenantId: "tenant-a", userId: "person-a" };
const DOC_A = "DocAllowed123456", DOC_B = "DocDenied123456";
const SHEET = "SheetAllowed1234", TAB = "shAllowed1", BASE = "BaseAllowed12345", TABLE = "tblAllowed123";
const CHAT = "oc_AllowedChat123", OTHER_CHAT = "oc_DeniedChat123";

function binding() {
  return makeScheduleCapability({ feishu: SAAS_FEISHU, who: WHO, validUntil: 2_000_000_000_000, resources: [
    { kind: "document", reference: `https://feishu.cn/docx/${DOC_A}` },
    { kind: "sheet", reference: `https://feishu.cn/sheets/${SHEET}?sheet=${TAB}` },
    { kind: "base", reference: `https://feishu.cn/base/${BASE}?table=${TABLE}` },
    { kind: "chat", id: CHAT },
  ] });
}

test("a schedule capability is identity-bound, canonical and rejects tampering", () => {
  const first = binding();
  const second = makeScheduleCapability({ feishu: SAAS_FEISHU, who: WHO, validUntil: 2_000_000_000_000, resources: [
    { kind: "chat", id: CHAT },
    { kind: "base", reference: `https://feishu.cn/base/${BASE}?table=${TABLE}` },
    { kind: "document", reference: `https://feishu.cn/docx/${DOC_A}` },
    { kind: "sheet", reference: `https://feishu.cn/sheets/${SHEET}?sheet=${TAB}` },
  ] });
  assert.equal(first.digest, second.digest, "resource order cannot create a different grant");
  assert.equal(validateScheduleCapability(first, WHO), first);
  const secondRevision = makeScheduleCapability({ feishu: SAAS_FEISHU, who: WHO, revision: 2, resources: [] });
  assert.equal(validateScheduleCapability(secondRevision, WHO).revision, 2);
  assert.throws(() => makeScheduleCapability({ feishu: SAAS_FEISHU, who: WHO, revision: 0 }), /版本/);
  assert.throws(() => validateScheduleCapability(first, { ...WHO, userId: "person-b" }), /授权无效/);
  assert.throws(() => validateScheduleCapability({ ...first, capability: { ...first.capability, resources: [] } }, WHO), /摘要/);
  assert.throws(() => makeScheduleCapability({ feishu: SAAS_FEISHU, who: WHO,
    resources: [{ kind: "document", reference: `https://feishu.cn/wiki/${DOC_A}` }] }), /Wiki/);
  // The Base parser reads a Wiki node's address too, because the reader opens
  // both. An authorization may not: the node is resolved by the control plane
  // first, and only what it resolved to is stored.
  assert.throws(() => makeScheduleCapability({ feishu: SAAS_FEISHU, who: WHO,
    resources: [{ kind: "base", reference: `https://feishu.cn/wiki/${BASE}` }] }), /Wiki/);
});

test("document A is allowed, document B and enumeration stay denied", () => {
  const capability = binding().capability;
  assert.equal(scheduleFeishuRequestAllowed(capability, "GET", `/open-apis/docx/v1/documents/${DOC_A}/raw_content`), true);
  assert.equal(scheduleFeishuRequestAllowed(capability, "GET", `/open-apis/docx/v1/documents/${DOC_B}/raw_content`), false);
  assert.equal(scheduleFeishuRequestAllowed(capability, "POST", `/open-apis/docs_ai/v1/documents/${DOC_A}/fetch`, Buffer.from("{}")), true,
    "the bundled CLI's document fetch is scoped to the same exact token");
  assert.equal(scheduleFeishuRequestAllowed(capability, "POST", `/open-apis/docs_ai/v1/documents/${DOC_B}/fetch`, Buffer.from("{}")), false);
  assert.equal(scheduleFeishuRequestAllowed(capability, "GET", `/open-apis/docx/v1/documents/${DOC_A}/raw_content?unexpected=1`), false);
  assert.equal(scheduleFeishuRequestAllowed(capability, "GET", "/open-apis/drive/v1/files?page_size=50"), false);
  assert.equal(scheduleFeishuRequestAllowed(capability, "POST", "/open-apis/search/v2/doc_wiki/search", Buffer.from('{"query":"all"}')), false);
});

test("a chat id cannot change and pagination cannot escape the selected chat", () => {
  const capability = binding().capability;
  assert.equal(scheduleFeishuRequestAllowed(capability, "GET",
    `/open-apis/im/v1/messages?container_id_type=chat&container_id=${CHAT}&page_token=next&page_size=50`), true);
  assert.equal(scheduleFeishuRequestAllowed(capability, "GET",
    `/open-apis/im/v1/messages?container_id_type=chat&container_id=${OTHER_CHAT}&page_token=next`), false);
  assert.equal(scheduleFeishuRequestAllowed(capability, "GET", "/open-apis/im/v1/chats?page_size=50"), false);
  assert.equal(scheduleFeishuRequestAllowed(capability, "POST", "/open-apis/im/v2/chats/search", Buffer.from("{}")), false);
});

test("sheet and Base semantic POST reads must name the granted resource in path and body", () => {
  const capability = binding().capability;
  const sheetBody = id => Buffer.from(JSON.stringify({ tool_name: "get_cell_ranges",
    input: JSON.stringify({ excel_id: SHEET, sheet_id: id, ranges: ["A1:B2"] }) }));
  const sheetPath = `/open-apis/sheet_ai/v2/spreadsheets/${SHEET}/tools/invoke_read`;
  assert.equal(scheduleFeishuRequestAllowed(capability, "POST", sheetPath, sheetBody(TAB)), true);
  assert.equal(scheduleFeishuRequestAllowed(capability, "POST", sheetPath, sheetBody("shDenied1")), false);
  assert.equal(scheduleFeishuRequestAllowed(capability, "POST",
    `/open-apis/sheet_ai/v2/spreadsheets/OtherSheet123/tools/invoke_read`, sheetBody(TAB)), false);

  const basePath = `/open-apis/base/v3/bases/${BASE}/tables/${TABLE}/records/batch_get`;
  assert.equal(scheduleFeishuRequestAllowed(capability, "POST", basePath, Buffer.from('{"record_id_list":["rec1"]}')), true);
  assert.equal(scheduleFeishuRequestAllowed(capability, "POST",
    `/open-apis/base/v3/bases/${BASE}/tables/tblDenied123/records/batch_get`, Buffer.from("{}")), false);
});

// A grant as a later build writes it: the same shape, a larger model budget,
// its digest recomputed the way the store's own is.
const withModelCalls = async (bound, modelCalls) => {
  const { createHash } = await import("node:crypto");
  const canonical = (value) => JSON.stringify(value, (_key, item) => (!item || typeof item !== "object" || Array.isArray(item)) ? item
    : Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])));
  const capability = { ...bound.capability, limits: { ...bound.capability.limits, modelCalls } };
  return { capability, digest: createHash("sha256").update(canonical(capability)).digest("hex"), revision: bound.revision };
};

// The next release gives a grant more model calls than eight. This one has to
// read such a grant as valid first: a build that does not wipes it as corrupt
// when it opens the store, which is what a rollback would otherwise do.
test("a grant with a larger model budget reads as valid, up to the bound", async () => {
  const bound = binding();
  assert.equal(validateScheduleCapability(await withModelCalls(bound, 74), WHO).capability.limits.modelCalls, 74);
  assert.equal(validateScheduleCapability(await withModelCalls(bound, 80), WHO).capability.limits.modelCalls, 80);
  const [over, none] = [await withModelCalls(bound, 81), await withModelCalls(bound, 0)];
  assert.throws(() => validateScheduleCapability(over, WHO), /授权无效/);
  assert.throws(() => validateScheduleCapability(none, WHO), /授权无效/);
});

// A grant's model budget follows what it may read: ten, and two more for each
// resource, up to the bound. One number for every grant ran a one-document task
// out of calls, and could never have read 32 resources.
test("a new grant's model budget grows with its resources, up to the bound", () => {
  assert.equal(binding().capability.limits.modelCalls, 18, "four resources");
  const one = makeScheduleCapability({ feishu: SAAS_FEISHU, who: WHO, resources: [{ kind: "chat", id: CHAT }] });
  assert.equal(one.capability.limits.modelCalls, 12);
  assert.equal(makeDenyAllScheduleCapability(WHO).capability.limits.modelCalls, 10, "a task with nothing to read still gets its own rounds");
  const many = makeScheduleCapability({ feishu: SAAS_FEISHU, who: WHO,
    resources: Array.from({ length: 32 }, (_, index) => ({ kind: "chat", id: `oc_Chat${String(index).padStart(4, "0")}` })) });
  assert.equal(many.capability.limits.modelCalls, 74);
  assert.equal(modelCallsFor(1000), 80, "never past the bound a stored grant is checked against");
  assert.equal(validateScheduleCapability(many, WHO), many);
});
