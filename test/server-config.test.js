import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadServerModelKey } from "../src/control-plane/server-config.js";

test("inactive prompt retention is bounded and independent of output retention", async () => {
  const { loadSchedulePromptRetention } = await import("../src/control-plane/server-config.js");
  assert.equal(loadSchedulePromptRetention({}), 30);
  assert.equal(loadSchedulePromptRetention({ IDOU_SCHEDULE_PROMPT_DAYS: "90" }), 90);
  for (const value of ["0", "-1", "366", "1.5", "NaN", ""]) {
    assert.throws(() => loadSchedulePromptRetention({ IDOU_SCHEDULE_PROMPT_DAYS: value }), /IDOU_SCHEDULE_PROMPT_DAYS/);
  }
});

test("server loads an explicitly selected domestic config without copying its contents", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-server-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "config.json");
  await writeFile(filename, JSON.stringify({ region: "cn", api_key: "test-only-key" }));
  assert.equal(await loadServerModelKey({ MINIMAX_CONFIG_FILE: filename }), "test-only-key");
  await writeFile(filename, JSON.stringify({ region: "global", api_key: "test-only-key" }));
  await assert.rejects(loadServerModelKey({ MINIMAX_CONFIG_FILE: filename }), /region/);
  await writeFile(filename, "malformed test-only-key");
  await assert.rejects(loadServerModelKey({ MINIMAX_CONFIG_FILE: filename }), (error) => !error.message.includes("test-only-key"));
});

test("configuration errors name the setting to fix and never echo a configured value", async t => {
  const { loadFeishuLoginConfig } = await import("../src/control-plane/server-config.js");
  const base = { IDOU_PUBLIC_URL: "https://control.example", FEISHU_APP_ID: "cli_synthetic", FEISHU_APP_SECRET: "s3cret", FEISHU_ALLOWED_TENANTS: "tenant-a" };
  // Each distinct mistake reports itself rather than one catch-all message.
  for (const [patch, pattern] of [
    [{ FEISHU_APP_ID: undefined }, /缺少 FEISHU_APP_ID/],
    [{ FEISHU_APP_ID: "app_wrong_prefix" }, /FEISHU_APP_ID 格式不对/],
    [{ FEISHU_APP_SECRET: undefined }, /缺少 FEISHU_APP_SECRET/],
    [{ FEISHU_ALLOWED_TENANTS: undefined }, /缺少 FEISHU_ALLOWED_TENANTS/],
    [{ FEISHU_ALLOWED_TENANTS: "tenant a" }, /无效的租户 key/],
  ]) assert.throws(() => loadFeishuLoginConfig({ ...base, ...patch }), pattern);

  // A value pasted into the wrong setting must not come back out in the error.
  // Invalid in every one of these settings, so each really does reject it.
  const pasted = "s3cret pasted into the wrong field!";
  for (const field of ["FEISHU_APP_ID", "FEISHU_ALLOWED_TENANTS", "IDOU_PUBLIC_URL"]) {
    assert.throws(() => loadFeishuLoginConfig({ ...base, [field]: pasted }), error => !error.message.includes(pasted));
  }
  for (const value of ["not-absolute", pasted]) {
    await assert.rejects(loadServerModelKey({ MINIMAX_CONFIG_FILE: value }), error => !error.message.includes(value));
  }
  await assert.rejects(loadServerModelKey({}), /缺少 MINIMAX_CONFIG_FILE/);
});

