// bin/sandbox/run.js is what a scheduled task's container runs. Before it
// starts anything it holds the container to what it was given -- an egress
// address and a run token -- and refuses an egress that would mean the
// container itself. These cases were first written against the sandbox's own
// read client (bin/sandbox/feishu.js), removed once the CLI sidecar moved into
// the container and nothing ran it; they belong to the entry point that runs.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("../bin/sandbox/run.js", import.meta.url));
const RUN = "R".repeat(43);
const EGRESS = "https://egress.idou.internal:881";

// `--self-test` with no Feishu app id starts no sidecar and calls nothing: past
// the checks it says it is ready and exits 0. So a check that went missing
// shows up here as a success, not as some unrelated failure. Only PATH is
// inherited: an IDOU_* or MYDOUBAO_* in the environment running the tests must
// not stand in for one a case leaves out.
function selfTest(env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [ENTRY, "--self-test"], { env: { PATH: process.env.PATH, ...env }, timeout: 30_000 },
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
  });
}

test("an egress it can use is accepted, so the refusals below are the checks and not a broken entry point", async () => {
  const ready = await selfTest({ IDOU_EGRESS: EGRESS, IDOU_RUN: RUN });
  assert.equal(ready.code, 0, ready.stderr);
  assert.match(ready.stdout, /沙箱就绪/);
});

test("without an egress address or a run token it refuses rather than trying something else", async () => {
  for (const [env, missing] of [[{ IDOU_RUN: RUN }, "IDOU_EGRESS"], [{ IDOU_EGRESS: EGRESS }, "IDOU_RUN"], [{}, "IDOU_EGRESS、IDOU_RUN"]]) {
    const refused = await selfTest(env);
    assert.equal(refused.code, 1, `${missing} missing must be refused`);
    assert.equal(refused.stderr.trim(), `沙箱缺少必要的环境变量：${missing}`);
    assert.equal(refused.stdout, "");
  }
});

test("a loopback egress address is refused where it is used, not only where the job is built", async () => {
  // Inside a container loopback is the container: a task pointed there would
  // believe it had a way out and quietly talk to itself. HTTPS, so that what
  // refuses these is the loopback check and not the scheme check after it.
  for (const egress of ["https://127.0.0.1:881", "https://localhost:881", "https://[::1]:881"]) {
    const refused = await selfTest({ IDOU_EGRESS: egress, IDOU_RUN: RUN });
    assert.equal(refused.code, 1, `${egress} must be refused`);
    assert.match(refused.stderr, /出口地址不能是回环地址/, egress);
    assert.equal(refused.stdout, "");
  }
});
