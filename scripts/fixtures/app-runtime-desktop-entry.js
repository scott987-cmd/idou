// Synthetic login/cipher and the native directory picker only. Product IPC and
// the export controller execute unchanged; no real Keychain, Feishu calls or
// model traffic.
//
// The export confirmation is drawn in the app now, so nothing here decides it.
// showMessageBox is kept only to record that no path fell back to a system
// alert -- a stub that answered one would hide exactly that regression.
import "../../src/adopt-legacy-env.js";
import { dialog, safeStorage } from "electron";
import { fixtureCipher } from "./wiki-cipher.js";
const cipher = fixtureCipher(Buffer.alloc(32, 41));
safeStorage.isEncryptionAvailable = cipher.available; safeStorage.encryptString = cipher.encrypt; safeStorage.decryptString = cipher.decrypt;
globalThis.runtimeUiFixture = { pickerCanceled: false, dialogs: [] };
dialog.showOpenDialog = async () => ({ canceled: globalThis.runtimeUiFixture.pickerCanceled, filePaths: [process.env.APP_RUNTIME_UI_EXPORT_DIRECTORY] });
dialog.showMessageBox = async (_win, options) => { globalThis.runtimeUiFixture.dialogs.push(options); return { response: 0 }; };
await import("../../src/desktop/main.js");
