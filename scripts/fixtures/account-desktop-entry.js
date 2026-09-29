// Test-only synthetic process boundary. Production never imports this entry.
import "../../src/adopt-legacy-env.js";
import { safeStorage } from "electron";
import { SaasFeishuCliProvider } from "../../src/providers/feishu/saas-cli-provider.js";
import { fixtureCipher } from "./wiki-cipher.js";
const cipher = fixtureCipher(Buffer.alloc(32, 27));
safeStorage.isEncryptionAvailable = cipher.available; safeStorage.encryptString = cipher.encrypt; safeStorage.decryptString = cipher.decrypt;
globalThis.accountFixture = { cliOpenId: "ou_cli_alpha", tenantUserId: "alpha", tenant: "tenant_fixture", denied: false, reads: 0, identityReads: 0 };
const invoke = SaasFeishuCliProvider.prototype.invoke;
SaasFeishuCliProvider.prototype.invoke = async function(args, options) {
  if (!this.fixtureRunner) {
    const originalRunner = this.runner;
    this.runner = async (binary, argv, opts) => {
      const state = globalThis.accountFixture;
      const ok = data => ({ code: 0, stderr: "", stdout: JSON.stringify({ ok: true, identity: "user", data }) });
      if (argv[0] === "skills" || argv[0] === "--version") return originalRunner(binary, argv, opts);
      if (argv[0] === "api" && argv[2] === "/open-apis/authen/v1/user_info") {
        state.identityReads++; return ok({ open_id: state.cliOpenId, user_id: state.tenantUserId, tenant_key: state.tenant });
      }
      if (argv[0] === "docs" && argv[1] === "+fetch") {
        state.reads++;
        if (state.denied) return { code: 1, stdout: "", stderr: JSON.stringify({ ok: false, error: { type: "authorization", message: "fixture source denied" } }) };
        return ok({ document: { document_id: "SyntheticAccountDoc123", revision_id: 1, content: "<title>企业账号联通验收（合成文档）</title><p>项目原文保留在飞书，引用按当前用户重新核验。</p>" } });
      }
      if (globalThis.publicationFixture) return globalThis.publicationFixture.run(argv, opts);
      throw new Error("Unexpected fixture command; no live account call permitted");
    };
    this.fixtureRunner = true;
  }
  return invoke.call(this, args, options);
};
await import("./login-desktop-entry.js");