test("an existing project's environment file can be pointed at without copying its key", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-envfile-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, ".env");
  // The shape another project already uses, comments and quoting included.
  await writeFile(filename, ["# project config", 'MINIMAX_API_KEY="env-file-key"', "MINIMAX_BASE_URL=https://api.minimaxi.com", "OTHER=ignored"].join("\n"));
  assert.equal(await loadServerModelKey({ MINIMAX_CONFIG_FILE: filename }), "env-file-key");

  // A non-domestic endpoint pinned by that project is still refused.
  await writeFile(filename, ["MINIMAX_API_KEY=env-file-key", "MINIMAX_BASE_URL=https://api.minimax.io"].join("\n"));
  await assert.rejects(loadServerModelKey({ MINIMAX_CONFIG_FILE: filename }), /不是国内区端点/);

  // A file that is neither shape names both accepted shapes and leaks nothing.
  await writeFile(filename, "SOMETHING_ELSE=env-file-key");
  await assert.rejects(loadServerModelKey({ MINIMAX_CONFIG_FILE: filename }),
    error => /MINIMAX_API_KEY/.test(error.message) && !error.message.includes("env-file-key"));

  // An explicit environment key still wins over any file.
  assert.equal(await loadServerModelKey({ MINIMAX_API_KEY: "direct-key", MINIMAX_CONFIG_FILE: filename }), "direct-key");
});

// --- the chat model: MiniMax by default, GLM through a loopback LiteLLM -------

const SECRET = "sk-litellm-secret-fixture";
async function keyDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-litellm-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const litellm = patch => ({ IDOU_MODEL_PROVIDER: "litellm", ...patch });

test("with no provider set the chat model is exactly the MiniMax route it always was", async t => {
  const { loadChatModelConfig } = await import("../src/control-plane/server-config.js");
  const { CHAT_MODELS } = await import("../src/providers/codex/chat-models.js");
  const expected = { provider: "minimax", model: "MiniMax-M3", upstreamOrigin: "https://api.minimaxi.com", upstreamModel: "MiniMax-M3", apiKey: "direct-key", maxOutputTokens: 16384, timeoutMs: 180000 };
  assert.deepEqual(await loadChatModelConfig({ MINIMAX_API_KEY: "direct-key" }), expected);
  assert.deepEqual(await loadChatModelConfig({ MINIMAX_API_KEY: "direct-key", IDOU_MODEL_PROVIDER: "minimax" }), expected);
  // LiteLLM settings without the switch change nothing.
  assert.deepEqual(await loadChatModelConfig({ MINIMAX_API_KEY: "direct-key", IDOU_LITELLM_BASE_URL: "http://127.0.0.1:9", IDOU_LITELLM_API_KEY: SECRET }), expected);
  // The key comes from the same loader, with the same failures.
  const directory = await keyDirectory(t), filename = path.join(directory, "config.json");
  await writeFile(filename, JSON.stringify({ region: "cn", api_key: "file-key" }));
  assert.equal((await loadChatModelConfig({ MINIMAX_CONFIG_FILE: filename })).apiKey, "file-key");
  await assert.rejects(loadChatModelConfig({}), /缺少 MINIMAX_CONFIG_FILE/);
  // Each provider's slug is one the desktop knows, for that provider.
  for (const env of [{ MINIMAX_API_KEY: "k" }, litellm({ IDOU_LITELLM_API_KEY: "k" })]) {
    const config = await loadChatModelConfig(env);
    assert.equal(CHAT_MODELS[config.model]?.provider, config.provider);
  }
});

test("the LiteLLM route defaults to the local proxy's GLM group with GLM's own limits", async () => {
  const { loadChatModelConfig } = await import("../src/control-plane/server-config.js");
  assert.deepEqual(await loadChatModelConfig(litellm({ IDOU_LITELLM_API_KEY: `  ${SECRET}  ` })),
    { provider: "litellm", model: "GLM-5.3", upstreamOrigin: "http://127.0.0.1:4000", upstreamModel: "volc-coding", apiKey: SECRET, maxOutputTokens: 32768, timeoutMs: 600000 });
  const custom = await loadChatModelConfig(litellm({ IDOU_LITELLM_API_KEY: SECRET, IDOU_LITELLM_BASE_URL: "http://[::1]:14000/", IDOU_LITELLM_MODEL: "glm-5.3:ark_v2" }));
  assert.equal(custom.upstreamOrigin, "http://[::1]:14000", "a trailing slash is the only path allowed, and it is dropped");
  assert.equal(custom.upstreamModel, "glm-5.3:ark_v2");
  assert.equal(custom.model, "GLM-5.3", "the client slug never follows the proxy's group name");
  await assert.rejects(loadChatModelConfig({ IDOU_MODEL_PROVIDER: "openai", MINIMAX_API_KEY: "k" }), error => /IDOU_MODEL_PROVIDER/.test(error.message) && !error.message.includes("openai"));
});

