// A sealed backup (backup-seal.js) taken to a Feishu Drive folder, as the
// operator chose on 2026-09-30 -- off the server, into the organisation's own
// storage. The application's bot does it, with the application's own
// credential: nobody's login is needed at 03:30, and the folder is one an
// administrator shared with the application and nothing else. What goes up is
// ciphertext the server itself cannot read back.
//
// Bounded without deleting anything: the folder keeps `keep` backups, and once
// it has them each new one is written over the oldest -- the file keeps its
// token and takes the new name and bytes (upload_all with file_token, the way
// the scheduled reports rotate: measured 2026-09-22). A backup over the
// single upload's 20 MB cannot be written over one, and goes up as a new file
// in blocks instead; that is said, so the folder is looked at.
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export const BACKUP_NAME = /^(?:idou|mydoubao)-(\d{8}T\d{9}Z)\.idou-backup$/;
const SINGLE_SHOT_MAX = 20 * 1024 * 1024;
const FOLDER = /^[A-Za-z0-9]{8,64}$/;

// Feishu answers a refusal as HTTP 400 with its code in the body; a success is
// code 0. Either way the body says, and it is what is reported.
async function answer(response, what) {
  let body = null;
  try { body = await response.json(); } catch { /* not JSON: said below */ }
  if (body?.code === 0) return body.data ?? {};
  const code = body?.code ?? `HTTP ${response.status}`;
  const hint = code === 99991672 || code === 99991679 ? "（应用没有开通这项权限：在飞书开放平台给应用开通「上传文件」等云空间权限并发布）"
    : code === 1061004 || code === 1061002 ? "（应用没有这个文件夹的权限：在飞书里把应用加为文件夹的协作者，给「可编辑」）" : "";
  throw new Error(`${what}失败：code=${code} ${String(body?.msg ?? "").slice(0, 160)}${hint}`);
}

async function tenantToken({ feishu, appId, appSecret, fetch }) {
  const response = await fetch(feishu.openApi.tenantTokenUrl, { method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
    headers: { "content-type": "application/json" }, body: JSON.stringify({ app_id: appId, app_secret: appSecret }) });
  let body = null; try { body = await response.json(); } catch { /* said below */ }
  if (body?.code !== 0 || typeof body.tenant_access_token !== "string") throw new Error(`飞书拒绝签发应用令牌：code=${body?.code ?? response.status} ${String(body?.msg ?? "").slice(0, 160)}`);
  return body.tenant_access_token;
}

// The backups already in the folder, oldest first.
async function backupsIn({ feishu, token, folderToken, fetch }) {
  const found = [];
  for (let pageToken = null; ;) {
    const url = new URL(feishu.openApi.url("/open-apis/drive/v1/files"));
    url.searchParams.set("folder_token", folderToken); url.searchParams.set("page_size", "200");
    if (pageToken) url.searchParams.set("page_token", pageToken);
    const data = await answer(await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000), headers: { authorization: `Bearer ${token}` } }), "读取备份文件夹");
    for (const file of data.files ?? []) {
      const match = BACKUP_NAME.exec(file?.name ?? "");
      if (match && file.type === "file" && typeof file.token === "string") found.push({ token: file.token, name: file.name, at: match[1] });
    }
    if (!data.has_more || !data.next_page_token) break;
    pageToken = data.next_page_token;
  }
  return found.sort((a, b) => a.at.localeCompare(b.at));
}

async function uploadWhole({ feishu, token, folderToken, name, bytes, replacing, fetch }) {
  const form = new FormData();
  form.set("file_name", name); form.set("parent_type", "explorer"); form.set("parent_node", folderToken); form.set("size", String(bytes.length));
  if (replacing) form.set("file_token", replacing);
  form.set("file", new Blob([bytes]), name);
  const data = await answer(await fetch(feishu.openApi.url("/open-apis/drive/v1/files/upload_all"), { method: "POST", redirect: "error",
    signal: AbortSignal.timeout(300_000), headers: { authorization: `Bearer ${token}` }, body: form }), replacing ? "覆盖最旧的备份" : "上传备份");
  if (typeof data.file_token !== "string") throw new Error("上传没有返回文件标识");
  return data.file_token;
}

