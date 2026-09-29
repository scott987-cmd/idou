import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AGENT_TOOL_NAME, RULES_NAME, agentToolScript, bareCommandPath, installToolRules, ownedPaths, rulesText, writableOwned } from "../src/providers/codex/tool-rules.js";
import { projectTrustOverrides } from "../src/application/sandbox-roots.js";
import { getPermission } from "../src/modes.js";

// The tools a rule lets out of 标准's sandbox, and what that rests on
// (tool-rules.js); the real Codex's side is test/codex-tool-rules.test.js.

test("标准 runs commands without network, and says what still reaches the application", () => {
  const standard = getPermission("standard");
  assert.equal(standard.sandbox, "workspace-write");
  assert.equal(standard.network, false);
  assert.match(standard.summary, /要联网.*先问你/);
  assert.match(standard.instruction, /no network access/);
  assert.match(standard.instruction, /escalation/);
  assert.equal(getPermission("auto").network, true, "自动 still says it may use the network");
});

test("only a path the shell takes as it is can carry a rule", () => {
  for (const good of ["/Applications/i豆.app/Contents/Resources/lark-cli/darwin-arm64/lark-cli", "/Users/someone/.idou/agent-tools/0123456789abcdef/idou-agent", "/opt/x_y/a-b/c+d.1"]) assert.ok(bareCommandPath(good), good);
  for (const bad of ["relative/lark-cli", "/Users/John Smith/.idou/x", "/tmp/a'b", "/tmp/a$b", "/tmp/a;b", "/tmp/a*b", "/tmp/../etc/x", "/tmp/a\nb", "", null]) assert.ok(!bareCommandPath(bad), String(bad));
});

test("the launcher runs the agent tool on one runtime, whatever its paths hold", () => {
  const script = agentToolScript({ runtime: "/Applications/i豆.app/Contents/MacOS/idou", script: "/Applications/i豆.app/Contents/Resources/app/bin/agent.js", runAsNode: true });
  assert.match(script, /^#!\/bin\/sh\n/);
  assert.match(script, /\nELECTRON_RUN_AS_NODE=1 exec '\/Applications\/i豆\.app\/Contents\/MacOS\/idou' '\/Applications\/i豆\.app\/Contents\/Resources\/app\/bin\/agent\.js' "\$@"\n$/);
  assert.match(agentToolScript({ runtime: "/usr/bin/node", script: "/w/it's/agent.js", runAsNode: false }), /\nexec '\/usr\/bin\/node' '\/w\/it'\\''s\/agent\.js' "\$@"\n$/, "a quote in a path stays one argument");
  assert.equal(rulesText(["/a/lark-cli", "/b/idou-agent"]).split("\n").filter((line) => line.startsWith("prefix_rule")).join("\n"),
    'prefix_rule(pattern = ["/a/lark-cli"], decision = "allow")\nprefix_rule(pattern = ["/b/idou-agent"], decision = "allow")');
});

test("the rules name each tool by its path, and a tool whose path cannot carry one gets none", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-tool-rules-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = path.join(root, "codex"), directory = path.join(root, "tools");
  const commands = await installToolRules({ codexHome, directory, larkCli: "/opt/idou/lark-cli", agentScript: "/opt/idou/bin/agent.js", runtime: "/usr/bin/node", runAsNode: false });
  assert.deepEqual(commands, { larkCli: "/opt/idou/lark-cli", agent: path.join(directory, AGENT_TOOL_NAME) });
  const rules = await readFile(path.join(codexHome, "rules", RULES_NAME), "utf8");
  assert.match(rules, /prefix_rule\(pattern = \["\/opt\/idou\/lark-cli"\], decision = "allow"\)/);
  assert.ok(rules.includes(`prefix_rule(pattern = [${JSON.stringify(commands.agent)}], decision = "allow")`));
  assert.equal((await stat(path.join(codexHome, "rules", RULES_NAME))).mode & 0o777, 0o600);
  assert.equal((await stat(commands.agent)).mode & 0o777, 0o700, "only its owner runs or rewrites it");
  // Written again with a tool that needs quoting: that one is left out, and the file holds nothing stale.
  const again = await installToolRules({ codexHome, directory, larkCli: "/opt/my tools/lark-cli", agentScript: "/opt/idou/bin/agent.js", runtime: "/usr/bin/node", runAsNode: false });
  assert.equal(again.larkCli, null);
  assert.doesNotMatch(await readFile(path.join(codexHome, "rules", RULES_NAME), "utf8"), /lark-cli/);
});

test("a working folder that could rewrite the tools, what they run or the rules is named", () => {
  const owned = ownedPaths({ codexHome: "/Users/a/Library/Application Support/i豆/accounts/x/codex", directory: "/Users/a/.idou/agent-tools/0123",
    larkCli: "/Applications/i豆.app/Contents/Resources/lark-cli/darwin-arm64/lark-cli", agentScript: "/Applications/i豆.app/Contents/Resources/app/bin/agent.js",
    runtime: "/Applications/i豆.app/Contents/MacOS/idou", applicationRoot: "/Applications/i豆.app/Contents/Resources/app" });
  const caches = ["/Users/a/.npm", "/Users/a/.cache"];
  assert.deepEqual(writableOwned(["/Users/a/项目/网站", ...caches], owned), [], "an ordinary project");
  assert.ok(writableOwned(["/Users/a", ...caches], owned).length >= 2, "the whole home folder holds the rules and the launcher");
  assert.ok(writableOwned(["/Applications", ...caches], owned).length >= 3, "the folder the application is in");
  assert.ok(writableOwned(["/Applications/i豆.app/Contents/Resources/app/src"], owned).length >= 1, "a folder inside the application");
});

test("a project is marked untrusted exactly when it, or its repository above it, has a .codex folder", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-trust-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo"), cwd = path.join(repo, "packages", "web");
  await mkdir(path.join(repo, ".git"), { recursive: true }); await mkdir(cwd, { recursive: true });
  const git = [path.join(repo, ".git")];
  assert.deepEqual(await projectTrustOverrides(cwd, git), {}, "no .codex anywhere: left as it is");
  await mkdir(path.join(repo, ".codex"));
  const marked = await projectTrustOverrides(cwd, git);
  assert.equal(marked.projects[cwd].trust_level, "untrusted");
  assert.equal(marked.projects[repo].trust_level, "untrusted", "and the repository's root, which Codex keys a project by");
  await rm(path.join(repo, ".codex"), { recursive: true });
  await mkdir(path.join(cwd, ".codex"));
  assert.ok((await projectTrustOverrides(cwd, git)).projects, "one in the folder itself");
  await rm(path.join(cwd, ".codex"), { recursive: true });
  await mkdir(path.join(root, ".codex"));
  assert.deepEqual(await projectTrustOverrides(cwd, git), {}, "above the repository is not the project's");
  assert.deepEqual(await projectTrustOverrides("relative", git), {});
});