test("the proxy key file may hold just the key or be the proxy's own environment file", async t => {
  const { loadChatModelConfig } = await import("../src/control-plane/server-config.js");
  const directory = await keyDirectory(t), filename = path.join(directory, "litellm.env");
  const load = async (contents, extra = {}) => { await writeFile(filename, contents, { mode: 0o600 }); return (await loadChatModelConfig(litellm({ IDOU_LITELLM_KEY_FILE: filename, ...extra }))).apiKey; };
  assert.equal(await load(`${SECRET}\n`), SECRET);
  assert.equal(await load(`# the proxy key\n\n  ${SECRET}  \r\n`), SECRET);
  // The shape LiteLLM's own deployment keeps its settings in.
  assert.equal(await load(["# LiteLLM", "", "VOLCENGINE_API_KEY=provider-key", `export LITELLM_MASTER_KEY="${SECRET}"`, "PORT=4000"].join("\n")), SECRET);
  assert.equal(await load(`LITELLM_MASTER_KEY='${SECRET}'\r\nOTHER = x\r\n`), SECRET);
  // A key made for this application wins over the master key in the same file.
  assert.equal(await load(`LITELLM_MASTER_KEY=master-key\nIDOU_LITELLM_API_KEY=${SECRET}\n`), SECRET);
  // And a key given directly wins over any file.
  assert.equal(await load("LITELLM_MASTER_KEY=master-key\n", { IDOU_LITELLM_API_KEY: SECRET }), SECRET);
  // "NAME=value" on its own line is an assignment, never taken as the key itself.
  await assert.rejects(load("OTHER_SETTING=value\n"), /LITELLM_MASTER_KEY/);
});

test("a base URL anywhere but this machine's loopback IP is refused, and never echoed", async () => {
  const { loadChatModelConfig } = await import("../src/control-plane/server-config.js");
  const marker = "s3cret-marker";
  for (const value of [`https://127.0.0.1:4000/${marker}`, `http://${marker}.example:4000`, `http://localhost:4000/${marker}`, `http://10.0.0.8:4000/${marker}`,
    `http://127.0.0.1:4000/v1/${marker}`, `http://127.0.0.1:4000/?${marker}`, `http://127.0.0.1:4000/#${marker}`, `http://user:${marker}@127.0.0.1:4000`,
    `http://127.0.0.1/${marker}`, `http://127.0.0.1:0/${marker}`, `http://127.0.0.1:65536/${marker}`, `http://127.0.0.1:04000/${marker}`, ` http://127.0.0.1:4000/${marker}`,
    `http://[0:0:0:0:0:0:0:1]:4000/${marker}`, `HTTP://127.0.0.1:4000/${marker}`]) {
    await assert.rejects(loadChatModelConfig(litellm({ IDOU_LITELLM_API_KEY: SECRET, IDOU_LITELLM_BASE_URL: value })),
      error => /IDOU_LITELLM_BASE_URL/.test(error.message) && !error.message.includes(marker) && !error.message.includes(SECRET), value);
  }
  for (const value of ["http://127.0.0.1", "http://localhost:4000", "http://127.0.0.1:4000/v1"]) {
    await assert.rejects(loadChatModelConfig(litellm({ IDOU_LITELLM_API_KEY: SECRET, IDOU_LITELLM_BASE_URL: value })), /IDOU_LITELLM_BASE_URL/, value);
  }
  for (const value of ["-leading-dash", "has space", "a/b", "glm-五点三", "x".repeat(65), `${marker}!`]) {
    await assert.rejects(loadChatModelConfig(litellm({ IDOU_LITELLM_API_KEY: SECRET, IDOU_LITELLM_MODEL: value })),
      error => /IDOU_LITELLM_MODEL/.test(error.message) && !error.message.includes(value), value);
  }
});

