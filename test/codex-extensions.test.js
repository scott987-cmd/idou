import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexExtensions, marketplaceSource, pluginId } from "../src/skills/codex-extensions.js";
import { runProcess } from "../src/providers/process-runner.js";

const binary = process.env.IDOU_CODEX_BIN || "codex";
const available = await runProcess(binary, ["--version"], { maxOutputBytes: 4096 }).then((r) => r.code === 0).catch(() => false);

test("市场地址只接受本地绝对路径与 Git 的四种写法", () => {
  assert.deepEqual(marketplaceSource("/srv/market"), { kind: "local", source: "/srv/market" });
  assert.equal(marketplaceSource("openai/codex-plugins").kind, "git");
  assert.equal(marketplaceSource("openai/codex-plugins@v2").kind, "git");
  assert.equal(marketplaceSource("https://example.com/market.git").kind, "git");
  assert.equal(marketplaceSource("git@example.com:team/market.git").kind, "git");
  // 这些若被放过去，就是让别人替你决定 codex 去执行什么。
  for (const bad of ["--ref=evil", "-c", "", "   ", "../../etc", "./market", "file:///etc", "http://example.com/m", "market; rm -rf /"]) {
    assert.throws(() => marketplaceSource(bad), Error, `未拒绝 ${JSON.stringify(bad)}`);
  }
});

test("插件标识必须是 插件名@市场名", () => {
  assert.equal(pluginId(" weekly@my-market "), "weekly@my-market");
  for (const bad of ["weekly", "@market", "weekly@", "-weekly@m", "a@b@c", "weekly@市场", ""]) {
    assert.throws(() => pluginId(bad), Error, `未拒绝 ${JSON.stringify(bad)}`);
  }
});

test("远程 MCP 只接受 https，本地 MCP 的名称不能伪装成参数", async () => {
  const ext = new CodexExtensions({ binary, env: process.env });
  await assert.rejects(() => ext.addMcpUrl("x", "http://example.com/mcp"), /https/);
  await assert.rejects(() => ext.addMcpUrl("x", "ws://example.com"), /https/);
  await assert.rejects(() => ext.addMcpCommand("--url", "/bin/echo", []), /不能以/);
  await assert.rejects(() => ext.addMcpCommand("probe", "--version", []), /不能以/);
  await assert.rejects(() => ext.addMcpCommand("probe", "/bin/echo", ["ok", 5]), /一组字符串/);
  await assert.rejects(() => ext.setPluginEnabled("weekly@m", "yes"), /布尔值/);
});

// A local marketplace is exactly how somebody publishes their own skills, so
// the test builds one the same way a person would and drives the real binary.
async function localMarketplace() {
  const root = path.join(await mkdtemp(path.join(os.tmpdir(), "ext-market-")), "market");
  await mkdir(path.join(root, ".agents/plugins"), { recursive: true });
  await mkdir(path.join(root, "plugins/wr/.codex-plugin"), { recursive: true });
  await mkdir(path.join(root, "plugins/wr/skills/weekly"), { recursive: true });
  await writeFile(path.join(root, ".agents/plugins/marketplace.json"), JSON.stringify({
    name: "mydoubao-test", owner: { name: "test" },
    plugins: [{ name: "weekly", source: "./plugins/wr", description: "把工作记录整理成周报" }] }));
  await writeFile(path.join(root, "plugins/wr/.codex-plugin/plugin.json"), JSON.stringify({ name: "weekly", version: "1.0.0" }));
  await writeFile(path.join(root, "plugins/wr/skills/weekly/SKILL.md"), "---\nname: weekly\ndescription: 整理周报\n---\n三段式。\n");
  return root;
}

test("自建市场：加市场、装、停用、启用、卸载、删市场", { skip: available ? false : `找不到可执行的 ${binary}` }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ext-home-"));
  const ext = new CodexExtensions({ binary, env: { ...process.env, CODEX_HOME: home } });
  assert.deepEqual(await ext.listMarketplaces(), []);
  assert.deepEqual(await ext.listPlugins(), []);

  const market = await localMarketplace();
  const markets = await ext.addMarketplace(market);
  assert.deepEqual(markets.map((row) => [row.name, row.kind]), [["mydoubao-test", "local"]]);

  const [available_] = await ext.listPlugins();
  assert.equal(available_.id, "weekly@mydoubao-test");
  assert.equal(available_.description, "把工作记录整理成周报");
  // 未安装时没有版本号；这里曾经把 PATH 列错当成版本。
  assert.equal(available_.version, null);
  assert.deepEqual([available_.installed, available_.enabled], [false, false]);

  const [installed] = await ext.installPlugin("weekly@mydoubao-test");
  assert.deepEqual([installed.installed, installed.enabled, installed.version], [true, true, "1.0.0"]);

  // 停用不等于卸载：为排查问题关掉它，不该把下载的东西丢掉。
  const [disabled] = await ext.setPluginEnabled("weekly@mydoubao-test", false);
  assert.deepEqual([disabled.installed, disabled.enabled], [true, false]);
  const [reenabled] = await ext.setPluginEnabled("weekly@mydoubao-test", true);
  assert.deepEqual([reenabled.installed, reenabled.enabled], [true, true]);

  const [removed] = await ext.removePlugin("weekly@mydoubao-test");
  assert.equal(removed.installed, false);
  assert.deepEqual(await ext.removeMarketplace("mydoubao-test"), []);
  assert.deepEqual(await ext.listPlugins(), []);
});

