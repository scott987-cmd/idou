import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { readDeploymentFile, preflight, serverEnvironment, redactDeployment, DEPLOYMENT_KEYS } from "../src/application/deployment.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";

const complete = model => [
  "IDOU_PUBLIC_URL=http://127.0.0.1:3041", "IDOU_PORT=3041",
  "FEISHU_APP_ID=cli_fixture", "FEISHU_APP_SECRET=fixture-secret",
  "FEISHU_ALLOWED_TENANTS=tenant_fixture", "FEISHU_SOURCE_ACCESS_ENABLED=1",
  "FEISHU_CLI_BRIDGE_ENABLED=1", "FEISHU_CLI_SCOPES=docx:document:readonly",
  "FEISHU_CLI_WRITE_ACTIONS=document.inline-replace", `MINIMAX_CONFIG_FILE=${model}`,
].join("\n");

async function fixture(t, contents, mode = 0o600) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-deployment-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const model = path.join(directory, "mmx.json");
  await writeFile(model, JSON.stringify({ region: "cn", api_key: "fixture-model-key" }), { mode: 0o600 });
  const filename = path.join(directory, "mydoubao.env");
  await writeFile(filename, typeof contents === "function" ? contents(model) : contents, { mode: 0o600 });
  await chmod(filename, mode);
  return { filename, model, directory };
}

test("a deployment file is read like a credential and rejects anything it cannot account for", async t => {
  await assert.rejects(readDeploymentFile("relative/path.env"), /绝对路径/);
  const loose = await fixture(t, complete, 0o644);
  await assert.rejects(readDeploymentFile(loose.filename), /0600/);
  // An unrecognised or repeated setting is refused rather than silently ignored,
  // so a typo cannot leave a capability quietly off.
  for (const [contents, pattern] of [
    ["FEISHU_APP_ID=cli_fixture\nFEISHU_APP_SECRETT=oops", /不是可识别的设置项/],
    ["FEISHU_APP_ID=cli_a\nFEISHU_APP_ID=cli_b", /重复设置/],
    ["just-a-line", /不是可识别的设置项/],
  ]) {
    const bad = await fixture(t, contents);
    await assert.rejects(readDeploymentFile(bad.filename), pattern);
  }
  const good = await fixture(t, "# comment\n\nFEISHU_APP_ID=cli_fixture\nFEISHU_CLI_SCOPES=\"a:b:c\"\n");
  assert.deepEqual(await readDeploymentFile(good.filename), { FEISHU_APP_ID: "cli_fixture", FEISHU_CLI_SCOPES: "a:b:c" });
});

test("preflight names what is missing and what must be registered with Feishu", async t => {
  // Nothing but a model key is local mode: immediately usable, Feishu closed.
  const bare = await fixture(t, model => `MINIMAX_CONFIG_FILE=${model}\n`);
  const localReport = await preflight(await readDeploymentFile(bare.filename), { checkPort: async () => true, runtime: async () => [] });
  assert.equal(localReport.ok, true);
  assert.equal(localReport.local, true);
  assert.equal(localReport.config, null);
  assert.match(localReport.checks.find(check => check.name === "mode").detail, /本机模式/);

  // A half-configured application is Feishu mode, and says what it still needs.
  const partial = await fixture(t, "IDOU_PUBLIC_URL=http://127.0.0.1:3041\nIDOU_PORT=3041\nFEISHU_APP_ID=cli_fixture\n");
  const missing = await preflight(await readDeploymentFile(partial.filename), { checkPort: async () => true, runtime: async () => [] });
  assert.equal(missing.ok, false);
  assert.equal(missing.local, false);
  assert.equal(missing.required.length, 2);
  assert.ok(missing.required.some(item => /FEISHU_APP_SECRET/.test(item)));
  assert.ok(missing.required.some(item => /MINIMAX_CONFIG_FILE/.test(item)));

  const ready = await fixture(t, complete);
  const report = await preflight(await readDeploymentFile(ready.filename), { checkPort: async () => true, runtime: async () => [] });
  assert.equal(report.ok, true);
  assert.equal(report.local, false);
  assert.deepEqual(report.required, []);
  const registration = report.checks.find(check => check.name === "oauth-registration").detail;
  assert.match(registration, /http:\/\/127\.0\.0\.1:3041\/auth\/feishu\/callback/);
  // The requested scope set is exactly what the control plane will ask for.
  assert.match(registration, /docs:permission\.member:auth docx:document:readonly/);
  assert.match(report.checks.find(check => check.name === "bridge-writes").detail, /document\.inline-replace/);
  // Neither secret is ever part of the report.
  assert.doesNotMatch(JSON.stringify(report.checks), /fixture-secret|fixture-model-key/);

  const busy = await preflight(await readDeploymentFile(ready.filename), { checkPort: async () => false, runtime: async () => [] });
  assert.equal(busy.ok, false);
  assert.ok(busy.required.some(item => /IDOU_PORT/.test(item)));
});