test("a key file that is relative, a symlink, not a file, oversized or keyless is refused without echoing it", async t => {
  const { loadChatModelConfig } = await import("../src/control-plane/server-config.js");
  const { symlink, mkdir } = await import("node:fs/promises");
  const directory = await keyDirectory(t);
  const real = path.join(directory, "real.env");
  await writeFile(real, `LITELLM_MASTER_KEY=${SECRET}\n`, { mode: 0o600 });
  const link = path.join(directory, "link.env"); await symlink(real, link);
  const folder = path.join(directory, "folder"); await mkdir(folder);
  const large = path.join(directory, "large.env"); await writeFile(large, `LITELLM_MASTER_KEY=${SECRET}\n${"#".repeat(70000)}\n`);
  const empty = path.join(directory, "empty.env"); await writeFile(empty, "\n# nothing here\n");
  const two = path.join(directory, "two.env"); await writeFile(two, `${SECRET}\nsecond-line\n`);
  const spaced = path.join(directory, "spaced.env"); await writeFile(spaced, `LITELLM_MASTER_KEY=${SECRET} trailing words\n`);
  const cases = [
    [{ IDOU_LITELLM_KEY_FILE: undefined }, /缺少 IDOU_LITELLM_KEY_FILE/],
    [{ IDOU_LITELLM_KEY_FILE: "relative/litellm.env" }, /绝对路径/],
    [{ IDOU_LITELLM_KEY_FILE: path.join(directory, "missing.env") }, /文件不存在/],
    [{ IDOU_LITELLM_KEY_FILE: link }, /符号链接/],
    [{ IDOU_LITELLM_KEY_FILE: folder }, /不是普通文件/],
    [{ IDOU_LITELLM_KEY_FILE: large }, /64KB/],
    [{ IDOU_LITELLM_KEY_FILE: empty }, /LITELLM_MASTER_KEY/],
    [{ IDOU_LITELLM_KEY_FILE: two }, /LITELLM_MASTER_KEY/],
    [{ IDOU_LITELLM_KEY_FILE: spaced }, /空白或不可见字符/],
    [{ IDOU_LITELLM_API_KEY: `${SECRET}\ninjected: header` }, /IDOU_LITELLM_API_KEY/],
  ];
  if (process.platform !== "win32") {
    // A FIFO in the key file's place must not stall startup waiting for a writer.
    const fifo = path.join(directory, "fifo.env");
    (await import("node:child_process")).execFileSync("mkfifo", [fifo]);
    cases.push([{ IDOU_LITELLM_KEY_FILE: fifo }, /不是普通文件/]);
  }
  for (const [patch, pattern] of cases) {
    await assert.rejects(loadChatModelConfig(litellm(patch)), error => {
      assert.match(error.message, pattern);
      assert.match(error.message, /IDOU_LITELLM_(KEY_FILE|API_KEY)/, "names the setting to fix");
      for (const value of [SECRET, directory, "second-line", "trailing words"]) assert.equal(error.message.includes(value), false, `echoed ${value}`);
      return true;
    }, JSON.stringify(patch));
  }
  // The real file behind the link is fine when pointed at directly.
  assert.equal((await loadChatModelConfig(litellm({ IDOU_LITELLM_KEY_FILE: real }))).apiKey, SECRET);
});

