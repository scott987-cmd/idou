# Fresh native Feishu account matching

Implemented for SaaS provider 1.0.78; verified with synthetic Feishu/CLI responses and actual local HTTP + Electron. This is a point-in-time identity comparison, not automatic CLI login, credential transfer, a permanent account binding, resource authorization, or OS-level tool isolation. No live/private-cloud acceptance is claimed.

## Why this identifier

Feishu documents `open_id` per application, `union_id` per application provider and `user_id` per tenant. The SaaS login application and bundled CLI application need not share an application provider, so neither raw open IDs nor assumed union-ID equivalence is sufficient. `user_id` is returned by `GET /open-apis/authen/v1/user_info` only with `contact:user.employee_id:readonly`. It is **not** `employee_no` and is administratively mutable.

Official sources inspected on 2026-09-09:

- [Authenticated user information and field scopes](https://open.feishu.cn/document/server-docs/authentication-management/login-state-management/get.md).
- [User identity semantics](https://open.feishu.cn/document/server-docs/contact-v3/user/field-overview.md).
- [Changing user IDs; tenant-wide cross-application semantics](https://open.feishu.cn/document/contact-v3/user/update_user_id.md).
- [Pinned CLI raw API command](https://github.com/larksuite/cli/blob/03de81c5f3986c2af98a3296328df9c98afabd39/cmd/api/api.go) and [success-envelope extraction](https://github.com/larksuite/cli/blob/03de81c5f3986c2af98a3296328df9c98afabd39/internal/output/envelope_success.go), tag v1.0.78. Bundled `auth --help`, `api --help`, `lark-shared` and `lark-openapi-explorer` were inspected; no login or business request was executed against the real CLI account.

## Configuration and execution

The server must explicitly enable `FEISHU_SOURCE_ACCESS_ENABLED=1` and `FEISHU_CLI_IDENTITY_CHECKS_ENABLED=1`. This implementation reuses the existing server-owned, in-memory source-access credential lifecycle; it currently requires the source-access feature rather than providing an independent identity-only retention mode. Its OAuth scope set adds only `contact:user.employee_id:readonly` for this feature. No directory listing, email, phone, employee-number or offline-access scope is added. Optional original/bundle reads retain their separately configured scopes.

This is now a fallback for deployments that do not enable the [single-login CLI bridge](feishu-cli-bridge.md). The user authorizes the server application and confirms its identity in the desktop. A confirmed server-issued session advertises `cliIdentityChecks: true`; this flag means the check is available, **not that a CLI identity has already matched**. Existing sessions without either bridge or matching capability keep the denied enterprise gate. In fallback mode the CLI remains separately logged in through its supported authentication mechanism, under the unchanged configured profile; its own app/user grants must expose user_id and the requested business capabilities. Login is not initiated, token-imported or repaired by the matcher.

1. An account-owned native provider captures the current application session and executes exactly `lark-cli api GET /open-apis/authen/v1/user_info --as user --format json`, with the configured profile, pinned absolute executable, bounded output and cancellation. The documented success envelope must have `ok: true` and `identity: user`; raw API or bot envelopes are rejected.
2. Only validated `{tenantKey, tenantUserId}` from that fresh CLI response goes to `POST /v1/feishu/account-match`, using the existing short-lived application bearer token. No CLI token, open ID, name, email, phone or arbitrary URL is submitted.
3. The server requires an enabled policy, a confirmed Feishu parent session and its retained OAuth grant. It freshly calls user_info with its own token, verifies the original application `open_id` and tenant still match that session, and compares the current tenant user ID. It returns only `matches`, `pointInTime`, candidate hash, check time and the already authenticated application subject. It does not adopt the client-supplied identity or issue a credential/resource grant.
4. The native consumer checks the response against the candidate, captured app/tenant/user/device, and unchanged session/server. The result exists only for that invocation. The local principal continues using CLI open ID + tenant + provider/profile; mutable tenant user IDs are not saved in task/Wiki account ownership.
5. Every native business dispatch checks again after any awaited preparation/confirmation/budget callback. Existing before/after resource identity and revision/ACL checks continue; document reads still require Feishu to allow the actual source. Metadata-only skill/version calls and the exact identity read avoid recursive checks. Raw Agent shell execution does not gain a new credential bridge or automatic authorization from this feature.

## Bounds and lifecycle

- Exact candidate schema, 4 KiB request/result limit at the native matching boundary; 64 KiB upstream user-info limit.
- No positive-result cache, fallback identity, token import, retries or refresh. A failed or cancelled probe stops the native operation; an already dispatched write retains its existing ambiguous-outcome behavior.
- Server checks share the existing per-parent single-flight and four-active upstream bound, with an additional process-local 120/minute probe ceiling. Concurrent work can be refused rather than queued. These are local bounds, not distributed enterprise capacity claims.
- Native 45-second overall deadline and existing 30-second CLI timeout; server 12-second upstream deadline. Logout, expiry, shutdown, policy disable and client disconnection are rechecked/cancelled around awaits.
- Account switching creates a new provider bound to that account's session file. The old scope is drained and cannot be rebound by changing a global provider. Renderer IPC receives neither provider credentials nor reusable match receipts.

## Verification and limitations

`test/feishu-account-verifier.test.js` exercises actual OAuth/login HTTP, native matching, the bundled-runtime dispatch adapter, document reads and encrypted LocalWiki. Coverage includes cross-app open IDs, custom Unicode user IDs, source denial, mutable IDs, mismatched/missing identity, bot/legacy envelopes, wrong parent/audience, missing scope/default-off policy, exact requests, cancelled/changed sessions, response substitution/overflow, revocation/expiry/close, rate limits and dispatch-time rechecking. An additional real server-entry test covers environment configuration and matching rejection after logout.

`node scripts/smoke-account-desktop.js` exercises actual Electron main/preload/renderer and HTTP: login confirmation, document opening, automatic Wiki observation/search, CLI account mismatch refusing document commands, source permission denial, logout and a second user's isolated task scope. CLI/API/cipher inputs are synthetic, not evidence of real Keychain compatibility. The screenshot is `evidence/desktop-account-wiki-fixture.png`.

The two upstream identity reads and subsequent business call are sequential, not an atomic transaction across applications. Another OS process or administrator can change identities between observations; before/after checks narrow this window but cannot freeze an external CLI account or prevent a write already dispatched. This feature assumes the trusted cooperating native process and configured CLI; it is not attestation against a hostile same-user process. Production deployment still needs tool/credential isolation, supported private-CLI auth, live scope/envelope verification and security review. A server comparison of guessed candidate IDs alone is not proof of CLI possession and must never authorize server-side access to another user's resources.

Still incomplete: single-login CLI provisioning, persistent/renewable enterprise sessions, raw coding-agent CLI credential brokerage, and actual automatic Wiki cloud-sync composition. This change enables the native desktop business path; it does not complete the overall product.
