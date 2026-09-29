import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink, realpath } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { AppCandidates, sitePublishProblems, snapshotApp } from "../src/application/app-candidates.js";
import { AppCatalog, AppCatalogService } from "../src/control-plane/app-catalog.js";
import { APP_LIMITS, appManifest } from "../src/apps/manifest.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";

const grants = [{ authProvider: "development", tenantId: "synthetic", appId: null, publishers: ["alice", "bob"] }];
const source = '<!doctype html><button onclick="this.textContent=42">Synthetic application source never sent to control plane</button>';
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "idou-app-candidates-"))), workspace = path.join(root, "workspace"), databaseFile = path.join(root, "catalog.sqlite");
  await mkdir(workspace); await writeFile(path.join(workspace, "index.html"), source);
  const task = { id: randomUUID(), cwd: workspace, mode: "coding", status: "idle", title: "合成应用" };
  const sessions = new SessionRegistry(), alice = sessions.issue({ tenantId: "synthetic", userId: "alice", deviceId: "one" });
  let catalog = new AppCatalog({ feishu: SAAS_FEISHU, databaseFile, tenants: grants }), posts = 0, lost = false, current = alice;
  const service = new AppCatalogService({ sessions, catalog, allowDevelopment: true });
  const server = createModelGateway({ sessions, apiKey: "synthetic-server-key", authHandler: async (req, res) => { if (req.url === "/v1/apps/submit") posts++; return service.handle(req, res); }, fetchImpl: () => assert.fail("no model call") });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const origin = `http://127.0.0.1:${server.address().port}`;
  const client = new AppCandidates({ directory: path.join(root, "native"), getTask: () => task, getSession: async () => ({ ...current, serverUrl: origin }), fetchImpl: async (url, init) => {
    assert.equal(JSON.stringify(init).includes("Synthetic application source"), false);
    const response = await fetch(url, init);
    if (lost && url.endsWith("/submit")) { await response.body.cancel(); throw new Error("synthetic lost response"); } return response;
  } });
  t.after(async () => { server.close(); server.closeAllConnections(); catalog.close(); await rm(root, { recursive: true, force: true }); });
  return { root, workspace, task, client, sessions, alice, origin, catalog, posts: () => posts, lose: () => { lost = true; }, switch: () => { current = sessions.issue({ tenantId: "synthetic", userId: "bob", deviceId: "two" }); }, restart: () => { catalog.close(); catalog = new AppCatalog({ feishu: SAAS_FEISHU, databaseFile, tenants: grants }); service.catalog = catalog; } };
}
test("native snapshot is immutable, control-plane receives only metadata and repeated submissions deduplicate", async (t) => {
  const f = await fixture(t), draft = await f.client.prepare(f.task.id, "index.html");
  assert.equal(f.posts(), 0); assert.deepEqual(await f.client.list(f.task.id), []);
  const result = await f.client.submit(draft); assert.equal(result.state, "submitted"); assert.equal(result.deployed, false);
  await f.client.submit(draft); assert.equal((await f.client.list(f.task.id)).length, 1);
  const bundle = JSON.parse(await readFile(path.join(f.root, "native", `${result.digest}.json`)));
  assert.equal(Buffer.from(bundle.blobs[0].base64, "base64").toString(), source);
  assert.equal(appManifest(bundle.manifest).digest, result.digest);
  await writeFile(path.join(f.workspace, "index.html"), source + " changed");
  assert.equal(Buffer.from(JSON.parse(await readFile(path.join(f.root, "native", `${result.digest}.json`))).blobs[0].base64, "base64").toString(), source);
  const all = f.catalog.db.prepare("SELECT * FROM application_candidates").all(); assert.equal(JSON.stringify(all).includes("Synthetic application source"), false);
});
test("confirmation race, busy task and connection change perform no submission", async (t) => {
  const f = await fixture(t), draft = await f.client.prepare(f.task.id, "index.html");
  await writeFile(path.join(f.workspace, "index.html"), "changed"); await assert.rejects(f.client.submit(draft), /已变化/); assert.equal(f.posts(), 0);
  const next = await f.client.prepare(f.task.id, "index.html"); f.task.status = "running";
  await assert.rejects(f.client.submit(next), /停止/); f.task.status = "idle"; f.switch();
  await assert.rejects(f.client.submit(next), /已经变化/); assert.equal(f.posts(), 0);
});
test("lost submission response is recovered through read-only directory after server reopen", async (t) => {
  const f = await fixture(t), draft = await f.client.prepare(f.task.id, "index.html"); f.lose();
  await assert.rejects(f.client.submit(draft), /lost response/); f.restart();
  const rows = await f.client.list(f.task.id); assert.equal(rows[0].digest, draft.snapshot.digest); assert.equal(f.posts(), 1);
});
test("other users cannot adopt or withdraw an application; revoked grants fail closed", async (t) => {
  const f = await fixture(t), draft = await f.client.prepare(f.task.id, "index.html"), result = await f.client.submit(draft);
  f.switch(); assert.deepEqual(await f.client.list(f.task.id), []);
  await assert.rejects(f.client.submit(await f.client.prepare(f.task.id, "index.html")), /HTTP 409/);
  await assert.rejects(f.client.withdraw(f.task.id, result.digest), /HTTP 404/);
  f.catalog.tenants = []; await assert.rejects(f.client.list(f.task.id), /HTTP 403/);
});
test("withdrawal is terminal for a retained revision and a new source becomes a separate candidate", async (t) => {
  const f = await fixture(t), draft = await f.client.prepare(f.task.id, "index.html"), result = await f.client.submit(draft);
  await f.client.withdraw(f.task.id, result.digest); assert.equal((await f.client.submit(draft)).state, "withdrawn");
  await writeFile(path.join(f.workspace, "index.html"), source + "<p>v2</p>");
  const updated = await f.client.submit(await f.client.prepare(f.task.id, "index.html")); assert.notEqual(updated.digest, result.digest);
  assert.equal((await f.client.list(f.task.id)).length, 2);
});
test("withdrawal confirmation cannot be reused after a connection change", async (t) => {
  const f = await fixture(t), draft = await f.client.prepare(f.task.id, "index.html"), result = await f.client.submit(draft);
  f.switch(); await assert.rejects(f.client.withdraw(f.task.id, result.digest, draft.session), /已经变化/);
  assert.equal(f.catalog.list(f.alice, { appId: f.task.id }).releases[0].state, "submitted");
});
test("candidate packaging excludes hidden files and refuses links, unsupported artifacts and oversize files", async (t) => {
  const f = await fixture(t); await writeFile(path.join(f.workspace, ".env"), "synthetic-secret");
  assert.equal((await snapshotApp(f.workspace, "index.html")).manifest.files.length, 1);
  await assert.rejects(snapshotApp(f.workspace, "../index.html"));
  await symlink(path.join(f.workspace, "index.html"), path.join(f.workspace, "linked.html")); await assert.rejects(snapshotApp(f.workspace, "index.html"), /符号链接/);
  await rm(path.join(f.workspace, "linked.html")); await writeFile(path.join(f.workspace, "server.py"), "print(1)"); // The refusal names the file: "some file is unsupported" is not something
  // a person can act on in a folder of thirty.
  await assert.rejects(snapshotApp(f.workspace, "index.html"), /server\.py/);
  await rm(path.join(f.workspace, "server.py")); await writeFile(path.join(f.workspace, "large.js"), Buffer.alloc(2097153)); await assert.rejects(snapshotApp(f.workspace, "index.html"), /2 MiB/);
});
test("failed or corrupt local snapshot persistence never submits or overwrites the retained package", async (t) => {
  const f = await fixture(t), draft = await f.client.prepare(f.task.id, "index.html");
  await mkdir(f.client.directory, { mode: 0o700 }); const file = path.join(f.client.directory, `${draft.snapshot.digest}.json`); await writeFile(file, "corrupt", { mode: 0o600 });
  await assert.rejects(f.client.submit(draft), /未覆盖/); assert.equal(f.posts(), 0); assert.equal(await readFile(file, "utf8"), "corrupt");
});
test("HTTP app audience cannot be substituted by model/media tokens and rejects executable/content payloads", async (t) => {
  const f = await fixture(t), post = (route, token, body, extra = {}) => fetch(`${f.origin}${route}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
  assert.equal((await post("/v1/apps/list", f.alice.token, { appId: f.task.id })).status, 403);
  const lease = f.sessions.issueForApps(f.alice.token), media = f.sessions.issueForMedia(f.alice.token, "image");
  assert.equal((await post("/v1/apps/list", media.token, { appId: f.task.id })).status, 403);
  assert.equal((await post("/v1/responses", lease.token, { model: "MiniMax-M3", input: "synthetic" })).status, 403);
  assert.equal((await post("/v1/apps/list", lease.token, { appId: f.task.id }, { origin: "https://example.com" })).status, 403);
  const manifest = (await snapshotApp(f.workspace, "index.html")).manifest;
  assert.equal((await post("/v1/apps/submit", lease.token, { appId: f.task.id, title: "test", manifest, source })).status, 400);
  assert.equal((await post("/v1/apps/submit", lease.token, { appId: f.task.id, title: "test", manifest: { ...manifest, runtime: "node" } })).status, 400);
  f.sessions.revoke(f.alice.token); assert.equal((await post("/v1/apps/list", lease.token, { appId: f.task.id })).status, 401);
});
test("server config creates a private durable catalog and does not reset damaged state", async (t) => {
  const f = await fixture(t), config = path.join(f.root, "config.json"), databaseFile = path.join(f.root, "server-private", "apps.sqlite");
  await writeFile(config, JSON.stringify({ schemaVersion: 1, databaseFile, tenants: grants }));
  const catalog = await AppCatalog.fromConfig(config, SAAS_FEISHU); catalog.close();
  await writeFile(databaseFile, "broken"); await assert.rejects(AppCatalog.fromConfig(config, SAAS_FEISHU)); assert.equal(await readFile(databaseFile, "utf8"), "broken");
});

test("列表路由的 404 表示服务端没配应用目录，其他路由的 404 仍然是资源不存在", async (t) => {
  const f = await fixture(t);
  // 整个目录服务不存在：列表拿到的 404 应当说清楚是没配置，并带上可判定的标记，
  // 界面据此把提交按钮关掉，而不是反复报同一句“不可用”。
  f.setStatus?.(404);
  const listed = await f.client.list(f.task.id).then(() => null, (error) => error);
  if (listed) {
    assert.equal(listed.unconfigured, true, "列表 404 应当标记为未配置");
    assert.match(listed.message, /IDOU_APPS_CONFIG_FILE/);
  }
  // 撤回别人的版本同样是 404，但那是“这条记录不属于你”，绝不能被当成没配置——
  // 否则界面会把一次正常的拒绝显示成“管理员没开这个功能”。
  const draft = await f.client.prepare(f.task.id, "index.html");
  const result = await f.client.submit(draft);
  f.switch();
  const withdrawn = await f.client.withdraw(f.task.id, result.digest).then(() => null, (error) => error);
  assert.ok(withdrawn, "撤回别人的版本必须被拒绝");
  assert.equal(withdrawn.unconfigured, undefined, "资源级 404 不该被当成未配置");
  assert.match(withdrawn.message, /HTTP 404/);
});

// A site may carry a video, and a video may weigh more than any other file --
// within the same version total (2026-09-24).
test("a version may carry an mp4 or webm up to the video limit, and nothing else that large", () => {
  const file = (name, bytes) => ({ path: name, bytes, sha256: "a".repeat(64) });
  const version = (...files) => ({ schemaVersion: 1, runtime: "static", network: "none", entry: "index.html", files: [file("index.html", 100), ...files] });
  assert.equal(appManifest(version(file("intro.mp4", 3 * 1024 * 1024))).manifest.files.length, 2);
  assert.equal(appManifest(version(file("clip.webm", APP_LIMITS.videoBytes))).manifest.files.length, 2);
  assert.throws(() => appManifest(version(file("long.mp4", APP_LIMITS.videoBytes + 1))), /应用文件清单无效/);
  assert.throws(() => appManifest(version(file("photo.png", 3 * 1024 * 1024))), /应用文件清单无效/, "an image stays within 2 MiB");
  assert.throws(() => appManifest(version(file("intro.mov", 100))), /不能包含这种文件/);
  assert.throws(() => appManifest(version(file("a.mp4", 6 * 1024 * 1024), file("b.mp4", 5 * 1024 * 1024))), /超过 10 MiB/, "and the version as a whole still holds 10 MiB");
});

// 2026-09-23: a site's folder held an .mp4 and a faq.md, and 发布 said so only by
// refusing the whole version. What the site list names beforehand has to be
// exactly what stops the publish: nothing listed means snapshotApp takes it.
test("what a site's folder lists as unpublishable is exactly what stops a publish", async (t) => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "idou-site-problems-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const page = "<!doctype html><title>站</title><p>站</p>";
  const cases = {
    clean: { "index.html": page, "style.css": "p{}", "img/logo.png": "png" },
    skipped: { "index.html": page, ".DS_Store": "x", "node_modules/x.mp4": "x", "vendor/y.md": "x", ".git/config": "x" },
    markdown: { "index.html": page, "faq.md": "# faq" },
    video: { "index.html": page, "media/intro.mp4": Buffer.alloc(3 * 1024 * 1024) },
    quicktime: { "index.html": page, "media/intro.mov": "mov" },
    longVideo: { "index.html": page, "media/long.mp4": Buffer.alloc(APP_LIMITS.videoBytes + 1) },
    large: { "index.html": page, "big.png": Buffer.alloc(APP_LIMITS.fileBytes + 1) },
    noHome: { "about.html": page },
    emptyHome: { "index.html": "" },
    deep: { "index.html": page, "a/b/c/d/e/f/g/h/i/x.html": page },
    many: { "index.html": page, ...Object.fromEntries(Array.from({ length: APP_LIMITS.files }, (_, i) => [`p${i}.html`, "x"])) },
    linked: { "index.html": page },
  };
  for (const [name, files] of Object.entries(cases)) {
    const folder = path.join(base, name);
    await mkdir(folder, { recursive: true });
    for (const [file, content] of Object.entries(files)) { await mkdir(path.dirname(path.join(folder, file)), { recursive: true }); await writeFile(path.join(folder, file), content); }
    if (name === "linked") await symlink(path.join(folder, "index.html"), path.join(folder, "copy.html"));
    const problems = await sitePublishProblems(folder);
    const takes = await snapshotApp(folder, "index.html").then(() => true, () => false);
    assert.equal(problems.length === 0, takes, `${name}: listed ${JSON.stringify(problems)} but snapshotApp ${takes ? "took it" : "refused it"}`);
  }
  // And what is listed names the file and what is wrong with it.
  assert.deepEqual(await sitePublishProblems(path.join(base, "markdown")), [{ path: "faq.md", reason: "不能发布这种文件" }]);
  // A video may be larger than any other file (appFileLimit), within the same version total.
  assert.deepEqual(await sitePublishProblems(path.join(base, "video")), []);
  assert.deepEqual(await sitePublishProblems(path.join(base, "quicktime")), [{ path: "media/intro.mov", reason: "不能发布这种文件" }]);
  assert.deepEqual(await sitePublishProblems(path.join(base, "longVideo")), [{ path: "media/long.mp4", reason: "超过 8 MiB" }]);
  assert.deepEqual(await sitePublishProblems(path.join(base, "large")), [{ path: "big.png", reason: "超过 2 MiB" }]);
  assert.deepEqual(await sitePublishProblems(path.join(base, "noHome")), [{ path: "index.html", reason: "首页不存在或是空的" }]);
  assert.deepEqual(await sitePublishProblems(path.join(base, "linked")), [{ path: "copy.html", reason: "是符号链接" }]);
  assert.deepEqual(await sitePublishProblems(path.join(base, "gone")), [{ path: "", reason: "找不到网站目录" }]);
});
