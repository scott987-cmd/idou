// Test-only native process/model boundaries. Production never imports this file.
// The desktop application with a synthetic Feishu CLI behind it: one Base, three
// fields, two records (scripts/fixtures/base-data.js). No account, no network,
// and no model -- /table never asks one.
import "../../src/adopt-legacy-env.js";
import { safeStorage } from "electron";
import { SaasFeishuCliProvider } from "../../src/providers/feishu/saas-cli-provider.js";
import { fixtureCipher } from "./wiki-cipher.js";
import { baseDataFixture } from "./base-data.js";

const cipher = fixtureCipher(Buffer.alloc(32, 32));
safeStorage.isEncryptionAvailable = cipher.available; safeStorage.encryptString = cipher.encrypt; safeStorage.decryptString = cipher.decrypt;
const fixture = baseDataFixture();
globalThis.tableFixture = fixture.state;
const invoke = SaasFeishuCliProvider.prototype.invoke;
SaasFeishuCliProvider.prototype.invoke = function (args, options) {
  if (!this.tableFixtureRunner) {
    const original = this.runner;
    this.runner = (binary, argv, opts) => argv[0] === "skills" || argv[0] === "--version" ? original(binary, argv, opts) : fixture.run(binary, argv, opts);
    this.tableFixtureRunner = true;
  }
  return invoke.call(this, args, options);
};
await import("../../src/desktop/main.js");
