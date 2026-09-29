// Drives real containers through the real Docker daemon. The unit tests prove
// the argv is what we meant; only this proves the daemon accepts it and that the
// boundary is actually in force. Reads the enforced values from inside the
// container rather than trying to provoke a crash -- a cgroup limit that is
// really applied is a number you can read, and provoking an OOM under a
// read-only rootfs hits the tmpfs cap first and proves nothing.
import { DockerSandbox } from "../src/control-plane/sandbox/docker-sandbox.js";
import { sandboxJob } from "../src/control-plane/sandbox/job.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

const box = new DockerSandbox({ owner: randomBytes(16).toString("hex") });
console.log("available:", JSON.stringify(await box.available()));

// colima only mounts /Users/$USER into its Linux VM, so a macOS os.tmpdir()
// path (/var/folders/...) does not exist from the daemon's side and every
// container refuses to start. Under $HOME it is visible on both hosts, so the
// same script runs unchanged against a native Linux daemon.
const workspace = await mkdtemp(path.join(os.homedir(), ".idou-sandbox-live-"));
console.log("workspace:", workspace);

let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
};

const run = async (label, overrides) => {
  const job = sandboxJob({ image: "alpine:3.20", workspace, ...overrides });
  const started = Date.now();
  try {
    const result = await box.execute(job);
    console.log(`\n[${label}] code=${result.code} ms=${Date.now() - started}`);
    const text = `${result.stdout}${result.stderr}`.trim();
    if (text) console.log(text.split("\n").map((line) => `    | ${line}`).join("\n"));
    return { ...result, text };
  } catch (error) {
    console.log(`\n[${label}] THREW: ${String(error.message).slice(0, 400)}`);
    return { code: -1, text: "", threw: String(error.message) };
  }
};

try {
  const basic = await run("runs at all, as nobody, and can write its workspace", {
    command: ["sh", "-c", "id -u; id -g; echo written > /workspace/out.txt && cat /workspace/out.txt"] });
  check("container started", basic.code === 0, `exit ${basic.code}`);
  check("runs as uid 65534", /^65534\b/m.test(basic.text));
  check("workspace is writable", /written/.test(basic.text));

  const rootfs = await run("image filesystem cannot be rewritten", {
    command: ["sh", "-c", "touch /etc/nope 2>&1 || echo REFUSED"] });
  check("read-only rootfs enforced", /REFUSED|Read-only/.test(rootfs.text));

  const caps = await run("capabilities and limits as the kernel sees them", {
    limits: { memoryMb: 256, pids: 64 },
    command: ["sh", "-c", "grep CapEff /proc/self/status; cat /sys/fs/cgroup/memory.max; cat /sys/fs/cgroup/pids.max; cat /proc/sys/kernel/cap_last_cap >/dev/null 2>&1; echo ---"] });
  check("all capabilities dropped", /CapEff:\s*0{16}/.test(caps.text), caps.text.match(/CapEff:\s*\S+/)?.[0]);
  check("memory limit is 256MiB", caps.text.includes(String(256 * 1024 * 1024)));
  check("pid limit is 64", /^64$/m.test(caps.text));

  // The verdict has to come from wget's own exit status. Piping it into `head`
  // makes the pipeline exit 0 whatever wget did, and truncating the output can
  // cut the very word being matched in half. The first attempt here did both
  // and called a boundary that was working a failure -- the same writing
  // mistake would just as easily hide a boundary that was not.
  const reachable = (url, seconds) => `if wget -q -T${seconds} -O- ${url} >/dev/null 2>&1; then echo REACHED; else echo UNREACHABLE; fi`;

  const isolated = await run("no network unless asked", {
    command: ["sh", "-c", `ip -o addr show 2>/dev/null | awk '{print $2}' | sort -u | tr '\\n' ' '; echo; ${reachable("http://1.1.1.1", 3)}`] });
  check("only loopback exists", !/eth0/.test(isolated.text), isolated.text.split("\n")[0]);
  check("cannot reach the network", /UNREACHABLE/.test(isolated.text) && !/REACHED/.test(isolated.text));

  const open = await run("egress when it is deliberately opened", {
    network: { mode: "open" },
    command: ["sh", "-c", reachable("http://example.com", 8)] });
  check("open mode really reaches out", /REACHED/.test(open.text), open.text.split("\n")[0]?.slice(0, 60));

  const leftovers = await box.sweep();
  check("no containers left behind", leftovers === 0, `swept ${leftovers}`);
} finally {
  await rm(workspace, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
