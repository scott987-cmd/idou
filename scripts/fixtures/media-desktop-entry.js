// Test-only entry: real native client, gateway and media job protocol; no paid calls.
import "../../src/adopt-legacy-env.js";
import { dialog, shell } from "electron";
import { MediaDownloader } from "../../src/application/media-download.js";
import { SaasFeishuCliProvider } from "../../src/providers/feishu/saas-cli-provider.js";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { exposeBridge } from "./agent-harness.js";
const driveFile = process.env.MEDIA_FIXTURE_DRIVE;
let drive = { uploads: 0, files: [] };
try { drive = JSON.parse(await readFile(driveFile, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
globalThis.mediaFixture = { confirmation: 0, confirmations: [], previews: 0, drive, opened: [] };
shell.openExternal = async (url) => { globalThis.mediaFixture.opened.push(url); };
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
  if (args[1] === "+inspect") return ok({ input_url: "https://synthetic.feishu.cn/drive/folder/SyntheticFolder123", token: "SyntheticFolder123", type: "folder", title: "联调成果（合成）", url: "https://synthetic.feishu.cn/drive/folder/SyntheticFolder123" });
  if (args[1] === "+upload") {
    const name = args[args.indexOf("--name") + 1];
    assert.deepEqual(args, ["drive", "+upload", "--file", name, "--name", name, "--folder-token", "SyntheticFolder123", "--as", "user", "--format", "json"]);
    assert.deepEqual(await readFile(path.join(options.cwd, name)), await readFile(process.env[name.endsWith(".png") ? "MEDIA_FIXTURE_PNG" : "MEDIA_FIXTURE_MP4"]));
    drive.uploads++;
    const token = `SyntheticFile${drive.uploads}123`;
    drive.files.push({ token, name, type: "file", parent_token: "SyntheticFolder123", url: `https://synthetic.feishu.cn/file/${token}` });
    await writeFile(driveFile, JSON.stringify(drive), { mode: 0o600 });
    return ok({ file_token: token });
  }
  assert.deepEqual(args.slice(0, 3), ["drive", "files", "list"]);
  return ok({ files: drive.files, has_more: false });
};
dialog.showOpenDialog = async () => globalThis.mediaFixture.connectionFile ? { canceled: false, filePaths: [globalThis.mediaFixture.connectionFile] } : { canceled: true, filePaths: [] };
dialog.showMessageBox = async (_win, options) => { globalThis.mediaFixture.confirmations.push(options); return { response: globalThis.mediaFixture.confirmation }; };
MediaDownloader.prototype.download = async function(result) {
  globalThis.mediaFixture.previews++;
  return { bytes: await readFile(process.env[result.kind === "image" ? "MEDIA_FIXTURE_PNG" : "MEDIA_FIXTURE_MP4"]), extension: result.kind === "image" ? "png" : "mp4" };
};
await exposeBridge();
await import("../../src/desktop/main.js");
