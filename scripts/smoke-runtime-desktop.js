// @requires docker: 隔离的应用运行时（本机 Docker）
// Exporting a short-lived runtime acceptance grant, driven through the current UI.
//
// The native alert this used to answer is gone: main.js sends "idou:confirm"
// and the renderer draws a card with the buttons the main process offered, so
// the second refusal is now a click in the app instead of a stubbed dialog. The
// card is raised while the runtime dialog is open on top of the window, so it
// also has to be reachable there rather than stranded behind it.
//
// What has to hold is unchanged: neither refusal mints a grant, the disclosure
// names the exact version and says the previous grant is revoked, the answer
// that does nothing is the one in hand, the exported file is usable by the real
// independent node, a version withdrawn while the confirmation is outstanding is
// refused and stops the node already running, and no bearer reaches the renderer
// or the desktop store.
//
// Usage: node scripts/smoke-runtime-desktop.js <docker绝对路径> <unix端点> <image-id>
import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import path from "node:path";
import { runtimeControlFixture } from "./fixtures/runtime-control-plane.js";
import { answerConfirm, waitForHumanConfirm } from "./fixtures/agent-harness.js";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { runProcess } from "../src/providers/process-runner.js";

const [dockerPath, endpoint, imageId] = process.argv.slice(2), f = await runtimeControlFixture(imageId);
const exportsDir = path.join(f.root, "exports"), data = path.join(f.root, "desktop"), evidence = path.resolve("docs/evidence"), sessionFile = path.join(f.root, "operator.json");
await mkdir(exportsDir, { mode: 0o700 }); await mkdir(evidence, { recursive: true });
let app, page, node, nodeDone; const errors = [];
const issues = () => f.requests.filter(route => route === "/auth/app-runtime-token").length;
const card = () => page.locator("#confirmations .confirm-card");
// The alert said this with defaultId/cancelId. The card says it by putting the
// answer that signs nothing first and giving no button the primary styling. A
// stray Enter cannot sign: an ordinary card leaves the person's focus where it
// was -- only a destructive one moves it to 取消 (c894d6b, 2026-09-22) -- and
// focus never rests on the answer that signs. This smoke needs Docker and had
// not run since then, so it still asked for 取消 to hold focus (2026-09-26).
const cancelInHand = async () => {
  const first = card().locator(".confirm-actions button").first();
  assert.equal((await first.innerText()).trim(), "取消");
  assert.equal(await page.evaluate(() => { const at = document.activeElement; return Boolean(at?.closest("#confirmations .confirm-card") && at.textContent.trim() !== "取消"); }), false, "focus must not rest on a confirming answer");
  assert.equal(await card().locator(".confirm-actions button.primary").count(), 0);
};
// The same disclosure is read whichever way the confirmation is answered.
const disclosed = text => {
  assert.match(text, new RegExp(f.pkg.digest)); assert.match(text, new RegExp(f.pkg.sha256)); assert.match(text, new RegExp(f.imageId));
  assert.match(text, /撤销.*旧运行许可/); assert.match(text, /不启动节点/); assert.match(text, /不正式发布/);
};
try {
  f.ready(); await writeFile(sessionFile, JSON.stringify({ token: f.operator.token, expiresAt: f.operator.expiresAt, serverUrl: f.serverUrl }), { mode: 0o600 });
  app = await electron.launch({ executablePath: electronBinary, timeout: 15000, args: [path.resolve("scripts/fixtures/app-runtime-desktop-entry.js")], env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), IDOU_SESSION_FILE: sessionFile, IDOU_DESKTOP_DATA_DIR: data, APP_RUNTIME_UI_EXPORT_DIRECTORY: exportsDir } });
  page = await app.firstWindow({ timeout: 15000 }); page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
  await page.locator("#new-task").waitFor();
  await page.locator('[data-section="coding"]').click(); await page.locator("#welcome-app-runtime").click();
  await page.locator(".app-runtime-choice").click(); await page.locator("#export-app-runtime").waitFor();
  assert.equal((await page.evaluate(() => window.idou.snapshot())).tasks.length, 0); assert.equal(issues(), 0);
  assert.match(await page.locator("#app-runtime-content").textContent(), new RegExp(f.imageId));
  // Refusing the directory never reaches a confirmation at all.
  await app.evaluate(() => { globalThis.runtimeUiFixture.pickerCanceled = true; });
  await page.locator("#export-app-runtime").click(); await page.locator("#app-runtime-notice").filter({ hasText: "已取消" }).waitFor();
  assert.equal(await card().count(), 0); assert.equal(issues(), 0);
  await app.evaluate(() => { globalThis.runtimeUiFixture.pickerCanceled = false; });
  // Refusing the in-app confirmation signs nothing either, and the control comes
  // back so the refusal is not a dead end.
  await page.locator("#export-app-runtime").click();
  await card().waitFor(); await cancelInHand();
  await page.screenshot({ path: path.join(evidence, "desktop-runtime-confirmation-fixture.png"), scale: "css" });
  disclosed(await answerConfirm(page, "取消"));
  await page.locator("#export-app-runtime:not([disabled])").waitFor(); assert.equal(issues(), 0); assert.deepEqual(await readdir(exportsDir), []);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(850, 680));
  const layout = await page.evaluate(() => { const c = document.querySelector("#app-runtime-content").getBoundingClientRect(), f = document.querySelector("#app-runtime-footer").getBoundingClientRect(); return { contentBottom: c.bottom, footerTop: f.top }; }); assert.ok(layout.contentBottom <= layout.footerTop);
  await page.screenshot({ path: path.join(evidence, "desktop-runtime-narrow-fixture.png"), scale: "css" });
  await page.locator("#export-app-runtime").click();
  await card().waitFor(); await cancelInHand(); disclosed(await waitForHumanConfirm(page, "确认签发并导出"));
  await page.locator("#app-runtime-notice").filter({ hasText: "许可已导出" }).waitFor(); assert.equal(issues(), 1);
  const directories = await readdir(exportsDir); assert.equal(directories.length, 1); const grantPath = path.join(exportsDir, directories[0], "runtime-grant.json"), grant = JSON.parse(await readFile(grantPath));
  assert.equal((await stat(grantPath)).mode & 0o077, 0); assert.equal(grant.binding.digest, f.pkg.digest);
  assert.ok(!(await page.content()).includes(grant.token)); assert.ok(!(await page.content()).includes(f.operator.token));
  assert.equal(await page.locator(".runtime-export-result code").textContent(), grantPath);
  assert.equal(await page.locator(".runtime-export-result").isVisible(), true);
  await page.screenshot({ path: path.join(evidence, "desktop-runtime-exported-fixture.png"), scale: "css" });
  // Consume the exact desktop-exported file using the actual independent node.
  const configPath = path.join(f.root, "node.json"), packagePath = path.join(f.root, "package.json");
  await writeFile(configPath, JSON.stringify({ runtime: { dockerPath, endpoint, imageId }, nodeId: f.nodeId, serverUrl: f.serverUrl }), { mode: 0o600 }); await writeFile(packagePath, f.pkg.bytes, { mode: 0o600 });
  node = spawn(process.execPath, ["bin/app-runtime.js", "--authorized", configPath, packagePath, grantPath], { env: clientEnvironment(), stdio: ["ignore", "pipe", "pipe"] }); nodeDone = once(node, "close"); // Keep the node's own complaint: a subprocess that dies silently is the hardest
