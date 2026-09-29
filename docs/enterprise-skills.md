# Enterprise skill center — signed catalog, review and task use

The desktop's standalone **技能中心** has separate **企业技能** and **内置飞书技能** sections. The enterprise section retrieves a tenant-authorized, signed catalog, previews verified text files and can bind a confirmed release to a new task. Each turn loads that release into its own Codex process using temporary files. It does not install global skills, upload or publish releases. Embedded Feishu skill instructions still come directly from the pinned CLI and are not copied into this catalog.

## Configuration

Use the existing Feishu OAuth server mode with these additional **server-only** environment variables:

| Variable | Required value |
| --- | --- |
| `IDOU_SKILL_CATALOG_FILE` | Absolute path to a regular JSON catalog file, maximum 8 MiB. |
| `IDOU_SKILL_SIGNING_KEY_FILE` | Absolute path to an Ed25519 private signing key in PEM format, maximum 8 KiB. On POSIX, only the owning server user may read/write it (0600). |

Both must be configured together. If neither is configured, the existing login/model server starts without skill endpoints. Invalid or incomplete signing configuration fails startup without printing file contents or key material. This increment loads the catalog at server startup; editing the file requires a controlled server restart and new user login. There is no remote publishing endpoint or hot-reload promise.

On the **desktop**, set `IDOU_SKILL_PUBLIC_KEY_FILE` to an administrator-provisioned absolute public-key PEM file, or set `skillCenter.publicKeyFile` in the desktop configuration. This must contain `BEGIN PUBLIC KEY`, never a private key. The client does not accept a replacement trust key from the catalog response. Missing/invalid trust configuration blocks enterprise retrieval, without disabling embedded CLI skill discovery. Key rotation currently requires coordinated administrator configuration; there is no automated trust-on-first-use or rotation protocol.

After Feishu login and identity confirmation, open **技能中心 → 刷新企业技能**. Each card shows publisher, version, declared tools and version-compatibility metadata. **核验并预览内容** fetches and validates a fresh catalog before showing text. The preview does not render Markdown/HTML or run scripts. Required tools are declarations, not granted permissions. Compatibility compares declared exact versions to the application's upstream lockfile, not a runtime execution certification.

## Server catalog format

The top-level format is:

```json
{
  "schemaVersion": 1,
  "revision": 1,
  "tenants": [
    { "tenantId": "replace_with_an_allowed_tenant_key", "skills": [] }
  ]
}
```

Each skill requires exactly these fields:

| Field | Meaning / development limits |
| --- | --- |
| `id` | Product enterprise ID starting with `enterprise-`; cannot replace a bundled `lark-*` skill. One visible release per ID per catalog. |
| `version` | Three numeric components such as `1.0.0`; prerelease/range syntax is not implemented. |
| `title`, `description`, `publisher` | Nonempty display text, limited to 160 / 600 / 120 UTF-16 code units. |
| `requiredTools` | Up to 16 distinct tool/capability labels. Executable admission supports `cli:local-files` and explicitly confirmed `mcp:connection-id:toolName`; other declarations remain preview-only. A declaration is not an automatic grant. |
| `runtimeVersions` | Object with `codex` and `feishu` arrays of exact versions; an empty array declares no version restriction. |
| `files` | 1–16 `{ "path": "...", "text": "..." }` records, including exact `SKILL.md`. Text only; no binary archive. |

File paths reject absolute paths, traversal, backslashes, URLs and case-insensitive duplicates. Allowed text extensions are `.md`, `.txt`, `.json`, `.js`, `.py`, `.sh`; inclusion alone does not grant execution authority. Each file is at most 65536 UTF-16 code units; all file contents in one skill total at most 128 KiB UTF-8. The catalog allows at most 100 tenants and 100 skills per tenant; each signed response payload is capped at 1 MiB including metadata. Catalog validation checks `SKILL.md` presence; actual task use additionally requires Codex to discover its frontmatter name as the exact enterprise ID. Full reference completeness and behavior are not certified by discovery.

`scripts/fixtures/skill-catalog.js` is a synthetic test fixture, not an installed or published corporate skill. It contains deliberately inert script-like text to verify safe preview behavior.

## Authorization and integrity

