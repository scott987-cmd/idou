// @requires docker: 隔离的应用运行时（本机 Docker）
import "../src/adopt-legacy-env.js";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import path from "node:path";
import os from "node:os";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { runProcess } from "../src/providers/process-runner.js";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { createIsolatedStaticApp } from "../src/apps/isolated-static-app.js";
import { staticAppFixture } from "./fixtures/static-app-package.js";
import { appHash } from "../src/apps/manifest.js";

const [dockerPath, endpoint, imageId] = process.argv.slice(2);
const config = { dockerPath, endpoint, imageId }, fixture = staticAppFixture();
const root = await mkdtemp(path.join(os.tmpdir(), "idou-runtime-smoke-")), evidence = path.resolve("docs/evidence"); await mkdir(evidence, { recursive: true });
const command = args => runProcess(dockerPath, ["--host", endpoint, ...args], { timeoutMs: 15000, maxOutputBytes: 65536 });
let runtime, browser, cli, cliDone;
try {
  runtime = await createIsolatedStaticApp({ config, ...fixture, expiresAt: Date.now() + 60000 });
  for (const [file, text] of Object.entries(fixture.files)) {
    const response = await fetch(runtime.url(file)); assert.equal(response.status, 200); assert.equal(await response.text(), text);
  }
  assert.equal((await fetch(runtime.url("../outside.html"))).status, 404);
  assert.equal((await fetch(runtime.entryUrl, { method: "POST" })).status, 404);
  assert.equal((await fetch(runtime.entryUrl, { headers: { origin: "https://foreign.invalid" } })).status, 404);
  const probe = `const fs=require('fs'),net=require('net'); let readOnly=false,socketAbsent=false;try{fs.writeFileSync('/tmp/runtime-write-probe','x')}catch(e){readOnly=e.code==='EROFS'}try{fs.accessSync('/var/run/docker.sock')}catch(e){socketAbsent=e.code==='ENOENT'}const status=fs.readFileSync('/proc/self/status','utf8');const result={uid:process.getuid(),readOnly,socketAbsent,noNewPrivileges:/NoNewPrivs:\\s+1/.test(status),noCapabilities:/CapEff:\\s+0+\\n/.test(status),seccomp:/Seccomp:\\s+2/.test(status),memory:fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim(),pids:fs.readFileSync('/sys/fs/cgroup/pids.max','utf8').trim(),cpu:fs.readFileSync('/sys/fs/cgroup/cpu.max','utf8').trim(),noCredentials:!Object.keys(process.env).some(k=>/KEY|TOKEN|SECRET|IDOU_RUNTIME_CANARY/.test(k))};const s=net.createConnection({host:'198.51.100.1',port:443});s.setTimeout(500,()=>{s.destroy();console.log(JSON.stringify({...result,networkBlocked:false}))});s.once('error',e=>console.log(JSON.stringify({...result,networkBlocked:['ENETUNREACH','EHOSTUNREACH'].includes(e.code)})));`;
  const diagnostic = await command(["exec", runtime.containerId, "/usr/local/bin/node", "-e", probe]); assert.equal(diagnostic.code, 0);
  const isolation = JSON.parse(diagnostic.stdout);
  assert.deepEqual(isolation, { uid: 1000, readOnly: true, socketAbsent: true, noNewPrivileges: true, noCapabilities: true, seccomp: true, memory: "268435456", pids: "32", cpu: "50000 100000", noCredentials: true, networkBlocked: true });
  const inspection = JSON.parse((await command(["inspect", runtime.containerId])).stdout)[0]; assert.equal(inspection.Mounts.length, 0); assert.equal(inspection.HostConfig.LogConfig.Type, "none");
  browser = await electron.launch({ executablePath: electronBinary, timeout: 15000, args: [path.resolve("scripts/fixtures/runtime-browser-entry.js")], env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), APP_RUNTIME_FIXTURE_URL: runtime.entryUrl, APP_RUNTIME_FIXTURE_DATA: path.join(root, "browser") } });
  const page = await browser.firstWindow({ timeout: 15000 }); page.setDefaultTimeout(15000); const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.locator("#counter").click(); assert.equal(await page.locator("#counter").textContent(), "已完成 1 项");
  assert.equal(await page.evaluate(() => typeof require + ":" + typeof process), "undefined:undefined");
  assert.equal(await page.evaluate(async () => { try { await fetch("https://example.invalid/runtime-probe"); return false; } catch { return true; } }), true);
  await page.screenshot({ path: path.join(evidence, "isolated-static-runtime-fixture.png"), scale: "css" }); assert.deepEqual(errors, []);
  await browser.close(); browser = null;
  const firstId = runtime.containerId, firstUrl = runtime.entryUrl; await runtime.close(); await runtime.closed; runtime = null;
  assert.notEqual((await command(["inspect", firstId])).code, 0); await assert.rejects(fetch(firstUrl));
  const invalid = Buffer.from("corrupt-package"); await assert.rejects(createIsolatedStaticApp({ config, bytes: invalid, digest: fixture.digest, sha256: appHash(invalid), expiresAt: Date.now() + 10000 }));
  runtime = await createIsolatedStaticApp({ config, ...fixture, expiresAt: Date.now() + 2500 });
  const expiringId = runtime.containerId, expiringUrl = runtime.entryUrl; await runtime.closed; runtime = null;
  assert.notEqual((await command(["inspect", expiringId])).code, 0); await assert.rejects(fetch(expiringUrl));
  runtime = await createIsolatedStaticApp({ config, ...fixture, expiresAt: Date.now() + 15000 });
  const killedId = runtime.containerId, killedUrl = runtime.entryUrl;
  assert.equal((await command(["kill", killedId])).code, 0); await runtime.closed; runtime = null; await assert.rejects(fetch(killedUrl));
  const configPath = path.join(root, "runtime.json"), packagePath = path.join(root, "app.json");
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 }); await writeFile(packagePath, fixture.bytes, { mode: 0o600 });
  cli = spawn(process.execPath, ["bin/app-runtime.js", "--development", configPath, packagePath, fixture.digest, fixture.sha256], { env: clientEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
  cliDone = once(cli, "close"); cli.stderr.resume();
  const lines = createInterface({ input: cli.stdout });
  let receipt;
  try {
    const [line] = await Promise.race([once(lines, "line", { signal: AbortSignal.timeout(15000) }), cliDone.then(() => { throw new Error("Runtime CLI exited before readiness"); })]);
    receipt = JSON.parse(line);
  } finally { lines.close(); }
  assert.equal(receipt.developmentOnly, true); assert.equal(receipt.deployed, false); assert.equal(receipt.digest, fixture.digest);
  assert.equal(await (await fetch(receipt.url)).text(), fixture.files["index.html"]);
  cli.kill("SIGTERM"); assert.equal((await cliDone)[0], 0); cli = null;
  assert.notEqual((await command(["inspect", receipt.containerId])).code, 0); await assert.rejects(fetch(receipt.url));
  console.log(JSON.stringify({ passed: true, actualDocker: true, imageId, isolation, actualElectron: true, verifiedStaticResources: Object.keys(fixture.files).length, interactiveCounter: true, invalidPackageRejected: true, removedOnClose: true, removedOnExpiry: true, gatewayClosesOnContainerFailure: true, developmentCliServesAndCleansOnSignal: true, modelCalls: 0, liveFeishuCalls: 0, productionDeployment: false }));
} finally { if (browser) await browser.close().catch(() => {}); if (cli) { cli.kill("SIGTERM"); await cliDone; } if (runtime) await runtime.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