// --- image and video keep MiniMax's key on either chat route ------------------
// bin/server.js used to decide this inline, and mutations that always passed
// null (media silently 503 despite a valid key), swallowed a broken key (startup
// no longer blocked) or answered 404 all survived the suite.
test("media takes the chat key on MiniMax, its own MiniMax key on LiteLLM, and only a broken one is fatal", async t => {
  const { loadChatModelConfig, loadMediaKey } = await import("../src/control-plane/server-config.js");
  const directory = await keyDirectory(t), valid = path.join(directory, "mmx.json");
  await writeFile(valid, JSON.stringify({ region: "cn", api_key: "media-file-key" }), { mode: 0o600 });
  const minimax = await loadChatModelConfig({ MINIMAX_API_KEY: "chat-key" });
  const glm = await loadChatModelConfig(litellm({ IDOU_LITELLM_API_KEY: SECRET }));
  const on = patch => ({ IDOU_MEDIA_ENABLED: "1", ...patch });

  // MiniMax route: the chat key is the media key, as it always was.
  assert.deepEqual(await loadMediaKey(minimax, on()), { enabled: true, mediaKey: "chat-key" });
  // LiteLLM with a valid MiniMax key, from the file or inline: media works.
  assert.deepEqual(await loadMediaKey(glm, on({ MINIMAX_CONFIG_FILE: valid })), { enabled: true, mediaKey: "media-file-key" });
  assert.deepEqual(await loadMediaKey(glm, on({ MINIMAX_API_KEY: " inline-media-key " })), { enabled: true, mediaKey: "inline-media-key" });
  // LiteLLM with a broken one: startup stops, naming the setting and nothing else.
  for (const broken of [path.join(directory, "missing.json"), "relative/mmx.json"]) {
    await assert.rejects(loadMediaKey(glm, on({ MINIMAX_CONFIG_FILE: broken })),
      error => /MINIMAX_CONFIG_FILE/.test(error.message) && !error.message.includes(directory) && !error.message.includes(SECRET), broken);
  }
  // LiteLLM with none: media stays on but unconfigured (the server answers 503),
  // and the proxy key is never handed to MiniMax in its place.
  assert.deepEqual(await loadMediaKey(glm, on({ MINIMAX_API_KEY: "  " })), { enabled: true, mediaKey: null });
  assert.deepEqual(await loadMediaKey(glm, on()), { enabled: true, mediaKey: null });
  // Media off: nothing is loaded on either route, not even a broken file.
  for (const chat of [minimax, glm]) {
    for (const env of [{}, { IDOU_MEDIA_ENABLED: "" }, { MINIMAX_CONFIG_FILE: path.join(directory, "missing.json") }]) {
      assert.deepEqual(await loadMediaKey(chat, env), { enabled: false, mediaKey: null }, `${chat.provider} ${JSON.stringify(env)}`);
    }
  }
  // Anything but 1 is refused rather than read as off.
  for (const value of ["true", "0", "yes"]) {
    await assert.rejects(loadMediaKey(glm, { IDOU_MEDIA_ENABLED: value }), error => /IDOU_MEDIA_ENABLED/.test(error.message) && !error.message.includes(value), value);
  }
});

