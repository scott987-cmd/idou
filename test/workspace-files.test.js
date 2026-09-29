import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listWorkspaceFiles, readWorkspaceFile, inspectWorkspaceFile, workspaceOpenTarget, createArtifactServer } from "../src/application/workspace-files.js";
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
