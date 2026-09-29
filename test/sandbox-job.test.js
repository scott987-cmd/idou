import test from "node:test";
import assert from "node:assert/strict";
import { sandboxJob, SANDBOX_LIMITS, WORKSPACE } from "../src/control-plane/sandbox/job.js";

const base = { image: "mydoubao/agent:1.0.0", command: ["node", "run.js"], workspace: "/srv/runs/abc" };

test("a job says what to run and where, in terms no container runtime owns", () => {
  const job = sandboxJob(base);
  assert.equal(job.image, "mydoubao/agent:1.0.0");
  assert.deepEqual([...job.command], ["node", "run.js"]);
  assert.equal(job.workspace, "/srv/runs/abc");
  assert.equal(WORKSPACE, "/workspace", "the guest path is fixed, so a job never names one");
  assert.ok(Object.isFrozen(job) && Object.isFrozen(job.command), "a job cannot be edited after it is checked");
});

test("no network unless the caller says the word", () => {
  assert.equal(sandboxJob(base).network.mode, "none", "the default is no network at all");
  assert.equal(sandboxJob({ ...base, network: { mode: "open" } }).network.mode, "open");
  // A hostname allowlist still cannot be enforced from inside, so it is refused
  // rather than accepted and quietly treated as open.
  assert.throws(() => sandboxJob({ ...base, network: { mode: "allowlist", hosts: ["open.feishu.cn"] } }), /none、gateway 或 open/);
  assert.throws(() => sandboxJob({ ...base, network: { mode: "" } }), /none、gateway 或 open/);
});

test("gateway mode reaches exactly one address, and it cannot be the sandbox itself", () => {
  const job = sandboxJob({ ...base, network: { mode: "gateway", gateway: "http://egress.mydoubao.internal:881" } });
  assert.deepEqual(job.network, { mode: "gateway", gateway: "http://egress.mydoubao.internal:881" });
  // Inside a container, loopback is the container -- a job pointed there would
  // believe it had a gateway and reach only itself.
  for (const gateway of ["http://localhost:8081", "http://127.0.0.1:8081", "https://[::1]:8081"]) {
    assert.throws(() => sandboxJob({ ...base, network: { mode: "gateway", gateway } }), /回环地址/, `${gateway} must be refused`);
  }
  // And it is an origin, not a URL to append to: a path or credentials in it
  // would be a second thing the job silently decides.
  for (const gateway of ["", "egress.internal:8081", "http://egress.internal:8081/api", "http://u:p@egress.internal"]) {
    assert.throws(() => sandboxJob({ ...base, network: { mode: "gateway", gateway } }), /网关地址/, `${JSON.stringify(gateway)} must be refused`);
  }
  assert.throws(() => sandboxJob({ ...base, network: { mode: "gateway" } }), /网关地址/, "gateway mode without an address is not a policy");
});

test("credentials are refused by name, not discouraged by documentation", () => {
  for (const name of ["LARKSUITE_CLI_TOKEN", "IDOU_FEISHU_BRIDGE_ID", "API_KEY", "SESSION_COOKIE", "DB_PASSWORD", "OPENAI_BASE_URL"]) {
    assert.throws(() => sandboxJob({ ...base, env: { [name]: "x" } }), /凭据不能进入沙箱/, `${name} must not reach a sandbox`);
  }
  // The point is that stealing what the sandbox holds gains nothing; ordinary
  // settings still pass.
  assert.deepEqual(sandboxJob({ ...base, env: { TASK_ID: "t-1", LANG: "zh_CN.UTF-8" } }).env, { TASK_ID: "t-1", LANG: "zh_CN.UTF-8" });
});

test("an environment cannot smuggle in anything else", () => {
  assert.throws(() => sandboxJob({ ...base, env: { "not a name": "x" } }), /名不合法/);
  assert.throws(() => sandboxJob({ ...base, env: { GOOD: "line\nbreak" } }), /控制字符/);
  assert.throws(() => sandboxJob({ ...base, env: { GOOD: "x".repeat(SANDBOX_LIMITS.envValueBytes + 1) } }), /值不合法/);
  const many = Object.fromEntries(Array.from({ length: SANDBOX_LIMITS.envEntries + 1 }, (_, index) => [`V${index}`, "x"]));
  assert.throws(() => sandboxJob({ ...base, env: many }), /最多/);
});

test("an image or command that could be read as something else is refused", () => {
  for (const image of ["", "bad image", "a;rm -rf /", "-flag", "UPPER/Case"]) {
    assert.throws(() => sandboxJob({ ...base, image }), /镜像名称不合法/, `${JSON.stringify(image)} must be refused`);
  }
  assert.doesNotThrow(() => sandboxJob({ ...base, image: "registry.example.com:5000/team/agent@sha256:" + "a".repeat(64) }));
  assert.throws(() => sandboxJob({ ...base, command: [] }), /要执行的命令/);
  assert.throws(() => sandboxJob({ ...base, command: ["node", ""] }), /参数不合法/);
});

test("the workspace must be a canonical absolute path", () => {
  for (const workspace of ["runs/abc", "/srv/runs/../abc", "/srv/runs/abc/", ""]) {
    assert.throws(() => sandboxJob({ ...base, workspace }), /绝对路径/, `${JSON.stringify(workspace)} must be refused`);
  }
});

test("limits have defaults and a ceiling, so one task cannot take the machine", () => {
  const job = sandboxJob(base);
  assert.equal(job.limits.memoryMb, SANDBOX_LIMITS.memoryMb.fallback);
  assert.equal(job.limits.timeoutMs, SANDBOX_LIMITS.timeoutMs.fallback);
  assert.equal(sandboxJob({ ...base, limits: { memoryMb: 256, cpus: 0.5, pids: 64, timeoutMs: 60_000 } }).limits.memoryMb, 256);
  assert.throws(() => sandboxJob({ ...base, limits: { memoryMb: SANDBOX_LIMITS.memoryMb.max + 1 } }), /内存上限/);
  assert.throws(() => sandboxJob({ ...base, limits: { timeoutMs: 1000 } }), /超时时间/);
  assert.throws(() => sandboxJob({ ...base, limits: { cpus: 0 } }), /CPU 上限/);
});
