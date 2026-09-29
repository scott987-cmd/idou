# Enterprise MCP broker — implemented development path

The Feishu-login control plane can now expose administrator-configured HTTP MCP tools through a credential broker. Users fetch allowed connections in desktop settings, confirm a local reference and use it in a standalone or signed-skill task. Upstream service credentials stay on the server. The native runtime receives a short-lived, connection/tool-scoped bearer token instead, without placing it in renderer IPC, task records or command arguments.

This is an authenticated **tools broker**, not a transparent MCP relay, general OAuth authorization server, document-permission engine or production deployment. It does not forward prompts, resources, sampling, roots, tasks, upstream elicitation or unsolicited upstream notifications. The normal manual stdio/HTTP connection path remains available independently.

## Server setup

Use the existing `node bin/server.js --feishu` mode and [Feishu OAuth configuration](feishu-login.md). The development-token mode does not expose this service. Install the lockfile dependencies with `npm ci`; the implementation pins the official `@modelcontextprotocol/sdk` at `1.30.0`.

Set server-only `IDOU_MCP_CONFIG_FILE` to an absolute regular JSON file (maximum 1 MiB). Example, with placeholder identity/endpoint values:

```json
{
  "schemaVersion": 1,
  "revision": 1,
  "connections": [
    {
      "id": "team-tools",
      "title": "团队业务工具",
      "url": "https://mcp.internal.example/mcp",
      "tokenEnv": "TEAM_MCP_SERVICE_TOKEN",
      "grants": [
        {
          "tenantId": "replace_with_tenant_key",
          "appId": "cli_replace_with_login_app_id",
          "userIds": ["replace_with_open_id_for_this_app"],
          "enabledTools": ["lookup"]
        }
      ]
    }
  ]
}
```

Provision the referenced environment variable through the **server's** secret manager/environment. Never put its value in the JSON, client configuration, a skill, a URL or a chat message. The broker uses that value as an upstream bearer credential; credential names/values and upstream URLs are not distributed to clients. Unknown configuration fields, missing credentials, duplicate connection IDs/grants and unsafe URLs fail startup with a generic error.

Each tenant/App-ID grant has an explicit user list. `"userIds": ["*"]` deliberately grants all users of that one tenant and login App ID; it cannot be mixed with individual IDs. User IDs are scoped to the configured login application, not interchangeable `open_id` values from a different Feishu App ID. Each connection has at most 100 grants; the catalog at most 100 connections; each grant at most 1000 users and 1–32 named tools. There is no wildcard tool grant.

Configuration loads at startup. Change it under administrator control, increment `revision` and restart; there is no hot-update or administration UI. Process restart invalidates the in-memory login/child sessions. A digest binds the connection URL/title, revision and tenant/app/user/tool grant. Rotating a credential also requires restart. Use TLS for remote access; only literal loopback/localhost HTTP endpoints are accepted for development. The server still listens on loopback behind the separately configured TLS reverse proxy.

## Desktop use

