import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { startFeishuCliSequence, validateFeishuCliSequenceStep, acceptFeishuCliSequencePrepare, acceptFeishuCliSequenceStep } from "../src/providers/feishu/cli-write-sequence.js";
import { DRIVE_CHUNK_PATHS, DRIVE_SINGLE_SHOT_MAX_BYTES, feishuCliWriteIntent, multipartFields, validateFeishuCliWriteRequest } from "../src/providers/feishu/cli-write-contract.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { FeishuSourceAccess } from "../src/control-plane/feishu-source-access.js";
import { FeishuCliProxyService } from "../src/control-plane/feishu-cli-proxy.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { FeishuCliSidecar } from "../src/providers/feishu/cli-sidecar.js";
import { SaasFeishuCliProvider } from "../src/providers/feishu/saas-cli-provider.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";
import { requireBundledCli } from "./helpers/stub-cli.js";

// 超过 20 MB，内置 CLI 不再一次 upload_all，而是 upload_prepare → 按飞书给的块大小依次 upload_part →
// upload_finish（对着打包的 CLI 录下来的）。一次性授权描述不了飞书中途决定的块数，所以这里用一个按顺序
// 逐步核对的授权：每块的序号、大小、上传标识都要对上，全部字节的摘要等于确认过的文件，才放行 finish。
const hash = value => createHash("sha256").update(value).digest("hex");
const FOLDER = "fldcnChunkFolder1", FILE = "mydoubao-11111111-2222-4333-8444-555555555555.mp4";
const BLOCK = 4 * 1024 * 1024;
// A prime-length pattern, so neighbouring blocks never hold the same bytes.
const PATTERN = Buffer.from(Array.from({ length: 4093 }, (_, index) => (index * 31 + 7) & 0xff));
const payloadOf = length => Buffer.alloc(length, PATTERN);
const intentFor = (payload, extra = {}) => ({ action: "drive.upload-chunked", operationId: randomUUID(), folderToken: FOLDER, fileName: FILE,
  byteLength: payload.length, contentHash: hash(payload), ...extra });