test("MCP：本地命令与远程地址都能登记、读回与删除", { skip: available ? false : `找不到可执行的 ${binary}` }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ext-mcp-home-"));
  const ext = new CodexExtensions({ binary, env: { ...process.env, CODEX_HOME: home } });
  assert.deepEqual(await ext.listMcp(), []);

  const withCommand = await ext.addMcpCommand("echo-probe", "/bin/echo", ["hi"]);
  assert.deepEqual(withCommand.map((row) => row.name), ["echo-probe"]);
  assert.deepEqual(withCommand[0].transport, { kind: "command", command: "/bin/echo", args: ["hi"] });
  assert.equal(withCommand[0].enabled, true);

  const withUrl = await ext.addMcpUrl("remote-probe", "https://example.com/mcp");
  assert.deepEqual(withUrl.find((row) => row.name === "remote-probe").transport, { kind: "url", url: "https://example.com/mcp" });

  assert.deepEqual((await ext.removeMcp("echo-probe")).map((row) => row.name), ["remote-probe"]);
  assert.deepEqual(await ext.removeMcp("remote-probe"), []);
});

test("找不到 codex 时报出可读的原因，而不是裸的 ENOENT", async () => {
  const ext = new CodexExtensions({ binary: path.join(os.tmpdir(), "definitely-not-codex") });
  await assert.rejects(() => ext.listMcp(), /找不到 codex 可执行文件/);
});

test("名称不是 ASCII 的插件不会凭空消失，而是带着原因留在列表里", { skip: available ? false : `找不到可执行的 ${binary}` }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ext-ascii-"));
  const root = path.join(await mkdtemp(path.join(os.tmpdir(), "ext-ascii-market-")), "market");
  await mkdir(path.join(root, ".agents/plugins"), { recursive: true });
  await mkdir(path.join(root, "plugins/a/.codex-plugin"), { recursive: true });
  await writeFile(path.join(root, ".agents/plugins/marketplace.json"), JSON.stringify({
    name: "ascii-market", owner: { name: "测试" },
    plugins: [{ name: "周报助手", source: "./plugins/a", description: "中文名的插件" },
              { name: "weekly", source: "./plugins/a", description: "英文名的插件" }] }));
  await writeFile(path.join(root, "plugins/a/.codex-plugin/plugin.json"), JSON.stringify({ name: "weekly", version: "1.0.0" }));
  const ext = new CodexExtensions({ binary, env: { ...process.env, CODEX_HOME: home } });
  await ext.addMarketplace(root);
  const rows = await ext.listPlugins();
  const chinese = rows.find((row) => row.name === "周报助手");
  assert.ok(chinese, "中文名的插件必须仍然出现在列表里，否则用户看到空列表却不知道为什么");
  assert.match(chinese.unusable, /只能用英文/);
  assert.equal(chinese.installed, false);
  // 能用的那个不受影响，也不该被误标。
  assert.equal(rows.find((row) => row.name === "weekly")?.unusable, undefined);
});

test("市场名不是 ASCII 时，报错要说清是哪个字段、能填什么", { skip: available ? false : `找不到可执行的 ${binary}` }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "ext-name-"));
  const root = path.join(await mkdtemp(path.join(os.tmpdir(), "ext-name-market-")), "market");
  await mkdir(path.join(root, ".agents/plugins"), { recursive: true });
  await writeFile(path.join(root, ".agents/plugins/marketplace.json"), JSON.stringify({ name: "我的技能库", owner: { name: "测试" }, plugins: [] }));
  const ext = new CodexExtensions({ binary, env: { ...process.env, CODEX_HOME: home } });
  await assert.rejects(() => ext.addMarketplace(root), /市场名只能用英文/);
});
