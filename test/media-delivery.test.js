import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SaasDriveFiles, driveReference } from "../src/providers/feishu/drive-files.js";
import { MediaDelivery } from "../src/application/media-delivery.js";
import { MediaWorkspace } from "../src/application/media-workspace.js";

const folderUrl = "https://synthetic.feishu.cn/drive/folder/SyntheticFolder123", fileToken = "SyntheticFile123";
const bytes = Buffer.from("synthetic bytes; actual decoder covered by media preview tests");
const ok = (data) => ({ code: 0, stdout: JSON.stringify({ ok: true, identity: "user", data }) });
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-delivery-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = { uploads: 0, title: "测试成果", identity: { principal: "a".repeat(64), tenantKey: "tenant", verifiedAt: Date.now() }, calls: [], block: false };
  const row = { id: randomUUID(), taskId: randomUUID(), instanceId: randomUUID(), jobId: randomUUID(), kind: "image", state: "awaiting_acceptance", ownerKey: "b".repeat(64), createdAt: Date.now() };
  const session = { token: "c".repeat(43), expiresAt: Date.now() + 60000, serverUrl: "http://127.0.0.1:12345" };
  const provider = { id: "saas-cli", documentIdentity: async () => ({ ...state.identity }), invoke: async (args, options) => {
    state.calls.push(args);
    assert.equal(args[args.indexOf("--as") + 1], "user");
    if (args[1] === "+inspect") {
      if (state.folderDenied) return { code: 1, stderr: JSON.stringify({ error: { message: "permission denied" } }) };
      return ok({ input_url: folderUrl, token: "SyntheticFolder123", type: "folder", title: state.title, url: folderUrl });
    }
    if (args[1] === "+upload") {
      state.uploads++; state.uploadDirectory = options.cwd; state.name = args[args.indexOf("--name") + 1];
      assert.deepEqual(args, ["drive", "+upload", "--file", state.name, "--name", state.name, "--folder-token", "SyntheticFolder123", "--as", "user", "--format", "json"]);
      assert.deepEqual(await readFile(path.join(options.cwd, state.name)), bytes);
      assert.equal(JSON.parse(await readFile(path.join(directory, "media.json"))).rows[0].delivery.state, "uploading");
      if (state.lost) throw new Error("synthetic lost upload response");
      if (state.badAck) return ok({});
      if (state.switchAfterUpload) state.identity.principal = "d".repeat(64);
      return ok({ file_token: fileToken });
    }
    assert.deepEqual(args.slice(0, 2), ["api", "GET"]);
    // The listing's query goes as --params: the pinned CLI refuses one in the path.
    assert.deepEqual([args[2], args[3], typeof JSON.parse(args[4]).folder_token], ["/open-apis/drive/v1/files", "--params", "string"]);
    if (state.listDenied) return { code: 1, stderr: JSON.stringify({ error: { message: "permission denied" } }) };
    if (state.pages) return ok(state.pages.shift());
    return ok({ files: [{ token: fileToken, type: "file", name: state.name, parent_token: "SyntheticFolder123", url: `https://synthetic.feishu.cn/file/${fileToken}` }], has_more: false });
  } };
  const drive = new SaasDriveFiles(provider);
  const make = () => {
    const media = new MediaWorkspace({ filename: path.join(directory, "media.json"), getTask: () => ({ mode: "cowork" }), getSession: async () => session });
    media.lease = async () => ({ ownerKey: row.ownerKey });
    media.result = async () => ({ kind: "image", session: { ...session } });
    media.inspect = async () => ({ job: state.expired ? {} : { result: {} } });
    const budget = { policy: async () => ({ policyDigest: "f".repeat(64) }), reserve: async () => {}, dispatch: async () => {}, report: async () => {} };
    const delivery = new MediaDelivery({ media, provider: drive, budget, businessAccess: () => { if (state.block) throw new Error("enterprise CLI identity unlinked"); }, downloader: { download: async () => ({ bytes, extension: "png" }) } });
    return { media, delivery };
  };
  const first = make(); first.media.loaded = true; first.media.rows = [row]; await first.media.save();
  return { ...first, make, row, state, drive, session, prepare: () => first.delivery.prepare(row.taskId, row.id, folderUrl) };
}

