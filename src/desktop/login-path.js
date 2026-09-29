import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";

// An app started from Finder inherits launchd's PATH (/usr/bin:/bin:/usr/sbin:/sbin),
// not the one the person's terminal has -- no Homebrew, no node, no version
// managers -- so the Agent could not run a project's own tools. A packaged app
// therefore asks the person's login shell for its PATH once, at start, the way
// editors do. Anything slow, failing or unreadable leaves the PATH as it was.
const MARK = "__IDOU_LOGIN_PATH__";

const isDirectory = (entry) => { try { return statSync(entry).isDirectory(); } catch { return false; } };
const usable = (entry) => Boolean(entry) && path.isAbsolute(entry) && ![...entry].some((character) => character.codePointAt(0) < 32);

// The login shell's entries first, each only if it is a real directory; then the
// ones the app already had, in their order, without repeats.
export function mergePath(login, current, exists = isDirectory) {
  const entries = [];
  for (const entry of String(login ?? "").split(path.delimiter)) if (usable(entry) && !entries.includes(entry) && exists(entry)) entries.push(entry);
  for (const entry of String(current ?? "").split(path.delimiter)) if (usable(entry) && !entries.includes(entry)) entries.push(entry);
  return entries.join(path.delimiter);
}

// Started the way editors start it: in a session of its own, so an interactive
// shell cannot take over the terminal the app was opened from, and with nothing on
// stdin, so a startup file that reads input ends instead of waiting. A shell that
// runs too long is ended together with whatever its startup files started.
function runShell(shell, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(shell, args, { detached: true, stdio: ["ignore", "pipe", "ignore"], env: process.env });
    let output = "", timer;
    const end = (error) => {
      clearTimeout(timer);
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
      child.stdout.destroy();
      reject(error);
    };
    timer = setTimeout(() => end(new Error("the login shell did not answer in time")), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; if (output.length > 1024 * 1024) end(new Error("the login shell printed too much")); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", () => { clearTimeout(timer); resolve(output); });
  });
}

export async function loginShellPath({ shell = process.env.SHELL, current = process.env.PATH ?? "", timeoutMs = 4000, run = runShell, exists = isDirectory } = {}) {
  if (typeof shell !== "string" || !path.isAbsolute(shell)) return current;
  try {
    const output = await run(shell, ["-ilc", `printf '%s%s%s' '${MARK}' "$PATH" '${MARK}'`], timeoutMs);
    // A shell's startup files may print around it; only the marked value counts.
    const parts = String(output).split(MARK);
    return parts.length >= 3 ? mergePath(parts[1], current, exists) : current;
  } catch {
    return current;
  }
}
