import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink, chmod, access } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AppCandidates } from "../src/application/app-candidates.js";
import { AppArchive } from "../src/application/app-archive.js";
import { AppCatalog, AppCatalogService } from "../src/control-plane/app-catalog.js";
import { DriveBudget, DriveBudgetService, drivePolicies } from "../src/control-plane/drive-budget.js";
import { SaasDriveFiles } from "../src/providers/feishu/drive-files.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { appPackage } from "../src/apps/archive.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";

const source = '<!doctype html><p>Frozen synthetic source only for Drive, never the control server</p>';
const folderUrl = "https://synthetic.feishu.cn/drive/folder/SyntheticFolder123";
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "idou-app-archive-"))), workspace = path.join(root, "workspace");
  await mkdir(workspace); await writeFile(path.join(workspace, "index.html"), source);
  const task = { id: randomUUID(), cwd: workspace, mode: "coding", status: "idle", title: "归档测试" };
  const sessions = new SessionRegistry(), parent = sessions.issue({ tenantId: "synthetic", userId: "alice", deviceId: "one" }); let current = parent;
  const opts = { databaseFile: path.join(root, "catalog.sqlite"), tenants: [{ authProvider: "development", tenantId: "synthetic", appId: null, publishers: ["alice", "bob"] }], feishu: SAAS_FEISHU };
  const policy = { authProvider: "development", tenantId: "synthetic", appId: null, providerId: "saas-cli", driveTenantKey: "tenant", folderToken: "SyntheticFolder123", maxBytes: 1048576 };
  let catalog = new AppCatalog(opts), budget = new DriveBudget({ feishu: SAAS_FEISHU, databaseFile: path.join(root, "budget.sqlite"), policies: [policy] });
  const catalogService = new AppCatalogService({ sessions, catalog, allowDevelopment: true }), budgetService = new DriveBudgetService({ sessions, ledger: budget, allowDevelopment: true });
  const state = { uploads: 0, downloads: 0, principal: "a".repeat(64), title: "合成应用归档", files: [], lost: null, blocked: false };
  const server = createModelGateway({ sessions, apiKey: "synthetic-key", authHandler: async (req, res) => (await catalogService.handle(req, res)) || budgetService.handle(req, res), fetchImpl: () => assert.fail("no model calls") });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const origin = `http://127.0.0.1:${server.address().port}`;
  const provider = new SaasDriveFiles({ id: "saas-cli", documentIdentity: async () => ({ principal: state.principal, tenantKey: "tenant", verifiedAt: Date.now() }), invoke: async (args, options) => {
    const ok = (data) => ({ code: 0, stdout: JSON.stringify({ ok: true, identity: "user", data }) });
    assert.equal(args[args.indexOf("--as") + 1], "user");
    if (args[1] === "+inspect") return ok({ input_url: folderUrl, token: policy.folderToken, type: "folder", title: state.title, url: folderUrl });
    if (args[1] === "+upload") {
      const name = args[args.indexOf("--name") + 1];
      assert.deepEqual(args, ["drive", "+upload", "--file", name, "--name", name, "--folder-token", policy.folderToken, "--as", "user", "--format", "json"]);
      state.uploads++; state.uploadDirectory = options.cwd; state.bytes = await readFile(path.join(options.cwd, name));
      const record = catalog.list(parent, { appId: task.id }).releases[0].archive;
      assert.equal(record.state, "uploading");
      assert.equal(budget.db.prepare("SELECT state FROM drive_reservations WHERE id=?").get(record.id).state, "dispatched");
      const token = `SyntheticFile${state.uploads}123`; state.files.push({ token, name, type: "file", parent_token: policy.folderToken, url: `https://synthetic.feishu.cn/file/${token}` });
      if (state.withdrawAfterUpload) catalog.withdraw(parent, { appId: task.id, digest: state.digest });
      if (state.lostUpload) throw new Error("synthetic lost upload acknowledgment");
      return ok({ file_token: token });
    }
    if (args[1] === "+download") {
      state.downloads++; state.downloadDirectory = options.cwd;
      assert.deepEqual(args, ["drive", "+download", "--file-token", state.files[0].token, "--output", "payload.bin", "--as", "user", "--format", "json"]);
      assert.equal(options.outputFileLimit.maxBytes, state.bytes.length); assert.equal(options.outputFileLimit.path, path.join(options.cwd, "payload.bin"));
      if (state.downloadDenied) return { code: 1, stderr: JSON.stringify({ error: { message: "permission denied" } }) };
      if (state.downloadLink) await symlink(path.join(workspace, "index.html"), options.outputFileLimit.path);
      else await writeFile(options.outputFileLimit.path, state.remoteBytes ?? state.bytes);
      if (state.afterDownload) await state.afterDownload();
      return ok({ output: "/untrusted/response/path" });
    }
    assert.deepEqual(args.slice(0, 2), ["api", "GET"]);
    // The listing's query goes as --params: the pinned CLI refuses one in the path.
    assert.deepEqual([args[2], args[3], typeof JSON.parse(args[4]).folder_token], ["/open-apis/drive/v1/files", "--params", "string"]);
    if (state.listDenied) throw new Error("synthetic list denied");
    return ok({ files: state.files, has_more: false });
  } });
  const make = () => {
    const candidates = new AppCandidates({ directory: path.join(root, "native"), getTask: () => task, getSession: async () => ({ ...current, serverUrl: origin }), fetchImpl: async (url, init) => {
      assert.equal(init.body.includes("Frozen synthetic source"), false); assert.equal(init.body.includes(Buffer.from(source).toString("base64")), false);
      const response = await fetch(url, init);
      if (state.lost && url.endsWith(state.lost)) { await response.body.cancel(); throw new Error("synthetic lost HTTP response"); } return response;
    } });
    return { candidates, archive: new AppArchive({ candidates, provider, businessAccess: () => { if (state.blocked) throw new Error("enterprise identity unlinked"); } }) };
  };
  t.after(async () => { server.close(); server.closeAllConnections(); catalog.close(); budget.close(); await rm(root, { recursive: true, force: true }); });
  const first = make(), draft = await first.candidates.prepare(task.id, "index.html"), row = await first.candidates.submit(draft); state.digest = row.digest;
  return { ...first, root, workspace, task, row, state, parent, policy, make, get catalog() { return catalog; }, get budget() { return budget; },
    prepare: () => first.archive.prepare(task.id, row.digest, folderUrl),
    switch: () => { current = sessions.issue({ tenantId: "synthetic", userId: "bob", deviceId: "two" }); },
    restart: () => { catalog.close(); budget.close(); catalog = new AppCatalog(opts); budget = new DriveBudget({ feishu: SAAS_FEISHU, databaseFile: path.join(root, "budget.sqlite"), policies: [policy] }); catalogService.catalog = catalog; budgetService.ledger = budget; },
  };
}
test("preview always downloads the authorized archived version without persisting or reading local cache", async (t) => {
  const f = await fixture(t); await f.archive.save(await f.prepare());
  const retained = path.join(f.root, "native", `${f.row.digest}.json`); await rm(retained);
  await writeFile(path.join(f.workspace, "index.html"), "new workspace, not archived");
  for (let count = 1; count <= 2; count++) {
    const result = await f.archive.preview(f.task.id, f.row.digest);
    assert.deepEqual(result.pkg.bytes, f.state.bytes); assert.equal(f.state.downloads, count);
    assert.ok(result.expiresAt <= result.session.expiresAt); assert.ok(result.expiresAt <= Date.now() + 300000); assert.ok(result.expiresAt > Date.now());
    await assert.rejects(access(retained), { code: "ENOENT" });
  }
  assert.equal(f.state.uploads, 1); assert.equal(f.budget.snapshot(f.parent).chargedBytes, f.state.bytes.length);
});
test("preview fails closed on remote corruption, revoked permission or changed session even when cache is valid", async (t) => {
  const f = await fixture(t); await f.archive.save(await f.prepare());
  f.state.remoteBytes = Buffer.from(f.state.bytes); f.state.remoteBytes[f.state.remoteBytes.length - 1] = 33;
  await assert.rejects(f.archive.preview(f.task.id, f.row.digest)); f.state.remoteBytes = null;
  f.state.downloadDenied = true; await assert.rejects(f.archive.preview(f.task.id, f.row.digest)); f.state.downloadDenied = false;
  f.state.afterDownload = () => f.switch(); await assert.rejects(f.archive.preview(f.task.id, f.row.digest));
  assert.deepEqual((await f.candidates.package(f.row.digest)).bytes, f.state.bytes); assert.equal(f.state.uploads, 1);
});
test("archive uploads the confirmed package, not changed workspace, charges encoded bytes once and survives restart", async (t) => {
  const f = await fixture(t), pkg = await f.candidates.package(f.row.digest);
  await writeFile(path.join(f.workspace, "index.html"), "new unrelated workspace contents");
  const draft = await f.prepare(); assert.equal(f.state.uploads, 0); assert.equal(f.budget.snapshot(f.parent).chargedBytes, 0);
  await f.archive.save(draft); assert.equal(f.state.uploads, 1); assert.deepEqual(f.state.bytes, pkg.bytes);
  assert.equal(Buffer.from(JSON.parse(f.state.bytes).blobs[0].base64, "base64").toString(), source);
  assert.equal(f.budget.snapshot(f.parent).chargedBytes, pkg.bytes.length); assert.ok(pkg.bytes.length > f.row.totalBytes);
  await assert.rejects(access(f.state.uploadDirectory), { code: "ENOENT" });
  f.restart(); const restored = f.make(); await restored.archive.verify(f.task.id, f.row.digest);
  assert.equal((await restored.candidates.list(f.task.id))[0].archive.state, "listed");
  await assert.rejects(restored.archive.save(draft)); assert.equal(f.state.uploads, 1);
  for (const table of ["application_candidates", "application_archives"]) assert.equal(JSON.stringify(f.catalog.db.prepare(`SELECT * FROM ${table}`).all()).includes("Frozen synthetic source"), false);
});
test("lost archive dispatch or budget dispatch responses do not upload or allow another permit", async (t) => {
  for (const route of ["/archive-dispatch", "/drive/dispatch"]) {
    const f = await fixture(t), draft = await f.prepare(); f.state.lost = route;
    await assert.rejects(f.archive.save(draft)); assert.equal(f.state.uploads, 0);
    f.restart(); f.state.lost = null; const restored = f.make();
    await assert.rejects(restored.archive.prepare(f.task.id, f.row.digest, folderUrl), /已有归档/);
    await assert.rejects(restored.archive.save(draft)); assert.equal(f.state.uploads, 0);
    assert.equal(f.budget.snapshot(f.parent).chargedBytes, draft.bytes.length);
  }
});
test("lost upload acknowledgment stays unknown and never adopts a same-name file", async (t) => {
  const f = await fixture(t), draft = await f.prepare(); f.state.lostUpload = true;
  await assert.rejects(f.archive.save(draft), /lost upload/); f.restart(); const restored = f.make();
  await assert.rejects(restored.archive.verify(f.task.id, f.row.digest), /人工核查/);
  await assert.rejects(restored.archive.save(draft)); assert.equal(f.state.uploads, 1);
  assert.equal((await restored.candidates.list(f.task.id))[0].archive.fileToken, null);
});
test("lost receipt/report responses and failed listing recover from recorded token without source files or reupload", async (t) => {
  for (const mode of ["/archive-receipt", "/drive/report", "list"]) {
    const f = await fixture(t), draft = await f.prepare(); if (mode === "list") f.state.listDenied = true; else f.state.lost = mode;
    await assert.rejects(f.archive.save(draft)); assert.equal(f.state.uploads, 1);
    await rm(path.join(f.root, "native", `${f.row.digest}.json`)); f.restart(); f.state.lost = null; f.state.listDenied = false;
    const restored = f.make(); await restored.archive.verify(f.task.id, f.row.digest);
    assert.equal((await restored.candidates.list(f.task.id))[0].archive.state, "listed"); assert.equal(f.state.uploads, 1);
  }
});
test("changed folder/CLI/account, withdrawn candidate and reduced budget deny confirmed uploads", async (t) => {
  for (const change of [f => { f.state.title = "changed"; }, f => { f.state.principal = "b".repeat(64); }, f => f.switch(), f => { f.state.blocked = true; }, f => f.catalog.withdraw(f.parent, { appId: f.task.id, digest: f.row.digest }), f => { f.budget.policies = drivePolicies([{ ...f.policy, maxBytes: 1 }], SAAS_FEISHU); }]) {
    const f = await fixture(t), draft = await f.prepare(); change(f);
    await assert.rejects(f.archive.save(draft)); assert.equal(f.state.uploads, 0);
  }
});
test("withdrawal during an upload retains its receipt but never restores or deploys the candidate", async (t) => {
  const f = await fixture(t), draft = await f.prepare(); f.state.withdrawAfterUpload = true; await f.archive.save(draft);
  const row = (await f.candidates.list(f.task.id))[0]; assert.equal(row.state, "withdrawn"); assert.equal(row.archive.state, "listed"); assert.equal(row.deployed, false);
});
test("other users and altered archive targets cannot overwrite a stored archive intent or receipt", async (t) => {
  const f = await fixture(t), draft = await f.prepare(), key = { appId: f.task.id, digest: f.row.digest };
  const initial = f.catalog.archive(f.parent, "prepare", { ...key, input: draft.input }).archive;
  const bob = { ...f.parent, userId: "bob" };
  assert.throws(() => f.catalog.archive(bob, "dispatch", { ...key, id: initial.id }), /not_found/);
  assert.throws(() => f.catalog.archive(f.parent, "prepare", { ...key, input: { ...draft.input, sha256: "f".repeat(64) } }), /already_started/);
  assert.throws(() => f.catalog.archive(f.parent, "receipt", { ...key, id: initial.id, fileToken: "SyntheticFile123" }), /receipt_mismatch/);
  await f.archive.save(draft);
  assert.throws(() => f.catalog.archive(f.parent, "receipt", { ...key, id: initial.id, fileToken: "DifferentFile123" }), /receipt_mismatch/);
  assert.throws(() => f.catalog.archive(f.parent, "prepare", { ...key, input: { ...draft.input, source } }), /invalid_archive/);
});
test("frozen package validates canonical format, every blob/hash, size and private filesystem boundaries", async (t) => {
  const f = await fixture(t), pkg = await f.candidates.package(f.row.digest), value = JSON.parse(pkg.bytes);
  for (const mutate of [v => { v.blobs[0].base64 = Buffer.from("corrupt").toString("base64"); }, v => { v.blobs[0].path = "other.html"; }, v => { v.blobs.push(v.blobs[0]); }, v => { v.extra = "untrusted"; }, v => { v.manifest.network = "any"; }]) {
    const clone = structuredClone(value); mutate(clone); assert.throws(() => appPackage(Buffer.from(JSON.stringify(clone)), f.row.digest));
  }
  assert.throws(() => appPackage(Buffer.from(JSON.stringify(value, null, 2)), f.row.digest), /规范格式/);
  const altered = structuredClone(value); altered.blobs[0].base64 = Buffer.from(source.replace("Frozen", "Forged")).toString("base64");
  assert.throws(() => appPackage(Buffer.from(JSON.stringify(altered)), f.row.digest), /内容校验失败/);
  const file = path.join(f.root, "native", `${f.row.digest}.json`);
  await writeFile(file, "corrupt"); await assert.rejects(f.prepare()); assert.equal(f.state.uploads, 0);
  await rm(file); await symlink(path.join(f.workspace, "index.html"), file); await assert.rejects(f.prepare()); await rm(file);
  await writeFile(file, pkg.bytes, { mode: 0o600 }); if (process.platform !== "win32") { await chmod(file, 0o644); await assert.rejects(f.prepare(), /不安全/); }
});
test("independent server processes grant archive dispatch exactly once for one retained candidate", async (t) => {
  const f = await fixture(t), draft = await f.prepare(), key = { appId: f.task.id, digest: f.row.digest };
  const record = f.catalog.archive(f.parent, "prepare", { ...key, input: draft.input }).archive;
  const module = new URL("../src/control-plane/app-catalog.js", import.meta.url).href;
  const saasUrl = new URL("../src/providers/feishu/saas-definition.js", import.meta.url).href;
  const code = `import {AppCatalog} from ${JSON.stringify(module)}; import {SAAS_FEISHU} from ${JSON.stringify(saasUrl)}; const c=new AppCatalog({ ...JSON.parse(process.argv[1]), feishu: SAAS_FEISHU }); try { c.archive(JSON.parse(process.argv[2]),"dispatch",JSON.parse(process.argv[3])); console.log("granted"); } catch(e) { console.log(e.message); } finally { c.close(); }`;
  const opts = { databaseFile: path.join(f.root, "catalog.sqlite"), tenants: f.catalog.tenants };
  const results = await Promise.all(Array.from({ length: 4 }, () => promisify(execFile)(process.execPath, ["--input-type=module", "-e", code, JSON.stringify(opts), JSON.stringify(f.parent), JSON.stringify({ ...key, id: record.id })])));
  assert.equal(results.filter((r) => r.stdout.trim() === "granted").length, 1);
  assert.equal(results.filter((r) => r.stdout.trim() === "application_archive_already_started_or_withdrawn").length, 3);
  f.restart(); assert.equal(f.catalog.list(f.parent, { appId: f.task.id }).releases[0].archive.state, "uploading");
});
test("version-one catalog upgrades without losing existing candidates; new archive HTTP routes require app audience", async (t) => {
  const f = await fixture(t); f.catalog.db.exec("DROP TABLE application_archives; PRAGMA user_version=1;"); f.restart();
  assert.equal(f.catalog.list(f.parent, { appId: f.task.id }).releases[0].digest, f.row.digest);
  assert.equal(f.catalog.db.prepare("PRAGMA user_version").get().user_version, 3);
  const session = await f.candidates.session();
  for (const action of ["prepare", "dispatch", "receipt", "verify"]) await assert.rejects(f.candidates.request(session, `/v1/apps/archive-${action}`, session.token, { appId: f.task.id, digest: f.row.digest }), /HTTP 403/);
});
test("remote retrieval restores missing retained bytes and never uses cache or sends source to server", async (t) => {
  const f = await fixture(t); await f.archive.save(await f.prepare());
  const filename = path.join(f.root, "native", `${f.row.digest}.json`), original = await readFile(filename);
  await rm(filename); f.restart(); const restored = f.make();
  const receipt = await restored.archive.retrieve(f.task.id, f.row.digest);
  assert.equal(receipt.digest, f.row.digest); assert.equal(receipt.bytes, original.length);
  assert.deepEqual(await readFile(filename), original); assert.equal(f.state.downloads, 1); assert.equal(f.state.uploads, 1);
  assert.equal(f.budget.snapshot(f.parent).chargedBytes, original.length);
  await assert.rejects(access(f.state.downloadDirectory), { code: "ENOENT" });
  f.state.downloadDenied = true; await assert.rejects(restored.archive.retrieve(f.task.id, f.row.digest));
  assert.deepEqual(await readFile(filename), original); assert.equal(f.state.downloads, 2);
});
test("same-length corruption, oversized download, unsafe output and CLI failure cannot restore a package", async (t) => {
  for (const mode of ["corrupt", "oversize", "link", "deny"]) {
    const f = await fixture(t); await f.archive.save(await f.prepare());
    const filename = path.join(f.root, "native", `${f.row.digest}.json`); await rm(filename);
    if (mode === "corrupt") { const value = JSON.parse(f.state.bytes); value.blobs[0].base64 = Buffer.from(source.replace("Frozen", "Forged")).toString("base64"); f.state.remoteBytes = Buffer.from(JSON.stringify(value)); }
    if (mode === "oversize") f.state.remoteBytes = Buffer.alloc(f.state.bytes.length + 1);
    if (mode === "link") f.state.downloadLink = true;
    if (mode === "deny") f.state.downloadDenied = true;
    await assert.rejects(f.archive.retrieve(f.task.id, f.row.digest));
    await assert.rejects(access(filename), { code: "ENOENT" }); await assert.rejects(access(f.state.downloadDirectory), { code: "ENOENT" });
    assert.equal(f.state.uploads, 1);
  }
});
test("revoked folder access, changed identity/owner and withdrawn-during-read never restore stale content", async (t) => {
  for (const change of [f => { f.state.listDenied = true; }, f => { f.state.principal = "b".repeat(64); }, f => f.switch(), f => f.catalog.withdraw(f.parent, { appId: f.task.id, digest: f.row.digest })]) {
    const f = await fixture(t); await f.archive.save(await f.prepare());
    const filename = path.join(f.root, "native", `${f.row.digest}.json`); await rm(filename); f.state.afterDownload = () => change(f);
    await assert.rejects(f.archive.retrieve(f.task.id, f.row.digest)); await assert.rejects(access(filename), { code: "ENOENT" });
    assert.equal(f.state.downloads, 1); assert.equal(f.state.uploads, 1);
  }
});
test("retrieval checks actual outer hash and never replaces a corrupt local retained package", async (t) => {
  const f = await fixture(t); await f.archive.save(await f.prepare());
  const filename = path.join(f.root, "native", `${f.row.digest}.json`); await writeFile(filename, "existing damaged cache");
  await assert.rejects(f.archive.retrieve(f.task.id, f.row.digest), /不一致/); assert.equal(await readFile(filename, "utf8"), "existing damaged cache");
  const stored = f.catalog.db.prepare("SELECT * FROM application_archives").get(), record = JSON.parse(stored.record); record.input.sha256 = "f".repeat(64);
  f.catalog.db.prepare("UPDATE application_archives SET record=?").run(JSON.stringify(record));
  await assert.rejects(f.archive.retrieve(f.task.id, f.row.digest), /已确认版本不一致/);
});
test("restoring a missing package refuses a symlinked ancestor of its cache directory", async (t) => {
  const f = await fixture(t); await f.archive.save(await f.prepare());
  const filename = path.join(f.root, "native", `${f.row.digest}.json`); await rm(filename);
  await symlink(f.root, path.join(f.root, "linked")); f.candidates.directory = path.join(f.root, "linked", "native");
  await assert.rejects(f.archive.retrieve(f.task.id, f.row.digest), /不安全/); await assert.rejects(access(filename), { code: "ENOENT" });
});