test("Drive save uses one new-file user upload, durable reservation and exact-token readback", async (t) => {
  const f = await fixture(t), draft = await f.prepare();
  assert.equal(f.state.uploads, 0); // Preparing or declining the native draft performs no write.
  const result = await f.delivery.save(draft);
  assert.equal(result.persisted, true); assert.equal(f.state.uploads, 1);
  assert.doesNotMatch(JSON.stringify(result), /https:|fileToken|tenant|principal/);
  await assert.rejects(access(f.state.uploadDirectory), { code: "ENOENT" });
  await assert.rejects(f.delivery.save(draft), /已有上传记录/); assert.equal(f.state.uploads, 1);
  const restored = f.make(); await restored.delivery.verify(f.row.taskId, f.row.id);
  assert.equal(restored.media.rows[0].delivery.state, "available"); assert.equal(f.state.uploads, 1);
});
test("ambiguous upload or malformed acknowledgment never retries or adopts by filename", async (t) => {
  for (const mode of ["lost", "badAck"]) {
    const f = await fixture(t), draft = await f.prepare(); f.state[mode] = true;
    await assert.rejects(f.delivery.save(draft)); assert.equal(f.row.delivery.state, "upload_unknown");
    const restored = f.make(); await assert.rejects(restored.delivery.verify(f.row.taskId, f.row.id), /人工核查/);
    await assert.rejects(restored.delivery.prepare(f.row.taskId, f.row.id, folderUrl), /不能再次上传/);
    assert.equal(await restored.delivery.folder(f.row.taskId, f.row.id), folderUrl); assert.equal(f.state.uploads, 1);
    await assert.rejects(access(f.state.uploadDirectory), { code: "ENOENT" });
  }
});
test("acknowledged upload with failed verification survives restart and recovers through reads only", async (t) => {
  const f = await fixture(t), draft = await f.prepare(); f.state.listDenied = true;
  await assert.rejects(f.delivery.save(draft)); assert.equal(f.row.delivery.state, "verification_pending"); assert.equal(f.row.delivery.fileToken, fileToken);
  const restored = f.make(); await assert.rejects(restored.delivery.verify(f.row.taskId, f.row.id));
  f.state.listDenied = false;
  assert.equal((await restored.delivery.verify(f.row.taskId, f.row.id)).fileToken, fileToken); assert.equal(f.state.uploads, 1);
});
test("changed folder, CLI identity, parent connection or expired result refuses confirmed upload", async (t) => {
  for (const mutation of [f => { f.state.title = "changed"; }, f => { f.state.identity.principal = "d".repeat(64); }, f => { f.session.token = "e".repeat(43); }, f => { f.state.expired = true; }]) {
    const f = await fixture(t), draft = await f.prepare(); mutation(f);
    await assert.rejects(f.delivery.save(draft)); assert.equal(f.state.uploads, 0);
  }
});
test("enterprise binding gate, folder access and journal reservation failures perform no upload", async (t) => {
  const f = await fixture(t); f.state.block = true; await assert.rejects(f.prepare(), /unlinked/); assert.equal(f.state.calls.length, 0);
  f.state.block = false; f.state.folderDenied = true; await assert.rejects(f.prepare());
  f.state.folderDenied = false; const draft = await f.prepare(); f.media.save = async () => { throw new Error("full disk"); };
  await assert.rejects(f.delivery.save(draft), /full disk/); assert.equal(f.state.uploads, 0);
});
test("CLI switch after dispatch retains acknowledged token but never claims completion", async (t) => {
  const f = await fixture(t), draft = await f.prepare(); f.state.switchAfterUpload = true;
  await assert.rejects(f.delivery.save(draft), /身份已变化/); assert.equal(f.row.delivery.state, "verification_pending");
  assert.equal(f.media.public(f.row).persisted, false); assert.equal(f.state.uploads, 1);
});
test("exact-token verification rejects filename-only matches and repeated pagination", async (t) => {
  const f = await fixture(t), draft = await f.prepare();
  f.state.pages = [{ files: [{ token: "OtherFile123", name: draft.name }], has_more: false }];
  await assert.rejects(f.delivery.save(draft), /尚未/);
  f.state.pages = [{ files: [], has_more: true, next_page_token: "same" }, { files: [], has_more: true, next_page_token: "same" }];
  await assert.rejects(f.delivery.verify(f.row.taskId, f.row.id), /分页不完整/); assert.equal(f.state.uploads, 1);
});
test("failure to persist completion leaves a pending receipt, never a false saved badge", async (t) => {
  const f = await fixture(t), draft = await f.prepare(), save = f.media.save.bind(f.media);
  f.media.save = async () => { if (f.row.delivery?.state === "available") throw new Error("synthetic completion disk failure"); await save(); };
  await assert.rejects(f.delivery.save(draft), /disk failure/);
  assert.equal(f.media.public(f.row).persisted, false); assert.equal(f.row.delivery.state, "verification_pending");
  const restored = f.make(); await restored.delivery.verify(f.row.taskId, f.row.id);
  assert.equal(restored.media.public(restored.media.rows[0]).persisted, true); assert.equal(f.state.uploads, 1);
});
test("server reservation or dispatch denial never reaches CLI upload", async (t) => {
  for (const method of ["reserve", "dispatch"]) {
    const f = await fixture(t), draft = await f.prepare();
    f.delivery.budget[method] = async () => { throw new Error("synthetic budget denied or reply lost"); };
    await assert.rejects(f.delivery.save(draft), /budget denied/); assert.equal(f.state.uploads, 0);
    assert.equal(f.row.delivery.state, method === "reserve" ? "prepared" : "upload_unknown");
  }
});
test("lost budget report retains the uploaded file and recovers without another upload", async (t) => {
  const f = await fixture(t), draft = await f.prepare();
  f.delivery.budget.report = async () => { throw new Error("synthetic report reply lost"); };
  await assert.rejects(f.delivery.save(draft), /reply lost/); assert.equal(f.row.delivery.fileToken, fileToken);
  assert.equal(f.row.delivery.state, "verification_pending"); assert.equal(f.state.uploads, 1);
  const restored = f.make(); await restored.delivery.verify(f.row.taskId, f.row.id); assert.equal(f.state.uploads, 1);
});
test("Drive target parsing refuses foreign, credentialed or wrong-kind references", () => {
  for (const value of ["http://synthetic.feishu.cn/drive/folder/SyntheticFolder123", "https://feishu.cn.evil.test/drive/folder/SyntheticFolder123", "https://user@feishu.cn/drive/folder/SyntheticFolder123", "https://feishu.cn:444/drive/folder/SyntheticFolder123", "https://feishu.cn/docx/SyntheticFolder123", "https://feishu.cn/drive/file/SyntheticFolder123"]) assert.throws(() => driveReference(value, "folder"));
  assert.equal(driveReference(`${folderUrl}?tracking=1#x`, "folder").url, folderUrl);
});
