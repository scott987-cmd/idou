# MCP connections — development desktop

**技能中心 → 连接器** supports reviewed, account-local MCP connections over stdio and Streamable HTTP (until 2026-09-23 they were under Settings). A connection can be explicitly bound to one new work/coding task. This is implemented task integration, not an enterprise MCP credential service or administrator policy system.

## Use

1. Open **技能中心 → 连接器** and, under **自定义连接器**, choose **从配置文件导入**. Import one connection JSON (regular file, maximum 32 KiB). The in-app confirmation displays its configuration and defaults to cancellation. Import does not start the server or call a model. The connection appears in the same list, marked 已添加.
2. From the row's **更多** menu, choose **检查连接** to start a fresh runtime and discover the explicitly selected tools. This makes no model request, but starts the configured local program or contacts the remote service. The check process closes afterward; success is a discovery snapshot, not continuous health monitoring.
3. Choose **用于新任务 → 新工作任务** or **新编程任务** on its row and confirm. Coding also requires choosing a workspace. Selection alone makes no model request.
4. Send a task. Each turn resolves the exact saved connection digest again and checks fresh Codex tool discovery before model dispatch. Each supported MCP tool approval offers **允许这一次** or **拒绝**, with the runtime's message and parameter details. No remembered grant is issued.
5. Removing (**更多 → 移除**) or replacing the connection requires confirmation and prevents old bound tasks from silently continuing with different settings. Create a new task after reconfiguration. Removal deletes only the saved connection, not tasks, installed programs or remote data. Configuration changes are blocked while tasks are active.

Example stdio descriptor; substitute an already installed, trusted executable and its actual tool names:

```json
{
  "id": "team-tools",
  "title": "团队工具",
  "transport": "stdio",
  "command": "/absolute/path/to/trusted-mcp-server",
  "args": [],
  "enabledTools": ["lookup"]
}
```

Example HTTP descriptor; this endpoint is a placeholder, not a provisioned service:

```json
{
  "id": "team-tools",
  "title": "团队工具",
  "transport": "http",
  "url": "https://mcp.example.com/mcp",
  "enabledTools": ["lookup"]
}
```

There are at most 16 saved connections and 1–32 unique explicitly enabled tools per connection. HTTP requires HTTPS, except HTTP on localhost/loopback; URL credentials, query strings and fragments are rejected. IDs are lowercase identifiers and cannot use the reserved `codex_apps` name. Unknown fields are rejected, including environment variables, custom headers and bearer-token configuration. There is no automatic package download/install workflow.

## Trust boundaries

