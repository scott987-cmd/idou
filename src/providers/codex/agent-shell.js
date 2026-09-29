import path from "node:path";
import { fileURLToPath } from "node:url";

// Commands the product adds to the end of the Agent's PATH. One is an
// `apply_patch` that explains itself. Codex applies a patch when a command is
// exactly `apply_patch <<'EOF' ... EOF` and never runs a program then; a patch
// with anything else in the same command becomes an ordinary shell command. In
// the coding evaluation that ended in "command not found" and the Agent went
// looking for a patch program, then fell back to `git apply`. This one applies
// nothing and says to send the patch on its own. The other is a `node` for a
// machine without one, running the application's own runtime, named in
// IDOU_NODE_RUNTIME. Both are appended, not prepended, so a real apply_patch
// or node someone installed wins.
export const AGENT_SHELL_DIRECTORY = fileURLToPath(new URL("../../../bin/agent-shell", import.meta.url));

// The variables of that environment which reach the Agent's commands.
export const AGENT_SHELL_VARIABLES = Object.freeze(["PATH", "IDOU_NODE_RUNTIME"]);

export function withAgentShellTools(env) {
  return { ...env, PATH: [env.PATH, AGENT_SHELL_DIRECTORY].filter(Boolean).join(path.delimiter), IDOU_NODE_RUNTIME: process.execPath };
}
