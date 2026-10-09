// Test-only native process/model boundaries. Production never imports this file.
// The desktop application with a synthetic Feishu CLI behind it that also
// answers the people and group searches a site's sharing panel makes
// (docs/sites-phase0.md §0.4). No account, no network, no model.
import "../../src/adopt-legacy-env.js";
import { safeStorage } from "electron";
import { SaasFeishuCliProvider } from "../../src/providers/feishu/saas-cli-provider.js";
import { fixtureCipher } from "./wiki-cipher.js";
import { baseDataFixture } from "./base-data.js";

const cipher = fixtureCipher(Buffer.alloc(32, 32));
safeStorage.isEncryptionAvailable = cipher.available; safeStorage.encryptString = cipher.encrypt; safeStorage.decryptString = cipher.decrypt;
const fixture = baseDataFixture();
const ok = (data) => ({ code: 0, stdout: JSON.stringify({ ok: true, identity: "user", data }), stderr: "" });
const run = async (binary, argv, options) => {
  if (argv[0] === "contact" && argv[1] === "+search-user") {
    return ok({ users: [{ open_id: "ou_synthetic_zhang", localized_name: "张三（合成）", department: "销售部", is_cross_tenant: false, is_activated: true }], has_more: false });
  }
  if (argv[0] === "im" && argv[1] === "+chat-search") {
    return ok({ chats: [{ chat_id: "oc_synthetic_sales", name: "张三的销售群（合成）", external: false, chat_status: "normal", owner_id: "ou_synthetic_zhang", description: "" }], has_more: false });
  }
  return fixture.run(binary, argv, options);
};
const invoke = SaasFeishuCliProvider.prototype.invoke;
SaasFeishuCliProvider.prototype.invoke = function (args, options) {
  if (!this.shareFixtureRunner) {
    const original = this.runner;
    this.runner = (binary, argv, opts) => argv[0] === "skills" || argv[0] === "--version" ? original(binary, argv, opts) : run(binary, argv, opts);
    this.shareFixtureRunner = true;
  }
  return invoke.call(this, args, options);
};
await import("../../src/desktop/main.js");