1. Log in through Feishu and explicitly confirm the identity. Open **技能中心 → 连接器**: the connections opened to this account are listed under **企业连接器** as soon as the page opens (a server without `IDOU_MCP_CONFIG_FILE` offers none, and the section is not shown). The control plane filters by its authenticated tenant, App ID and user; the client checks the returned identity and rejects revision rollback within its current instance.
2. Choose **添加** on the connection's row. The in-app confirmation identifies the connection, policy digest and allowed tools, defaults to cancellation and explains the data path. It fetches again after confirmation. Only an `enterprise` descriptor is saved locally; users cannot import this descriptor type through arbitrary local JSON.
3. Check the connection (**更多 → 检查连接**) or explicitly use it in a new work/coding task (**用于新任务**). A connection the server no longer lists shows **管理员已收回**; one whose grant changed shows **授权有变化** with **更新**. A check connects and reads tool definitions but calls no model or tool. Each execution freshly checks server policy and acquires a separate short-lived token. The existing per-call MCP prompt remains required.
4. A signed skill can select the saved connection using [explicit dependency labels](enterprise-skills.md#explicit-mcp-dependency-binding), such as `mcp:team-tools:lookup`. The broker token is narrowed to the skill's declared tools, not all tools in the saved connection. The broker independently enforces this list on both discovery and actual calls; bypassing renderer filtering does not broaden it.
5. Normal stop/completion/probe cleanup revokes the token. A cleanup failure produces a task warning rather than claiming confirmed revocation. Removing a local connection does not remove the server policy or remote service. User logout revokes all child authorizations.

## Authorization and session boundaries

- `POST /v1/mcp-connections` and `POST /auth/mcp-token` require a verified Feishu **model-audience parent** session, not a development or skill token. The latter accepts only `{id, policyDigest, enabledTools}`; no caller-supplied URL, tenant override or credential.
- The issued token has audience `mcp-broker`, one connection ID, the policy digest and a fixed tool subset. It expires within five minutes and never outlives its parent. At most six MCP leases coexist per parent. Refreshing the separate skill token does not revoke MCP tokens. An MCP token cannot call models or issue further children.
- MCP requests use `/v1/mcp/<id>`. Every HTTP request is authenticated and checked against the current server policy. A token for another connection, tenant or parent session cannot access an existing protocol session. The server rejects browser Origin requests and unsupported methods, oversized/invalid JSON and unsupported MCP operations.
- A token is an authorization, **not** a protocol session ID. Codex uses separate MCP clients for task execution and tool discovery. The broker allows four isolated protocol sessions per lease (32 total), each with its own SDK server, upstream client and random session ID. Closing one protocol session does not revoke its sibling; revoking the lease closes all of them. This distinction was demonstrated by a failing two-client regression and verified with actual Codex.
- The SDK terminates Streamable HTTP independently on each side, supporting JSON and SSE upstream responses. Client tokens are never passed upstream. The configured service credential is inserted only for the exact configured URL, with redirect following disabled. Authentication failure does not auto-enroll, refresh OAuth or retry a tool call.
- Upstream errors are replaced with a generic failure that warns completion may be unknown. Result payloads containing an exact known service credential or the current child token are rejected; this is not a general DLP classifier and cannot detect arbitrary transformed/encoded leaks from a malicious upstream.
- Requests/results are transient memory only: no content audit logs, event replay store or disk cache is enabled. SDK traffic is bounded (1 MiB inbound/tool result, 4 MiB per upstream HTTP stream, ten discovery pages/1000 tool definitions, two simultaneous calls per protocol session). Request rate is bounded per parent bucket; these are development limits, not enterprise billing quotas.
- Cancellation/logout/expiry attempt to abort in-flight upstream work and discard late results. A remote write may already have happened; there is no rollback or exactly-once promise. Upstream session DELETE is attempted during cleanup with a short deadline, then local transports close. Remote servers remain responsible for their own abandoned-session TTLs.

## Security limits and unfinished delivery

**Tool authorization is not source-data authorization.** The broker currently authenticates to each upstream with an administrator-provisioned service credential. It does not automatically impersonate the Feishu user or evaluate document/row ACLs from tool arguments. Use a dedicated, least-privileged, tenant-appropriate endpoint/account. Do not expose a broad cross-tenant search credential and assume that a tool-name allowlist filters its data. Delegated user OAuth, resource-level policy contracts and per-call resource authorization remain required before such endpoints can serve sensitive enterprise data.

The native client necessarily holds short-lived bearer credentials. The MCP token is supplied only in the Codex process environment using `bearer_token_env_var`, not the configured shell environment or renderer. Same-OS-user process inspection, memory dumps or unrestricted local tools can still steal a short-lived token; this is not hardware binding or a process-security boundary. No automatic renewal is performed during a long turn; expired authorization must not silently expand or replay work. Failed/ambiguous lease issuance can consume a slot until expiry.

The broker accepts only administrator-configured destinations, but does not implement DNS pinning or enterprise network egress controls. Those remain deployment responsibilities. This release has no distributed session store, persistent policy/audit service, role/group synchronization, administrator UI, OAuth discovery/DCR/consent for arbitrary upstream services or production HA/security acceptance. The current token exchange is a private control-plane contract, not a claim to implement every MCP OAuth requirement.

Protocol basis: [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [MCP authorization and separate upstream tokens](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), and [Codex HTTP bearer-token configuration](https://learn.chatgpt.com/docs/extend/mcp). Compatibility was verified with pinned Codex 0.147.0 and SDK 1.30.0, not every later protocol revision.

## Verification

`npm run check` includes 14 added tests: independent/scoped token lifetime and revocation, tenant/app/user isolation, safe configuration and endpoint selection, actual authenticated JSON/SSE tool calls, audience/resource restrictions, tool filtering, error/credential-echo suppression, multiple protocol sessions and foreign-session refusal, request bounds, in-flight logout, stale policy/account detection, native lease validation/cleanup and persisted cleanup warnings.

`node scripts/smoke-skill-mcp-desktop.js --enterprise` runs actual Electron, signed skill catalog, actual Codex, the real broker and a credential-protected local HTTP MCP upstream. Login identities, model responses and credentials are synthetic. It checks the settings import/probe, explicit skill binding, confirmation cancellation/races, denied call count zero, one approved echo result in model context, task/connection withdrawal, lease cleanup and absence of test service/scoped credentials in renderer state and isolated app-data files. Four fixture model requests, zero paid calls. No real enterprise credentials, Feishu content or MiniMax provider request is used. Screenshots were visually inspected.