// --- video's own key: a Qwen Token Plan key, only ever from a file -----------
// It is a subscription key, so it stays out of the environment and every log;
// the file is the one place it lives on the server.
test("the Token Plan key is read from a private file, and a wrong one stops startup naming the setting only", async t => {
  const { loadVideoKey } = await import("../src/control-plane/server-config.js");
  const { symlink, chmod } = await import("node:fs/promises");
  const directory = await keyDirectory(t), filename = path.join(directory, "qwen-token-plan.key");
  const KEY = "sk-sp-synthetic0123456789abcdef";
  const load = async (contents, mode = 0o600) => { await writeFile(filename, contents, { mode }); await chmod(filename, mode); return loadVideoKey({ QWEN_TOKEN_PLAN_KEY_FILE: filename }); };
  assert.equal(await loadVideoKey({}), null, "unset: video stays on MiniMax");
  assert.equal(await loadVideoKey({ QWEN_TOKEN_PLAN_KEY_FILE: "" }), null);
  assert.equal(await load(`${KEY}\n`), KEY);
  // 640 root:mydoubao is how the server holds it: the group reads, others do not.
  assert.equal(await load(KEY, 0o640), KEY);
  const link = path.join(directory, "link.key"); await symlink(filename, link);
  const cases = [
    [{ QWEN_TOKEN_PLAN_KEY_FILE: "relative/qwen.key" }, /绝对路径/],
    [{ QWEN_TOKEN_PLAN_KEY_FILE: path.join(directory, "missing.key") }, /文件不存在/],
    [{ QWEN_TOKEN_PLAN_KEY_FILE: link }, /符号链接/],
    [{ QWEN_TOKEN_PLAN_KEY_FILE: directory }, /不是普通文件/],
  ];
  for (const [env, reason] of cases) await assert.rejects(loadVideoKey(env), error => /QWEN_TOKEN_PLAN_KEY_FILE/.test(error.message) && reason.test(error.message), JSON.stringify(env));
  // Whatever is wrong with the contents, they are never quoted back.
  for (const [contents, mode, reason] of [[KEY, 0o644, /其他用户/], ["sk-0123456789abcdefghij", 0o600, /sk-sp-/], [`${KEY}\n${KEY}`, 0o600, /一行/], ["x".repeat(5000), 0o600, /4KB/]]) {
    await assert.rejects(load(contents, mode), error => reason.test(error.message) && !error.message.includes("0123456789") && !error.message.includes("xxxx"), reason.source);
  }
});

// R7: which image a scheduled run happens in. A production server with a tag is
// refused at start, rather than coming up and refusing every run.
test("the sandbox image is optional in development and must be a digest in production", async () => {
  const { loadSandboxImage } = await import("../src/control-plane/server-config.js");
  const DIGEST = `mydoubao/sandbox@sha256:${"d".repeat(64)}`;
  assert.equal(loadSandboxImage({}), null, "unset: the lock's tag is used");
  assert.equal(loadSandboxImage({ IDOU_SANDBOX_IMAGE: "" }), null);
  assert.equal(loadSandboxImage({ IDOU_SANDBOX_IMAGE: "mydoubao/sandbox:local" }), "mydoubao/sandbox:local", "a developer may name a tag");
  assert.equal(loadSandboxImage({ IDOU_SANDBOX_MODE: "production", IDOU_SANDBOX_IMAGE: DIGEST }), DIGEST);
  assert.throws(() => loadSandboxImage({ IDOU_SANDBOX_MODE: "production" }), /生产模式需要 IDOU_SANDBOX_IMAGE/);
  assert.throws(() => loadSandboxImage({ IDOU_SANDBOX_MODE: "production", IDOU_SANDBOX_IMAGE: "mydoubao/sandbox:0.147.0-1.0.78" }), /必须按摘要固定/);
  for (const bad of ["--privileged", "mydoubao/sandbox:latest; rm", "Mydoubao/Sandbox", `x@sha256:${"d".repeat(63)}`]) {
    assert.throws(() => loadSandboxImage({ IDOU_SANDBOX_IMAGE: bad }), /不是合法的镜像引用/, bad);
  }
  // A server whose Docker keeps the classic image store has no repository
  // digest for an image it loaded; its image ID is the pinned name there.
  const ID = `sha256:${"e".repeat(64)}`;
  assert.equal(loadSandboxImage({ IDOU_SANDBOX_MODE: "production", IDOU_SANDBOX_IMAGE: ID }), ID);
  assert.throws(() => loadSandboxImage({ IDOU_SANDBOX_MODE: "production", IDOU_SANDBOX_IMAGE: `sha256:${"e".repeat(12)}` }), /必须按摘要固定/, "a short ID is a prefix match, not a pin");
});

