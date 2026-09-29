import { createHash } from "node:crypto";
import { alwaysDestructive, canonicalCliPath, canonicalJson, cliWriteFamily, isDestructiveRequest } from "./cli-write-plan.js";
import { EITHER } from "../../product-names.js";

// What this product names the files it puts in a person's Drive, under either
// spelling of its name (product-names.js).
const OWN_FILE_NAME = new RegExp(`^${EITHER}-[a-f0-9-]{36}\\.[a-z0-9.]{2,16}$`);
const OWN_REPORT_NAME = new RegExp(`^${EITHER}-[a-f0-9-]{36}\\.schedule\\.md$`);

// One semantic action per supported write, each with its own exact endpoint and
// body policy. Adding an action means adding a spec here plus its scopes and
// tests; it never means widening a method or a path prefix.
export const DOCUMENT_INLINE_REPLACE = "document.inline-replace";
export const DOCUMENT_CREATE = "document.create";
export const DOCUMENT_APPEND = "document.append";
export const CLI_WRITE = "cli.write";
// The same CLI route for requests that destroy something. A separate action so
// that an administrator enables deletion on its own, the audit trail says which
// grants could delete, and -- the point -- an ordinary write grant can never
// carry a deletion, whatever the application in front of it believed.
export const CLI_DELETE = "cli.delete";
export const MESSAGE_SEND = "message.send";
export const MESSAGE_REPLY = "message.reply";
export const DRIVE_UPLOAD = "drive.upload";
export const DRIVE_UPLOAD_CHUNKED = "drive.upload-chunked";
// Overwriting one existing file in place: a scheduled task's oldest kept report,
// chosen by the control plane from its own receipts (schedule-report-archive.js)
// so each task keeps a bounded few reports instead of one more file per run. Its
// own action, so that no upload grant can ever overwrite anything, and an
// administrator enables it on its own.
export const DRIVE_REPLACE = "drive.replace";

// Measured against the pinned binary: at or below this the CLI issues one
// upload_all; above it, it switches to a server-structured
// upload_prepare/upload_part/upload_finish sequence, which travels under its own
// action: one grant admitting exactly that sequence, step by step.
export const DRIVE_SINGLE_SHOT_MAX_BYTES = 20 * 1024 * 1024;
// Recorded against the bundled binary: upload_prepare {file_name, parent_node,
// parent_type, size}; then one multipart upload_part {seq, size, file,
// upload_id} per block, in order, each block as large as upload_prepare answered
// (the last one the remainder); then upload_finish {block_num, upload_id}. The
// largest file the application uploads at all, and the largest block a part may
// carry whatever Feishu answers.
export const DRIVE_CHUNKED_MAX_BYTES = 100 * 1024 * 1024;
export const DRIVE_CHUNK_MAX_BYTES = 16 * 1024 * 1024;
export const DRIVE_CHUNK_PATHS = Object.freeze({
  prepare: "/open-apis/drive/v1/files/upload_prepare",
  part: "/open-apis/drive/v1/files/upload_part",
  finish: "/open-apis/drive/v1/files/upload_finish",
});

// The pinned lark-cli resolves its own user identity before every command, so a
// write-scoped credential must tolerate that read without spending its grant.
// Recorded against the exact bundled 1.0.78 authsidecar build.
export const IDENTITY_PREFLIGHT_PATH = "/open-apis/authen/v1/user_info";
export const MAX_IDENTITY_PREFLIGHTS = 3;
// What the pinned CLI puts in extra_param on every `docs +create`.
const DOCS_CREATE_ASYNC = '{"open_create_async":true}';

export const feishuCliWriteDigest = value => createHash("sha256").update(value).digest("hex");
const digest = feishuCliWriteDigest;
const exact = (value, names) => Boolean(value) && !Array.isArray(value) && typeof value === "object" &&
  Object.keys(value).sort().join(",") === [...names].sort().join(",");
