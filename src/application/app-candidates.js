import { constants } from "node:fs";
import { open, readdir, lstat, realpath, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { APP_FILE_PATTERN, APP_LIMITS, appFileLimit, appManifest, appHash, appId, appPath } from "../apps/manifest.js";
import { validateServerUrl } from "../control-plane/client-session.js";
import { appPackage, MAX_APP_PACKAGE_BYTES, archiveRecord } from "../apps/archive.js";
import { reviewRecord } from "../apps/review.js";
import { CLOCK_SKEW_MS } from "./clock-skew.js";

export async function snapshotApp(cwd, entry) {
  appPath(entry); if (!/\.html?$/.test(entry)) throw new Error("请选择 HTML 入口");
  const workspace = await realpath(cwd), root = path.join(workspace, path.dirname(entry));
  if (await realpath(root) !== root) throw new Error("应用目录不能包含符号链接");
  const buffer = Buffer.alloc(Math.max(APP_LIMITS.fileBytes, APP_LIMITS.videoBytes) + 1);
  const blobs = [], walk = async (directory, prefix = "") => {
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length > 256) throw new Error("应用目录过大，请选择独立的构建产物目录");
    for (const item of entries) {
      if (item.name.startsWith(".") || ["node_modules", "vendor"].includes(item.name)) continue;
      const name = prefix + item.name, full = path.join(directory, item.name);
      if (item.isSymbolicLink()) throw new Error("应用产物不能包含符号链接");
      if (item.isDirectory()) { if (name.split("/").length > 8) throw new Error("应用目录层级超限"); await walk(full, `${name}/`); continue; }
      appPath(name); if (!item.isFile() || blobs.length >= APP_LIMITS.files) throw new Error("应用文件数量或类型无效");
      const handle = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const limit = appFileLimit(name), tooBig = `单个文件不能超过 ${limit / 1024 / 1024} MiB：${name}`;
        const before = await handle.stat(); if (!before.isFile() || before.size > limit) throw new Error(tooBig);
        let used = 0;
        while (used < buffer.length) { const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null); if (!bytesRead) break; used += bytesRead; }
        if (used > limit) throw new Error(tooBig);
        const bytes = Buffer.from(buffer.subarray(0, used)), after = await handle.stat();
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== before.size || await realpath(full) !== full) throw new Error("读取期间文件发生变化，请重试");
        blobs.push({ path: name, bytes });
        if (blobs.reduce((sum, blob) => sum + blob.bytes.length, 0) > APP_LIMITS.totalBytes) throw new Error("应用版本超过 10 MiB");
      } finally { await handle.close(); }
    }
  };
  await walk(root);
  const result = appManifest({ schemaVersion: 1, runtime: "static", network: "none", entry: path.basename(entry), files: blobs.map((file) => ({ path: file.path, bytes: file.bytes.length, sha256: appHash(file.bytes) })) });
  return { ...result, root, blobs: result.manifest.files.map((file) => ({ path: file.path, base64: blobs.find((blob) => blob.path === file.path).bytes.toString("base64") })) };
}

// Everything that would stop a site's folder from being published, found before
// anyone presses 发布. snapshotApp stops at the first file it cannot take, which
// is how a site learned it held a video only when the whole version was refused
// (2026-09-23). The same walk and the same rules, read-only and listing all of
// them; a folder with nothing listed is one snapshotApp takes -- the test holds
// the two to exactly that. At most 20 are listed.
export async function sitePublishProblems(folder, entry = "index.html") {
  const problems = [], add = (file, reason) => { if (problems.length < 20) problems.push({ path: file, reason }); };
  let root;
  try { root = await realpath(folder); } catch { return [{ path: "", reason: "找不到网站目录" }]; }
  const seen = new Set();
  let files = 0, total = 0, home = 0;
  const walk = async (directory, prefix = "") => {
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length > 256) { add(prefix || "./", "一个目录里超过 256 项"); return; }
    for (const item of entries) {
      if (item.name.startsWith(".") || ["node_modules", "vendor"].includes(item.name)) continue;
      const name = prefix + item.name, full = path.join(directory, item.name);
      if (item.isSymbolicLink()) { add(name, "是符号链接"); continue; }
      if (item.isDirectory()) { if (name.split("/").length > 8) add(name, "目录层级超过 8 层"); else await walk(full, `${name}/`); continue; }
      if (!item.isFile()) { add(name, "不是普通文件"); continue; }
      try { appPath(name); } catch { add(name, APP_FILE_PATTERN.test(name) ? "文件名里有网站不能用的字符" : "不能发布这种文件"); continue; }
      const folded = name.toLowerCase().normalize("NFC");
      if (seen.has(folded)) add(name, "和另一个文件只差大小写"); seen.add(folded);
      const { size } = await lstat(full);
      files += 1; total += size;
      if (size > appFileLimit(name)) add(name, `超过 ${appFileLimit(name) / 1024 / 1024} MiB`);
      if (name === entry) home = size;
    }
  };
  await walk(root);
  if (files > APP_LIMITS.files) add("", `文件超过 ${APP_LIMITS.files} 个`);
  if (total > APP_LIMITS.totalBytes) add("", `合计超过 ${APP_LIMITS.totalBytes / 1024 / 1024} MiB`);
  if (!home) add(entry, "首页不存在或是空的");
  return problems;
}

