// Test-only interception of the system browser and encrypted storage. The Agent
// bridge, Feishu provider, bundled lark-cli, loopback sidecar, control plane and
// write-grant path all stay real, and so does the in-app confirmation, which the
// smoke answers by clicking the rendered button.
import "../../src/adopt-legacy-env.js";
import { shell, safeStorage } from "electron";
import { fixtureCipher } from "./wiki-cipher.js";

globalThis.agentFeishuFixture = { launches: [] };
const cipher = fixtureCipher(Buffer.alloc(32, 29));
safeStorage.isEncryptionAvailable = cipher.available;
safeStorage.encryptString = cipher.encrypt;
safeStorage.decryptString = cipher.decrypt;
shell.openExternal = async url => { globalThis.agentFeishuFixture.launches.push(url); };
await import("../../src/desktop/main.js");
