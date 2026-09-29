#!/usr/bin/env node
// Codex's auth command, the sandbox edition.
//
// On the desktop this reads the session file and prints the agent token. A
// sandbox has no session file and must not have one: the whole arrangement is
// that the container holds a credential which dies with the run. So this prints
// the run token and nothing else, and Codex re-reads it on its own schedule the
// same way it would any other auth command.
import "./legacy-env.js";
const token = process.env.IDOU_RUN;
if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
  process.stderr.write("沙箱没有有效的运行令牌，无法访问模型。\n");
  process.exitCode = 1;
} else {
  process.stdout.write(token);
}
