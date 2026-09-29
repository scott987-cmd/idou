import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { getPermission } from "../src/modes.js";
import { repositoryDirectories, repositoryRoot, sandboxOverrides, toolCacheRoots } from "../src/application/sandbox-roots.js";

const HOME = "/Users/probe", TEMP = "/tmp/probe";
const rootsFor = (id) => sandboxOverrides(getPermission(id), { home: HOME, temp: TEMP })["sandbox_workspace_write.writable_roots"];

test("可写沙箱额外放开的只有构建缓存，不含凭据、配置或整个家目录", () => {
  const roots = toolCacheRoots(HOME, TEMP);
  assert.ok(roots.includes(TEMP));
  for (const cache of [`${HOME}/.npm`, `${HOME}/.cache`, `${HOME}/Library/Caches/pip`, `${HOME}/Library/Caches/Yarn`, `${HOME}/.cargo/registry`]) assert.ok(roots.includes(cache), `缺少 ${cache}`);
  // 沙箱外会被执行的地方不能可写（2026-09-27）：浏览器连接器在沙箱外启动的 Chromium 在
  // ~/Library/Caches/ms-playwright；~/.deno/bin、~/.yarn/bin 在 PATH 上。
  const writable = (target) => roots.some((root) => target === root || target.startsWith(`${root}/`));
  for (const executed of [`${HOME}/Library/Caches/ms-playwright/chromium-1187/chrome-mac/Chromium.app`, `${HOME}/Library/Caches/electron`,
    `${HOME}/Library/Caches/Cypress`, `${HOME}/.deno/bin/tool`, `${HOME}/.yarn/bin/tool`, `${HOME}/Library/Caches`]) {
    assert.ok(!writable(executed), `沙箱不应能写 ${executed}`);
  }
  // 这些是真实存在的越权路径，任何一条被放进来都意味着 Agent 能改凭据或全局配置。
  for (const forbidden of [HOME, `${HOME}/`, `${HOME}/.ssh`, `${HOME}/.aws`, `${HOME}/.config`, `${HOME}/.gitconfig`, `${HOME}/Library`, "/"]) {
    assert.ok(!roots.includes(forbidden), `不应放开 ${forbidden}`);
  }
  // 前缀匹配的沙箱里，一条 `~/Library` 会连带放开 `~/Library/Keychains`。
  for (const root of roots) assert.ok(root === TEMP || root.startsWith(`${HOME}/.`) || root.startsWith(`${HOME}/Library/Caches`) || root.startsWith(`${HOME}/go/`), `根目录过宽：${root}`);
  assert.equal(new Set(roots).size, roots.length);
});

test("只读模式不携带任何可写沙箱设置", () => {
  for (const id of ["plan", "manual"]) assert.deepEqual(sandboxOverrides(getPermission(id), { home: HOME, temp: TEMP }), {});
  // 完全访问没有沙箱可配，配上去只会让人误以为它仍受限制。
  assert.deepEqual(sandboxOverrides(getPermission("full"), { home: HOME, temp: TEMP }), {});
});

test("自动模式开放网络、标准不开，两者的可写范围一致", () => {
  assert.equal(sandboxOverrides(getPermission("auto"), { home: HOME, temp: TEMP })["sandbox_workspace_write.network_access"], true);
  assert.equal(sandboxOverrides(getPermission("standard"), { home: HOME, temp: TEMP })["sandbox_workspace_write.network_access"], false);
  assert.deepEqual(rootsFor("standard"), rootsFor("auto"));
});

test("network_access 永远是布尔值，不会因为缺字段而变成开着", () => {
  const value = sandboxOverrides({ sandbox: "workspace-write" }, { home: HOME, temp: TEMP })["sandbox_workspace_write.network_access"];
  assert.equal(value, false);
});

test("放开的仓库只有本任务目录下的那一个", () => {
  assert.deepEqual(repositoryRoot("/work/site"), ["/work/site/.git"]);
  // 没有目录、或者拿到的是相对路径时，宁可什么都不放开，也不要拼出一个别处的 .git。
  for (const bad of [undefined, null, "", "relative/path", 42]) assert.deepEqual(repositoryRoot(bad), []);
  const roots = sandboxOverrides(getPermission("standard"), { cwd: "/work/site", home: HOME, temp: TEMP })["sandbox_workspace_write.writable_roots"];
  assert.deepEqual(roots.filter((root) => root.endsWith(".git")), ["/work/site/.git"]);
});

test("任务目录在仓库的子目录或 worktree 里时，放开的是 git 实际写入的 .git", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "idou-repository-roots-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (cwd, ...args) => { const result = spawnSync("git", ["-c", "user.name=probe", "-c", "user.email=probe@example.invalid", ...args], { cwd, encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); };
  const main = path.join(root, "monorepo"), site = path.join(main, "packages", "site");
  await mkdir(site, { recursive: true });
  git(main, "init", "-q"); git(main, "commit", "-q", "--allow-empty", "-m", "start");
  assert.deepEqual(await repositoryDirectories(site), [path.join(main, ".git")]);
  git(main, "worktree", "add", "-q", path.join(root, "feature"));
  assert.deepEqual(new Set(await repositoryDirectories(path.join(root, "feature"))), new Set([path.join(main, ".git", "worktrees", "feature"), path.join(main, ".git")]));
  const plain = path.join(root, "plain"); await mkdir(plain);
  assert.deepEqual(await repositoryDirectories(plain), [path.join(plain, ".git")], "not a repository yet: its own .git, for one created later");
  assert.deepEqual(await repositoryDirectories("relative/path"), []);
  const roots = sandboxOverrides(getPermission("standard"), { cwd: site, home: HOME, temp: TEMP, repository: await repositoryDirectories(site) })["sandbox_workspace_write.writable_roots"];
  assert.deepEqual(roots.filter((entry) => entry.endsWith(".git")), [path.join(main, ".git")]);
});

test("被植入的 .git/commondir 指向别处仓库时，不放开那个 .git", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "idou-commondir-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (cwd, ...args) => { const result = spawnSync("git", ["-c", "user.name=probe", "-c", "user.email=probe@example.invalid", ...args], { cwd, encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); };
  const victim = path.join(root, "victim"), task = path.join(root, "task");
  await mkdir(victim); await mkdir(task);
  git(victim, "init", "-q"); git(victim, "commit", "-q", "--allow-empty", "-m", "v");
  git(task, "init", "-q"); git(task, "commit", "-q", "--allow-empty", "-m", "t");
  // The agent can write inside its own .git; a commondir there points git at
  // another repository. The resolver must not turn that into a writable root.
  await writeFile(path.join(task, ".git", "commondir"), `${path.join(victim, ".git")}\n`);
  const roots = await repositoryDirectories(task);
  assert.ok(!roots.includes(path.join(victim, ".git")), "别处仓库的 .git 不应被放开");
  assert.deepEqual(roots, [path.join(task, ".git")]);
});

test("只读模式即使传了目录也不会因此获得仓库写权限", () => {
  for (const id of ["plan", "manual", "full"]) assert.deepEqual(sandboxOverrides(getPermission(id), { cwd: "/work/site", home: HOME, temp: TEMP }), {});
});
