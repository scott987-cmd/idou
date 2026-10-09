// Test-only native process/model boundaries. Production never imports this file.
// The desktop application with its list of sites reachable from the smoke
// (docs/sites-phase0.md §0.6): a site published from this machine earlier is
// recorded straight into the list, as a publish leaves it, so the versions the
// server keeps of it can be looked at without anybody answering a card.
// Synthetic Feishu behind it; no account, no network, no model.
import "../../src/adopt-legacy-env.js";
import { safeStorage } from "electron";
import { SaasFeishuCliProvider } from "../../src/providers/feishu/saas-cli-provider.js";
import { SiteStore } from "../../src/application/site-store.js";
import { fixtureCipher } from "./wiki-cipher.js";
import { baseDataFixture } from "./base-data.js";
import { exposeBridge } from "./agent-harness.js";

const cipher = fixtureCipher(Buffer.alloc(32, 32));
safeStorage.isEncryptionAvailable = cipher.available; safeStorage.encryptString = cipher.encrypt; safeStorage.decryptString = cipher.decrypt;
const fixture = baseDataFixture();
// The table itself, for a smoke to change underneath the application (smoke-site-refresh-desktop.js).
globalThis.tableFixture = fixture.state;
const ok = (data) => ({ code: 0, stdout: JSON.stringify({ ok: true, identity: "user", data }), stderr: "" });
// One group the person is in, for sending a site's link (docs/sites-phase1.md §1.4).
const GROUP = { chat_id: "oc_synthetic_sales", name: "销售群（合成）", owner_id: "ou_synthetic_owner", description: "合成的群", external: false, chat_status: "normal" };
const run = async (binary, argv, options) => {
  if (argv[0] === "im" && argv[1] === "+chat-search") return ok({ chats: [GROUP], has_more: false });
  if (argv[0] === "api" && String(argv[2]).startsWith(`/open-apis/im/v1/chats/${GROUP.chat_id}`)) {
    return ok({ name: GROUP.name, owner_id: GROUP.owner_id, description: GROUP.description, external: false, tenant_key: fixture.state.tenant, chat_status: "normal", chat_mode: "group", chat_type: "private", user_count: "8" });
  }
  if (argv[0] === "im" && argv[1] === "+chat-members-list") return ok({ chat_id: GROUP.chat_id, users: [], has_more: false });
  return fixture.run(binary, argv, options);
};
// What a send to a group would have put in Feishu, recorded here, where the
// document-delivery fixture records its own: ahead of the one-shot write grant,
// which this synthetic control plane does not hand out.
globalThis.siteSends = [];
const invoke = SaasFeishuCliProvider.prototype.invoke;
SaasFeishuCliProvider.prototype.invoke = function (args, options) {
  if (args[0] === "im" && args[1] === "+messages-send") {
    const value = (name) => args[args.indexOf(name) + 1];
    const message = { message_id: `om_synthetic_${globalThis.siteSends.length + 1}`, chat_id: value("--chat-id"), msgType: value("--msg-type"),
      content: JSON.parse(value("--content")), as: value("--as"), intent: options?.feishuWriteIntent?.action ?? null };
    globalThis.siteSends.push(message);
    return Promise.resolve(ok({ message_id: message.message_id, chat_id: message.chat_id }));
  }
  if (!this.versionsFixtureRunner) {
    const original = this.runner;
    this.runner = (binary, argv, opts) => argv[0] === "skills" || argv[0] === "--version" ? original(binary, argv, opts) : run(binary, argv, opts);
    this.versionsFixtureRunner = true;
  }
  return invoke.call(this, args, options);
};
const open = SiteStore.open;
SiteStore.open = async function (...args) {
  const store = await open.apply(this, args);
  globalThis.siteStoreFixture = store;
  return store;
};
// The Agent's bridge, for a smoke to run bin/agent.js as a task's Agent would (smoke-agent-site-desktop.js).
await exposeBridge();
await import("../../src/desktop/main.js");
