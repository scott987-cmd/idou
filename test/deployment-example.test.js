import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { FEISHU_CLI_WRITE_ACTIONS } from "../src/providers/feishu/cli-write-contract.js";

// The example deployment file is the only instruction an operator gets, and a
// value it fails to mention is a capability that silently does not exist for
// them. That is exactly how document.create, document.append and cli.write went
// missing from a live deployment: the contract grew, the example did not, and
// nothing compared the two.
const example = fileURLToPath(new URL("../.idou.deployment.example.env", import.meta.url));

test("the example deployment file documents every controlled write action", async () => {
  const text = await readFile(example, "utf8");
  const documented = new Set([...text.matchAll(/^#\s{2,}([a-z]+(?:[.-][a-z]+)+)\s{2,}\S/gmu)].map(match => match[1]));
  for (const action of FEISHU_CLI_WRITE_ACTIONS) {
    assert.ok(documented.has(action), `写入动作 ${action} 没有写进部署示例，运维照抄就会少这项能力`);
  }
  for (const action of documented) {
    assert.ok(FEISHU_CLI_WRITE_ACTIONS.includes(action), `部署示例写了不存在的写入动作 ${action}`);
  }
});

// The example file is also a set of instructions to uncomment. A key it names
// that the allowlist rejects does not degrade gracefully: readDeploymentFile
// throws on the first unrecognised line and the whole application refuses to
// start. That is how the enterprise skill shelf stayed unreachable -- the
// example documented a 3-step setup for three keys none of which were allowed.
test("every setting the example deployment file names is one the loader accepts", async () => {
  const { DEPLOYMENT_KEYS } = await import("../src/application/deployment.js");
  const text = await readFile(example, "utf8");
  const named = new Set([...text.matchAll(/^#?\s*([A-Z][A-Z0-9_]{3,})=/gmu)].map(match => match[1]));
  assert.ok(named.size > 10, "the example should still be naming settings");
  for (const key of named) {
    assert.ok(DEPLOYMENT_KEYS.includes(key), `部署示例让运维填 ${key}，但 DEPLOYMENT_KEYS 不认它，照做会让应用直接起不来`);
  }
});

// FEISHU_CLI_SCOPES is the one part of the deployment file nothing validates
// against an authoritative list: server-config.js checks only shape and
// uniqueness, so a short list loads cleanly and simply makes capabilities
// disappear. The example's own comment points at docs/feishu-scopes.json as the
// complete set while the line under it carried thirteen of twenty-five.
test("the example's FEISHU_CLI_SCOPES matches the generated console list", async () => {
  const text = await readFile(example, "utf8");
  const listed = /^FEISHU_CLI_SCOPES=(.*)$/mu.exec(text)[1].split(",").filter(Boolean);
  const generated = JSON.parse(await readFile(new URL("../docs/feishu-scopes.json", import.meta.url), "utf8")).scopes.user;
  assert.deepEqual(listed.filter(scope => !generated.includes(scope)), [],
    "部署示例要了一个不在控制台清单里的权限，导入时会因为名字对不上失败");
  // The bridged example can never spend the account-match scope; every other
  // generated scope belongs on the line.
  assert.deepEqual(generated.filter(scope => !listed.includes(scope)), ["contact:user.employee_id:readonly"],
    "控制台清单里有的权限没写进部署示例，照抄示例就会少掉对应能力");
});

// The committed JSON is what an operator bulk-imports. It is generated, so it
// can silently fall behind the generator it came from.
test("docs/feishu-scopes.json is what the generator currently produces", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const script = fileURLToPath(new URL("../scripts/print-feishu-scopes.js", import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [script]);
  const committed = await readFile(new URL("../docs/feishu-scopes.json", import.meta.url), "utf8");
  assert.deepEqual(JSON.parse(stdout), JSON.parse(committed), "docs/feishu-scopes.json 已过期，跑 npm run scopes 重新生成");
});

// serverEnvironment rebuilds the control plane's env from PATH/HOME/TMPDIR/LANG
// plus DEPLOYMENT_KEYS, so a name the server reads but the allowlist omits can
// never arrive -- the feature is simply off, with no error anywhere. That is how
// the enterprise skill shelf and the MCP broker both ended up unreachable while
// their own docs described how to configure them.
test("every setting the control plane reads is one the deployment file can carry", async () => {
  const { DEPLOYMENT_KEYS } = await import("../src/application/deployment.js");
  const { readdir } = await import("node:fs/promises");
  const directory = new URL("../src/control-plane/", import.meta.url);
  const sources = [new URL("../bin/server.js", import.meta.url),
    ...(await readdir(directory)).filter(name => name.endsWith(".js")).map(name => new URL(name, directory))];
  const read = new Set();
  for (const source of sources) {
    for (const match of (await readFile(source, "utf8")).matchAll(/\benv\.((?:IDOU|FEISHU|MINIMAX)_[A-Z0-9_]+)/gu)) read.add(match[1]);
  }
  assert.ok(read.size > 15, "expected to find the control plane's settings");
  for (const key of read) {
    assert.ok(DEPLOYMENT_KEYS.includes(key), `控制面会读 ${key}，但 serverEnvironment 会把它滤掉，配了也到不了服务端`);
  }
});

// The bridge document is the reference for what a write action actually sends,
// and it described four of the seven -- while contradicting itself two
// paragraphs earlier, which listed all seven. A row per action is the promise
// its own text makes ("Each enabled write action contributes exactly one
// endpoint"), so pin that promise rather than the prose around it.
test("the bridge document has an endpoint row for every write action", async () => {
  const { FEISHU_CLI_WRITE_ACTIONS } = await import("../src/providers/feishu/cli-write-contract.js");
  const text = await readFile(new URL("../docs/feishu-cli-bridge.md", import.meta.url), "utf8");
  const rows = new Set([...text.matchAll(/^\|\s*`([a-z]+(?:[.-][a-z]+)+)`\s*\|/gmu)].map(match => match[1]));
  for (const action of FEISHU_CLI_WRITE_ACTIONS) {
    assert.ok(rows.has(action), `docs/feishu-cli-bridge.md 的端点表缺 ${action}，读文档的人会以为这个动作不存在`);
  }
});

// The operator registers scopes from docs/setup-real-feishu.md's tables, so a
// scope the generator emits but that table never names is one they will not
// enable -- and the failure surfaces much later as a 400 from Feishu on an
// unrelated-looking action. Three were missing this way.
test("the setup guide names every scope the console list asks for", async () => {
  const generated = JSON.parse(await readFile(new URL("../docs/feishu-scopes.json", import.meta.url), "utf8")).scopes.user;
  const guide = await readFile(new URL("../docs/setup-real-feishu.md", import.meta.url), "utf8");
  for (const scope of generated) {
    assert.ok(guide.includes(scope), `docs/setup-real-feishu.md 没提到 ${scope}，照着它开权限会漏掉这一项`);
  }
});

// The desktop's own overrides drift the same way the server's did: config.js
// grew skillCenter.publicKeyFile, while the README list and the example JSON
// both stayed at five keys -- so the one setting that makes the skill centre
// trust a signed catalogue was undiscoverable from either.
test("the README and example config cover every desktop override config.js reads", async () => {
  const source = await readFile(new URL("../src/config.js", import.meta.url), "utf8");
  const reads = new Set([...source.matchAll(/process\.env\.(IDOU_[A-Z0-9_]+)/gu)].map(match => match[1]));
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.ok(reads.size >= 6, "expected config.js to still read its overrides from the environment");
  for (const key of reads) assert.ok(readme.includes(key), `README 的覆盖项清单缺 ${key}`);

  // Every file-config branch config.js reads must have a place to live in the
  // example, or the reader has nothing to copy.
  const sections = new Set([...source.matchAll(/fileConfig\.([A-Za-z]+)/gu)].map(match => match[1]));
  const example = JSON.parse(await readFile(new URL("../.idou.example.json", import.meta.url), "utf8"));
  for (const section of sections) assert.ok(section in example, `.idou.example.json 缺 ${section} 段，config.js 会读它`);
});

// The login document's variable table is hand-kept, and the one it omitted --
// FEISHU_LONG_SESSION_DAYS -- is the setting that reverses the "no refresh
// token, no offline permission" promise the same document makes.
test("the login document's variable table names every Feishu login setting", async () => {
  const source = await readFile(new URL("../src/control-plane/server-config.js", import.meta.url), "utf8");
  const reads = new Set([...source.matchAll(/\benv\.(FEISHU_[A-Z0-9_]+)/gu)].map(match => match[1]));
  const doc = await readFile(new URL("../docs/feishu-login.md", import.meta.url), "utf8");
  assert.ok(reads.size >= 8, "expected server-config to still read the Feishu login settings");
  for (const key of reads) assert.ok(doc.includes(key), `docs/feishu-login.md 的变量表缺 ${key}`);
});

// A deployment setting has to reach the process that reads it. The skill
// catalogue's public key is read by src/config.js on the desktop and by nothing
// in the control plane, yet start-app.js sent it only to the server -- so a
// signed enterprise shelf reached a desktop with no key to verify it against.
test("the skill catalogue public key is handed to the side that reads it", async () => {
  const launcher = await readFile(new URL("../scripts/start-app.js", import.meta.url), "utf8");
  const desktopCall = /launchDesktop\(([\s\S]*?)\n\s*code =>/u.exec(launcher)[1];
  assert.match(desktopCall, /IDOU_SKILL_PUBLIC_KEY_FILE/, "桌面端拿不到公钥，企业技能货架签名就没法核验");
  const controlPlane = await readFile(new URL("../src/control-plane/skill-catalog.js", import.meta.url), "utf8");
  assert.doesNotMatch(controlPlane, /IDOU_SKILL_PUBLIC_KEY_FILE/, "公钥是桌面端的设置，控制面不该读它");
  const config = await readFile(new URL("../src/config.js", import.meta.url), "utf8");
  assert.match(config, /IDOU_SKILL_PUBLIC_KEY_FILE/);
});

// Twenty-one of the thirty-one smokes had no npm script and no runner. Nothing
// stopped a new one from joining them, which is how media and document smokes
// ended up only running when somebody typed the path from memory.
test("every smoke script is reachable from a runner or an npm script", async () => {
  const { readdir } = await import("node:fs/promises");
  const directory = new URL("../scripts/", import.meta.url);
  const smokes = (await readdir(directory)).filter(name => /^smoke-.*\.js$/.test(name));
  const runner = await readFile(new URL("run-desktop-acceptance.js", directory), "utf8");
  const packaged = await readFile(new URL("../package.json", import.meta.url), "utf8");
  assert.ok(smokes.length > 20, "expected the smoke suite to still be there");
  // The runner discovers by pattern, so the real risk is a smoke it deliberately
  // skips whose reason has gone stale, or a name the pattern no longer matches.
  assert.match(runner, /\^smoke-\.\*\\\.js\$/u, "runner must still discover by pattern");
  // Which smokes it holds back (--live, --docker) is said by each smoke in its
  // own header since 2026-09-25 -- the runner's hand-kept list had fallen behind
  // -- so what must hold is that the runner reads those headers and that they
  // are there (test/smoke-requirements.test.js checks each against its source).
  assert.match(runner, /declaredRequirements/u, "the runner must take each smoke's own declaration");
  const declared = await Promise.all(smokes.map(async name => (await readFile(new URL(name, directory), "utf8")).match(/^\s*\/\/\s*@requires\s+(live|docker)\s*:/mu)?.[1]));
  assert.ok(declared.filter(kind => kind === "live").length >= 8, "the --live smokes must still say so");
  assert.ok(declared.filter(kind => kind === "docker").length >= 1, "the --docker smokes must still say so");
  assert.match(packaged, /"test:acceptance"/, "package.json 里要有跑验收的入口");
});

// The chat-model switch is the newest set of server-only settings, and the one
// an operator reaches for only when changing models -- exactly when a setting
// the example and the variable table forgot would go unnoticed.
test("every chat-model setting the control plane reads is in the example and the login document", async () => {
  const source = await readFile(new URL("../src/control-plane/server-config.js", import.meta.url), "utf8");
  const reads = new Set([...source.matchAll(/\benv\.(IDOU_(?:MODEL_PROVIDER|LITELLM_[A-Z0-9_]+))/gu)].map(match => match[1]));
  assert.ok(reads.size >= 5, "expected server-config to still read the chat-model settings");
  const text = await readFile(example, "utf8");
  const doc = await readFile(new URL("../docs/feishu-login.md", import.meta.url), "utf8");
  for (const key of reads) {
    assert.match(text, new RegExp(`^#?\\s*${key}=`, "mu"), `部署示例没写 ${key}，想换对话模型的运维照抄会找不到它`);
    assert.ok(doc.includes(key), `docs/feishu-login.md 的变量表缺 ${key}`);
  }
});
