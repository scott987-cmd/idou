// Test-only native dialogs. Product candidate collection, HTTP and SQLite remain real.
import "../../src/adopt-legacy-env.js";
import { dialog } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { SaasFeishuCliProvider } from "../../src/providers/feishu/saas-cli-provider.js";
import { AppArchive } from "../../src/application/app-archive.js";
let drive = { uploads: 0, downloads: 0, files: [] };
try { drive = JSON.parse(await readFile(process.env.APPS_FIXTURE_DRIVE, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
// Confirmations are answered in the window now, so nothing here decides them.
// showMessageBox is kept only to record that no path fell back to a system
// alert -- a stub that answered one would hide exactly that regression.
globalThis.appsFixture = { dialogs: [], drive };
const originalPreview = AppArchive.prototype.preview;
AppArchive.prototype.preview = async function(...args) {
  const result = await originalPreview.apply(this, args);
  if (globalThis.appsFixture.previewLifetime) result.expiresAt = Math.min(result.expiresAt, Date.now() + globalThis.appsFixture.previewLifetime);
  return result;
};
const originalInvoke = SaasFeishuCliProvider.prototype.invoke;
SaasFeishuCliProvider.prototype.invoke = async function(args, options) {
  const ok = (data) => ({ code: 0, stdout: JSON.stringify({ ok: true, identity: "user", data }) });
  if (args[0] === "auth" && args[1] === "status") return { code: 0, stdout: JSON.stringify({ verified: true, identities: { user: { tokenStatus: "valid", openId: "synthetic-user", tenantKey: "synthetic-tenant" } } }) };
  // Verification reads the destination through the read-only API passthrough,
  // its query as --params (lark-cli 1.0.96 refuses one in the path).
  if (args[0] === "api" && args[1] === "GET" && args[2] === "/open-apis/drive/v1/files") {
    assert.equal(args[3], "--params"); assert.equal(JSON.parse(args[4]).folder_token, "SyntheticFolder123");
    return ok({ files: drive.files, has_more: false });
  }
  if (args[0] !== "drive") return originalInvoke.call(this, args, options);
  assert.equal(args[args.indexOf("--as") + 1], "user");
  if (args[1] === "+inspect") return ok({ input_url: "https://synthetic.feishu.cn/drive/folder/SyntheticFolder123", token: "SyntheticFolder123", type: "folder", title: "应用版本归档（合成）", url: "https://synthetic.feishu.cn/drive/folder/SyntheticFolder123" });
  if (args[1] === "+upload") {
    const name = args[args.indexOf("--name") + 1];
    assert.deepEqual(args, ["drive", "+upload", "--file", name, "--name", name, "--folder-token", "SyntheticFolder123", "--as", "user", "--format", "json"]);
    assert.match(name, /\.app\.json$/); const bytes = await readFile(path.join(options.cwd, name));
    drive.uploads++; drive.bytes = bytes.toString("base64"); const token = `SyntheticFile${drive.uploads}123`;
    drive.files.push({ token, name, type: "file", parent_token: "SyntheticFolder123", url: `https://synthetic.feishu.cn/file/${token}` });
    await writeFile(process.env.APPS_FIXTURE_DRIVE, JSON.stringify(drive), { mode: 0o600 }); return ok({ file_token: token });
  }
  if (args[1] === "+download") {
    if (globalThis.appsFixture.deferDownload) await new Promise((resolve) => { globalThis.appsFixture.releaseDownload = resolve; });
    assert.deepEqual(args, ["drive", "+download", "--file-token", drive.files[0].token, "--output", "payload.bin", "--as", "user", "--format", "json"]);
    const bytes = Buffer.from(drive.bytes, "base64");
    if (globalThis.appsFixture.corruptDownload) bytes[bytes.length - 1] = 33;
    assert.equal(options.outputFileLimit.maxBytes, bytes.length); drive.downloads++;
    await writeFile(path.join(options.cwd, "payload.bin"), bytes, { mode: 0o600 });
    await writeFile(process.env.APPS_FIXTURE_DRIVE, JSON.stringify(drive), { mode: 0o600 }); return ok({});
  }
  assert.deepEqual(args.slice(0, 3), ["drive", "files", "list"]); return ok({ files: drive.files, has_more: false });
};
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [process.env.APPS_FIXTURE_WORKSPACE] });
dialog.showMessageBox = async (_window, options) => { globalThis.appsFixture.dialogs.push(options); return { response: 0 }; };
await import("../../src/desktop/main.js");
