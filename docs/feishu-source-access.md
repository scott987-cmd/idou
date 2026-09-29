# Server-side Feishu source-permission checks

This is an implemented prerequisite for independently authorized Wiki keys, not a key service or automatic-sync release. The optional SaaS authority now receives credentials directly from server-side OAuth, binds them to the successfully redeemed product session and checks document permission with that user's credential. It never accepts a Feishu token from the client, invokes the local CLI, or reads document bodies.

## Explicit configuration and consent

Set `FEISHU_SOURCE_ACCESS_ENABLED=1` **on the server** in `--feishu` mode to enable this feature. Omit it to retain identity-only login and no source-permission endpoint. Other values are rejected by the Feishu login configuration loader. No real environment or account was enabled during development.

The Feishu application administrator must first approve `docs:permission.member:auth`. Enabled login explicitly requests that scope in the authorization URL. The v3 token exchange also requests this narrowed scope, rather than retaining all historically granted permissions by default. The actual returned scope must contain it or the login fails. No document-content, write, chat or offline-access scope is requested by this feature. Existing tokens may have provider-dependent baseline identity scopes; the service nevertheless exposes only the fixed permission probe.

The service keeps at most 100 pending/bound credentials in memory. Pending credentials expire after at most five minutes; after signed login redemption, a credential is bound to the exact product parent-session ID, app, tenant and user, and capped by both Feishu expiry and the product's maximum 15-minute lifetime. An unrelated parent session, even for the same user/device, cannot borrow it. Child Wiki/skill/model-development tokens cannot access it.

With the separately enabled [bounded online renewal](feishu-login.md#optional-bounded-online-renewal), a successful live identity check and device-signed renewal may copy authority to the exact successor in the same session family. The copy has its own buffer/controller and remains capped by original Feishu expiry and the successor's short lifetime. Predecessor expiry removes only its own copy; explicit family logout removes all copies. Actual source reads still verify current identity and ACL; no permission is inferred from a renewed model session. Rotation does not renew Wiki scheduling permits or replay interrupted reads/writes.

The access token is held in a private server-owned Buffer; it is absent from flow identity objects, session records, client responses, renderer IPC and files. Refresh tokens are discarded. Denied/cancelled/expired flows drop their pending credential. Session revocation and server close abort in-flight probes and zero owned token buffers. Expired records are pruned on use and periodically. This is not encrypted persistent storage, refresh-session support, a KMS, guaranteed memory erasure, or protection against a compromised server process. Header strings and runtime/HTTP copies are not guaranteed to be wiped.

## Native protocol

`POST /v1/feishu/source-access` requires the exact authenticated Feishu parent Agent bearer token and JSON:

```json
{"sources":[{"resourceType":"docx","resourceId":"SyntheticDoc123"}]}
```

The request contains 1–20 unique resolved Docx resource IDs, at most 4096 bytes. Unknown fields, arbitrary URLs, other resource types, supplied credentials and requested actions are rejected. A Wiki URL must already be resolved to its actual Docx resource by the appropriate trusted workflow; this endpoint does not reinterpret Wiki node tokens. The scheduled-task resolver on the same authority (`resolveScheduleResources`) is one such workflow: it reads the node as the person, pins whichever document, spreadsheet or Base it carries, and proves that exact resource readable with the probe type matching its kind before any authorization is stored. The list is copied and ASCII-sorted for an exact canonical digest.

The authority rechecks the live Feishu `user_info` identity against the original OAuth app/user/tenant binding. It then calls the fixed SaaS permission endpoint with `type=docx&action=view` for every resource. Only numeric `code: 0` and boolean `auth_result: true` count as success. A denial, malformed result, timeout, changed identity, expired/revoked parent or failure on any later source rejects the whole request. Every request probes upstream again; there is no positive-permission cache.

Successful output contains only `authorized: true`, `pointInTime: true`, `sourceSetHash`, `checkedAt` and the product's app/tenant/user/device identity. It is explicitly a point-in-time result, not a reusable permission token or permission lease. Errors contain bounded generic codes, not upstream messages or credentials. Responses are `no-store`; browser Origin requests are rejected. The native `FeishuSourceAccessClient` validates the returned source digest and metadata, rejects a changed connection/session after the request and strips unspecified response fields.

One check may run per parent, with four concurrent checks per authority instance. Before any upstream request, the full requested batch reserves from a local sliding-window ceiling of 100 source checks/minute, matching the documented permission endpoint ceiling. Failure does not refund reservations. Requests are bounded to 12 seconds, prohibit redirects and cap upstream JSON at 64 KiB. These are single-process controls; replicas sharing one Feishu app need shared limiting, and other services using that app can still consume the upstream quota. No automatic retry occurs.

## What this does not authorize

- It does not prove that the caller-provided list is the complete source list inside a ciphertext. A trusted immutable package/source registry must establish that before any key is released.
- It checks `view`, not copy/export, downstream model processing, synchronization permission or enterprise data-governance policy.
- It does not map the bundled CLI identity to OAuth, import a token into the CLI, reuse browser cookies, open business IPC or bypass the current enterprise login/CLI gate.
- It does not implement the scheduler's source/folder/device policy grant, package key custody/delivery, recipient automatic retrieval or ACL/deletion propagation. There is no production key or scheduler enablement in this increment.
- A later key service must check every authoritative source, handle the batch bound and concurrent changes conservatively, and bind the result to the exact generation/recipient. No set of point-in-time calls is an atomic transaction with later Feishu ACL changes.

## Evidence

`test/feishu-source-access.test.js` adds 14 tests using the actual OAuth provider, signed login client/service, session registry, native permission client and local HTTP routing with synthetic upstream responses. It covers all-source denial, no success cache, scope opt-in/narrowing, no token serialization, tenant/user/parent isolation, cancellation/expiry/revocation, final-await logout, input bounds, fixed read-only paths, redirects/oversized/errors, concurrency/rate budgets and native response substitution. One test launches the actual `bin/server.js --feishu` in a child process with only synthetic credentials and an intercepted upstream fetch; it verifies enablement, login, check and logout through real server routing.

An isolated module-loader mutation removed the strict `auth_result` check; the later-source denial test failed with HTTP 200 instead of 403. The production source was not modified. The unmodified test passed afterwards. Default identity-only login and Electron account/skill/CLI-gate regressions also passed. This is not live OAuth, live document permission, private Feishu, installer/deployment or a production security audit.

## Official API references

- [Current-user document permission](https://open.feishu.cn/document/server-docs/docs/permission/permission-member/auth): fixed GET endpoint, permission scope, boolean result and 100/minute limit.
- [OAuth authorization](https://open.feishu.cn/document/authentication-management/access-token/obtain-oauth-code): explicit incremental scopes and administrator approval.
- [v3 token exchange](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/get-user-access-token-v3): scope narrowing and authoritative returned scopes.
- [Authenticated user information](https://open.feishu.cn/document/server-docs/authentication-management/login-state-management/get): user identity is verified upstream, never accepted from client metadata.

CLI 1.0.78's embedded Drive/shared skills and `drive.permission.members.auth` schema were also inspected. No account/auth/content command was run. The official documentation index could not be opened by the web reader because of its Markdown content type; the same official Markdown documents were retrieved directly over HTTPS for inspection.
