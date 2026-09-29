import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listPermissions } from "../src/modes.js";
import { sandboxOverrides } from "../src/application/sandbox-roots.js";
import { CodexAppServerClient } from "../src/providers/codex/app-server-client.js";
import { runProcess } from "../src/providers/process-runner.js";

// Every permission mode is a claim about what the Codex runtime will do, and
// the runtime is the only thing that can confirm it. This shipped with
// `on-failure`, which the app-server does not accept — the label said 自动 and
// every 自动 task died on `unknown variant`. A unit test on our own object
// could never have caught that, so this one talks to the real binary.
const binary = process.env.IDOU_CODEX_BIN || "codex";
const available = await runProcess(binary, ["--version"], { maxOutputBytes: 4096 }).then((r) => r.code === 0).catch(() => false);

test("每个权限模式都被真实的 codex app-server 接受", { skip: available ? false : `找不到可执行的 ${binary}` }, async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "permission-contract-"));
  const home = await mkdtemp(path.join(os.tmpdir(), "permission-home-"));
  for (const permission of listPermissions()) {
    const client = new CodexAppServerClient({ binary, cwd, env: { ...process.env, CODEX_HOME: home }, configOverrides: sandboxOverrides(permission) });
    await client.start();
    try {
      const started = await client.request("thread/start", { cwd, sandbox: permission.sandbox, approvalPolicy: permission.approvalPolicy,
        model: "gpt-5", serviceName: "mydoubao-desktop", developerInstructions: permission.instruction });
      assert.ok(started?.thread?.id, `${permission.id} 未能启动会话：${JSON.stringify(started).slice(0, 200)}`);
    } finally { await client.stop(); }
  }
});