const json = value => Buffer.from(JSON.stringify(value));
const multipart = (fields, boundary = "chunkboundary0123456789") => {
  const parts = Object.entries(fields).map(([name, value]) => Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"${name === "file" ? "; filename=\"unknown-file\"\r\nContent-Type: application/octet-stream" : ""}\r\n\r\n`),
    Buffer.isBuffer(value) ? value : Buffer.from(String(value)), Buffer.from("\r\n")]));
  return { body: Buffer.concat([...parts, Buffer.from(`--${boundary}--\r\n`)]), contentType: `multipart/form-data; boundary=${boundary}` };
};
const prepareBody = (payload, extra = {}) => json({ file_name: FILE, parent_node: FOLDER, parent_type: "explorer", size: payload.length, ...extra });
const partFor = (payload, seq, uploadId = "upload-1", extra = {}) => {
  const chunk = payload.subarray(seq * BLOCK, Math.min(payload.length, (seq + 1) * BLOCK));
  return multipart({ seq: String(seq), size: String(chunk.length), file: chunk, upload_id: uploadId, ...extra });
};
const prepared = (payload, uploadId = "upload-1") => json({ code: 0, msg: "success", data: { upload_id: uploadId, block_size: BLOCK, block_num: Math.ceil(payload.length / BLOCK) } });
const finishBody = (payload, uploadId = "upload-1") => json({ upload_id: uploadId, block_num: Math.ceil(payload.length / BLOCK) });

function startedSequence(payload) {
  const state = startFeishuCliSequence(intentFor(payload));
  validateFeishuCliSequenceStep(state, "POST", DRIVE_CHUNK_PATHS.prepare, prepareBody(payload), "application/json");
  acceptFeishuCliSequencePrepare(state, prepared(payload));
  return state;
}
const sendPart = (state, payload, seq, ...rest) => { const { body, contentType } = partFor(payload, seq, ...rest); return validateFeishuCliSequenceStep(state, "POST", DRIVE_CHUNK_PATHS.part, body, contentType); };

test("分片上传：按录下的三步顺序放行，块的序号、大小、上传标识都对上，全部字节摘要对上才放行 finish", () => {
  const payload = payloadOf(DRIVE_SINGLE_SHOT_MAX_BYTES + 3 * 1024 * 1024 + 17), blocks = Math.ceil(payload.length / BLOCK);
  const state = startFeishuCliSequence(intentFor(payload));
  assert.equal(validateFeishuCliSequenceStep(state, "POST", DRIVE_CHUNK_PATHS.prepare, prepareBody(payload), "application/json"), "prepare");
  assert.equal(acceptFeishuCliSequencePrepare(state, prepared(payload)), true);
  for (let seq = 0; seq < blocks; seq += 1) {
    assert.equal(sendPart(state, payload, seq), "part");
    assert.equal(acceptFeishuCliSequenceStep(state, json({ code: 0 })), true);
  }
  assert.equal(validateFeishuCliSequenceStep(state, "POST", DRIVE_CHUNK_PATHS.finish, finishBody(payload), "application/json"), "finish");
  assert.equal(state.stage, "done");
});

test("分片上传：换文件夹、改名、改大小、乱序、重复、换上传标识、多字段、少块、改一个字节都被拒绝，拒绝后不能再继续", () => {
  const payload = payloadOf(DRIVE_SINGLE_SHOT_MAX_BYTES + 5 * 1024 * 1024 + 3), blocks = Math.ceil(payload.length / BLOCK);
  for (const extra of [{ parent_node: "fldcnOtherFolder1" }, { file_name: "mydoubao-11111111-2222-4333-8444-555555555556.mp4" }, { size: payload.length - 1 }, { parent_type: "wiki" }, { extra: 1 }]) {
    const state = startFeishuCliSequence(intentFor(payload));
    assert.throws(() => validateFeishuCliSequenceStep(state, "POST", DRIVE_CHUNK_PATHS.prepare, prepareBody(payload, extra), "application/json"), /does not match/, JSON.stringify(extra));
    assert.equal(state.stage, "refused");
  }
  assert.throws(() => sendPart(startFeishuCliSequence(intentFor(payload)), payload, 0), /does not match/, "a part before prepare was answered");
  { const state = startedSequence(payload); assert.throws(() => sendPart(state, payload, 1), /does not match/); assert.throws(() => sendPart(state, payload, 0), /does not match/, "a refused sequence stays refused"); }
  { const state = startedSequence(payload); sendPart(state, payload, 0); assert.throws(() => sendPart(state, payload, 0), /does not match/, "the same block twice"); }
  assert.throws(() => sendPart(startedSequence(payload), payload, 0, "upload-2"), /does not match/, "another upload id");
  assert.throws(() => sendPart(startedSequence(payload), payload, 0, "upload-1", { checksum: "1" }), /does not match/, "an extra field");
  {
    const state = startedSequence(payload), short = multipart({ seq: "0", size: String(BLOCK - 1), file: payload.subarray(0, BLOCK - 1), upload_id: "upload-1" });
    assert.throws(() => validateFeishuCliSequenceStep(state, "POST", DRIVE_CHUNK_PATHS.part, short.body, short.contentType), /does not match/, "a block of the wrong size");
  }
  {
    const state = startedSequence(payload);
    for (let seq = 0; seq < blocks - 1; seq += 1) sendPart(state, payload, seq);
    assert.throws(() => validateFeishuCliSequenceStep(state, "POST", DRIVE_CHUNK_PATHS.finish, finishBody(payload), "application/json"), /does not match/, "finish before every block");
  }
  {
    const tampered = Buffer.from(payload); tampered[BLOCK + 5] ^= 1;
    const state = startedSequence(payload);
    for (let seq = 0; seq < blocks; seq += 1) sendPart(state, tampered, seq);
    assert.throws(() => validateFeishuCliSequenceStep(state, "POST", DRIVE_CHUNK_PATHS.finish, finishBody(payload), "application/json"), /does not match/, "bytes other than the confirmed ones never become a file");
  }
});

test("分片上传：飞书回的块大小和块数要和确认的文件对得上；小文件不是分片动作；这个动作不能当单个请求放行", () => {
  const payload = payloadOf(DRIVE_SINGLE_SHOT_MAX_BYTES + 1);
  for (const answer of [
    json({ code: 1, msg: "denied" }),
    json({ code: 0, data: { upload_id: "u", block_size: BLOCK, block_num: 99 } }),
    json({ code: 0, data: { upload_id: "u", block_size: 64, block_num: Math.ceil(payload.length / 64) } }),
    json({ code: 0, data: { upload_id: "u", block_size: 64 * 1024 * 1024, block_num: 1 } }),
    json({ code: 0, data: { upload_id: "has space", block_size: BLOCK, block_num: Math.ceil(payload.length / BLOCK) } }),
    Buffer.from("not json"),
  ]) {
    const state = startFeishuCliSequence(intentFor(payload));
    validateFeishuCliSequenceStep(state, "POST", DRIVE_CHUNK_PATHS.prepare, prepareBody(payload), "application/json");
    assert.equal(acceptFeishuCliSequencePrepare(state, answer), false);
    assert.equal(state.stage, "refused");
  }
  assert.throws(() => feishuCliWriteIntent(intentFor(payloadOf(1024))), /intent/, "a small file travels as one upload_all");
  // Found while writing these tests: the name pattern allowed letters only after
  // the dot, so an .mp4 -- the one type big enough to need chunks, and a type
  // the adapter itself accepts -- could not even be granted as a single upload.
  assert.doesNotThrow(() => feishuCliWriteIntent({ ...intentFor(payloadOf(1024)), action: "drive.upload" }), "a small .mp4 is a valid single-shot upload");
  assert.throws(() => validateFeishuCliWriteRequest(intentFor(payload), "POST", DRIVE_CHUNK_PATHS.prepare, prepareBody(payload)), /does not match/);
});

async function chunkFixture(t, { cliWriteActions = ["drive.upload", "drive.upload-chunked"], refusePart = null } = {}) {
  const sessions = new SessionRegistry();
  const sourceAccess = new FeishuSourceAccess({ feishu: SAAS_FEISHU, sessions, appId: "cli_chunk_fixture", cliProxyScopes: ["fixture:read", "fixture.drive:write"], cliWriteActions });
  const identity = { authProvider: "feishu", appId: "cli_chunk_fixture", tenantId: "tenant_fixture", userId: "ou_fixture", displayName: "Fixture", expiresAt: Date.now() + 600_000, cliBridge: true, cliDriveWrites: true };
  sourceAccess.remember(identity, "server-only-feishu-user-token");
  const session = sessions.issue({ ...identity, deviceId: "device_chunk", deviceProof: "ed25519-login", ttlMs: 300_000 });
  sourceAccess.bind(identity, session);
  const upstream = [], audits = [], stored = [];
  const proxy = new FeishuCliProxyService({ sourceAccess, audit: event => audits.push(event), fetchImpl: async (url, options) => {
    const target = new URL(url).pathname; upstream.push(target);
    if (target === DRIVE_CHUNK_PATHS.prepare) {
      const size = JSON.parse(Buffer.from(options.body).toString("utf8")).size;
      return Response.json({ code: 0, msg: "success", data: { upload_id: "upload-live-1", block_size: BLOCK, block_num: Math.ceil(size / BLOCK) } });
    }
    if (target === DRIVE_CHUNK_PATHS.part) {
      stored.push(multipartFields(Buffer.from(options.body), options.headers["content-type"]).get("file"));
      return refusePart?.(stored.length) ? Response.json({ code: 1062, msg: "refused" }) : Response.json({ code: 0, msg: "success", data: {} });
    }
    if (target === DRIVE_CHUNK_PATHS.finish) return Response.json({ code: 0, msg: "success", data: { file_token: "boxcnChunked1" } });
    if (target === "/open-apis/drive/v1/metas/batch_query") {
      const doc = JSON.parse(Buffer.from(options.body).toString("utf8")).request_docs[0];
      return Response.json({ code: 0, data: { metas: [{ doc_token: doc.doc_token, doc_type: doc.doc_type, title: doc.doc_type === "folder" ? "验收文件夹" : FILE, url: `https://fixture.feishu.cn/${doc.doc_type}/${doc.doc_token}` }], failed_list: [] } });
    }
    return Response.json({ code: 0, data: { open_id: "ou_fixture", tenant_key: "tenant_fixture", user_id: "fixture-user", name: "Fixture" } });
  } });
  const gateway = createModelGateway({ apiKey: "unused", sessions, authHandler: (req, res) => proxy.handle(req, res), fetchImpl: () => assert.fail("model gateway is not used") });
  await new Promise((resolve, reject) => { gateway.once("error", reject); gateway.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${gateway.address().port}`;
  t.after(async () => { proxy.close(); sourceAccess.close(); sessions.sessions.clear(); gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); });
  const grantFor = intent => fetch(`${origin}/v1/feishu/cli-write-grants`, { method: "POST", headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" }, body: JSON.stringify(intent) });
  const issued = async intent => { const response = await grantFor(intent), payload = await response.json(); assert.equal(response.status, 201, JSON.stringify(payload)); return payload.grant; };
  const post = (grant, path, body, contentType) => fetch(`${origin}/v1/feishu/cli-proxy`, { method: "POST", headers: { authorization: `Bearer ${session.token}`, "content-type": contentType,
    "x-mydoubao-feishu-target": "https://open.feishu.cn", "x-mydoubao-feishu-path": path, ...(grant ? { "x-mydoubao-feishu-write-grant": grant } : {}) }, body });
  return { session, identity, origin, upstream, audits, stored, grantFor, issued, post };
}

test("控制面：分片上传整段放行并在 finish 时用掉授权；改过一个字节的上传到不了 finish", async t => {
  const payload = payloadOf(DRIVE_SINGLE_SHOT_MAX_BYTES + 2 * BLOCK + 11), blocks = Math.ceil(payload.length / BLOCK);
  const f = await chunkFixture(t);
  const grant = await f.issued(intentFor(payload));
  assert.equal((await f.post(grant, DRIVE_CHUNK_PATHS.prepare, prepareBody(payload), "application/json")).status, 200);
  for (let seq = 0; seq < blocks; seq += 1) {
    const { body, contentType } = partFor(payload, seq, "upload-live-1");
    assert.equal((await f.post(grant, DRIVE_CHUNK_PATHS.part, body, contentType)).status, 200);
  }
  assert.equal((await f.post(grant, DRIVE_CHUNK_PATHS.finish, finishBody(payload, "upload-live-1"), "application/json")).status, 200);
  assert.deepEqual(f.upstream, [DRIVE_CHUNK_PATHS.prepare, ...Array(blocks).fill(DRIVE_CHUNK_PATHS.part), DRIVE_CHUNK_PATHS.finish]);
  assert.equal(hash(Buffer.concat(f.stored)), hash(payload));
  assert.deepEqual(f.audits.map(event => event.kind), ["grant_issued", "dispatch_started", "upstream_finished"]);
  assert.doesNotMatch(JSON.stringify(f.audits), new RegExp(`${FOLDER}|${FILE}|upload-live-1|server-only-feishu-user-token`));
  assert.equal((await f.post(grant, DRIVE_CHUNK_PATHS.finish, finishBody(payload, "upload-live-1"), "application/json")).status, 403, "a spent grant admits nothing more");

  const g = await chunkFixture(t);
  const tampered = Buffer.from(payload); tampered[3] ^= 1;
  const second = await g.issued(intentFor(payload));
  await g.post(second, DRIVE_CHUNK_PATHS.prepare, prepareBody(payload), "application/json");
  for (let seq = 0; seq < blocks; seq += 1) { const { body, contentType } = partFor(tampered, seq, "upload-live-1"); await g.post(second, DRIVE_CHUNK_PATHS.part, body, contentType); }
  assert.equal((await g.post(second, DRIVE_CHUNK_PATHS.finish, finishBody(payload, "upload-live-1"), "application/json")).status, 403);
  assert.equal(g.upstream.includes(DRIVE_CHUNK_PATHS.finish), false, "finish never reaches Feishu for bytes nobody confirmed");
  assert.ok(g.audits.some(event => event.kind === "grant_rejected"));
});

test("控制面：飞书拒收一块就结束整个序列；没开分片动作的部署，三个端点和授权都关着", async t => {
  const payload = payloadOf(DRIVE_SINGLE_SHOT_MAX_BYTES + BLOCK);
  const f = await chunkFixture(t, { refusePart: count => count === 2 });
  const grant = await f.issued(intentFor(payload));
  await f.post(grant, DRIVE_CHUNK_PATHS.prepare, prepareBody(payload), "application/json");
  for (const [seq, status] of [[0, 200], [1, 200], [2, 403]]) {
    const { body, contentType } = partFor(payload, seq, "upload-live-1");
    assert.equal((await f.post(grant, DRIVE_CHUNK_PATHS.part, body, contentType)).status, status, `part ${seq}`);
  }
  assert.equal(f.upstream.filter(path => path === DRIVE_CHUNK_PATHS.part).length, 2, "nothing continues after a refused block");

  const closed = await chunkFixture(t, { cliWriteActions: ["drive.upload"] });
  for (const path of Object.values(DRIVE_CHUNK_PATHS)) assert.equal((await closed.post(undefined, path, json({}), "application/json")).status, 405, path);
  assert.equal((await closed.grantFor(intentFor(payload))).status, 403);
  assert.deepEqual(closed.upstream, []);
});

test("真实 CLI：22 MB 的文件经侧车和控制面分片落地，飞书收到的正是确认过的字节", async t => {
  if (!(await requireBundledCli(t))) return;
  const f = await chunkFixture(t);
  const sidecar = await new FeishuCliSidecar({ appId: f.identity.appId, getSession: async () => ({ token: f.session.token, expiresAt: f.session.expiresAt, serverUrl: f.origin,
    identity: { provider: "feishu", appId: f.identity.appId, tenantId: f.identity.tenantId, userId: f.identity.userId, deviceId: "device_chunk", deviceProof: "ed25519-login", cliBridge: true, cliDriveWrites: true } }) }).start();
  t.after(() => sidecar.close());
  const provider = new SaasFeishuCliProvider({ environment: intent => intent ? sidecar.environment(intent) : sidecar.environment() });
  const folder = await provider.drive.resolveFolder(`https://fixture.feishu.cn/drive/folder/${FOLDER}`);
  const payload = payloadOf(22 * 1024 * 1024 + 123);
  let dispatched = 0, uploaded = null;
  const receipt = await provider.drive.upload({ bytes: payload, name: FILE, folder, confirmed: true,
    onDispatched: async () => { dispatched += 1; }, onUploaded: async fileToken => { uploaded = fileToken; } });
  assert.equal(receipt.fileToken, "boxcnChunked1"); assert.equal(uploaded, "boxcnChunked1"); assert.equal(dispatched, 1);
  assert.equal(f.upstream.filter(path => path === DRIVE_CHUNK_PATHS.part).length, Math.ceil(payload.length / BLOCK));
  assert.equal(f.upstream.filter(path => path === DRIVE_CHUNK_PATHS.finish).length, 1);
  assert.equal(hash(Buffer.concat(f.stored)), hash(payload), "the bytes that reached Feishu, in order, are the confirmed bytes");
  assert.deepEqual(f.audits.map(event => event.kind), ["grant_issued", "dispatch_started", "upstream_finished"]);
  assert.equal(sidecar.writeKeys.size <= 1, true);
});