1. The native client exchanges its confirmed Feishu Agent token at `POST /auth/skills-token` with an empty JSON object. Development sessions are not eligible. Tenant availability is selected by server-held session identity, never a caller-supplied tenant parameter.
2. The server issues a separate `skill-center` audience / `skills:read` bearer token, valid for at most five minutes and no longer than its parent. One derivative is retained per parent; reissue invalidates the prior derivative. Parent logout/revocation/expiry also invalidates the derivative. The derivative cannot call the model gateway or login-session endpoints, and cannot exchange for further derivatives.
3. `POST /v1/skills/catalog` requires that derivative and exactly one client-generated random `nonce`. The model token cannot be used directly on this endpoint. Browser-origin requests, extra tenant selectors, unsupported methods, compressed/oversized JSON and unauthorized sessions are rejected. Exchanges and reads are rate-limited in memory per parent/route bucket.
4. The server signs the exact payload bytes using domain-separated Ed25519. The payload includes schema/revision, server origin, tenant, Feishu App ID, request nonce, issue/expiry times and the selected tenant's skill contents. Responses are not cacheable and expire within 60 seconds.
5. The native client checks the pinned key, signature, nonce, origin, tenant/App ID, expiry, schema and content limits, then rechecks the active login binding. Lower catalog revisions are rejected within that account-scope client instance. Renderer IPC receives list metadata or explicitly selected text, never tokens or private signing keys.
6. Opening a card fetches again and requires the same ID, version and SHA-256 digest of normalized skill metadata/files. A withdrawn or changed release cannot be opened from that old card. Previously viewed information cannot be remotely erased from a user's memory or screenshot.

Signing proves integrity and possession of the configured signing key, not that a publisher is trustworthy, content is harmless, tool access is authorized or the code will work. Authorized skill preview necessarily delivers that skill content to the client; secrets must never be embedded in skill text. Confidential executable logic would need a separately authorized server execution service.

## Remaining delivery

Manually reviewed [MCP connections](mcp-connections.md) can now be explicitly bound to a signed skill as described below. This is user-confirmed account-local binding, not administrator-distributed connection policy or server-side MCP authentication.

This is not a full software distribution/update security system. Durable release immutability/history, rollback protection across restarts, key revocation/rotation, role-based author/reviewer/publisher workflow, staged rollout, persistent installation/atomic activation, removal from already-running tasks, fine-grained tool authority, delegated-user/resource policy services, audit persistence and automated compatibility testing across upstream versions remain required. The administrator-controlled startup catalog is not a substitute for the planned publishing service. No live enterprise catalog, private CLI or production installer is claimed.

## Confirmed task use

1. Choose **用于新工作任务** or **用于新编程任务**. A fresh read verifies the selected release, then a native confirmation shows publisher, tools, version and digest, with cancellation selected by default. Coding tasks also require a directory picker. Cancelling either step creates no task and makes no model request.
2. After confirmation, the client re-reads the release before creating a task. Its ID/version/digest and confirmation time are persisted as a fixed binding; selection alone does not send a prompt. Changing versions requires a new task, not a silent upgrade.
3. Each send fetches that exact signed release again. Unavailable, changed or incompatible releases fail before message persistence and runtime startup. A private per-turn temporary directory holds the declared files; nothing is installed into the user's global skill directory.
4. The selected Codex binary must report the lockfile version (currently 0.147.0). The client registers process-local extra roots, refreshes discovery and requires one enabled skill with the exact canonical path and enterprise name, without declared dependency tools. It revalidates the signed release and temporary bytes again immediately before starting the model turn. Refusal at this later stage leaves a failed task record, without dispatching a model turn.
5. The task passes both the explicit skill input and its name marker, retaining the mode's existing sandbox and approval policy. Runtime shutdown precedes temporary-file cleanup. Task/message metadata retains the version and digest, while Codex conversation history can retain the injected instructions.

The current usable subset declares no tools, `cli:local-files`, and/or specific tools from one explicitly confirmed MCP connection. Other declarations and a root `SKILL.json` are rejected until their authority/dependency flows are implemented. **This admission check is not a tool-enforcement sandbox:** the bound MCP server is tool-filtered, but skill instructions and scripts can request other capabilities otherwise available to the task. Existing shell permissions still govern execution; repository/global skill discovery is not disabled. Signatures do not establish harmlessness or prevent prompt injection.

### Explicit MCP dependency binding

For example, a signed catalog bundle may declare `"requiredTools": ["mcp:team-tools:lookup"]`. This is a i豆 catalog contract, **not** a new upstream `SKILL.md`/`SKILL.json` syntax. Connection IDs are case-sensitive lowercase identifiers; tool names are case-sensitive MCP names (up to 100 characters). Wildcards, the reserved `codex_apps` connection and requirements spanning multiple servers are not executable in this release. The existing maximum of 16 declarations applies. Do not put endpoints, commands or credentials in dependency labels.

