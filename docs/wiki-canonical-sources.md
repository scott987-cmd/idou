# Shared Feishu Wiki source representation

The optional canonical Wiki reader uses the same documented source APIs and the same formatter on the native CLI path and the server OAuth path. Document display/editing continues to use XML. No existing customer configuration is changed automatically.

## Enabling the two readers

Native `.idou.json`: set `feishu.wikiOrigin` to the exact enterprise origin, for example `https://your-tenant.feishu.cn` (no trailing slash). Omitted/null keeps the previous XML-based local Wiki provider. When configured, desktop `LocalWiki` uses `SaasWikiSourceReader`; the document task/editor retains the original provider. The local CLI must already have user read access. This option does not log in the CLI, request permissions, bypass enterprise SSO linkage or enable Drive synchronization.

Server: retain `FEISHU_SOURCE_ACCESS_ENABLED=1` and explicitly set `FEISHU_WIKI_ORIGINAL_ORIGINS` to JSON such as `{"tenant_key":"https://your-tenant.feishu.cn"}`. Only configured, allowlisted tenants are accepted, at most 100. This adds `docx:document:readonly` to the existing permission-check scope in both the OAuth consent URL and token exchange. Both scopes must actually be granted. It changes the configured application's consent request, not only the requests of an already-known tenant; tenant identity is established after OAuth. Omitted origins keep the existing permission-only behavior; default login with source access disabled remains identity-only. No deployed environment or live authorization was changed by this increment.

`FeishuSourceAccess.readOriginal(parentToken, registeredSource, {signal})` is an internal server method, not an HTTP content endpoint. It uses only the existing short-lived server-held OAuth credential and checks the current upstream identity. The source must be registered-format metadata for the same SaaS tenant. The method returns a subject-bound source snapshot to the server verifier; it exposes no token or token-import mechanism. The production payload verifier still needs real artifact reading/key custody and service wiring.

## Representation and reads

The shared `readWikiDocx` operation performs:

1. `GET /open-apis/docx/v1/documents/:document_id` for resource ID, title and revision.
2. `GET /open-apis/docx/v1/documents/:document_id/raw_content?lang=0` for the exact plain-text projection.
3. The metadata GET again; changed revision or title rejects the read.

These are the official [document metadata](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document/get.md) and [plain-text](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document/raw_content.md) APIs, inspected on 2026-09-09. Both document read scopes and actual resource access are required; the implementation requests the read-only scope, not edit access. The CLI adapter uses the pinned absolute bundled binary's `api GET` command with `--as user` and JSON query parameters; the server uses fixed `open.feishu.cn` URLs with redirects rejected. No endpoint is taken from source text or a package URL.

The formatter preserves text bytes at the JS UTF-8 serialization boundary, including spaces and trailing newlines. It rejects empty/over-500,000-character/NUL text, invalid metadata and changed versions. The SHA-256 input is JSON `["feishu-docx-plain-v1", resourceId, revisionString, title, text]`; the format namespace prevents old XML hashes being treated as equivalent. A source URL is always the configured origin plus `/docx/<resourceId>`. Full Wiki references are resolved through the existing CLI document reader and verified identity before canonicalization; partial/anchored reads and foreign origins are not promoted into full-source knowledge pages.

This is the document's **plain-text projection**, not a lossless representation of images, attachments, tables/Base internals or every resource. Stored/read results carry that warning. Metadata bracketing detects observed changes; it is not an upstream transaction or a pinned snapshot API. Mention names and other upstream projection changes can differ despite a stable document revision; exact content hashing/comparison then rejects an old package. Nothing strips differences to force verification to pass.

## Migration and limits

Existing encrypted pages remain readable in storage; no mass rewrite or automatic model run occurs. Once the configured canonical provider rereads a source during observation/search/export, new text/hash/chunks are derived. Old synthesis keys no longer match and old citations are not reused. Search-driven refresh is demonstrated across encrypted restart. Old published XML-based bundles will not pass comparison to canonical originals; they are not silently re-labelled or re-encrypted. Coordinated producer/recipient deployment and republishing under new versions remain an operational requirement. Switching the setting back may similarly invalidate canonical synthesis; it does not repair historical bundle provenance.

Server original reads share the existing per-session single-flight and four-operation concurrency bound, use a 12-second deadline, and reserve at most two source reads per local one-second window (each entails two metadata requests and one text request). The two API endpoints document per-app limits; other processes/callers and long reads can still trigger upstream throttling. There is no distributed limiter, retry queue or automatic retry. Large bundles need deliberate pacing/batching before production enablement. CLI identity is independently rechecked around awaits; the extra subprocess/API cost is not yet production-load tested.

New reads hold bodies only transiently on the server, with a 2 MiB response bound; local pages remain encrypted. Deployment must still prevent body logging, crash-dump/swap retention and unauthorized model processing. Canonical source consistency does not certify free-form synthesis, authorize content-key delivery or supply export/synchronization policy.

## Verification

Eight new tests cover identical native/server representations with separate synthetic CLI and HTTP transports; preservation of editor XML; exact whitespace and metadata races; identity/domain/partial/Wiki remapping controls; explicit scopes/origin configuration; upstream failures and revocation; automatic canonical observation → encrypted local export → actual AES-GCM bundle → server original-reader verification; encrypted legacy refresh without old citations/model calls; and cancellation without persistence. The integration uses the actual verifier/readers/codec/local Wiki but a synthetic coordinator and key custodian; real SQLite coordinator behavior has separate tests.

The native adapter uses the actual pinned-binary resolution path with a synthetic process runner, not a live CLI response. Real SaaS response-envelope, canonical-link behavior, distributed rate limits and private CLI parity remain unverified. An isolated loader mutation disabled metadata revision/title comparison; its regression test failed. Normal tests pass, with no production source mutation. Default Electron Wiki regression passes separately; it does not exercise the configured canonical provider inside Electron. No real document, account or model call was used.
