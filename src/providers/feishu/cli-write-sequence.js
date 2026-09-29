import { createHash } from "node:crypto";
import { DRIVE_CHUNK_MAX_BYTES, DRIVE_CHUNK_PATHS, feishuCliWriteIntent, feishuCliWriteIsSequence, multipartFields } from "./cli-write-contract.js";

// A write the pinned CLI sends as several requests: a Drive file above the
// single-shot bound (DRIVE_UPLOAD_CHUNKED in cli-write-contract.js). One grant
// admits exactly the recorded sequence, and every step is checked against the
// ones before it -- by the sidecar, and again by the control plane:
//
//   upload_prepare  the confirmed folder, name and size, exactly;
//   upload_part     the upload_id Feishu answered, the next seq in order, the
//                   block size Feishu answered (the last block the remainder)
//                   and bytes of exactly that length, fed to a running digest;
//   upload_finish   that upload_id and block count, once every block has gone,
//                   and only if the running digest equals the confirmed one.
//
// Nothing exists in Drive until upload_finish, so bytes other than the confirmed
// ones can travel as far as an unfinished upload at most and never become a
// file. The block size is Feishu's to choose, which is why the sequence cannot be
// written into a grant up front: the state learns it from the prepare response
// and holds every later step to it. A refused step ends the sequence for good.

// Bounds on what upload_prepare may answer. 100 MiB in blocks no smaller than
// 256 KiB is at most 400 blocks.
const MIN_BLOCK_BYTES = 256 * 1024;
const MAX_BLOCKS = 400;

const refuse = () => { throw new Error("Feishu CLI write request does not match its grant"); };
const exactKeys = (value, names) => Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...names].sort().join(",");
const decimal = value => typeof value === "string" && /^(0|[1-9]\d{0,9})$/.test(value) ? Number(value) : NaN;
function parseJson(bytes) {
  try { return JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { return undefined; }
}

export function startFeishuCliSequence(intentValue) {
  const intent = feishuCliWriteIntent(intentValue);
  if (!feishuCliWriteIsSequence(intent.action)) refuse();
  return { intent, stage: "prepare", uploadId: null, blockSize: 0, blockNum: 0, nextSeq: 0, received: 0, digest: createHash("sha256") };
}

const blockLength = (state, seq) => seq < state.blockNum - 1 ? state.blockSize : state.intent.byteLength - state.blockSize * (state.blockNum - 1);

// Checks one request against the sequence so far and records it; returns which
// step it was. Anything out of order, out of shape or out of size is refused.
export function validateFeishuCliSequenceStep(state, method, path, bytes, contentType = "") {
  const { intent } = state;
  try {
    if (method !== "POST" || !Buffer.isBuffer(bytes)) refuse();
    const json = String(contentType).split(";")[0].trim() === "application/json";
    if (state.stage === "prepare" && path === DRIVE_CHUNK_PATHS.prepare) {
      const body = json ? parseJson(bytes) : undefined;
      if (!exactKeys(body, ["file_name", "parent_node", "parent_type", "size"]) || body.file_name !== intent.fileName ||
          body.parent_node !== intent.folderToken || body.parent_type !== "explorer" || body.size !== intent.byteLength) refuse();
      state.stage = "preparing";
      return "prepare";
    }
    if (state.stage === "parts" && path === DRIVE_CHUNK_PATHS.part) {
      const fields = multipartFields(bytes, contentType);
      const text = name => fields.get(name)?.toString("utf8");
      const file = fields.get("file"), seq = decimal(text("seq")), size = decimal(text("size"));
      if (fields.size !== 4 || !file || text("upload_id") !== state.uploadId || seq !== state.nextSeq || size !== blockLength(state, seq) || file.length !== size) refuse();
      state.digest.update(file);
      state.nextSeq += 1; state.received += size;
      if (state.nextSeq === state.blockNum) state.stage = "finish";
      return "part";
    }
    if (state.stage === "finish" && path === DRIVE_CHUNK_PATHS.finish) {
      const body = json ? parseJson(bytes) : undefined;
      if (!exactKeys(body, ["block_num", "upload_id"]) || body.upload_id !== state.uploadId || body.block_num !== state.blockNum ||
          state.received !== intent.byteLength || state.digest.digest("hex") !== intent.contentHash) refuse();
      state.stage = "done";
      return "finish";
    }
    return refuse();
  } catch (error) {
    state.stage = "refused";
    throw error;
  }
}

// What upload_prepare answered: the upload this sequence is bound to and the
// block size every part must follow. A refusal, or an answer that does not fit
// the confirmed file, ends the sequence.
export function acceptFeishuCliSequencePrepare(state, responseBytes) {
  const payload = state.stage === "preparing" ? parseJson(responseBytes) : undefined;
  const data = payload?.code === 0 ? payload.data : null;
  const blockSize = data?.block_size, blockNum = data?.block_num;
  if (typeof data?.upload_id !== "string" || !/^[\x21-\x7e]{1,256}$/.test(data.upload_id) ||
      !Number.isSafeInteger(blockSize) || blockSize < MIN_BLOCK_BYTES || blockSize > DRIVE_CHUNK_MAX_BYTES ||
      !Number.isSafeInteger(blockNum) || blockNum < 1 || blockNum > MAX_BLOCKS || blockNum !== Math.ceil(state.intent.byteLength / blockSize)) {
    state.stage = "refused";
    return false;
  }
  Object.assign(state, { uploadId: data.upload_id, blockSize, blockNum, stage: "parts" });
  return true;
}

// A part or the finish Feishu did not accept ends the sequence as well: the CLI
// stops there, and nothing may resume it under the same grant.
export function acceptFeishuCliSequenceStep(state, responseBytes) {
  const payload = parseJson(responseBytes);
  if (payload?.code === 0) return true;
  state.stage = "refused";
  return false;
}
