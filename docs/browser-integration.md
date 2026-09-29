# Built-in browser and Feishu surfaces

## Implemented development slice — 2026-09-08

The desktop serves task-owned static HTML through a tokenized loopback server and a separate native WebContentsView. The Agent conversation stays alongside the artifact; a completed turn reloads the selected file/preview. The renderer cannot supply arbitrary preview URLs, and the guest has no Node or desktop bridge. Preview bounds are confined to the artifact panel; switching task/section destroys the guest, including when navigation races with path validation.

Preview replacement waits for the previous guest's `destroyed` event and retains the closing view until that event; calling `close()` alone is not treated as completed destruction ([Electron lifecycle](https://www.electronjs.org/docs/latest/api/web-contents#contentscloseopts)). An explicit UI readiness state gates test inspection of the newly loaded guest. Two final offline desktop regressions passed five repeat refreshes each after correcting a reproduced teardown/inspection overlap; broader packaged and cross-platform stability is not established.

Feishu docx/wiki also has a CLI-backed text reader with source/revision and selected references beside the Agent. This is not an embedded Feishu rich editor. The optional [single-login bridge](feishu-cli-bridge.md) has actual bundled-CLI coverage against synthetic upstreams and avoids the developer Keychain; live SaaS reading is still unverified. See [document reader boundaries and fixture evidence](feishu-document-reader.md).

The **飞书消息** and **飞书文档** entries now show Feishu's own web pages in a native view, with the application's Agent docked beside them. The CLI-backed conversation reader and reply still exist as application operations (see [message reader, expiry and verification boundaries](feishu-chat.md)), but they are no longer what the section draws. The next section is what that embedding may and may not be trusted for.

## Embedded Feishu pages: whose they are

The pages keep their own Feishu web sign-in, in a browser partition per application account. That sign-in was never compared with the account signed in to the application, and the dock bound a page to an API chat by matching the name in the page's header. Both are now decided in the main process:

- **Web identity** (`src/application/web-identity.js`, server routes in [feishu-login.md](feishu-login.md)). A hidden view in the pages' partition follows the control plane's launch URL; Feishu's authorize page answers for whoever is signed in there; the control plane redeems the code and returns only `verified` or `conflict`. When Feishu passes straight through this is silent. When it shows a page, that page is revealed over the Feishu section for the person to act on — nothing clicks it for them. Asked when a Feishu section is warmed or opened, at most once every two minutes on its own, never again by itself after the person declined, and again whenever the pages' `session` cookie changes value (only a digest of it is kept).
- **The docked conversation** (`src/desktop/docked-chat.js`). A name matching exactly one of the account's chats (up to three pages of the list) is a **candidate**: its conversation is shown, but the Agent is not given the chat id and is told to ask. It becomes **bound** when the person confirms it or picks a chat from their own list. A confirmation is remembered (`feishu-chat-confirmations.json`, versioned) only when the pages were verified at the time, and used again only while they still are and the name still matches one chat. Two chats with the name are **ambiguous** and the person picks; a pick is kept for that page only. Pages signed in as someone else match nothing. A name the page stopped reporting for fifteen seconds is no name.
- **What the Agent is told** is composed in the main process at send time from the page's own report and the decision above. The renderer only says which dock it is standing beside; `bind-feishu-chat` no longer accepts a key from it.
- **Page events** count only from the page's own top frame on a Feishu origin, and are forgotten when the views are torn down or the pages sign in again.
- **Logging out** clears the pages' partition, as the settings page always said it did.

The Electron acceptance is `npm run test:web-identity-desktop` (synthetic Feishu inside the partition, real control plane over HTTP). The same check against a real account is part of `npm run test:feishu-dock-live`.

Local file references carry a SHA-256 revision and optional selection. Selection offsets are UTF-16 offsets into LF-normalized display text; the revision hashes original bytes. The main process resolves the reference inside the task workspace and reconstructs excerpts itself, with an 8000-character selection limit. Stale references fail before starting a model turn. A file reference without a selection attaches path/revision, not the whole file body. This is send-time freshness, not an atomic compare-and-swap on later Agent writes; diff/apply/undo remains unfinished.

The sections below describe the larger target. Two parts of it have since been built as bundled MCP servers rather than as browser-guest plumbing: the Agent's own browser diagnostics (`bin/mcp/browser.js` — navigate, read, click, type, console, screenshot), and its access to the task's own build output. For the latter the desktop starts one artifact server per coding task and hands that exact origin to the browser on argv; it is the single loopback address the browser's SSRF guard admits, so any other port on the same host — where the model gateway, the control plane and LiteLLM live — stays refused, and the model itself can never name a localhost target. Development-server lifecycle, Feishu browser login/components and online document editing are still not implemented.

## Decision

Use an isolated Chromium/WebView profile as a first-class client capability, but do not treat browser cookies as an API credential source.

For Coding, the browser opens localhost development servers and generated HTML. The Agent receives scoped navigation, screenshot, accessibility/DOM, console, and network diagnostics so it can verify output. Local server processes remain owned by the runner and are terminated with the task.

For Feishu documents, prefer the official cloud-document Web Component where the customer's edition supports it. It provides the closest in-app editing experience while Feishu remains the document system of record. Fall back to an authenticated Feishu page or an “Open in Feishu” deep link for unsupported document types.

For Feishu chat, build an API-driven chat surface over `lark-cli im` and event subscriptions. Embedding the full Feishu web chat is a fallback, not the integration contract: iframe policy, browser-cookie partitions, UI changes, and private-edition differences make browser automation too fragile for reliable read/send behavior.

## Login behavior

The available connected browser currently has no Feishu tab, so an existing Feishu web session could not be validated in this workspace. In the product, the embedded browser has its own cookie partition and should complete Feishu SSO explicitly. Never import or extract Chrome cookies. Product Agent authentication still uses the server-issued Feishu-backed session described in `control-plane.md`.

## Security boundaries

- Allow normal HTTPS navigation plus explicitly approved localhost ports.
- Block `file://`, arbitrary custom protocols, silent downloads, and cross-tenant popup reuse by default.
- Browser operations use the same approval and audit model as CLI/MCP tools.
- A page's text is untrusted content, never an instruction or permission grant.
- Document and message writes use OpenAPI/CLI when available, then refresh the embedded page from the authoritative result.
