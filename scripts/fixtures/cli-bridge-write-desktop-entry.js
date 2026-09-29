// Test-only interception of the system browser and the native confirmation
// dialog. The Feishu provider, bundled lark-cli, loopback sidecar, control
// plane and write-grant path all stay real.
import "../../src/adopt-legacy-env.js";
import { shell, dialog, safeStorage } from "electron";
import { fixtureCipher } from "./wiki-cipher.js";

globalThis.bridgeWriteFixture = { launches: [], dialogs: [], confirmation: 1 };
const cipher = fixtureCipher(Buffer.alloc(32, 31));
safeStorage.isEncryptionAvailable = cipher.available;
safeStorage.encryptString = cipher.encrypt;
safeStorage.decryptString = cipher.decrypt;
shell.openExternal = async url => { globalThis.bridgeWriteFixture.launches.push(url); };
dialog.showMessageBox = async (_win, options) => {
  globalThis.bridgeWriteFixture.dialogs.push(options);
  return { response: globalThis.bridgeWriteFixture.confirmation };
};
await import("../../src/desktop/main.js");
