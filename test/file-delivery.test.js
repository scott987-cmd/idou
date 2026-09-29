import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, truncate } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { FileDelivery, uploadableTypes } from "../src/application/file-delivery.js";
import { DRIVE_CHUNKED_MAX_BYTES, DRIVE_SINGLE_SHOT_MAX_BYTES } from "../src/providers/feishu/cli-write-contract.js";

const FOLDER = { providerId: "saas-cli", token: "fldTOKEN", url: "https://example.feishu.cn/drive/folder/fldTOKEN",
  title: "成果", identity: { principal: "ou_x", tenantKey: "tk" } };

function fixture({ blocked = null, remainingBytes = 50 * 1048576, uploadFails = null } = {}) {
  const calls = [];
  const session = { token: "t".repeat(43), serverUrl: "https://plane.example", expiresAt: Date.now() + 600000 };
  const media = { session: async () => session, unchanged: async () => { calls.push({ step: "unchanged" }); }, request: async () => ({}) };
  const budget = {
    policy: async (_s, folder, bytes) => {
      calls.push({ step: "policy", bytes, folder: folder.token });
      if (bytes > remainingBytes) throw new Error("企业配置的云盘预算不足，未上传");
      return { policyDigest: "a".repeat(64), remainingBytes };
    },
    reserve: async (_s, id) => calls.push({ step: "reserve", id }),
    dispatch: async (_s, id) => calls.push({ step: "dispatch", id }),
    report: async (_s, id, fileToken) => calls.push({ step: "report", id, fileToken }),
  };
  const provider = {
    resolveFolder: async (url) => { calls.push({ step: "resolveFolder", url }); return { ...FOLDER, url }; },
    upload: async ({ bytes, name, folder, confirmed, onDispatched, onUploaded }) => {
      calls.push({ step: "upload", name, confirmed, folder: folder.token, bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex") });
      await onDispatched();
      if (uploadFails) throw new Error(uploadFails);
      await onUploaded("fileTOKEN");
      return { url: "https://example.feishu.cn/file/fileTOKEN", fileToken: "fileTOKEN" };
    },
  };
  const delivery = new FileDelivery({ media, provider, budget,
    businessAccess: () => { if (blocked) throw new Error(blocked); } });
  return { delivery, calls, session };
}

const withFile = async (name, size = 32) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "file-delivery-"));
  const file = path.join(directory, name);
  await writeFile(file, Buffer.alloc(size, 7));
  return file;
};

test("上传前先核验目标文件夹和配额，任何字节都还没离开这台机器", async () => {
  const f = fixture();
  const draft = await f.delivery.prepare(await withFile("片子.mp4", 1024), FOLDER.url);
  assert.deepEqual(f.calls.map((call) => call.step), ["resolveFolder", "policy"]);
  assert.equal(f.calls.some((call) => call.step === "upload"), false, "prepare 阶段绝不能真的上传");
  assert.equal(draft.originalName, "片子.mp4");
  // 云盘上的名字必须符合上传契约接受的形状，同时保留原名用于确认。
  assert.match(draft.name, /^idou-[0-9a-f-]{36}\.mp4$/);
  assert.equal(draft.byteLength, 1024);
  assert.match(draft.sha256, /^[a-f0-9]{64}$/);
  assert.equal(draft.folder.title, "成果");
});

test("只接受契约允许的文件类型，其余明确拒绝并说清支持什么", async () => {
  const f = fixture();
  for (const name of ["文档.docx", "页面.html", "包.zip", "脚本.sh", "无扩展名"]) {
    const file = await withFile(name);
    await assert.rejects(() => f.delivery.prepare(file, FOLDER.url), /只支持/, `未拒绝 ${name}`);
  }
  for (const name of ["图.png", "图.JPG", "图.webp", "片.mp4"]) {
    const file = await withFile(name);
    assert.ok(await f.delivery.prepare(file, FOLDER.url), `${name} 应当被接受`);
  }
  assert.deepEqual(uploadableTypes().sort(), ["jpg", "mp4", "png", "webp"]);
});