async function uploadInBlocks({ feishu, token, folderToken, name, bytes, fetch }) {
  const post = (path, init, what) => fetch(feishu.openApi.url(path), { method: "POST", redirect: "error", signal: AbortSignal.timeout(300_000), ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } }).then((response) => answer(response, what));
  const prepared = await post("/open-apis/drive/v1/files/upload_prepare", { headers: { "content-type": "application/json" },
    body: JSON.stringify({ file_name: name, parent_type: "explorer", parent_node: folderToken, size: bytes.length }) }, "准备分块上传");
  const blockSize = Number(prepared.block_size), blocks = Number(prepared.block_num);
  if (typeof prepared.upload_id !== "string" || !Number.isSafeInteger(blockSize) || blockSize < 1 || !Number.isSafeInteger(blocks) || blocks !== Math.ceil(bytes.length / blockSize)) throw new Error("分块上传的准备结果不对");
  for (let seq = 0; seq < blocks; seq += 1) {
    const block = bytes.subarray(seq * blockSize, Math.min(bytes.length, (seq + 1) * blockSize));
    const form = new FormData();
    form.set("upload_id", prepared.upload_id); form.set("seq", String(seq)); form.set("size", String(block.length));
    form.set("file", new Blob([block]), name);
    await post("/open-apis/drive/v1/files/upload_part", { body: form }, `上传第 ${seq + 1} 块`);
  }
  const finished = await post("/open-apis/drive/v1/files/upload_finish", { headers: { "content-type": "application/json" },
    body: JSON.stringify({ upload_id: prepared.upload_id, block_num: blocks }) }, "完成分块上传");
  if (typeof finished.file_token !== "string") throw new Error("分块上传没有返回文件标识");
  return finished.file_token;
}

// The sealed file into the folder; what was done, for the line the backup prints.
export async function shipToFeishu({ file, folderToken, feishu, appId, appSecret, keep = 14, fetch = globalThis.fetch, singleShotMax = SINGLE_SHOT_MAX }) {
  const name = path.basename(file);
  if (!BACKUP_NAME.test(name)) throw new Error(`不是加密备份的文件名：${name}`);
  if (!FOLDER.test(folderToken ?? "")) throw new Error("飞书备份文件夹的标识不对：用文件夹链接最后那一段");
  if (!Number.isSafeInteger(keep) || keep < 2 || keep > 365) throw new Error("飞书里保留的份数只能是 2 到 365");
  if (!feishu?.openApi) throw new Error("需要飞书部署定义");
  const bytes = await readFile(file);
  if (bytes.length !== (await stat(file)).size) throw new Error("读取加密备份时文件在变");
  const token = await tenantToken({ feishu, appId, appSecret, fetch });
  const present = await backupsIn({ feishu, token, folderToken, fetch });
  if (present.some((row) => row.name === name)) return { name, action: "already-there", fileToken: present.find((row) => row.name === name).token };
  const whole = bytes.length <= singleShotMax;
  const replacing = whole && present.length >= keep ? present[0] : null;
  const fileToken = whole ? await uploadWhole({ feishu, token, folderToken, name, bytes, replacing: replacing?.token ?? null, fetch })
    : await uploadInBlocks({ feishu, token, folderToken, name, bytes, fetch });
  // Read back: the folder names it now, under this name.
  const after = await backupsIn({ feishu, token, folderToken, fetch });
  if (!after.some((row) => row.token === fileToken && row.name === name)) throw new Error("上传后在文件夹里没有找到它");
  return { name, action: replacing ? "replaced" : "added", fileToken, replaced: replacing?.name ?? null, count: after.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), tooLargeToRotate: !whole };
}