// The same file is read twice in production: by this parser, and by the
// LaunchAgent's `set -a; . file`. A JSON setting has quotes of its own and
// survives a shell only in single quotes, so the two readers have to agree on
// what a single-quoted value is -- checked against a real shell, not described.
test("a single-quoted value reads the same here as it does to a shell", async t => {
  const origins = '{"tenant_fixture":"https://fixture.feishu.cn"}';
  const file = await fixture(t, `FEISHU_WIKI_ORIGINAL_ORIGINS='${origins}'\nFEISHU_APP_ID="cli_fixture"\n`);
  const parsed = await readDeploymentFile(file.filename);
  assert.equal(parsed.FEISHU_WIKI_ORIGINAL_ORIGINS, origins);
  const shell = execFileSync("/bin/bash", ["-c", 'set -a; . "$1"; set +a; printf %s "$FEISHU_WIKI_ORIGINAL_ORIGINS"', "bash", file.filename], { encoding: "utf8" });
  assert.equal(shell, parsed.FEISHU_WIKI_ORIGINAL_ORIGINS, "both readers see the same JSON");
  assert.deepEqual(JSON.parse(parsed.FEISHU_WIKI_ORIGINAL_ORIGINS), { tenant_fixture: "https://fixture.feishu.cn" });
  // Double quotes keep working as they did.
  assert.equal(parsed.FEISHU_APP_ID, "cli_fixture");
});

