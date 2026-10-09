import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listWorkspaceFiles, readWorkspaceFile, inspectWorkspaceFile, workspaceOpenTarget, createArtifactServer, MAX_PREVIEW_FILE_BYTES } from "../src/application/workspace-files.js";
import { contractFiles, CONTRACT_DATA_PATH, MAX_DATA_FILE_BYTES } from "../src/application/table-contract.js";
import { SLICE_LIMITS } from "../src/application/table-slice.js";
import { openWorkspaceItem } from "../src/desktop/workspace-open.js";

test("workspace files and static preview reject traversal, secrets and symlink escapes", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "idou-files-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const cwd = path.join(parent, "workspace"); await mkdir(cwd);
  await writeFile(path.join(cwd, "index.html"), "<h1>实际应用</h1>");
  await writeFile(path.join(cwd, ".env"), "PRIVATE=secret");
  await writeFile(path.join(parent, "outside.txt"), "outside");
  await symlink(path.join(parent, "outside.txt"), path.join(cwd, "escape.txt"));
  await symlink(path.join(cwd, ".env"), path.join(cwd, "hidden.txt"));
  assert.deepEqual((await listWorkspaceFiles(cwd)).map((item) => item.name), ["index.html"]);
  assert.equal((await readWorkspaceFile(cwd, "index.html")).canPreview, true);
  for (const name of ["../outside.txt", "escape.txt", "hidden.txt", ".env", "/etc/passwd"]) await assert.rejects(readWorkspaceFile(cwd, name));
  const server = await createArtifactServer(cwd); t.after(server.close);
  const response = await fetch(server.url("index.html"));
  assert.equal(response.status, 200); assert.equal(await response.text(), "<h1>实际应用</h1>");
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(response.headers.get("content-security-policy"), /connect-src 'self'/);
  assert.equal((await fetch(`${server.origin}/index.html`)).status, 404);
  assert.equal((await fetch(server.url(".env"))).status, 404);
  assert.equal((await fetch(server.url("index.html"), { method: "POST" })).status, 404);
  assert.equal(server.relative(server.url("index.html")), "index.html");
  assert.equal(server.allows(server.url("index.html")), true);
  assert.equal(server.allows(`${server.origin}/index.html`), false);
});

// 2026-09-23, while recording: a site's page with an .mp4 on it showed an empty
// player in the local preview -- the preview served only the types a site
// could then hold, and the video was a 404.
// 2026-10-08: a table read into a site came to a 21.3 MB data file (13 fields,
// 20,000 rows), and the site's preview showed a dashboard of 0 rows -- the
// preview stopped at 20 MiB and answered the data file with a 404, while a slice
// may be 24 MiB. The limit is now the largest data file a slice can write.
test("the preview serves a table site's data file as large as a slice can make it", async (t) => {
  // The largest: a snapshot at the slice limit, under a schema of the most fields.
  const fields = Array.from({ length: SLICE_LIMITS.fields }, (_, i) => ({ id: `fld${String(i).padStart(7, "0")}`, name: `字段名字可以写得很长很长的第 ${i} 列`, type: "text", format: { kind: "text" } }));
  const schema = { version: 1, sliceId: "s".repeat(32), source: { kind: "base", token: "SyntheticBaseToken01", tableId: "tblSynthetic", viewId: null, title: "名".repeat(120) }, fields, rows: { limit: SLICE_LIMITS.rows, truncated: false } };
  const empty = { sliceId: "s".repeat(32), readAt: 1, truncated: false, rowCount: 1, rows: [], digest: "d".repeat(64) };
  const room = SLICE_LIMITS.bytes - Buffer.byteLength(JSON.stringify(empty)) - Buffer.byteLength('{"id":"rec1","values":{"fld0000000":""}}');
  const snapshot = { ...empty, rows: [{ id: "rec1", values: { fld0000000: "x".repeat(room) } }] };
  assert.equal(Buffer.byteLength(JSON.stringify(snapshot)), SLICE_LIMITS.bytes);
  const largest = Buffer.byteLength(contractFiles({ schema, snapshot }).get(CONTRACT_DATA_PATH));
  assert.ok(largest <= MAX_DATA_FILE_BYTES, `a slice at its limit writes ${largest} bytes, over MAX_DATA_FILE_BYTES`);
  assert.ok(MAX_PREVIEW_FILE_BYTES >= MAX_DATA_FILE_BYTES);
  // And the preview serves it -- the size that was a 404.
  const cwd = await mkdtemp(path.join(os.tmpdir(), "idou-preview-table-")); t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(path.join(cwd, "data"));
  await writeFile(path.join(cwd, CONTRACT_DATA_PATH), Buffer.alloc(21_331_737, 0x20));
  const server = await createArtifactServer(cwd); t.after(server.close);
  const answer = await fetch(server.url(CONTRACT_DATA_PATH));
  assert.equal(answer.status, 200);
  assert.equal((await answer.arrayBuffer()).byteLength, 21_331_737);
});