// What production needs from the host, named at start: a server that would
// refuse every run for one of these does not come up at all.
test("production names gVisor, the proxy's address on the sandbox network, and a user that is not root", async () => {
  const { loadSandboxRuntime, loadSandboxGateway, loadSandboxUser } = await import("../src/control-plane/server-config.js");
  const production = { IDOU_SANDBOX_MODE: "production" };

  assert.equal(loadSandboxRuntime({}), "runc", "development keeps plain namespaces unless told otherwise");
  assert.equal(loadSandboxRuntime({ IDOU_SANDBOX_RUNTIME: "runsc" }), "runsc");
  assert.equal(loadSandboxRuntime({ ...production, IDOU_SANDBOX_RUNTIME: "runsc" }), "runsc");
  assert.throws(() => loadSandboxRuntime(production), /不能是 runc/);
  assert.throws(() => loadSandboxRuntime({ ...production, IDOU_SANDBOX_RUNTIME: "runc" }), /不能是 runc/);
  for (const bad of ["--privileged", "run sc", "../runsc", "-x"]) assert.throws(() => loadSandboxRuntime({ IDOU_SANDBOX_RUNTIME: bad }), /不是合法的 Docker 运行时名称/, bad);

  assert.equal(loadSandboxGateway({}), null, "development reaches the host gateway");
  assert.equal(loadSandboxGateway({ ...production, IDOU_SANDBOX_GATEWAY: "172.30.0.1" }), "172.30.0.1");
  assert.throws(() => loadSandboxGateway(production), /生产模式需要 IDOU_SANDBOX_GATEWAY/);
  // Listening everywhere or on loopback is not an address on the sandbox's
  // network: the first reaches the world, the second not the container.
  for (const bad of ["0.0.0.0", "127.0.0.1", "host-gateway", "172.30.0.1:8444", "::1", "172.30.0.256"]) {
    assert.throws(() => loadSandboxGateway({ IDOU_SANDBOX_GATEWAY: bad }), /必须是沙箱网络上的一个 IPv4 地址/, bad);
  }

  assert.equal(loadSandboxUser({}), null, "unset: nobody");
  assert.deepEqual(loadSandboxUser({ IDOU_SANDBOX_USER: "999:988" }), { uid: 999, gid: 988 });
  for (const bad of ["0:0", "999:0", "0:999", "root", "999", "-1:5", "999:988:1", " 999:988", `${2 ** 31}:1`]) {
    assert.throws(() => loadSandboxUser({ IDOU_SANDBOX_USER: bad }), /必须是 uid:gid/, bad);
  }
});

// The console has an origin of its own (site-server.js): from the sites'
// origin a published page, which is script, could read it.
test("the console's address has to be another origin than the sites'", async () => {
  const { loadSitesConfig } = await import("../src/control-plane/server-config.js");
  const base = { IDOU_SITES: "1", IDOU_SITES_URL: "https://sites.example.com", IDOU_ADMIN_USERS: "ou_boss" };
  assert.equal(loadSitesConfig(base).console, null, "admins alone open no console");
  assert.deepEqual(loadSitesConfig({ ...base, IDOU_ADMIN_URL: "https://admin.example.com" }).console, { origin: "https://admin.example.com", port: 3045 });
  assert.deepEqual(loadSitesConfig({ ...base, IDOU_ADMIN_URL: "https://sites.example.com:8445", IDOU_ADMIN_PORT: "3046" }).console, { origin: "https://sites.example.com:8445", port: 3046 },
    "another port is another origin");
  assert.throws(() => loadSitesConfig({ ...base, IDOU_ADMIN_URL: "https://sites.example.com" }), /不能和 IDOU_SITES_URL 同源/);
  assert.throws(() => loadSitesConfig({ ...base, IDOU_ADMIN_URL: "https://admin.example.com", IDOU_ADMIN_PORT: "3042" }), /IDOU_ADMIN_PORT 无效，或和 IDOU_SITES_PORT 相同/);
  assert.throws(() => loadSitesConfig({ ...base, IDOU_ADMIN_URL: "https://admin.example.com/admin" }), /只能是协议加主机名/);
});
