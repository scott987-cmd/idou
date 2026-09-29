import { SOURCE_ACCESS_SCOPE } from "../../knowledge/source-access-contract.js";
import { WIKI_SOURCE_SCOPE } from "./wiki-source-format.js";
import { WIKI_BUNDLE_SCOPES } from "./wiki-bundle-reader.js";
import { ACCOUNT_IDENTITY_SCOPE } from "./account-identity.js";

// What a login will actually ask Feishu for, in one place.
//
// This exists because it used to be built twice: once by FeishuSourceAccess for
// the real authorization URL, and once by hand in the preflight report an
// operator reads before registering scopes in the Feishu console. The hand-built
// copy re-typed two scope literals and knew nothing about the Wiki ones, so
// preflight under-reported and the operator registered a short list. The first
// login then asked for scopes nobody had enabled and stopped at 「当前应用权限
// 不足」 with no hint that the report was the thing that was wrong.
//
// offline_access is deliberately not here: it is not a capability the operator
// registers, it is how long a login survives, and it is appended at the
// authorization URL only when long sessions are on.
export const OFFLINE_SCOPE = "offline_access";
export const SCHEDULE_RESOURCE_SCOPE = "wiki:wiki:readonly";

export function feishuLoginScopes({ originalOrigins = {}, bundleReadsEnabled = false, identityChecksEnabled = false, cliProxyScopes = [], scheduleResourcesEnabled = false } = {}) {
  return Object.freeze([...new Set([
    SOURCE_ACCESS_SCOPE,
    ...(Object.keys(originalOrigins).length ? [WIKI_SOURCE_SCOPE] : []),
    ...(bundleReadsEnabled ? WIKI_BUNDLE_SCOPES : []),
    // Only asked for when something can actually spend it. Its sole consumer is
    // the account-match endpoint, and the only caller of that is
    // FeishuAccountVerifier, which the desktop constructs just for the
    // unbridged deployment (`enterprise && !bridged`, src/desktop/main.js). With
    // the bridge on, the identity carries cliBridge and the verifier is never
    // built -- so the scope was asked for at consent and could never be used.
    // That combination is not exotic: wiki key custody gates on the same
    // identity-checks flag, which walks a bridged operator straight into it.
    ...(identityChecksEnabled && !cliProxyScopes.length ? [ACCOUNT_IDENTITY_SCOPE] : []),
    // A Wiki URL is a node, not the document a scheduled task will later read.
    // Only schedule-enabled deployments ask for the read scope needed to bind
    // that node to its concrete docx token during task creation.
    ...(scheduleResourcesEnabled ? [SCHEDULE_RESOURCE_SCOPE] : []),
    ...cliProxyScopes,
  ])]);
}