const token = (value, prefix = "") => typeof value === "string" && new RegExp(`^${prefix}[A-Za-z0-9_-]{1,128}$`).test(value);
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const idempotencyKey = value => typeof value === "string" && /^[A-Za-z0-9-]{1,50}$/.test(value);
const sha256 = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const text = (value, limit) => typeof value === "string" && Boolean(value) && value.length <= limit;
const DISPOSITION = /^Content-Disposition: form-data; name="([A-Za-z0-9_]{1,64})"(?:; filename="[^"\r\n]{0,255}")?$/;
const CONTENT_TYPE = /^Content-Type: [A-Za-z0-9!#$&^_.+-]{1,64}\/[A-Za-z0-9!#$&^_.+-]{1,64}$/;
const CRLF = Buffer.from("\r\n"), DASHES = Buffer.from("--");
const CLI_WRITE_METHODS = Object.freeze(["POST", "PUT", "PATCH"]);
const CLI_DELETE_METHODS = Object.freeze(["POST", "PUT", "PATCH", "DELETE"]);
// A DELETE carries no body; its grant is bound to the digest of "no body".
const NO_BODY = createHash("sha256").update("null").digest("hex");

// Strict, non-streaming multipart reader for the one upload shape the pinned
// CLI emits. It accepts no nesting, no unknown headers, no duplicate field and
// no unterminated part; anything else is refused rather than repaired.
export function multipartFields(bytes, contentType) {
  const header = /^multipart\/form-data;\s*boundary=("?)([A-Za-z0-9'()+_,\-.\/:=?]{1,70})\1$/.exec(String(contentType).trim());
  if (!header) throw new Error("unsupported multipart body");
  const delimiter = Buffer.from(`--${header[2]}`), fields = new Map();
  let index = bytes.indexOf(delimiter);
  if (index !== 0) throw new Error("unsupported multipart body");
  index += delimiter.length;
  while (true) {
    if (bytes.subarray(index, index + 2).equals(DASHES)) break;
    if (!bytes.subarray(index, index + 2).equals(CRLF)) throw new Error("unsupported multipart body");
    index += 2;
    const headerEnd = bytes.indexOf("\r\n\r\n", index, "latin1");
    if (headerEnd < 0) throw new Error("unsupported multipart body");
    const lines = bytes.subarray(index, headerEnd).toString("latin1").split("\r\n");
    const disposition = DISPOSITION.exec(lines[0]);
    if (!disposition || lines.length > 2 || lines[1] !== undefined && !CONTENT_TYPE.test(lines[1])) throw new Error("unsupported multipart body");
    const start = headerEnd + 4, next = bytes.indexOf(delimiter, start);
    if (next < start + 2 || !bytes.subarray(next - 2, next).equals(CRLF)) throw new Error("unsupported multipart body");
    if (fields.has(disposition[1]) || fields.size >= 16) throw new Error("unsupported multipart body");
    fields.set(disposition[1], bytes.subarray(start, next - 2));
    index = next + delimiter.length;
  }
  return fields;
}

// Every spec states the exact method, the pre-grant path shape used to refuse a
// request before any grant lookup, the exact path bound to one intent, and the
// exact body. Bodies are inspected transiently and compared only by digest.
const ACTIONS = Object.freeze({
  [DOCUMENT_INLINE_REPLACE]: {
    capability: "cliDocumentWrites",
    method: "PUT",
    maxBytes: 262144,
    fields: ["documentId", "revisionId", "patternHash", "contentHash"],
    valid: value => token(value.documentId) && Number.isSafeInteger(value.revisionId) && value.revisionId >= 0 &&
      sha256(value.patternHash) && sha256(value.contentHash),
    shape: path => /^\/open-apis\/docs_ai\/v1\/documents\/[A-Za-z0-9_-]{1,128}$/.test(path),
    path: intent => `/open-apis/docs_ai/v1/documents/${intent.documentId}`,
    resource: intent => intent.documentId,
    body: (intent, body) => {
      // A deletion sends no content field; every other shape is rejected.
      const names = body?.content === undefined ? ["command", "format", "pattern", "revision_id"] : ["command", "content", "format", "pattern", "revision_id"];
      return exact(body, names) && body.command === "str_replace" && body.format === "xml" &&
        body.revision_id === intent.revisionId && text(body.pattern, 2000) &&
        (body.content === undefined || (typeof body.content === "string" && body.content.length <= 10_000)) &&
        digest(body.pattern) === intent.patternHash && digest(body.content ?? "") === intent.contentHash;
    },
  },
  // Recorded against the pinned CLI (1.0.96): `docs +create --doc-format
  // markdown` sends exactly {content, extra_param, format}, extra_param always
  // the fixed '{"open_create_async":true}'. The title is not a separate field
  // -- the CLI prepends it to the content as a <title> element, so the
  // confirmed digest already covers it. (1.0.78 sent {content, format}.)
  //
  // Asking for async creation means Feishu may answer with a task instead of
  // the document, which the CLI then polls until it settles. Those polls are
  // the follow-up: reads of that one task, named by the write's own answer,
  // admitted after the write and nothing else. Refusing them would leave a
  // document created with no receipt, which is worse than either outcome.
  [DOCUMENT_CREATE]: {
    capability: "cliDocumentWrites",
    method: "POST",
    maxBytes: 262144,
    fields: ["contentHash"],
    valid: value => sha256(value.contentHash),
    shape: path => path === "/open-apis/docs_ai/v1/documents",
    path: () => "/open-apis/docs_ai/v1/documents",
    // A creation has no prior resource; the confirmed content identifies it.
    resource: intent => intent.contentHash,
    body: (intent, body) => exact(body, ["content", "extra_param", "format"]) && body.extra_param === DOCS_CREATE_ASYNC &&
      body.format === "markdown" && text(body.content, 100_000) && digest(body.content) === intent.contentHash,
    followUp: {
      // The CLI waits at most ten minutes, polling no faster than every 100 ms.
      windowMs: 11 * 60_000, maxReads: 600,
      id: answer => { const id = answer?.data?.task?.task_id; return token(id) ? id : null; },
      read: id => ({ method: "GET", path: `/open-apis/docs_ai/v1/async_tasks/${id}` }),
      settled: answer => ["succeeded", "failed", "expired"].includes(String(answer?.data?.task?.status ?? "").toLowerCase()),
    },
  },
  // `docs +update --command append` is emitted by the pinned CLI as a
  // block_insert_after at the document-end sentinel block. The base revision is
  // bound so the confirmed document state is the one written to.
  [DOCUMENT_APPEND]: {
    capability: "cliDocumentWrites",
    method: "PUT",
    maxBytes: 262144,
    fields: ["documentId", "revisionId", "contentHash"],
    valid: value => token(value.documentId) && Number.isSafeInteger(value.revisionId) && value.revisionId >= 0 && sha256(value.contentHash),
    shape: path => /^\/open-apis\/docs_ai\/v1\/documents\/[A-Za-z0-9_-]{1,128}$/.test(path),
    path: intent => `/open-apis/docs_ai/v1/documents/${intent.documentId}`,
    resource: intent => intent.documentId,
    body: (intent, body) => exact(body, ["block_id", "command", "content", "format", "revision_id"]) &&
      body.block_id === "-1" && body.command === "block_insert_after" && body.format === "markdown" &&
      body.revision_id === intent.revisionId && text(body.content, 100_000) && digest(body.content) === intent.contentHash,
  },
  // One command the Agent asked for, described by the CLI itself with
  // `--dry-run` and approved as that exact request. The path is whatever the
  // dry run declared, restricted to the allowed write families, and the body is
  // pinned by a canonical digest so key order cannot change what was approved.
  // This is how sheets and Base are reached without the product re-encoding
  // every request shape the shipped binary already knows.
  [CLI_WRITE]: {
    capability: "cliDocumentWrites",
    method: null, // Declared per intent rather than fixed by the action.
    methods: CLI_WRITE_METHODS,
    maxBytes: 262144,
    fields: ["requestMethod", "requestPath", "bodyHash"],
    // A family that only ever destroys cannot even be granted as a write.
    valid: value => CLI_WRITE_METHODS.includes(value.requestMethod) && typeof value.requestPath === "string" &&
      value.requestPath.length <= 2048 && Boolean(cliWriteFamily(value.requestMethod, value.requestPath)) &&
      !alwaysDestructive(cliWriteFamily(value.requestMethod, value.requestPath)) && sha256(value.bodyHash),
    shape: path => CLI_WRITE_METHODS.some(method => Boolean(cliWriteFamily(method, path))),
    path: intent => intent.requestPath,
    // Query parameters may arrive in a different order than they were planned.
    samePath: (intent, path) => canonicalCliPath(path) === canonicalCliPath(intent.requestPath),
    resource: intent => intent.requestPath,
    methodOf: intent => intent.requestMethod,
    // And a body that destroys something is refused under a write grant even
    // when its digest matches: deletion needs a deletion grant.
    body: (intent, body) => digest(canonicalJson(body ?? null)) === intent.bodyHash &&
      !isDestructiveRequest(intent.requestMethod, intent.requestPath, body),
  },
  // A deletion grant covers exactly one request in any family, destructive or
  // not -- it is the stronger approval -- but it is the only grant a
  // destructive request can travel under.
  [CLI_DELETE]: {
    capability: "cliDestructiveWrites",
    method: null,
    methods: CLI_DELETE_METHODS,
    maxBytes: 262144,
    fields: ["requestMethod", "requestPath", "bodyHash"],
    valid: value => CLI_DELETE_METHODS.includes(value.requestMethod) && typeof value.requestPath === "string" &&
      value.requestPath.length <= 2048 && Boolean(cliWriteFamily(value.requestMethod, value.requestPath)) && sha256(value.bodyHash) &&
      (value.requestMethod !== "DELETE" || value.bodyHash === NO_BODY),
    shape: path => CLI_DELETE_METHODS.some(method => Boolean(cliWriteFamily(method, path))),
    path: intent => intent.requestPath,
    samePath: (intent, path) => canonicalCliPath(path) === canonicalCliPath(intent.requestPath),
    resource: intent => intent.requestPath,
    methodOf: intent => intent.requestMethod,
    body: (intent, body) => digest(canonicalJson(body ?? null)) === intent.bodyHash,
  },
  [MESSAGE_SEND]: {
    capability: "cliMessageWrites",
    method: "POST",
    maxBytes: 262144,
    fields: ["receiveIdType", "receiveId", "msgType", "contentHash", "idempotencyKey"],
    valid: value => ["open_id", "chat_id"].includes(value.receiveIdType) &&
      token(value.receiveId, value.receiveIdType === "open_id" ? "ou_" : "oc_") &&
      ["text", "post"].includes(value.msgType) && sha256(value.contentHash) && idempotencyKey(value.idempotencyKey),
    shape: path => /^\/open-apis\/im\/v1\/messages\?receive_id_type=(open_id|chat_id)$/.test(path),
    path: intent => `/open-apis/im/v1/messages?receive_id_type=${intent.receiveIdType}`,
    resource: intent => intent.receiveId,
    // The idempotency key is bound too: the CLI serializes it as `uuid`, so one
    // grant can never carry a differently keyed retry.
    body: (intent, body) => exact(body, ["content", "msg_type", "receive_id", "uuid"]) &&
      body.msg_type === intent.msgType && body.receive_id === intent.receiveId &&
      body.uuid === intent.idempotencyKey && text(body.content, 32_768) && digest(body.content) === intent.contentHash,
  },
  [DRIVE_UPLOAD]: {
    capability: "cliDriveWrites",
    method: "POST",
    // The confirmed bytes plus a bounded multipart envelope.
    maxBytes: DRIVE_SINGLE_SHOT_MAX_BYTES + 8192,
    multipart: true,
    fields: ["folderToken", "fileName", "byteLength", "contentHash"],
    valid: value => token(value.folderToken) && OWN_FILE_NAME.test(value.fileName) &&
      Number.isSafeInteger(value.byteLength) && value.byteLength > 0 && value.byteLength <= DRIVE_SINGLE_SHOT_MAX_BYTES && sha256(value.contentHash),
    shape: path => path === "/open-apis/drive/v1/files/upload_all",
    path: () => "/open-apis/drive/v1/files/upload_all",
    resource: intent => intent.folderToken,
    // Exactly one new file, in the confirmed folder, with the confirmed name,
    // length and bytes. parent_type is pinned so an upload cannot be retargeted
    // at a wiki node or another container.
    raw: (intent, bytes, contentType) => {
      const fields = multipartFields(bytes, contentType);
      if (fields.size !== 5) return false;
      const value = name => fields.get(name)?.toString("utf8");
      const file = fields.get("file");
      return Boolean(file) && value("file_name") === intent.fileName && value("parent_type") === "explorer" &&
        value("parent_node") === intent.folderToken && value("size") === String(intent.byteLength) &&
        file.length === intent.byteLength && digest(file) === intent.contentHash;
    },
    // upload_all answers with a token only; the CLI then reads the file metadata
    // back. That read is part of the command, so it is permitted alongside it.
    companionReads: [{ method: "POST", path: "/open-apis/drive/v1/metas/batch_query" }],
  },
  // One scheduled report overwritten in place. The same single upload_all as a
  // new file, plus exactly one file_token: the file this grant names, in the
  // folder it names, getting the name, length and bytes it names. Only a
  // scheduled report, only one request, and the file keeps its token -- the CLI
  // forwards --file-token to the upload API, measured 2026-09-22.
  [DRIVE_REPLACE]: {
    capability: "cliDriveWrites",
    method: "POST",
    maxBytes: DRIVE_SINGLE_SHOT_MAX_BYTES + 8192,
    multipart: true,
    fields: ["folderToken", "fileToken", "fileName", "byteLength", "contentHash"],
    valid: value => token(value.folderToken) && token(value.fileToken) && OWN_REPORT_NAME.test(value.fileName) &&
      Number.isSafeInteger(value.byteLength) && value.byteLength > 0 && value.byteLength <= DRIVE_SINGLE_SHOT_MAX_BYTES && sha256(value.contentHash),
    shape: path => path === "/open-apis/drive/v1/files/upload_all",
    path: () => "/open-apis/drive/v1/files/upload_all",
    // What the grant can change is that one file.
    resource: intent => intent.fileToken,
    raw: (intent, bytes, contentType) => {
      const fields = multipartFields(bytes, contentType);
      if (fields.size !== 6) return false;
      const value = name => fields.get(name)?.toString("utf8");
      const file = fields.get("file");
      return Boolean(file) && value("file_token") === intent.fileToken && value("file_name") === intent.fileName &&
        value("parent_type") === "explorer" && value("parent_node") === intent.folderToken && value("size") === String(intent.byteLength) &&
        file.length === intent.byteLength && digest(file) === intent.contentHash;
    },
    companionReads: [{ method: "POST", path: "/open-apis/drive/v1/metas/batch_query" }],
  },
  // A file above the single-shot bound: the same confirmed folder, name, length
  // and bytes, admitted as the recorded three-step sequence instead of one
  // request. Each step is checked against the ones before it
  // (cli-write-sequence.js), and the bytes are bound by a running digest that
  // must equal the confirmed one before upload_finish -- the step that makes
  // the file exist -- is sent. Enabled on its own, under the same capability.
  [DRIVE_UPLOAD_CHUNKED]: {
    capability: "cliDriveWrites",
    method: "POST",
    sequence: true,
    // The largest block a part may carry, plus a bounded multipart envelope.
    maxBytes: DRIVE_CHUNK_MAX_BYTES + 8192,
    fields: ["folderToken", "fileName", "byteLength", "contentHash"],
    valid: value => token(value.folderToken) && OWN_FILE_NAME.test(value.fileName) &&
      Number.isSafeInteger(value.byteLength) && value.byteLength > DRIVE_SINGLE_SHOT_MAX_BYTES && value.byteLength <= DRIVE_CHUNKED_MAX_BYTES && sha256(value.contentHash),
    shape: path => Object.values(DRIVE_CHUNK_PATHS).includes(path),
    path: () => DRIVE_CHUNK_PATHS.prepare,
    resource: intent => intent.folderToken,
    companionReads: [{ method: "POST", path: "/open-apis/drive/v1/metas/batch_query" }],
  },
  [MESSAGE_REPLY]: {
    capability: "cliMessageWrites",
    method: "POST",
    maxBytes: 262144,
    fields: ["messageId", "replyInThread", "contentHash", "idempotencyKey"],
    valid: value => token(value.messageId, "om_") && typeof value.replyInThread === "boolean" &&
      sha256(value.contentHash) && idempotencyKey(value.idempotencyKey),
    shape: path => /^\/open-apis\/im\/v1\/messages\/om_[A-Za-z0-9_-]{1,128}\/reply$/.test(path),
    path: intent => `/open-apis/im/v1/messages/${intent.messageId}/reply`,
    resource: intent => intent.messageId,
    // The pinned CLI omits reply_in_thread entirely for a main-chat reply, so
    // presence itself is part of the confirmed placement.
    body: (intent, body) => exact(body, intent.replyInThread ? ["content", "msg_type", "reply_in_thread", "uuid"] : ["content", "msg_type", "uuid"]) &&
      body.msg_type === "text" && (!intent.replyInThread || body.reply_in_thread === true) &&
      body.uuid === intent.idempotencyKey && text(body.content, 32_768) && digest(body.content) === intent.contentHash,
  },
});

export const FEISHU_CLI_WRITE_ACTIONS = Object.freeze(Object.keys(ACTIONS));
export const FEISHU_CLI_WRITE_CAPABILITIES = Object.freeze([...new Set(Object.values(ACTIONS).map(spec => spec.capability))]);

export function isIdentityPreflight(method, path) {
  return method === "GET" && path === IDENTITY_PREFLIGHT_PATH;
}

// Server capability flags implied by an administrator's action allowlist.
export function feishuCliWriteCapabilities(actions) {
  return Object.freeze([...new Set(actions.map(action => ACTIONS[action]?.capability).filter(Boolean))]);
}

// Native-only description of one confirmed write. It carries digests, never the
// confirmed text, so neither the grant service nor the audit sink can
// reconstruct enterprise content.
export function feishuCliWriteIntent(value) {
  const spec = value && !Array.isArray(value) && typeof value === "object" ? ACTIONS[value.action] : null;
  if (!spec || !exact(value, ["action", "operationId", ...spec.fields]) || !uuid(value.operationId) || !spec.valid(value)) {
    throw new Error("invalid Feishu CLI write intent");
  }
  return Object.freeze({ ...value });
}

export const feishuCliWriteCapability = action => ACTIONS[action]?.capability ?? null;
export const feishuCliWriteResource = intent => ACTIONS[intent.action].resource(intent);

// Method and path precheck used before any grant lookup, so a request no
// configured action could ever target is refused outright.
export function feishuCliWriteEndpoint(action, method, path) {
  const spec = ACTIONS[action];
  if (!spec) return false;
  // An action with no fixed method carries it in the intent; the pre-grant check
  // can only test the shape, which the family list already bounds.
  return (spec.method === null ? (spec.methods ?? CLI_WRITE_METHODS).includes(method) : spec.method === method) && spec.shape(path);
}

// Reads a configured action needs in order to complete. They carry no grant
// and exist only while that action is enabled, so a read-only deployment
// keeps exactly the read surface it has today.
export function feishuCliWriteCompanionRead(action, method, path) {
  return (ACTIONS[action]?.companionReads || []).some(read => read.method === method && read.path === path);
}

// Reads an action's write may be followed by, named by its own answer: the
// request that settles what the write started (see DOCUMENT_CREATE). Null for
// an action whose write is the whole of it.
export const feishuCliWriteFollowUp = action => ACTIONS[action]?.followUp ?? null;

// Bind the grant to the exact request the pinned CLI emits for this action.
export const feishuCliWriteIsMultipart = action => Boolean(ACTIONS[action]?.multipart);
export const feishuCliWriteMaxBytes = action => ACTIONS[action]?.maxBytes ?? 0;
// An action admitted as a sequence of requests rather than one (see
// cli-write-sequence.js); its multipart step is the upload_part.
export const feishuCliWriteIsSequence = action => ACTIONS[action]?.sequence === true;
export const feishuCliWriteStepIsMultipart = (action, path) => feishuCliWriteIsSequence(action) && path === DRIVE_CHUNK_PATHS.part;

export function validateFeishuCliWriteRequest(intentValue, method, path, bytes, contentType = "application/json") {
  const intent = feishuCliWriteIntent(intentValue), spec = ACTIONS[intent.action];
  // A sequence has no single request to compare with; it is checked step by step.
  if (spec.sequence) throw new Error("Feishu CLI write request does not match its grant");
  const pathMatches = spec.samePath ? spec.samePath(intent, path) : path === spec.path(intent);
  if (method !== (spec.methodOf ? spec.methodOf(intent) : spec.method) || !pathMatches || !Buffer.isBuffer(bytes) || bytes.length > spec.maxBytes) {
    throw new Error("Feishu CLI write request does not match its grant");
  }
  if (spec.multipart) {
    let matched = false;
    try { matched = spec.raw(intent, bytes, contentType); } catch { matched = false; }
    if (!matched) throw new Error("Feishu CLI write request does not match its grant");
    return intent;
  }
  let body;
  // A DELETE has no body at all; anything sent with one is not the request approved.
  if (method === "DELETE") { if (bytes.length) throw new Error("Feishu CLI write request does not match its grant"); body = null; }
  else { try { body = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Feishu CLI write request does not match its grant"); } }
  if (!spec.body(intent, body)) throw new Error("Feishu CLI write request does not match its grant");
  return intent;
}
