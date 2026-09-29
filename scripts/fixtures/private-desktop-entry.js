// Test-only executable entry: the ordinary desktop, configured by name for a
// Feishu deployment this build does not ship. Production main never imports
// this file, and nothing in it changes what the application does -- only which
// deployment the registry can hand out.
import "../../src/adopt-legacy-env.js";
import { register } from "node:module";
import { safeStorage } from "electron";
import { createHash } from "node:crypto";
import { fixtureCipher } from "./wiki-cipher.js";

register("./private-registry-hooks.js", import.meta.url);
// Stable synthetic key permits a restart. This is NOT OS-keychain evidence.
const cipher = fixtureCipher(createHash("sha256").update("synthetic-private-deployment-key-not-a-secret").digest());
safeStorage.isEncryptionAvailable = cipher.available;
safeStorage.encryptString = cipher.encrypt;
safeStorage.decryptString = cipher.decrypt;
await import("../../src/desktop/main.js");
