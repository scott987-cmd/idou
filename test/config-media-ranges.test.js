import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";

async function withConfig(t, media) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "idou-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, ".idou.json"), JSON.stringify({ media }));
  return loadConfig(dir);
}

test("media.allowedAddressRanges 缺省为空，合法 CIDR 去重后保留", async (t) => {
  assert.deepEqual((await withConfig(t, {})).media.allowedAddressRanges, []);
  assert.deepEqual((await withConfig(t, { allowedAddressRanges: ["198.18.0.0/15", "198.18.0.0/15", "10.0.0.0/8"] })).media.allowedAddressRanges, ["198.18.0.0/15", "10.0.0.0/8"]);
});

test("不是 IPv4 CIDR 的条目在加载配置时就被拒绝，而不是在下载时才发现", async (t) => {
  for (const bad of [["198.18.0.0"], ["not-a-cidr"], ["198.18.0.0/33"], ["300.1.1.1/8"], ["::/0"], "198.18.0.0/15"]) {
    await assert.rejects(withConfig(t, { allowedAddressRanges: bad }), /allowedAddressRanges/);
  }
});

// `.idou.json` is read from wherever the command started, which can be a
// repository someone else wrote. The programs named here run holding the
// person's Feishu and model credentials, so a checked-out file must not choose
// them; the developer's own environment still can.
test(".idou.json 不能指定要运行的可执行文件，改名前的 .mydoubao.json 也不能", async (t) => {
  for (const file of [".idou.json", ".mydoubao.json"]) {
    for (const [section, variable] of [["feishu", "IDOU_FEISHU_BIN"], ["codex", "IDOU_CODEX_BIN"]]) {
      const dir = await mkdtemp(path.join(os.tmpdir(), "idou-config-"));
      t.after(() => rm(dir, { recursive: true, force: true }));
      await writeFile(path.join(dir, file), JSON.stringify({ [section]: { binary: "/tmp/repo/tools/evil" } }));
      await assert.rejects(loadConfig(dir), new RegExp(`^Error: ${file.replace(".", "\\.")} 不能指定可执行文件（${section}\\.binary.*${variable}`), file);
    }
  }
});

// The product was renamed: a folder set up before then has .mydoubao.json and
// is read as it is; one that has both means the new one.
test("改名前的 .mydoubao.json 照样读取；两个都在时以 .idou.json 为准", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "idou-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, ".mydoubao.json"), JSON.stringify({ feishu: { profile: "earlier" } }));
  assert.equal((await loadConfig(dir)).feishu.profile, "earlier");
  await writeFile(path.join(dir, ".idou.json"), JSON.stringify({ feishu: { profile: "current" } }));
  assert.equal((await loadConfig(dir)).feishu.profile, "current");
});

test("开发者自己的环境变量仍然可以指定可执行文件", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "idou-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const saved = { feishu: process.env.IDOU_FEISHU_BIN, codex: process.env.IDOU_CODEX_BIN };
  t.after(() => {
    for (const [key, name] of [["feishu", "IDOU_FEISHU_BIN"], ["codex", "IDOU_CODEX_BIN"]]) {
      if (saved[key] === undefined) delete process.env[name]; else process.env[name] = saved[key];
    }
  });
  process.env.IDOU_FEISHU_BIN = "/opt/dev/lark-cli";
  process.env.IDOU_CODEX_BIN = "/opt/dev/codex";
  await writeFile(path.join(dir, ".idou.json"), JSON.stringify({ feishu: { profile: "work" }, codex: {} }));
  const config = await loadConfig(dir);
  assert.equal(config.feishu.binary, "/opt/dev/lark-cli");
  assert.equal(config.codex.binary, "/opt/dev/codex");
  assert.equal(config.feishu.profile, "work", "the rest of the section is still read");
});

// The example is what people copy. One that named an executable -- it used to
// carry "codex": {"binary": "codex"} -- would now stop the application loading.
test("照抄 .idou.example.json 得到的配置可以直接加载", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "idou-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const example = await (await import("node:fs/promises")).readFile(new URL("../.idou.example.json", import.meta.url), "utf8");
  await writeFile(path.join(dir, ".idou.json"), example);
  const config = await loadConfig(dir);
  assert.equal(config.feishu.provider, "saas-cli");
});
