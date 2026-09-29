# Background document discovery from selected chats

## Implemented user path

In **飞书消息**, read a conversation and choose **自动整理此会话文档**. A native confirmation identifies the chat ID, CLI tenant/principal, background read scope, local storage and possible model transfer. Cancel adds nothing. After confirmation, the native worker runs without requiring a document click or creating a work task. Navigate to **企业知识库** to see progress, search freshly authorized sources or **停止自动整理**. Application section changes do not stop the worker; renderer reload/crash, connection/account change, exit and permission lifetime expiration do.

This is a user-selected, per-startup development scope, not administrator deployment policy or automatic enterprise-wide subscription. Application login authorizes bundled-CLI reads only when the server explicitly advertises the [read-only bridge](feishu-cli-bridge.md); otherwise enterprise business operations remain rejected until the fallback identity linkage exists. Live SaaS acceptance is still pending.

## Discovery and source authority

`MessageDiscovery` owns the native timer, single-flight scan, immutable confirmed identity, selected chat IDs and a bounded in-memory fairness map. It uses the provider's chat reader, not browser cookies, DOM scraping, enterprise search or message text as executable Agent instructions.

Each scan asks for the recent 24-hour message window and follows at most three pages per selected chat. The pinned CLI may also expand thread replies; partial/error signals remain incomplete coverage, not a full-discussion claim. Only supported document URLs already extracted by the provider become candidates. Message bodies are discarded after each scan and never persisted in the task store, Wiki, model request or control plane. URLs/IDs required for the active scan and selection metadata remain in process memory until stop/expiry.

Before each document, the worker re-fetches the exact source message. It then performs an independently user-authorized document read and re-fetches the message again before enqueueing the source. Recalled/edited/inaccessible messages cannot contribute their old link. Anchored URLs are skipped rather than promoted to a full read; partial provider results are also excluded. Canonical source tenant/principal/resource/revision/hash/ACL evidence enters the existing encrypted local Wiki pipeline. Only the document, not its chat commentary, contributes facts and citations.

Queries continue to re-read current source permissions/content. A removed message stops future discovery from that link but does not revoke separately authorized document access or delete an already collected document automatically. A document read failure is skipped; stale derived sources remain governed by the normal query-time eviction and source reauthorization. Message/document checks are sequential, not an atomic transaction or instantaneous revocation subscription.

## Bounds and lifecycle

- Maximum five explicitly selected chats, three pages/chat/scan, 200 unique candidate URLs and five attempted documents/scan.
- After completion, the next scan starts approximately two minutes later. Scans never overlap. A monotonic attempt sequence prioritizes less recently attempted URLs, including after individual failures, rather than starving later sources behind the first five.
- Permission lasts at most eight hours from the first selected chat. Adding chats does not extend it. A native lifetime timer stops and cancels active work. Nothing auto-enables after process restart; selection is not stored durably.
- Every new scan checks secure local storage and the original CLI identity. Chat/identity/whole-scan failures pause the worker instead of retrying indefinitely or switching accounts/bot identities. Individual document failures are counted and revisited only in later bounded scans. Coverage caps are visible; old/high-volume conversations may not be fully indexed.
- Stop invalidates pending confirmations, aborts active CLI/model reads, drains the current operation and only then reports completion. `runProcess` rejects a canceled operation after actual child exit, escalating a TERM-ignoring child to KILL. Cancellation does not claim to undo a remote request already received or a local source already committed.
- Canceled source observations waiting in the Wiki queue are discarded; checks before file creation and rename prevent canceled pending writes from committing. Existing accepted sources are not deleted by Stop. This is not power-loss durability, an OS-level sandbox or continuous protection from another process using the same OS account.

## Optional model synthesis

If **本次会话开启自动归纳** is enabled, discovered complete sources use the same bound gateway, per-source durable reservation, citation validation, six-attempt startup ceiling and no-automatic-rebilling behavior as interactive document reads. Confirmation names the model subsequent source text can reach: the one the server enforces (MiniMax-M3 by default, or GLM-5.3 through a loopback LiteLLM proxy). Stopping discovery aborts only its active synthesis; it does not silently revoke the separate user-selected synthesis setting for future manual document reads. Already dispatched calls can incur cost. The knowledge screen receives updated remaining-attempt counts from background status events.

The development gateway retains the model key server-side. No new model endpoint, CLI credential copy, server content storage or Drive write is introduced.

## Verification

- `test/message-discovery.test.js`: provider-runner through actual pinned binary resolution, source-only encrypted Wiki/search, automatic revision refresh, source-message checks on both sides of the read, consent races, canceled/forged scopes, changed identity, partial/anchored exclusion, fairness/caps, single-flight, storage failure, lifetime timer and canceled queued observations. Synthetic model tests prove opt-in synthesis, per-retained-revision deduplication and cancellation.
- `test/process-runner.test.js`: actual subprocess cancellation, including a TERM-ignoring process and pre-aborted no-spawn behavior.
- `scripts/smoke-discovery-desktop.js`: actual Electron/native IPC/timer callback, with only the test interval accelerated, synthetic CLI/model responses and test-only encryption. A newly arriving synthetic message produces a searchable document while the UI stays in the knowledge section; no task or document click is required. Native cancellation, identity-change pause, reload disabled state and stopping a held read are checked. The screenshot `evidence/desktop-message-discovery-fixture.png` was opened and inspected; a stale synthesis-counter display found during visual review was corrected.
- `MINIMAX_CONFIG_FILE=/absolute/server/config.json node scripts/smoke-wiki-synthesis.js --live --discovery`: one explicit paid model request using synthetic source/chat/identity/encryption adapters and the real gateway/MiniMax. In this increment it returned three cited facts using **744 total tokens**; a second discovery cycle made no extra model request. It did not contact live Feishu or exercise the OS Keychain. This live run preceded the final counter, fairness-sequence and storage-availability refinements; final-source fixture regressions cover those changes without another paid call. The smoke now follows the server's chat-model setting, so `IDOU_MODEL_PROVIDER=litellm` with a LiteLLM key runs the same check against GLM-5.3; no GLM-5.3 run has been recorded yet.
- An isolated in-memory mutation skipped the post-document source-message rejection; the revoked-source storage assertion failed, detecting the missing protection. Production source and live resources were not mutated. No independent-agent review is claimed.

## Remaining full-product scope

Durable administrator-managed scopes, event-driven incremental ingestion and cursor/watermark recovery, arbitrary chat-text knowledge under its own ACL/provenance policy, account/CLI SSO linkage, real SaaS/private-provider acceptance, graph/ontology and cross-source synthesis, embeddings/hybrid search, distributed Wiki Drive publication and revocation/quota reconciliation remain unfinished. A bounded polling worker is real automatic discovery, not evidence that enterprise-wide ingestion or distributed knowledge delivery is complete.
