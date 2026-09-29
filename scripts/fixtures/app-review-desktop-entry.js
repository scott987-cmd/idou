// Isolated desktop acceptance only; no real OAuth, Keychain or model traffic.
import "../../src/adopt-legacy-env.js";
import { dialog, safeStorage } from "electron";
import { fixtureCipher } from "./wiki-cipher.js";
const cipher = fixtureCipher(Buffer.alloc(32, 39));
safeStorage.isEncryptionAvailable = cipher.available; safeStorage.encryptString = cipher.encrypt; safeStorage.decryptString = cipher.decrypt;
// Confirmations are answered in the window now, so nothing here decides them.
// showMessageBox is kept only to record that no path fell back to a system
// alert -- a stub that answered one would hide exactly that regression.
globalThis.appReviewFixture = { dialogs: [] };
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [process.env.APP_REVIEW_FIXTURE_WORKSPACE] });
dialog.showMessageBox = async (_win, options) => { globalThis.appReviewFixture.dialogs.push(options); return { response: 0 }; };
await import("../../src/desktop/main.js");
