// Test-only browser interception. Production imports neither this entry nor mocks.
import "../../src/adopt-legacy-env.js";
import { shell, safeStorage } from "electron";
import { fixtureCipher } from "./wiki-cipher.js";
import { DesktopAuth } from "../../src/application/desktop-auth.js";
import { TaskService } from "../../src/application/task-service.js";
globalThis.loginFixture = { launches: [], leases: [] };
if (!globalThis.accountFixture) {
  const cipher = fixtureCipher(Buffer.alloc(32, 28));
  safeStorage.isEncryptionAvailable = cipher.available; safeStorage.encryptString = cipher.encrypt; safeStorage.decryptString = cipher.decrypt;
}
shell.openExternal = async (url) => { globalThis.loginFixture.launches.push(url); };
const confirm = DesktopAuth.prototype.confirm;
DesktopAuth.prototype.confirm = async function() {
  const result = await confirm.call(this);
  globalThis.loginFixture.leases.push(this.active.lease.filename);
  return result;
};
const init = TaskService.prototype.init;
TaskService.prototype.init = async function() {
  await init.call(this);
  const runtimeFactory = this.runtimeFactory;
  this.runtimeFactory = (...args) => globalThis.loginFixture.holdRuntime
    ? new Promise((_resolve, reject) => { globalThis.loginFixture.releaseRuntime = () => reject(new Error("Synthetic runtime released without starting Codex")); })
    : runtimeFactory(...args);
};
await import("../../src/desktop/main.js");