1. An administrator/user first imports the trusted connection through settings. In the skill card, **检查可用连接** freshly verifies the signed release and lists account-local connections with the exact required ID and all required enabled tools. This checks configuration only: it does not start an MCP process, contact its endpoint or call a model. A missing match explains how to configure one; no service is installed or silently selected.
2. Explicitly select the connection, then choose a new work/coding task. The main process independently validates the selection; renderer filtering is not the authority. Native confirmation displays the skill digest, complete connection descriptor, original connection digest, narrowed tool list and process/data-exposure warning. Cancelling creates no task. Revalidation after confirmation/workspace choice rejects a changed or removed connection or release.
3. The task persists the exact skill release reference and original connection digest, plus the displayed allowed tool names. Every send resolves both again before appending a user message. Only the intersection permitted by the connection and **required by the skill** is supplied to the task runtime; an unrelated connection or an added connection for a skill without MCP requirements is rejected.
4. The verified skill lease carries that narrowed runtime configuration; it is not stored as a new global connection or installed configuration. After runtime startup/discovery, the original connection digest and signed skill release are checked again immediately before model dispatch. Unavailable tools stop dispatch. Skill-only dependency sidecars remain rejected rather than triggering automatic upstream setup.
5. Actual tool execution still requires the existing per-call MCP confirmation. Stdio process startup is outside the task file sandbox and can itself have effects; authorizing the tool is not authorizing only a safe process. Remote tools receive parameters/results under the connection's normal trust boundaries. Revocation is checked between turns, not continuously during a running tool, and cannot erase prior history.

Manual connection descriptors are user-reviewed local configuration; a signed label does not certify the executable or remote endpoint behind that ID. Descriptor digests do not hash program bytes. The implemented [enterprise MCP broker](enterprise-mcp-broker.md) additionally supports server-configured service credentials and tenant/app/user/tool grants; an imported enterprise connection can be bound through this same skill flow. Delegated user/resource authorization, durable administrator policy management, multiple selected servers and automatic dependency installation remain required separately.

Temporary files use owner-only directories and read-only owner file modes on POSIX, not encryption or protection from other processes running as that OS user. Integrity is checked before dispatch, not continuously or atomically through all later Agent reads. Abrupt process/machine failure can leave temporary files; crash scavenging and Windows ACL hardening remain open. Revocation is checked before each turn, not continuously during an active turn; it cannot erase previous conversation history. Starting a new task is necessary when old skill instructions must not remain in the conversation.

Protocol basis: [official Codex app-server documentation](https://learn.chatgpt.com/docs/app-server#skills) describes explicit skill input and nonpersistent process-level extra roots. The inspected lockfile commit `553df1c691fe8bf7747e50da22f1342984495ae0` and actual 0.147.0 runtime support `skills/extraRoots/set {extraRoots}` followed by `skills/list {cwds, forceReload}`. The newer documentation's `perCwdExtraUserRoots` field is absent from this pinned version's `SkillsListParams`; this adapter does not send it.

## Verification

`npm run check` includes ten enterprise-skill tests: tenant/audience isolation, parent revocation and expiry, bounded derivative issuance, signature tampering/foreign keys/replay/identity/expiry, bad paths/private verification keys, changed/withdrawn content, revision rollback, account-switch races, oversized/error responses, rate limits and server file configuration.

Five task-skill tests additionally cover temporary-file integrity/cleanup, invalid digests/symlinks, unsupported tools/sidecars, exact runtime discovery and cancellation/revalidation. Four task-service tests cover preparation refusal, stopping during preparation, discovery failure and withdrawal after runtime startup, including no model dispatch and shutdown-before-file-cleanup.

`node scripts/smoke-task-skill.js` runs actual Codex 0.147.0 and verifies that a marker present only in skill instructions reaches the actual model request; it also checks temporary cleanup and withdrawn continuation refusal. The model response is a local synthetic SSE fixture, not LLM-generated work.

The explicit-dependency increment adds four tests covering declaration syntax/limits, exact server/tool matching, narrowing without mutating the saved connection, foreign/stale connections, revalidation after startup and passing the confirmed binding/narrowed lease through task execution without persisting temporary configuration. `node scripts/smoke-skill-mcp-desktop.js` uses real Electron, signed HTTP catalog, actual Codex and an actual stdio MCP server. It verifies no automatic selection, cancellation, connection removal during native confirmation, a wider saved tool list narrowed at the actual model request, denied calls not executing, one approved echo result returned to model context, and connection/skill withdrawal before message persistence. Four synthetic model responses, zero paid requests; no real Feishu login or enterprise content. Screenshots in `evidence/desktop-skill-mcp-*-fixture.png` were visually inspected.

`node scripts/smoke-login-desktop.js` exercises the signed catalog through real Electron and local HTTP OAuth/gateway routing using synthetic identities, keys and upstreams. It checks tenant filtering, plain-text preview, cancellation of native confirmation/directory selection, confirmed task creation, actual Codex skill injection and refusal after withdrawal. Dialog answers are test-controlled; no human system-dialog acceptance is claimed. Existing account-isolation/logout checks remain. No fixture is imported by production entry points, no real Feishu consent or enterprise data is used, and no paid model call or global skill installation occurs. The skill-use increment had 117 passing tests.
