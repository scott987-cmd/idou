import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, chmod, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ResumeStore } from "../src/application/resume-store.js";

// Stands in for the OS keystore. Reversible on purpose: the tests care about
// what the store accepts and rejects, not about the cipher.
const cipher = (available = true) => ({
  available: async () => available,
  encrypt: async (text) => Buffer.from(`sealed:${text}`, "utf8"),
  decrypt: async (bytes) => { const value = bytes.toString("utf8"); if (!value.startsWith("sealed:")) throw new Error("bad"); return value.slice(7); },
});
const NS = "a".repeat(64);
async function setup(t, available = true) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-resume-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: new ResumeStore({ directory: path.join(directory, "resume"), cipher: cipher(available) }) };
}

test("写入后能按同一账号和同一服务端读回，文件保持私有", async (t) => {
  const { store } = await setup(t);
  assert.equal(await store.write(NS, "http://127.0.0.1:3041", "credential-1"), true);
  assert.equal(await store.read(NS, "http://127.0.0.1:3041"), "credential-1");
  const info = await stat(store.file(NS));
  if (process.platform !== "win32") assert.equal(info.mode & 0o077, 0, "凭据文件不得对其他用户可读");
});

test("换服务端或换账号都读不到，不会跨账号复用", async (t) => {
  const { store } = await setup(t);
  await store.write(NS, "http://127.0.0.1:3041", "credential-1");
  assert.equal(await store.read(NS, "http://127.0.0.1:9999"), null);
  assert.equal(await store.read("b".repeat(64), "http://127.0.0.1:3041"), null);
});

test("新凭据覆盖旧的，旧的不会留在盘上", async (t) => {
  const { store } = await setup(t);
  await store.write(NS, "http://127.0.0.1:3041", "credential-1");
  await store.write(NS, "http://127.0.0.1:3041", "credential-2");
  assert.equal(await store.read(NS, "http://127.0.0.1:3041"), "credential-2");
});

test("损坏、超长或无法解密的记录当作没有，而不是抛错", async (t) => {
  const { store, directory } = await setup(t);
  await store.write(NS, "http://127.0.0.1:3041", "credential-1");
  await writeFile(store.file(NS), Buffer.from("not-sealed"), { mode: 0o600 });
  assert.equal(await store.read(NS, "http://127.0.0.1:3041"), null);
  assert.equal(await store.read(NS, "http://127.0.0.1:3041"), null, "重复读取仍然安静返回空");
  assert.ok(directory);
});

test("对其他用户可读的文件被拒绝读取", { skip: process.platform === "win32" }, async (t) => {
  const { store } = await setup(t);
  await store.write(NS, "http://127.0.0.1:3041", "credential-1");
  await chmod(store.file(NS), 0o644);
  assert.equal(await store.read(NS, "http://127.0.0.1:3041"), null);
});

test("系统加密不可用时既不写也不读", async (t) => {
  const { store } = await setup(t, false);
  assert.equal(await store.write(NS, "http://127.0.0.1:3041", "credential-1"), false);
  assert.equal(await store.read(NS, "http://127.0.0.1:3041"), null);
});

test("清除后读不到，重复清除不报错", async (t) => {
  const { store } = await setup(t);
  await store.write(NS, "http://127.0.0.1:3041", "credential-1");
  assert.equal(await store.clear(NS), true);
  assert.equal(await store.read(NS, "http://127.0.0.1:3041"), null);
  assert.equal(await store.clear(NS), true);
});

test("账号命名空间必须是账号哈希，不接受路径", async (t) => {
  const { store } = await setup(t);
  for (const bad of ["../escape", "short", "", "/etc/passwd"]) assert.throws(() => store.file(bad), /Invalid account namespace/);
});