// kind of failure to read, and this assertion's whole job is that it started.
let nodeStderr = ""; node.stderr.on("data", chunk => { nodeStderr += chunk; });
  const lines = createInterface({ input: node.stdout }); let receipt;
  try { const [line] = await Promise.race([once(lines, "line", { signal: AbortSignal.timeout(15000) }), nodeDone.then(() => { throw new Error(`Exported grant did not start the runtime node: ${nodeStderr.slice(-600) || "(no stderr)"}`); })]); receipt = JSON.parse(line); } finally { lines.close(); }
  assert.equal(await (await fetch(receipt.url)).text(), f.pkg.files["index.html"]); assert.equal(receipt.deployed, false);
  // Withdraw the version while the confirmation is still outstanding, then
  // answer it. No new grant may be minted, and the already-running node must
  // stop on revocation.
  await page.locator("#refresh-app-runtime-version").click(); await page.locator("#export-app-runtime").waitFor();
  await page.locator("#export-app-runtime").click(); await card().waitFor();
  f.catalog.withdraw(f.author, f.selector);
  await waitForHumanConfirm(page, "确认签发并导出");
  await page.locator("#app-runtime-notice").filter({ hasText: "未确认本次导出" }).waitFor(); assert.equal(issues(), 1); assert.equal((await readdir(exportsDir)).length, 1);
  let timer; try { assert.equal((await Promise.race([nodeDone, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Runtime did not stop after withdrawal")), 20000); })]))[0], 0); } finally { clearTimeout(timer); }
  node = null; await assert.rejects(fetch(receipt.url)); assert.notEqual((await runProcess(dockerPath, ["--host", endpoint, "inspect", receipt.containerId])).code, 0);
  const scan = async dir => { for (const entry of await readdir(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) await scan(file); else if (entry.isFile()) { const bytes = await readFile(file); assert.ok(!bytes.includes(Buffer.from(grant.token)), "Runtime bearer leaked into desktop storage"); assert.ok(!bytes.includes(Buffer.from(f.operator.token)), "Parent token leaked into desktop storage"); } } };
  // Every confirmation on this path was answered in the window; no step fell
  // back to a system alert over it.
  assert.deepEqual(await app.evaluate(() => globalThis.runtimeUiFixture.dialogs), []);
  await app.close(); app = null; await scan(data); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, actualElectron: true, actualDocker: true, actualHttpSqlite: true, inAppConfirmation: true, pickerCancelNoGrant: true, confirmationCancelNoGrant: true, privateExportUsableByNode: true, rendererAndDesktopStoreNoBearer: true, withdrawalDuringConfirmationDenied: true, withdrawnRuntimeStopped: true, grantIssues: issues(), paidCalls: 0, liveFeishuCalls: 0, productionDeployment: false }));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(evidence, "desktop-runtime-failure.png"), timeout: 3000 }).catch(() => {});
  throw error;
} finally { if (node) { node.kill("SIGTERM"); await nodeDone; } if (app) await app.close().catch(() => {}); await f.close(); }
