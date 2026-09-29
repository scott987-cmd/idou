# Delivery roadmap

## Milestone 0 — runnable boundary baseline (this repository)

- Two modes over one Codex app-server client.
- SaaS Feishu CLI provider with versioned skill discovery.
- Interactive command/file approvals in the local CLI.
- Provider-neutral knowledge contracts, a Feishu Drive sync adapter, and stable content identities.
- Upstream version pins, doctor command, and unit tests.

## Milestone 1 — single-device Cowork

- Desktop shell with local session persistence, source previews, and a browser-backed Coding artifact preview.
- Feishu Drive/Wiki/Docs incremental crawler through SaaS `lark-cli`; Feishu documents remain canonical.
- Parser, deterministic chunker, local embedding provider, hybrid local search, and citations.
- Immutable wiki bundles synchronized to Feishu Drive with preflight budget/quota checks.
- Feishu chat list/message UI plus document delivery drafts with recipient resolution and confirmation.
- Permission-change and deletion propagation tests.

Exit: one user can ask a question over authorized Feishu content, receive cited results, and lose access promptly after source permission removal.

## Milestone 2 — distributed enterprise wiki

- Feishu-login-backed node enrollment, capability advertisement, shard leases, revision manifests, tombstones, and query routing.
- Offline-node behavior, duplicate/late publisher protection, device revocation, and tenant isolation.
- Feishu Drive generation catalog, retention/garbage collection, and customer-controlled maximum occupancy.

Exit: multiple clients cooperatively index a corpus with no duplicate published revision, and a query remains permission-correct under node churn.

## Milestone 3 — private deployment controls

- Feishu SSO/device identity, customer-managed keys, egress allowlists, audit export, retention, quotas, and admin policy.
- Responses-compatible model gateway, server-held model keys, signed skill center, and image/video job gateway.
- Supported Feishu Docs Web Component integration with API-driven chat and deep-link fallbacks.
- Signed runtime/skill packages and staged upstream upgrades.
- Replace SaaS `lark-cli` with the private provider and run the same contract suite.

Exit: deployment passes customer security review and provider swap tests without application-layer changes.

## Where things stand (2026-09-21)

- Milestone 1's "local embedding provider, hybrid local search" has not shipped. Retrieval today is BM25 over document sections, with each candidate re-verified against Feishu.
  - bge-m3 embeddings were compared with it locally, on the knowledge-base evaluation set in `test/fixtures/knowledge-eval`.
  - The gain over the current LLM Wiki is modest. Across eight corpus-and-question-set combinations, vectors add 1.6 of 28 questions with complete evidence on average. The largest gain is +5, on reworded questions. Two combinations are one question worse, and questions that use the documents' own words gain nothing.
  - It does not tell same-type documents apart; that needs metadata.
  - At ten thousand documents the index belongs on the server, not in each desktop's copy.