export class AppCandidates {
  constructor({ directory, getTask, getSession, fetchImpl = fetch }) { Object.assign(this, { directory, getTask, getSession, fetch: fetchImpl }); this.queue = Promise.resolve(); }
  task(id) { if (!appId(id)) throw new Error("应用任务标识无效"); const task = this.getTask(id); if (task.mode !== "coding" || ["running", "awaiting_approval", "stopping"].includes(task.status)) throw new Error("请先停止编程任务，再操作应用版本"); return task; }
  async session() { const s = await this.getSession(); if (!s || !/^[A-Za-z0-9_-]{43}$/.test(s.token) || !Number.isFinite(s.expiresAt) || s.expiresAt <= Date.now()) throw new Error("请先登录或连接服务端"); return { ...s, serverUrl: validateServerUrl(s.serverUrl) }; }
  async unchanged(expected) { const current = await this.session(); if (current.token !== expected.token || current.serverUrl !== expected.serverUrl) throw new Error("账号或服务端已经变化"); }
  async request(session, route, token, body, { serviceProbe = false } = {}) {
    const response = await this.fetch(`${session.serverUrl}${route}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok || !response.body || response.headers.get("content-type")?.split(";")[0] !== "application/json") {
      await response.body?.cancel();
      // On the listing route a 404 can only mean the control plane was started
      // without an application catalogue at all — there is no resource there to
      // be missing. Elsewhere a 404 is about the specific record being asked
      // for (someone else's version, an already-withdrawn digest), which is a
      // different thing entirely and must keep saying so.
      const unconfigured = serviceProbe && response.status === 404;
      const error = new Error(unconfigured
        ? "这个服务端没有启用应用目录。需要管理员在服务端配置 IDOU_APPS_CONFIG_FILE 后重启，才能提交和审核版本清单。"
        : `应用目录服务不可用或未授权（HTTP ${response.status}）；未自动重新提交`);
      error.status = response.status;
      if (unconfigured) error.unconfigured = true;
      throw error;
    }
    let size = 0; const chunks = [], reader = response.body.getReader();
    try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 262144) { await reader.cancel(); throw new Error("应用目录响应超限"); } chunks.push(Buffer.from(value)); } } finally { reader.releaseLock(); }
    const result = JSON.parse(Buffer.concat(chunks)); await this.unchanged(session); return result;
  }
  // The token route is the first thing every catalogue call touches, so when
  // the control plane was started without a catalogue at all this is where the
  // 404 actually lands. An authorised-publisher problem answers 403, not 404,
  // so a 404 here can only mean the service is absent.
  async lease(session) {
    const result = await this.request(session, "/auth/apps-token", session.token, {}, { serviceProbe: true });
    if (result.audience !== "app-catalog" || !/^[A-Za-z0-9_-]{43}$/.test(result.token) || !Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now() || result.expiresAt > Math.min(session.expiresAt, Date.now() + 300000 + CLOCK_SKEW_MS)) throw new Error("应用目录授权无效"); return result.token;
  }
  async prepare(id, entry) { const task = this.task(id), session = await this.session(), snapshot = await snapshotApp(task.cwd, entry); await this.unchanged(session); return { id, entry, title: task.title.slice(0, 80), session, snapshot }; }
  async package(digest) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("应用版本标识无效");
    const dir = await lstat(this.directory);
    if (!dir.isDirectory() || await realpath(this.directory) !== this.directory || (process.platform !== "win32" && ((dir.mode & 0o077) || dir.uid !== process.getuid()))) throw new Error("应用版本缓存目录不安全");
    const handle = await open(path.join(this.directory, `${digest}.json`), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_APP_PACKAGE_BYTES || (process.platform !== "win32" && ((stat.mode & 0o077) || stat.uid !== process.getuid()))) throw new Error("应用版本缓存不安全或超限");
      const buffer = Buffer.alloc(stat.size + 1); let used = 0;
      while (used < buffer.length) { const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null); if (!bytesRead) break; used += bytesRead; }
      const after = await handle.stat();
      if (used !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error("应用版本缓存读取期间发生变化");
      return appPackage(buffer.subarray(0, used), digest);
    } finally { await handle.close(); }
  }
  async persist(snapshot) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.directory); if (!directory.isDirectory() || await realpath(this.directory) !== this.directory || (process.platform !== "win32" && ((directory.mode & 0o077) || directory.uid !== process.getuid()))) throw new Error("应用版本缓存目录权限不安全");
    const filename = path.join(this.directory, `${snapshot.digest}.json`);
    const contents = JSON.stringify({ manifest: snapshot.manifest, blobs: snapshot.blobs });
    let handle, created = false;
    try {
      try { handle = await open(filename, "wx", 0o600); created = true; }
      catch (error) { if (error.code !== "EEXIST") throw error; handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
      if (!created) { const stat = await handle.stat(); if (!stat.isFile() || stat.size !== Buffer.byteLength(contents) || (process.platform !== "win32" && (stat.mode & 0o077)) || await handle.readFile("utf8") !== contents) throw new Error("已有应用版本缓存不一致，未覆盖"); return; }
      if ((await readdir(this.directory)).length > 30) throw new Error("本机应用版本缓存已满，请由管理员归档");
      await handle.writeFile(contents); await handle.sync();
    } catch (error) { if (created) await unlink(filename).catch(() => {}); throw error; }
    finally { await handle?.close(); }
    if (process.platform !== "win32") { const dir = await open(this.directory, "r"); try { await dir.sync(); } finally { await dir.close(); } }
  }
  submit(draft) {
    const run = this.queue.then(async () => {
      const task = this.task(draft.id); await this.unchanged(draft.session);
      const current = await snapshotApp(task.cwd, draft.entry);
      if (current.digest !== draft.snapshot.digest || current.root !== draft.snapshot.root) throw new Error("确认期间源码或产物已变化，请重新检查版本");
      await this.persist(draft.snapshot);
      const token = await this.lease(draft.session);
      const result = await this.request(draft.session, "/v1/apps/submit", token, { appId: draft.id, title: draft.title, manifest: draft.snapshot.manifest });
      if (result.appId !== draft.id || result.digest !== draft.snapshot.digest || !["submitted", "withdrawn"].includes(result.state) || result.deployed !== false) throw new Error("应用目录回执无效，请刷新核查"); return result;
    }); this.queue = run.catch(() => {}); return run;
  }
  async list(id) {
    this.task(id); const session = await this.session(), token = await this.lease(session), value = await this.request(session, "/v1/apps/list", token, { appId: id }, { serviceProbe: true });
    if (!Array.isArray(value.releases) || value.releases.length > 30 || value.releases.some((row) => row.appId !== id || !/^[a-f0-9]{64}$/.test(row.digest) || !["submitted", "withdrawn"].includes(row.state) || row.deployed !== false || typeof row.title !== "string" || row.title.length > 80 || !Number.isSafeInteger(row.totalBytes) || row.totalBytes < 0 || !Number.isSafeInteger(row.fileCount) || row.fileCount < 1 || row.fileCount > 128)) throw new Error("应用目录响应无效");
    for (const row of value.releases) { if (row.archive) archiveRecord(row.archive); row.review = reviewRecord(row.review); }
    return value.releases;
  }
  async withdraw(id, digest, expectedSession) {
    this.task(id); const session = expectedSession ?? await this.session(); await this.unchanged(session); const token = await this.lease(session);
    return this.request(session, "/v1/apps/withdraw", token, { appId: id, digest });
  }
}