// 20 MB 以上走分片上传（test/drive-chunked-upload.test.js），不再在这里拦下；
// 应用整体只收 100 MB 以内的文件，更大的在读盘之前、发出之前就被拒绝。
test("超过 20 MB 的文件照常准备上传；超过 100 MB 的在读盘和发出之前就被拒绝", async () => {
  const f = fixture();
  const draft = await f.delivery.prepare(await withFile("长片.mp4", DRIVE_SINGLE_SHOT_MAX_BYTES + 1), FOLDER.url);
  assert.equal(draft.byteLength, DRIVE_SINGLE_SHOT_MAX_BYTES + 1);
  const big = await withFile("超大片.mp4", 1);
  await truncate(big, DRIVE_CHUNKED_MAX_BYTES + 1); // sparse: the size is what is checked
  const before = f.calls.length;
  await assert.rejects(() => f.delivery.prepare(big, FOLDER.url), /单个文件限 100 MB/);
  assert.equal(f.calls.length, before, "refused before the folder or the quota is even asked");
  assert.equal(f.calls.some((call) => call.step === "upload"), false);
});

test("配额不足时不上传，而且是在发出之前拒绝", async () => {
  const f = fixture({ remainingBytes: 512 });
  const small = await withFile("片子.mp4", 4096);
  await assert.rejects(() => f.delivery.prepare(small, FOLDER.url), /预算不足/);
  assert.equal(f.calls.some((call) => call.step === "upload"), false);
});

test("企业策略未开放云盘写入时，连读文件都不做", async () => {
  const f = fixture({ blocked: "当前企业策略尚未启用登录桥接下的飞书云盘上传，请联系管理员。" });
  const file = await withFile("片子.mp4");
  await assert.rejects(() => f.delivery.prepare(file, FOLDER.url), /尚未启用/);
  assert.deepEqual(f.calls, []);
});

test("真正发出时的顺序是：预留、下发一次性许可、上传、回报账本", async () => {
  const f = fixture();
  const draft = await f.delivery.prepare(await withFile("片子.mp4", 2048), FOLDER.url);
  const receipt = await f.delivery.send(draft);
  const steps = f.calls.map((call) => call.step);
  assert.ok(steps.indexOf("reserve") < steps.indexOf("dispatch"), "先预留再取许可");
  assert.ok(steps.indexOf("dispatch") < steps.indexOf("report"), "上传成功后才回报");
  const upload = f.calls.find((call) => call.step === "upload");
  // 发出去的东西必须和确认时看到的一模一样：目标、名称、长度、内容。
  assert.equal(upload.confirmed, true);
  assert.equal(upload.folder, FOLDER.token);
  assert.equal(upload.name, draft.name);
  assert.equal(upload.bytes, draft.byteLength);
  assert.equal(upload.sha256, draft.sha256);
  assert.equal(receipt.originalName, "片子.mp4");
  assert.equal(receipt.fileToken, "fileTOKEN");
});

test("上传失败时不会向账本回报成功", async () => {
  const f = fixture({ uploadFails: "CLI 拒绝了这次写入" });
  const draft = await f.delivery.prepare(await withFile("片子.mp4", 2048), FOLDER.url);
  await assert.rejects(() => f.delivery.send(draft), /拒绝了这次写入/);
  assert.equal(f.calls.some((call) => call.step === "report"), false, "没传成功就不该记账");
});

test("两次上传排队进行，不会同时握着许可", async () => {
  const f = fixture();
  const order = [];
  const draftA = await f.delivery.prepare(await withFile("甲.mp4", 1024), FOLDER.url);
  const draftB = await f.delivery.prepare(await withFile("乙.mp4", 1024), FOLDER.url);
  const original = f.delivery.dispatch.bind(f.delivery);
  f.delivery.dispatch = async (draft) => {
    order.push(`开始 ${draft.originalName}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const result = await original(draft);
    order.push(`结束 ${draft.originalName}`);
    return result;
  };
  await Promise.all([f.delivery.send(draftA), f.delivery.send(draftB)]);
  assert.deepEqual(order, ["开始 甲.mp4", "结束 甲.mp4", "开始 乙.mp4", "结束 乙.mp4"]);
});
