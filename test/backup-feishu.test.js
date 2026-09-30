// Sealed backups taken to a Feishu Drive folder by the application's bot
// (backup-feishu.js, bin/backup-ship-feishu.js), as the operator chose on
// 2026-09-30. Against a Feishu of the test's own, answering the way Feishu was
// measured to: a success is code 0, a refusal HTTP 400 with its code.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { shipToFeishu } from "../src/control-plane/backup-feishu.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";

const FOLDER = "FolderBackups0001", APP = "cli_a1b2c3d4e5f60718";
const refusal = (code, msg) => new Response(JSON.stringify({ code, msg }), { status: 400, headers: { "content-type": "application/json" } });
const ok = (data) => Response.json({ code: 0, msg: "success", data });

function feishu({ files = [], listRefusal = null, pageSize = 3 } = {}) {
  const folder = files.map((name, index) => ({ token: `FileTok${String(index).padStart(4, "0")}`, name, type: "file", bytes: 1 }));
  const calls = [];
  let next = folder.length;
  const fetch = async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url);
    calls.push({ method: init.method ?? "GET", pathname });
    if (pathname.endsWith("/auth/v3/tenant_access_token/internal")) return Response.json({ code: 0, tenant_access_token: "t-synthetic", expire: 7200 });
    assert.equal(init.headers?.authorization, "Bearer t-synthetic", "every call as the application");
    if (pathname === "/open-apis/drive/v1/files" && (init.method ?? "GET") === "GET") {
      if (listRefusal) return refusal(...listRefusal);
      assert.equal(searchParams.get("folder_token"), FOLDER);
      const start = Number(searchParams.get("page_token") ?? 0), page = folder.slice(start, start + pageSize);
      const more = start + pageSize < folder.length;
      return ok({ files: [...page.map(({ token, name, type }) => ({ token, name, type })), ...(start === 0 ? [{ token: "Other0001", name: "会议纪要.docx", type: "docx" }] : [])],
        has_more: more, ...(more ? { next_page_token: String(start + pageSize) } : {}) });
    }
    if (pathname === "/open-apis/drive/v1/files/upload_all") {
      const body = init.body, bytes = Buffer.from(await body.get("file").arrayBuffer());
      assert.equal(body.get("parent_node"), FOLDER); assert.equal(body.get("parent_type"), "explorer"); assert.equal(Number(body.get("size")), bytes.length);
      const replacing = body.get("file_token");
      if (replacing) {
        const file = folder.find((row) => row.token === replacing);
        Object.assign(file, { name: body.get("file_name"), bytes: bytes.length });
        return ok({ file_token: file.token });
      }
      const file = { token: `FileTok${String(next++).padStart(4, "0")}`, name: body.get("file_name"), type: "file", bytes: bytes.length };
      folder.push(file);
      return ok({ file_token: file.token });
    }
    if (pathname === "/open-apis/drive/v1/files/upload_prepare") {
      const body = JSON.parse(init.body);
      calls.prepared = { ...body, parts: [] };
      return ok({ upload_id: "Upload0001", block_size: 4, block_num: Math.ceil(body.size / 4) });
    }
    if (pathname === "/open-apis/drive/v1/files/upload_part") {
      calls.prepared.parts.push(Buffer.from(await init.body.get("file").arrayBuffer()));
      return ok({});
    }
    if (pathname === "/open-apis/drive/v1/files/upload_finish") {
      const file = { token: `FileTok${String(next++).padStart(4, "0")}`, name: calls.prepared.file_name, type: "file", bytes: Buffer.concat(calls.prepared.parts).length };
      folder.push(file);
      return ok({ file_token: file.token });
    }
    throw new Error(`unexpected ${pathname}`);
  };
  return { fetch, folder, calls };
}

async function sealed(t, name, body = "ciphertext only") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-backup-feishu-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, name);
  await writeFile(file, body);
  return file;
}
const stamp = (day) => `idou-202610${String(day).padStart(2, "0")}T033000000Z.idou-backup`;
const ship = (file, fake, extra = {}) => shipToFeishu({ file, folderToken: FOLDER, feishu: SAAS_FEISHU, appId: APP, appSecret: "synthetic-secret", keep: 3, fetch: fake.fetch, ...extra });

test("below the number it keeps, a backup is added to the folder, and read back there", async (t) => {
  const fake = feishu({ files: [stamp(1)] });
  const result = await ship(await sealed(t, stamp(2)), fake);
  assert.deepEqual({ action: result.action, count: result.count }, { action: "added", count: 2 });
  assert.equal(result.sha256, createHash("sha256").update("ciphertext only").digest("hex"));
  assert.deepEqual(fake.folder.map((row) => row.name), [stamp(1), stamp(2)]);
});

test("at the number it keeps, the oldest is written over in place -- nothing is ever deleted -- and across pages", async (t) => {
  const fake = feishu({ files: [stamp(3), stamp(1), stamp(2), "mydoubao-20260930T033000000Z.idou-backup"], pageSize: 2 });
  const result = await ship(await sealed(t, stamp(4)), fake, { keep: 4 });
  assert.equal(result.action, "replaced");
  assert.equal(result.replaced, "mydoubao-20260930T033000000Z.idou-backup", "the oldest, whatever the name it was written under");
  assert.deepEqual(fake.folder.map((row) => row.name).sort(), [stamp(1), stamp(2), stamp(3), stamp(4)]);
  assert.equal(fake.folder.find((row) => row.name === stamp(4)).token, "FileTok0003", "the same file, its token kept");
  assert.ok(!fake.calls.some((call) => call.method === "DELETE"), "no deletion, ever");
  const again = await ship(await sealed(t, stamp(4)), fake, { keep: 4 });
  assert.equal(again.action, "already-there", "the same backup twice is one");
});

test("one too large to write over another goes up in blocks, as a new file, and says the folder needs looking at", async (t) => {
  const fake = feishu({ files: [stamp(1), stamp(2), stamp(3)] });
  const result = await ship(await sealed(t, stamp(5), "0123456789"), fake, { singleShotMax: 8 });
  assert.equal(result.action, "added");
  assert.equal(result.tooLargeToRotate, true);
  assert.deepEqual(fake.calls.prepared.parts.map((part) => part.toString()), ["0123", "4567", "89"]);
  assert.equal(fake.folder.at(-1).bytes, 10);
});

test("what Feishu refuses is said in its words, with what to do about the two that need an administrator", async (t) => {
  const file = await sealed(t, stamp(6));
  await assert.rejects(ship(file, feishu({ listRefusal: [1061004, "forbidden"] })), /读取备份文件夹失败：code=1061004 forbidden（应用没有这个文件夹的权限：在飞书里把应用加为文件夹的协作者，给「可编辑」）/);
  await assert.rejects(ship(file, feishu({ listRefusal: [99991672, "Access denied"] })), /应用没有开通这项权限/);
  await assert.rejects(ship(await sealed(t, "not-a-backup.txt"), feishu()), /不是加密备份的文件名/);
  await assert.rejects(ship(file, feishu(), { folderToken: "https://x" }), /文件夹的标识不对/);
});
