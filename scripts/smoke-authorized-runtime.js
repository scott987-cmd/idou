// @requires docker: 隔离的应用运行时（本机 Docker）
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { runtimeControlFixture } from "./fixtures/runtime-control-plane.js";
import { runProcess } from "../src/providers/process-runner.js";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";

const [dockerPath, endpoint, imageId] = process.argv.slice(2), f = await runtimeControlFixture(imageId);
const runtime = { dockerPath, endpoint, imageId }, sessionPath = path.join(f.root, "operator.json"), configPath = path.join(f.root, "node.json"), packagePath = path.join(f.root, "package.json");
let child, done, stderr = "";
const inspect = id => runProcess(dockerPath, ["--host", endpoint, "inspect", id], { timeoutMs: 10000 });
const waitExit = async () => {
  let timer; try { return await Promise.race([done, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Runtime failed to exit after revocation")), 20000); })]); } finally { clearTimeout(timer); }
};
try {
  f.ready();
  await writeFile(sessionPath, JSON.stringify({ token: f.operator.token, serverUrl: f.serverUrl, expiresAt: f.operator.expiresAt }), { mode: 0o600 });
  await writeFile(configPath, JSON.stringify({ runtime, serverUrl: f.serverUrl, nodeId: f.nodeId }), { mode: 0o600 });
  await writeFile(packagePath, f.pkg.bytes, { mode: 0o600 });
  const results = [];
  for (const reason of ["withdraw", "server-outage"]) {
    // The first stopped version cannot be un-withdrawn; use a fresh application
    // identity for the second test while retaining the same immutable bytes.
    if (reason === "server-outage") {
      const { randomUUID } = await import("node:crypto"); f.selector.appId = randomUUID();
      f.catalog.submit(f.author, { appId: f.selector.appId, title: "第二个合成应用", manifest: f.pkg.manifest }); f.ready();
    }
    const grantPath = path.join(f.root, `${reason}.grant.json`);
    const issued = await runProcess(process.execPath, ["bin/app-runtime-grant.js", sessionPath, f.selector.appId, f.selector.digest, grantPath], { env: clientEnvironment(), timeoutMs: 15000 });
    assert.equal(issued.code, 0, issued.stderr); const grant = JSON.parse(await readFile(grantPath));
    const issuedCount = f.requests.filter(route => route === "/auth/app-runtime-token").length;
    const overwrite = await runProcess(process.execPath, ["bin/app-runtime-grant.js", sessionPath, f.selector.appId, f.selector.digest, grantPath], { env: clientEnvironment(), timeoutMs: 15000 });
    assert.notEqual(overwrite.code, 0); assert.equal(f.requests.filter(route => route === "/auth/app-runtime-token").length, issuedCount);
    assert.equal((await stat(grantPath)).mode & 0o077, 0); assert.equal(grant.audience, "app-runtime"); assert.notEqual(grant.token, f.operator.token);
    assert.ok(!issued.stdout.includes(grant.token) && !issued.stdout.includes(f.operator.token));
    child = spawn(process.execPath, ["bin/app-runtime.js", "--authorized", configPath, packagePath, grantPath], { env: clientEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
    done = once(child, "close"); child.stderr.on("data", chunk => { stderr += chunk; });
    const lines = createInterface({ input: child.stdout }); let receipt;
    try { const [line] = await Promise.race([once(lines, "line", { signal: AbortSignal.timeout(15000) }), done.then(() => { throw new Error(`Runtime exited before ready: ${stderr}`); })]); receipt = JSON.parse(line); } finally { lines.close(); }
    assert.equal(receipt.authorizedValidation, true); assert.equal(receipt.deployed, false); assert.equal(receipt.digest, f.pkg.digest);
    let checks = f.requests.filter(route => route === "/v1/apps/runtime-check").length;
    assert.equal(await (await fetch(receipt.url)).text(), f.pkg.files["index.html"]);
    assert.ok(f.requests.filter(route => route === "/v1/apps/runtime-check").length >= checks + 2);
    checks = f.requests.filter(route => route === "/v1/apps/runtime-check").length;
    const assetUrl = new URL("assets/app.js", receipt.url); assert.equal(await (await fetch(assetUrl)).text(), f.pkg.files["assets/app.js"]);
    assert.ok(f.requests.filter(route => route === "/v1/apps/runtime-check").length >= checks + 2);
    if (reason === "withdraw") f.catalog.withdraw(f.author, f.selector);
    else { f.server.close(); f.server.closeAllConnections(); }
    assert.equal((await waitExit())[0], 0, `${reason}: ${stderr.replaceAll(grant.token, "[runtime token]").replaceAll(f.operator.token, "[operator token]")}`); child = null;
    await assert.rejects(fetch(receipt.url)); assert.notEqual((await inspect(receipt.containerId)).code, 0);
    if (reason === "withdraw") assert.equal(f.sessions.verify(grant.token), null);
    assert.ok(!stderr.includes(grant.token) && !stderr.includes(f.operator.token)); results.push({ reason, stopped: true, containerAbsent: true, gatewayClosed: true });
  }
  assert.equal(f.requests.filter(route => route === "/v1/apps/runtime-claim").length, 2);
  console.log(JSON.stringify({ passed: true, actualDocker: true, actualHttpAndSqlite: true, operatorCli: true, authorizedNodeCli: true, results, productionDeployment: false, paidCalls: 0, liveFeishuCalls: 0 }));
} finally {
  if (child) { child.kill("SIGTERM"); await done; }
  await f.close();
}