- Only import a program/service you trust. A stdio server runs as the current OS user, outside the task's file sandbox; process startup itself may have effects. Per-tool confirmation does not sandbox the server. HTTP tools can disclose submitted data to their endpoint. Neither descriptor validation nor a read-only tool hint proves harmlessness.
- Configuration is stored locally as plaintext with owner-only file permissions on POSIX. **Never put secrets in arguments, paths or other text.** Field validation cannot recognize every secret hidden in arbitrary strings. Runtime configuration digests pin descriptor values, not executable/script bytes or remote server behavior.
- Account scoping is application-level separation, not protection from other processes running as the same OS user. There is no enterprise-controlled egress allowlist, DNS/redirect policy or global restriction on all tools discovered by Codex.
- The client accepts only the pinned runtime's recognized empty-form, per-tool approval request for the bound server/thread. Unsupported URL/data-collection/foreign/oversized requests fail closed. Stopping declines pending requests; resolved requests cannot subsequently be accepted. If the runtime supplies no argument details, the UI warns explicitly; refuse when details are necessary to make the decision.
- Tool results reach Codex and the model gateway/provider to continue the task. The gateway does not persist content, but Codex history can retain arguments/results. Removing a connection does not erase prior conversation context or reverse completed actions.
- This release does not accept client-side enterprise service keys. The implemented [server-side MCP broker](enterprise-mcp-broker.md) supports configured HTTP service credentials, tenant/App-ID/user/tool grants and short-lived client authorization. Fetch these descriptors with **获取企业 MCP** after confirmed Feishu login; arbitrary JSON cannot import an enterprise descriptor. Delegated user OAuth, resource ACL enforcement, durable policy/audit, automatic renewal and multiple task-bound servers remain open. Signed skills can declare specific tools from one saved connection; the user must explicitly select and confirm it, with its tool list narrowed for the skill task. See [dependency binding](enterprise-skills.md#explicit-mcp-dependency-binding). No automatic service installation is performed.

## Runtime and model adapter

No upstream fork or version pin changed. Each MCP task requires actual Codex 0.147.0. The adapter supplies process-level `mcp_servers`, explicit `enabled_tools` and `default_tools_approval_mode: "prompt"`. It inspects `mcpServerStatus/list` with `threadId` and `toolsAndAuthOnly` detail.

The actual pinned binary's generated schema returns `serverInfo` and `tools`, without the newer `runtimeStatus` field. A fresh process must complete handshake discovery and expose every selected tool; the implementation does not interpret `authStatus: "unsupported"` alone as failure or success. If a future response supplies runtime status, it must be connected. These checks require revalidation on any upstream upgrade. Protocol references: [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp) and [app-server](https://learn.chatgpt.com/docs/app-server).

Codex presents MCP tools in namespaces. The model gateway maps supported MCP function namespaces to stable, collision-checked flat function aliases, maps prior calls/tool choice consistently, and restores names/namespaces in returned function-call envelopes. Argument strings and tool results are not rewritten. SSE adaptation is incremental, bounded and abort-aware; malformed/truncated frames fail rather than reporting success. Unsupported tool definitions fail before provider dispatch. The same adapter runs whichever chat model the server is configured for: MiniMax-M3 by default, or GLM-5.3 through a loopback LiteLLM proxy (`IDOU_MODEL_PROVIDER=litellm`), whose responses the gateway rewrites back to the enforced model name before Codex reads them. It was verified live against actual MiniMax-M3 only; the GLM-5.3 round trip awaits its own live run. Neither is a claim of universal provider/schema compatibility.

## Verification

- `npm run check`: 127 tests across the repository. Ten added MCP/adapter tests cover strict configuration, account registry/stale references, discovery, approval/refusal, namespace/history mapping, JSON/SSE boundaries and upstream cancellation.
- `node scripts/smoke-mcp-desktop.js`: real Electron, actual Codex, actual local stdio and HTTP MCP servers. Native dialog answers and model replies are synthetic. Verifies cancelled import, discovery without a model request, allowlisting, zero tool executions after refusal, one approved execution per transport, tool results in model context and refusal after removal. Six fixture model requests, zero paid calls, no renderer errors.
- Explicit paid test: `MINIMAX_CONFIG_FILE=/absolute/server/mmx-config.json node scripts/smoke-mcp-live.js --live`. It uses an isolated workspace and a synthetic local echo server, accepts only the exact test call, and caps requests. The verified run made **two real MiniMax-M3 provider requests and one actual MCP echo call**; the result returned to the model and produced the final marker. No enterprise document or shell tool was used. This test-only approval guard is not a production auto-approval path.
- The paid smokes build their gateway from the server's own chat-model settings. With `IDOU_MODEL_PROVIDER=litellm` and `IDOU_LITELLM_KEY_FILE` (or `IDOU_LITELLM_API_KEY`) in place of the MiniMax setting, `smoke-mcp-live.js` and `smoke-mcp-remote-live.js` run against GLM-5.3 instead and raise their per-request output cap from 1024 to 8192 tokens: GLM-5.3 reasons before answering, and a response that runs out of tokens ends incomplete. No GLM-5.3 run has been recorded yet.
- The live run preceded the final MCP import-button/UI-only adjustment and test additions; gateway/runtime code was unchanged afterward. Final desktop fixtures cover the final source. Login, document and native-preview regressions and doctor also passed.

Screenshots `evidence/desktop-mcp-connections-fixture.png` and `evidence/desktop-mcp-approval-fixture.png` were visually inspected. All depicted identities/content are synthetic. Real enterprise MCP authorization, private Feishu CLI, production deployment and installer acceptance remain unverified.