// Archiving a scheduled report builds the managed folder's link on the tenant's
// own domain and refuses without one -- at the very end of every run, after the
// model was paid for. Measured live: preflight passed and both runs failed with
// 「报告未保存：未配置该租户的飞书内容域名」.
test("with schedules on, preflight names each tenant that has no content domain", async t => {
  const schedules = (model) => `${complete(model)}\nIDOU_SCHEDULED_TASKS=1\nIDOU_DRIVE_CONFIG_FILE=/fixture/drive-budget.json\n`
    .replace("FEISHU_CLI_WRITE_ACTIONS=document.inline-replace", "FEISHU_CLI_WRITE_ACTIONS=document.inline-replace,drive.upload");
  const bare = await fixture(t, schedules);
  const without = await preflight(await readDeploymentFile(bare.filename), { checkPort: async () => true, runtime: async () => [] });
  const check = without.checks.find(entry => entry.name === "schedule-report-origin");
  assert.equal(check.ok, false);
  assert.match(check.detail, /tenant_fixture/);
  assert.equal(without.ok, false);
  assert.ok(without.required.some(item => /FEISHU_WIKI_ORIGINAL_ORIGINS='\{"tenant_fixture":/.test(item)), JSON.stringify(without.required));

  const withOrigin = await fixture(t, (model) => `${schedules(model)}FEISHU_WIKI_ORIGINAL_ORIGINS='{"tenant_fixture":"https://fixture.feishu.cn"}'\n`);
  const report = await preflight(await readDeploymentFile(withOrigin.filename), { checkPort: async () => true, runtime: async () => [] });
  assert.equal(report.checks.find(entry => entry.name === "schedule-report-origin").ok, true);
  assert.equal(report.ok, true, JSON.stringify(report.required));

  // Without schedules nothing is asked for.
  const plain = await fixture(t, complete);
  assert.equal((await preflight(await readDeploymentFile(plain.filename), { checkPort: async () => true, runtime: async () => [] }))
    .checks.find(entry => entry.name === "schedule-report-origin").ok, true);
});

test("only recognised settings reach the server process, and secrets stay out of any report", async t => {
  const ready = await fixture(t, complete);
  const env = await readDeploymentFile(ready.filename);
  const forwarded = serverEnvironment(env, { PATH: "/bin", HOME: "/home/fixture", SECRET_SHELL_VAR: "leak" });
  assert.equal(forwarded.FEISHU_APP_SECRET, "fixture-secret", "the server does need the secret");
  assert.equal(forwarded.SECRET_SHELL_VAR, undefined, "unrelated shell state must not reach the control plane");
  assert.ok(Object.keys(forwarded).every(key => ["PATH", "HOME", "TMPDIR", "LANG"].includes(key) || DEPLOYMENT_KEYS.includes(key)));
  assert.equal(redactDeployment(env).FEISHU_APP_SECRET, "<redacted>");
  assert.equal(redactDeployment(env).FEISHU_APP_ID, "cli_fixture");
});

// preflight is the report an operator registers scopes from. It used to build
// its own list by hand, which silently dropped every Wiki scope; the console
// then held a shorter set than the login asked for and the first authorization
// stopped at 「当前应用权限不足」. These pin the report to the authorization URL
// itself rather than to a copy of the expected answer.
test("the scope list preflight prints is the scope list the login actually requests", async t => {
  const everything = model => [
    "IDOU_PUBLIC_URL=http://127.0.0.1:3041", "IDOU_PORT=3041",
    "FEISHU_APP_ID=cli_fixture", "FEISHU_APP_SECRET=fixture-secret",
    "FEISHU_ALLOWED_TENANTS=tenant_fixture", "FEISHU_SOURCE_ACCESS_ENABLED=1",
    "FEISHU_CLI_BRIDGE_ENABLED=1", "FEISHU_CLI_SCOPES=docx:document,im:message",
    "FEISHU_CLI_IDENTITY_CHECKS_ENABLED=1",
    `FEISHU_WIKI_ORIGINAL_ORIGINS=${JSON.stringify({ tenant_fixture: "https://fixture.feishu.cn" })}`, "FEISHU_WIKI_BUNDLE_READS_ENABLED=1",
    "FEISHU_CLI_WRITE_ACTIONS=document.inline-replace", `MINIMAX_CONFIG_FILE=${model}`,
  ].join("\n");
  const ready = await fixture(t, everything);
  const config = await readDeploymentFile(ready.filename);
  const { loadFeishuLoginConfig } = await import("../src/control-plane/server-config.js");
  const { FeishuSourceAccess } = await import("../src/control-plane/feishu-source-access.js");
  const { FeishuOAuthProvider } = await import("../src/control-plane/feishu-oauth-provider.js");
  const { SessionRegistry } = await import("../src/control-plane/sessions.js");

  const login = loadFeishuLoginConfig({ ...config });
  const sessions = new SessionRegistry();
  t.after(() => sessions.close?.());
  const sourceAccess = new FeishuSourceAccess({ feishu: SAAS_FEISHU, sessions, ...login });
  t.after(() => sourceAccess.close?.());
  const provider = new FeishuOAuthProvider({ feishu: SAAS_FEISHU, ...login, sessions, sourceAccess });
  const requested = new URL(provider.authorizationUrl({ redirectUri: `${login.origin}/auth/feishu/callback`, state: "s", challenge: "c" })).searchParams.get("scope").split(" ");

  const report = await preflight(config, { checkPort: async () => true, runtime: async () => [] });
  const printed = /申请授权范围 ([^；]+?)(?:，另加|$)/.exec(report.checks.find(check => check.name === "oauth-registration").detail)[1].split(" ");
  assert.deepEqual(printed, requested, "operator registers what preflight prints, so it must be what the login asks for");
  // A Wiki scope is the exact thing the hand-built list used to lose.
  assert.ok(printed.includes("docx:document:readonly") && printed.includes("space:document:retrieve"));
});

// Uploads to Drive are refused without a server-held quota, and until preflight
// said so the only symptom was a refusal at the moment someone tried to upload.
test("preflight says when uploads are enabled but no Drive quota is configured", async t => {
  const withUploads = model => complete(model).replace("FEISHU_CLI_WRITE_ACTIONS=document.inline-replace", "FEISHU_CLI_WRITE_ACTIONS=document.inline-replace,drive.upload");
  const ready = await fixture(t, withUploads);
  const report = await preflight(await readDeploymentFile(ready.filename), { checkPort: async () => true, runtime: async () => [] });
  assert.match(report.checks.find(check => check.name === "drive-budget").detail, /IDOU_DRIVE_CONFIG_FILE.*拒绝/u);
  const plain = await fixture(t, complete);
  const quiet = await preflight(await readDeploymentFile(plain.filename), { checkPort: async () => true, runtime: async () => [] });
  assert.doesNotMatch(quiet.checks.find(check => check.name === "drive-budget").detail, /拒绝/u, "no uploads enabled, nothing to warn about");
});

test("scheduled reports require both a Drive target and the narrow upload action", async t => {
  const missing = await fixture(t, model => `${complete(model)}\nIDOU_SCHEDULED_TASKS=1`);
  const report = await preflight(await readDeploymentFile(missing.filename), { checkPort: async () => true, runtime: async () => [] });
  assert.equal(report.ok, false);
  assert.match(report.checks.find(check => check.name === "oauth-registration").detail, /wiki:wiki:readonly/,
    "schedule deployments must register the scope used to resolve Wiki resources");
  assert.match(report.checks.find(check => check.name === "schedule-report-write").detail, /drive\.upload/);
  assert.match(report.checks.find(check => check.name === "drive-budget").detail, /定时报告/);

  const ready = await fixture(t, model => `${complete(model).replace("FEISHU_CLI_WRITE_ACTIONS=document.inline-replace", "FEISHU_CLI_WRITE_ACTIONS=document.inline-replace,drive.upload")}\nIDOU_SCHEDULED_TASKS=1\nIDOU_DRIVE_CONFIG_FILE=/private/drive.json`);
  const accepted = await preflight(await readDeploymentFile(ready.filename), { checkPort: async () => true, runtime: async () => [] });
  assert.equal(accepted.checks.find(check => check.name === "schedule-report-write").ok, true);
  assert.equal(accepted.checks.find(check => check.name === "drive-budget").ok, true);
});

// --- choosing the chat model -------------------------------------------------

const LITELLM_SECRET = "sk-litellm-deployment-fixture";
async function litellmFixture(t, lines, keyMode = 0o600) {
  const { filename, directory, model } = await fixture(t, "");
  const keyFile = path.join(directory, "litellm.env");
  await writeFile(keyFile, `# LiteLLM\nexport LITELLM_MASTER_KEY="${LITELLM_SECRET}"\n`, { mode: 0o600 });
  await chmod(keyFile, keyMode);
  await writeFile(filename, lines({ keyFile, model }).join("\n"), { mode: 0o600 });
  return { filename, keyFile, directory, model };
}
const quiet = { checkPort: async () => true, runtime: async () => [] };

test("the LiteLLM settings are deployment settings, and its key is treated as a secret", async t => {
  const names = ["IDOU_MODEL_PROVIDER", "IDOU_LITELLM_BASE_URL", "IDOU_LITELLM_MODEL", "IDOU_LITELLM_KEY_FILE", "IDOU_LITELLM_API_KEY"];
  for (const name of names) assert.ok(DEPLOYMENT_KEYS.includes(name), name);
  const ready = await litellmFixture(t, ({ keyFile }) => ["IDOU_MODEL_PROVIDER=litellm", "IDOU_LITELLM_BASE_URL=http://127.0.0.1:4000",
    "IDOU_LITELLM_MODEL=volc-coding", `IDOU_LITELLM_KEY_FILE=${keyFile}`, `IDOU_LITELLM_API_KEY=${LITELLM_SECRET}`]);
  const env = await readDeploymentFile(ready.filename);
  const forwarded = serverEnvironment(env, { PATH: "/bin" });
  for (const name of names) assert.equal(forwarded[name], env[name], `${name} must reach the control plane`);
  assert.equal(redactDeployment(env).IDOU_LITELLM_API_KEY, "<redacted>");
  assert.equal(redactDeployment(env).IDOU_LITELLM_KEY_FILE, ready.keyFile, "a path is not a secret");
});

test("preflight checks the LiteLLM route the way the server will load it, and never prints its key", async t => {
  const lines = ({ keyFile }) => ["IDOU_MODEL_PROVIDER=litellm", `IDOU_LITELLM_KEY_FILE=${keyFile}`];
  const ready = await litellmFixture(t, lines);
  const probed = [];
  const report = await preflight(await readDeploymentFile(ready.filename), { ...quiet, liteLlm: async origin => { probed.push(origin); return true; } });
  assert.equal(report.ok, true);
  assert.equal(report.local, true, "no MiniMax key is needed for local mode on LiteLLM");
  assert.deepEqual(probed, ["http://127.0.0.1:4000"]);
  const detail = report.checks.find(check => check.name === "model-key").detail;
  assert.match(detail, /GLM-5\.3/); assert.match(detail, /volc-coding/);
  assert.doesNotMatch(detail, /chmod/);
  assert.match(report.checks.find(check => check.name === "litellm").detail, /有响应/);
  assert.doesNotMatch(JSON.stringify(report.checks), new RegExp(LITELLM_SECRET));

  // A proxy that is down does not stop the control plane from starting.
  const down = await preflight(await readDeploymentFile(ready.filename), { ...quiet, liteLlm: async () => false });
  assert.equal(down.ok, true);
  assert.match(down.checks.find(check => check.name === "litellm").detail, /没有响应/);

  // A key file others can read is started with, and flagged.
  const loose = await litellmFixture(t, lines, 0o644);
  const flagged = await preflight(await readDeploymentFile(loose.filename), { ...quiet, liteLlm: async () => true });
  assert.equal(flagged.ok, true);
  assert.match(flagged.checks.find(check => check.name === "model-key").detail, /chmod 600/);
});

test("preflight names the LiteLLM setting that would stop the server", async t => {
  for (const [lines, pattern] of [
    [({ keyFile }) => ["IDOU_MODEL_PROVIDER=litellm", "IDOU_LITELLM_BASE_URL=http://localhost:4000", `IDOU_LITELLM_KEY_FILE=${keyFile}`], /IDOU_LITELLM_BASE_URL/],
    [({ keyFile }) => ["IDOU_MODEL_PROVIDER=litellm", "IDOU_LITELLM_MODEL=bad model", `IDOU_LITELLM_KEY_FILE=${keyFile}`], /IDOU_LITELLM_MODEL/],
    [() => ["IDOU_MODEL_PROVIDER=litellm"], /IDOU_LITELLM_KEY_FILE/],
    [({ model }) => ["IDOU_MODEL_PROVIDER=openai-direct", `MINIMAX_CONFIG_FILE=${model}`], /IDOU_MODEL_PROVIDER/],
  ]) {
    const bad = await litellmFixture(t, lines);
    const report = await preflight(await readDeploymentFile(bad.filename), { ...quiet, liteLlm: async () => assert.fail("nothing to probe") });
    assert.equal(report.ok, false);
    assert.ok(report.required.some(item => pattern.test(item)), `${pattern}: ${report.required.join(" | ")}`);
    assert.doesNotMatch(JSON.stringify(report), /openai-direct|bad model|localhost:4000/, "the wrong value is not repeated back");
  }
});

// Image and video never followed the chat model: they keep MiniMax's own key.
test("with LiteLLM for chat, media reports its own MiniMax key, and only a broken one blocks startup", async t => {
  const base = ({ keyFile }) => ["IDOU_MODEL_PROVIDER=litellm", `IDOU_LITELLM_KEY_FILE=${keyFile}`, "IDOU_MEDIA_ENABLED=1"];
  const none = await litellmFixture(t, base);
  const withoutKey = await preflight(await readDeploymentFile(none.filename), { ...quiet, liteLlm: async () => true });
  assert.equal(withoutKey.ok, true, "the control plane still starts");
  assert.match(withoutKey.checks.find(check => check.name === "media-key").detail, /没有配置 MiniMax 密钥/);

  const good = await litellmFixture(t, args => [...base(args), `MINIMAX_CONFIG_FILE=${args.model}`]);
  const withKey = await preflight(await readDeploymentFile(good.filename), { ...quiet, liteLlm: async () => true });
  assert.equal(withKey.ok, true);
  assert.match(withKey.checks.find(check => check.name === "media-key").detail, /仍走 MiniMax/);
  assert.doesNotMatch(JSON.stringify(withKey.checks), /fixture-model-key|sk-litellm/);

  // A file that is not there (args carries no directory: it used to read "undefined/missing.json").
  const broken = await litellmFixture(t, args => [...base(args), `MINIMAX_CONFIG_FILE=${path.dirname(args.keyFile)}/missing.json`]);
  const withBroken = await preflight(await readDeploymentFile(broken.filename), { ...quiet, liteLlm: async () => true });
  assert.equal(withBroken.ok, false);
  assert.ok(withBroken.required.some(item => /MINIMAX_CONFIG_FILE/.test(item) && /文件不存在/.test(item)), withBroken.required.join(" | "));

  // Media off: no MiniMax check at all on the LiteLLM route.
  const off = await litellmFixture(t, ({ keyFile }) => ["IDOU_MODEL_PROVIDER=litellm", `IDOU_LITELLM_KEY_FILE=${keyFile}`]);
  assert.equal((await preflight(await readDeploymentFile(off.filename), { ...quiet, liteLlm: async () => true })).checks.some(check => check.name === "media-key"), false);
});

// Video on Qwen: the key file is a deployment setting that reaches the control
// plane, is loaded here exactly as the server loads it, and does nothing -- said
// so -- without media on.
test("the Token Plan key file reaches the control plane, and preflight loads it as the server will", async t => {
  assert.ok(DEPLOYMENT_KEYS.includes("QWEN_TOKEN_PLAN_KEY_FILE"));
  const QWEN = "sk-sp-synthetic-preflight-key";
  const withQwen = async (lines, contents = QWEN, mode = 0o600) => {
    // The callback is given the LiteLLM key file and the MiniMax config, not the directory.
    const ready = await litellmFixture(t, args => [...lines(args), `QWEN_TOKEN_PLAN_KEY_FILE=${path.dirname(args.keyFile)}/qwen.key`]);
    await writeFile(path.join(ready.directory, "qwen.key"), contents, { mode }); await chmod(path.join(ready.directory, "qwen.key"), mode);
    return { ready, env: await readDeploymentFile(ready.filename) };
  };
  const on = ({ keyFile, model }) => ["IDOU_MODEL_PROVIDER=litellm", `IDOU_LITELLM_KEY_FILE=${keyFile}`, "IDOU_MEDIA_ENABLED=1", `MINIMAX_CONFIG_FILE=${model}`];
  const { env } = await withQwen(on);
  assert.equal(serverEnvironment(env, { PATH: "/bin" }).QWEN_TOKEN_PLAN_KEY_FILE, env.QWEN_TOKEN_PLAN_KEY_FILE, "stripped, the server would quietly keep video on MiniMax");
  const good = await preflight(env, { ...quiet, liteLlm: async () => true });
  assert.equal(good.ok, true);
  assert.match(good.checks.find(check => check.name === "video-key").detail, /视频走阿里云百炼/);
  assert.match(good.checks.find(check => check.name === "media-key").detail, /^图片仍走 MiniMax/, "video is not MiniMax's any more");
  assert.doesNotMatch(JSON.stringify(good), new RegExp(QWEN));

  const broken = await preflight((await withQwen(on, "sk-not-a-token-plan-key")).env, { ...quiet, liteLlm: async () => true });
  assert.equal(broken.ok, false);
  assert.ok(broken.required.some(item => /QWEN_TOKEN_PLAN_KEY_FILE/.test(item)), broken.required.join(" | "));
  assert.doesNotMatch(JSON.stringify(broken), /sk-not-a-token-plan-key/);

  const unused = await preflight((await withQwen(({ keyFile }) => ["IDOU_MODEL_PROVIDER=litellm", `IDOU_LITELLM_KEY_FILE=${keyFile}`], "broken")).env, { ...quiet, liteLlm: async () => true });
  assert.equal(unused.ok, true, "without media the file is not read, so it cannot block");
  assert.match(unused.checks.find(check => check.name === "video-key").detail, /不生效/);
});

test("on the default MiniMax route, stray LiteLLM settings are said to do nothing", async t => {
  const stray = await litellmFixture(t, ({ model, keyFile }) => [`MINIMAX_CONFIG_FILE=${model}`, `IDOU_LITELLM_KEY_FILE=${keyFile}`]);
  const report = await preflight(await readDeploymentFile(stray.filename), { ...quiet, liteLlm: async () => assert.fail("MiniMax route has no proxy") });
  assert.equal(report.ok, true);
  assert.match(report.checks.find(check => check.name === "model-key").detail, /不生效/);
  assert.equal(report.checks.some(check => check.name === "litellm"), false);
});

// The real probe, against a loopback server this test owns: LiteLLM's
// unauthenticated liveness route, and no key on the request.
test("the LiteLLM liveness probe sends no key", async t => {
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const seen = [];
  const proxy = createServer((req, res) => { seen.push({ method: req.method, url: req.url, headers: req.headers }); res.writeHead(200, { "content-type": "text/plain" }); res.end("I'm alive!"); });
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
  t.after(() => { proxy.close(); proxy.closeAllConnections(); });
  const up = await litellmFixture(t, ({ keyFile }) => ["IDOU_MODEL_PROVIDER=litellm", `IDOU_LITELLM_BASE_URL=http://127.0.0.1:${proxy.address().port}`, `IDOU_LITELLM_KEY_FILE=${keyFile}`]);
  const report = await preflight(await readDeploymentFile(up.filename), quiet);
  assert.equal(report.ok, true);
  assert.match(report.checks.find(check => check.name === "litellm").detail, /有响应/);
  assert.deepEqual(seen.map(request => `${request.method} ${request.url}`), ["GET /health/liveliness"]);
  assert.equal(seen[0].headers.authorization, undefined);
  assert.doesNotMatch(JSON.stringify(seen), new RegExp(LITELLM_SECRET));

  // Nothing listening: reported, not fatal.
  const port = proxy.address().port; proxy.close(); proxy.closeAllConnections(); await once(proxy, "close");
  const gone = await preflight(await readDeploymentFile(up.filename), quiet);
  assert.equal(gone.ok, true);
  assert.match(gone.checks.find(check => check.name === "litellm").detail, new RegExp(`127\\.0\\.0\\.1:${port} 暂时没有响应`));
});

// The MiniMax route's key line, word for word as preflight printed it before the
// chat model became a choice -- including the permission note, which predates
// LiteLLM (added 2026-09-09 for another project's config file). One thing differs
// on purpose: with an inline key the config file is not read, so it is no longer
// warned about as an unnamed "该文件" (review, 2026-09-11).
test("on the MiniMax route the key line reads as it always did, and only a file actually read is warned about", async t => {
  const { directory, model } = await fixture(t, "");
  const deployment = path.join(directory, "minimax.env");
  const run = async (lines, keyMode = 0o600) => {
    await chmod(model, keyMode);
    await writeFile(deployment, lines.join("\n"), { mode: 0o600 });
    return preflight(await readDeploymentFile(deployment), { ...quiet, liteLlm: async () => assert.fail("MiniMax route has no proxy") });
  };
  const detail = report => report.checks.find(check => check.name === "model-key").detail;

  const plain = await run([`MINIMAX_CONFIG_FILE=${model}`]);
  assert.equal(detail(plain), `已从 ${model} 读取（不复制、不显示）`);
  assert.deepEqual(plain.checks.map(check => check.name), ["mode", "model-key"], "nothing LiteLLM-shaped on this route");
  assert.equal(detail(await run([`MINIMAX_CONFIG_FILE=${model}`], 0o644)), `已从 ${model} 读取（不复制、不显示）；注意该文件对其他用户可读，建议 chmod 600`);
  const inline = await run(["MINIMAX_API_KEY=inline-fixture-key", `MINIMAX_CONFIG_FILE=${model}`], 0o644);
  assert.equal(detail(inline), "已从环境读取（不显示内容）", "the file was not read, so it is not the subject of a warning");
  assert.doesNotMatch(JSON.stringify(inline), /inline-fixture-key|fixture-model-key/);

  const broken = await run([`MINIMAX_CONFIG_FILE=${directory}/missing.json`]);
  assert.equal(broken.ok, false);
  assert.deepEqual(broken.required, [`打不开 MINIMAX_CONFIG_FILE：文件不存在。填入现有数字人项目那个 region 为 "cn" 的配置文件绝对路径`]);
});

test("on the LiteLLM route the media key line follows the same rule: only a file actually read is warned about", async t => {
  const base = ({ keyFile }) => ["IDOU_MODEL_PROVIDER=litellm", `IDOU_LITELLM_KEY_FILE=${keyFile}`, "IDOU_MEDIA_ENABLED=1"];
  const media = async lines => {
    const ready = await litellmFixture(t, args => [...base(args), ...lines(args)]);
    await chmod(ready.model, 0o644);
    const report = await preflight(await readDeploymentFile(ready.filename), { ...quiet, liteLlm: async () => true });
    assert.equal(report.ok, true);
    return { detail: report.checks.find(check => check.name === "media-key").detail, model: ready.model };
  };
  const fromFile = await media(({ model }) => [`MINIMAX_CONFIG_FILE=${model}`]);
  assert.equal(fromFile.detail, `图片与视频仍走 MiniMax，密钥已从 ${fromFile.model} 读取（不复制、不显示）；注意该文件对其他用户可读，建议 chmod 600`);
  const inline = await media(({ model }) => ["MINIMAX_API_KEY=inline-fixture-key", `MINIMAX_CONFIG_FILE=${model}`]);
  assert.equal(inline.detail, "图片与视频仍走 MiniMax，密钥已从环境读取（不显示内容）");
});
