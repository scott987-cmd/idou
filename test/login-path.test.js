import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loginShellPath, mergePath } from "../src/desktop/login-path.js";

// A packaged app started from Finder has launchd's PATH; it asks the login shell
// for the person's own, and never lets a bad answer take away what it had.
test("the login shell's PATH comes first, the app's own follows, and only real absolute directories are kept", async () => {
  const run = async (shell, args) => {
    assert.equal(shell, "/bin/zsh");
    assert.equal(args[0], "-ilc");
    return "Welcome back!\n__IDOU_LOGIN_PATH__/opt/homebrew/bin:/usr/bin:relative/bin:/does/not/exist:/opt/homebrew/bin__IDOU_LOGIN_PATH__\nbye";
  };
  const exists = (entry) => ["/opt/homebrew/bin", "/usr/bin"].includes(entry);
  assert.equal(await loginShellPath({ shell: "/bin/zsh", current: "/usr/bin:/bin", run, exists }), "/opt/homebrew/bin:/usr/bin:/bin");
  assert.equal(mergePath("/a:/b", "/b:/c", () => true), "/a:/b:/c");
});

test("a slow, failing or silent login shell leaves the PATH exactly as it was", async () => {
  for (const run of [async () => { throw new Error("timed out"); }, async () => "no markers here", async () => ""]) {
    assert.equal(await loginShellPath({ shell: "/bin/zsh", current: "/usr/bin:/bin", run }), "/usr/bin:/bin");
  }
  const refuse = async () => { throw new Error("must not run"); };
  assert.equal(await loginShellPath({ shell: "zsh", current: "/usr/bin:/bin", run: refuse }), "/usr/bin:/bin", "a shell named without an absolute path is not run");
  assert.equal(await loginShellPath({ shell: undefined, current: "/usr/bin", run: refuse }), "/usr/bin");
});

test("a real login shell answers through the marker", async () => {
  const merged = await loginShellPath({ shell: "/bin/sh", current: "/app-only-entry" });
  assert.ok(merged.split(":").includes("/usr/bin"), `the shell's own PATH should be read: ${merged}`);
  assert.ok(merged.endsWith("/app-only-entry"), "what the app had is kept after it");
});

async function ended(pid) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { process.kill(pid, 0); } catch { return true; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

// The real shell with a startup file that never finishes -- and that started
// something of its own, which must not outlive it either.
test("a login shell whose startup never finishes is ended with what it started, and the PATH stays as it was", { skip: !existsSync("/bin/zsh") && "needs /bin/zsh" }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-login-path-"));
  const previous = process.env.ZDOTDIR;
  t.after(async () => {
    if (previous === undefined) delete process.env.ZDOTDIR; else process.env.ZDOTDIR = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const shellPid = path.join(directory, "shell.pid"), childPid = path.join(directory, "child.pid");
  await writeFile(path.join(directory, ".zshenv"), `echo $$ > "${shellPid}"\nsleep 30 &\necho $! > "${childPid}"\nwait\n`);
  process.env.ZDOTDIR = directory;
  const started = Date.now();
  assert.equal(await loginShellPath({ shell: "/bin/zsh", current: "/usr/bin:/bin", timeoutMs: 800 }), "/usr/bin:/bin");
  assert.ok(Date.now() - started < 5000, "the app must not wait on the shell");
  assert.equal(await ended(Number((await readFile(shellPid, "utf8")).trim())), true, "the shell must not be left running");
  assert.equal(await ended(Number((await readFile(childPid, "utf8")).trim())), true, "nor what its startup file started");
});
