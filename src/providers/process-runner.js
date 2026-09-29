import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import path from "node:path";

export function runProcess(command, args, options = {}) {
  const { cwd, env = process.env, timeoutMs = 15_000, maxOutputBytes = 4 * 1024 * 1024, outputFileLimit, signal } = options;
  if (signal?.aborted) return Promise.reject(new Error("CLI operation canceled"));
  if (outputFileLimit && (!cwd || !path.isAbsolute(outputFileLimit.path) || path.dirname(outputFileLimit.path) !== path.resolve(cwd) || !Number.isSafeInteger(outputFileLimit.maxBytes) || outputFileLimit.maxBytes < 1)) return Promise.reject(new Error("Invalid subprocess output-file limit"));

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false, failure = null, killTimer, fileTimer, checking = false;

    // A timeout/output limit is not proof that the process has exited. Wait for
    // close before callers remove temporary files; escalate an ignored TERM.
    function stop(error, immediate = false) {
      if (settled || failure) return;
      failure = error; clearInterval(fileTimer); child.kill(immediate ? "SIGKILL" : "SIGTERM");
      if (!immediate) killTimer = setTimeout(() => child.kill("SIGKILL"), 500);
    }

    const timer = setTimeout(() => {
      stop(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const abort = () => stop(new Error("CLI operation canceled"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    if (outputFileLimit) fileTimer = setInterval(async () => {
      if (checking || settled || failure) return; checking = true;
      try {
        const stat = await lstat(outputFileLimit.path);
        if (!stat.isFile() || stat.size > outputFileLimit.maxBytes) stop(new Error("CLI download exceeded its file limit or produced an unsafe file"), true);
      } catch (error) { if (error.code !== "ENOENT") stop(new Error("Unable to monitor CLI download"), true); }
      finally { checking = false; }
    }, 25);

    const collect = (target) => (chunk) => {
      if (failure || settled) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        stop(new Error(`${command} exceeded ${maxOutputBytes} bytes of output`));
        return;
      }
      target.push(chunk);
    };

    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", finish);
    child.on("close", (code, signal) => {
      finish(failure, {
        code: code ?? 1,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer); clearInterval(fileTimer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(result);
    }
  });
}