test("the preview serves a page's video, and in the pieces a player asks for", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "idou-preview-video-")); t.after(() => rm(cwd, { recursive: true, force: true }));
  const video = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
  await writeFile(path.join(cwd, "intro.mp4"), video);
  const server = await createArtifactServer(cwd); t.after(server.close);
  const whole = await fetch(server.url("intro.mp4"));
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("content-type"), "video/mp4");
  assert.equal(whole.headers.get("accept-ranges"), "bytes");
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()), video);
  const part = await fetch(server.url("intro.mp4"), { headers: { range: "bytes=0-1" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), "bytes 0-1/32");
  assert.deepEqual([...Buffer.from(await part.arrayBuffer())], [0, 1]);
  const past = await fetch(server.url("intro.mp4"), { headers: { range: "bytes=32-" } });
  assert.equal(past.status, 416); await past.arrayBuffer();
});

test("the file panel preserves text, raster and Office identities and only system-opens an allow-listed task file", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "idou-file-kinds-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(path.join(cwd, "notes.txt"), "one\ntwo\n");
  await writeFile(path.join(cwd, "picture.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  await writeFile(path.join(cwd, "report.docx"), Buffer.from("office bytes\0"));
  await writeFile(path.join(cwd, "run.sh"), "#!/bin/sh\necho no\n");
  const text = await inspectWorkspaceFile(cwd, "notes.txt"), image = await inspectWorkspaceFile(cwd, "picture.png"), office = await inspectWorkspaceFile(cwd, "report.docx");
  assert.deepEqual([text.kind, text.text, text.canSystemOpen], ["text", "one\ntwo\n", undefined]);
  assert.equal(image.kind, "image"); assert.match(image.dataUrl, /^data:image\/png;base64,/); assert.equal(image.canSystemOpen, true);
  assert.deepEqual([office.kind, office.extension, office.canSystemOpen], ["office", "DOCX", true]);
  await assert.rejects(workspaceOpenTarget(cwd, "run.sh", { system: true }), /避免执行脚本或网页/);
  const calls = [], systemShell = { openPath: async value => { calls.push(["open", value]); return ""; }, showItemInFolder: value => calls.push(["reveal", value]) };
  await openWorkspaceItem(cwd, "report.docx", "open", systemShell);
  await openWorkspaceItem(cwd, "run.sh", "reveal", systemShell);
  assert.deepEqual(calls.map(([kind, value]) => [kind, path.basename(value)]), [["open", "report.docx"], ["reveal", "run.sh"]]);
  await assert.rejects(openWorkspaceItem(cwd, "run.sh", "open", systemShell), /避免执行脚本或网页/);
});

test("missing files and every symbolic link fail with stable user-facing errors", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "idou-file-boundary-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(path.join(cwd, "inside")); await writeFile(path.join(cwd, "inside", "file.txt"), "ok");
  await symlink(path.join(cwd, "inside", "file.txt"), path.join(cwd, "inside-link.txt"));
  await symlink(path.join(cwd, "inside"), path.join(cwd, "folder-link"));
  await assert.rejects(inspectWorkspaceFile(cwd, "missing.docx"), /文件已不在原位置/);
  await assert.rejects(inspectWorkspaceFile(cwd, "inside-link.txt"), /符号链接/);
  await assert.rejects(inspectWorkspaceFile(cwd, "folder-link/file.txt"), /符号链接/);
});
