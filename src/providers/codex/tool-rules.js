import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { nodeRuntime } from "../node-runtime.js";

// In a mode whose commands have no network (modes.js: 标准, and the read-only
// ones), the application's own tools still have to reach the application: the
// Feishu CLI talks to its sidecar, and bin/agent.js to the desktop's bridge,
// both on this machine's loopback address -- which Codex's sandbox shuts along
// with everything else (measured on 0.157: loopback and Unix sockets both
// refused once network access is off). Codex runs a command that one of its
// rules allows outside the sandbox, without asking; so each of these tools gets
// a rule of its own, in the rules folder of the Codex home the task runs under.
//
// What a rule can and cannot be, as the pinned Codex matches it (measured, and
// asked of the binary again in test/codex-tool-rules.test.js):
//   - by absolute path, never by name: a rule for a name is matched against
//     whatever that name finds first on PATH, and a sandboxed command can put an
//     impostor there;
//   - the path unquoted: a quoted first word never matches, so a path that would
//     need quoting -- a space, a quote, a shell character -- cannot have one;
//   - the tool alone in its command: after a pipe, a redirection or an
//     assignment, the whole command stays in the sandbox.
// And what it rests on: nothing a sandboxed command may write can be one of
// these tools, what they run, or the rules themselves (ownedPaths below;
// task-runtime.js refuses a working folder that would make them writable).
export const RULES_NAME = "idou.rules";
export const AGENT_TOOL_NAME = "idou-agent";

// Letters in any script, digits and _ . / - + : a word the shell takes as it is.
const BARE = /^\/[\p{L}\p{N}_./+-]+$/u;
export const bareCommandPath = (value) => typeof value === "string" && BARE.test(value) && !value.split("/").includes("..");
const quoted = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

// bin/agent.js on the application's Node (node-runtime.js), named by one path:
// `node` is found on PATH, and a development Electron runs scripts only when
// told to.
export function agentToolScript({ runtime, script, runAsNode }) {
  return `#!/bin/sh\n# Written by i豆 for its Agent; replaced every time a task starts.\n${runAsNode ? "ELECTRON_RUN_AS_NODE=1 " : ""}exec ${quoted(runtime)} ${quoted(script)} "$@"\n`;
}

export function rulesText(paths) {
  return ["# Written by i豆 every time a task starts. The application's own tools, which",
    "# reach the application on this machine; everything else a command does stays",
    "# inside the sandbox.",
    ...paths.map((file) => `prefix_rule(pattern = [${JSON.stringify(file)}], decision = "allow")`), ""].join("\n");
}

async function replace(file, text, mode) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { mode, flag: "wx" });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

// Writes the agent tool's launcher and the rules for both tools, and says how
// the Agent runs each: `larkCli` and `agent` are the exact commands, or null
// for a tool whose path cannot carry a rule (it is then run as before, and in a
// mode without network the person is asked).
export async function installToolRules({ codexHome, directory, larkCli, agentScript, runtime = nodeRuntime().command, runAsNode = Boolean(nodeRuntime().env.ELECTRON_RUN_AS_NODE) }) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const agent = path.join(directory, AGENT_TOOL_NAME);
  await replace(agent, agentToolScript({ runtime, script: agentScript, runAsNode }), 0o700);
  const allowed = { larkCli: bareCommandPath(larkCli) ? larkCli : null, agent: bareCommandPath(agent) ? agent : null };
  await mkdir(path.join(codexHome, "rules"), { recursive: true, mode: 0o700 });
  await replace(path.join(codexHome, "rules", RULES_NAME), rulesText([allowed.larkCli, allowed.agent].filter(Boolean)), 0o600);
  return allowed;
}

// What a sandboxed command must never be able to write: the tools a rule lets
// out of the sandbox, what they run, and where the rules are. A working folder
// that holds any of them, or lies inside one, would let a task rewrite a tool
// and then run it outside.
export function ownedPaths({ codexHome, directory, larkCli, agentScript, runtime = nodeRuntime().command, applicationRoot }) {
  return [codexHome, directory, larkCli, agentScript, runtime, applicationRoot].filter(Boolean).map((entry) => path.resolve(entry));
}
const within = (parent, child) => { const relative = path.relative(parent, child); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); };
export const writableOwned = (writable, owned) => owned.filter((entry) => writable.some((root) => within(path.resolve(root), entry) || within(entry, path.resolve(root))));
