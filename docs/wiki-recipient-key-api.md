# Recipient package-key delivery

The native `WikiRecipientKeyClient` now connects the existing `WikiBundleReceiver` to the explicitly configured key service. The server verifies the actual Drive package and current originals before issuing its key; the receiver then independently checks every source again before encrypted local import. This is implemented and tested through real local HTTP/SQLite/crypto with synthetic Feishu transport. [Desktop automatic reception](wiki-desktop-reception.md) now supplies a separately approved discovery and receiving entry. Application/CLI identity matching is supported, but CLI credential provisioning/shared login and live/private-cloud acceptance remain unfinished.

## Administrator policy

The existing `IDOU_WIKI_KEY_CONFIG_FILE` tenant row accepts two optional arrays:

- `recipients`: user open_ids belonging to the configured OAuth app and tenant. Omitted means no recipient processing/delivery authorization. A receiver-only tenant can have empty `publishers`; at least one publisher or recipient is required.
- `trustedSynthesisPublisherNodes`: exact 64-character node hashes from authenticated coordinator publications. Omitted means no publisher synthesis is trusted. These are app/tenant/user/device-bound coordinator node IDs, not client-supplied display names or open_ids.

Recipients also require `processingApproved: true`, current coordinator membership/destination policy, configured canonical originals and `FEISHU_WIKI_BUNDLE_READS_ENABLED=1` with its read scopes. Configuration is read at startup; policy changes require service restart and invalidate in-memory grants. Existing publisher-only configuration remains publisher-only. No deployment root, membership, consent or configuration is created automatically.

A package containing only original evidence needs recipient approval and successful verification. A package containing generated synthesis additionally needs its publisher node on the explicit trust list. Matching quotations do **not** prove a generated claim follows from those quotations. The import retains the existing publisher-claim provenance; trusting a node is an administrator's risk decision, not semantic verification. The entire package is denied when synthesis is untrusted—its encryption key cannot safely expose only selected records.

## Request and lifetime

`POST /v1/wiki/keys/acquire` accepts only `{ "shardKey": "<sha256>" }` under a current parent Feishu Agent bearer session. It shares the existing native-only HTTP restrictions: no browser Origin, no child tokens, JSON metadata capped at 4 KiB, no request-supplied source list, manifest, credentials, key or approval flags.

The server resolves the current publication and immutable declaration, downloads the exact Drive artifact, authenticates it using the persistently bound package key, and independently reads every original under the recipient's server-held OAuth credential. It compares canonical full source fields and recipient identity, rechecking session, publication, membership and policy around awaits. `verifyPublication` still reports `keyReleaseAuthorized: false`; a separate trusted delivery-policy decision authorizes the subsequent grant. No cached or client-returned verifier report is accepted.

The receipt contains a random grant ID, recipient-domain parent-session binding, exact publication/manifest hashes, generation/fence/node, source digest/count, destination, key ID, synthesis provenance, explicit policy authorization, expiry and the package key. Model-provider secrets and the wrapping root never leave the server. `current` returns the revalidated receipt without a key. `release` clears the server grant; another parent session cannot inspect, release or bind it. Sessions were redeemed through device-key login but requests use bearer tokens, not hardware attestation.

Every acquire independently verifies again and invalidates a previous same-parent/same-shard recipient grant. A prior success is not cached permission. There is no automatic retry after response loss. The shared service caps live grants at 100, concurrent acquisitions at four, and serializes acquisitions per parent; existing per-parent request quotas apply. Server acquire deadline is 125 seconds, verifier deadline 120 seconds, native request deadline 130 seconds. Original reads wait *before* issuing requests within the existing two-per-second/four-operation bounds and each read's 12-second deadline; failed reads are never retried. Large live enterprise workloads and distributed quotas have not been benchmarked or accepted.

Grant lifetime is at most 60 seconds and the parent expiry, starting after verification. Native response validation permits five seconds of timestamp skew but does not extend the local 60-second lifetime. The adapter validates exact publication/session/source/destination fields, caps responses at 8 KiB and clears owned response bytes and key buffers at release/abort/expiry/close or a failed current check. Native business-access/session checks remain mandatory. Grant IDs and keys must not enter the renderer, tool output, journals, logs or environment.

`current` rechecks the bound server session, publication, enterprise policy and vault availability; it does not reread Feishu ACLs on every call. Acquisition reads each current original, local import reads them again, and later queries still require source authorization. There is no atomic ACL snapshot across documents or cryptographic recall of already copied keys. Cross-device source deletion/ACL propagation, host compromise, transport/JS copies, root rotation/KMS, backup rollback and safe deployment remain separate requirements.

## Verification

Ten added tests in `test/wiki-publisher.test.js` cover second-user actual encrypted import after custody restart and local encrypted reopen/citations; source/Drive/corruption and membership denial; unsupported but correctly quoted synthesis default rejection and explicit configured trust; grant/session isolation and fresh reacquisition; substituted receipts; key-buffer lifecycle; three-source pacing; session/membership/head races; cancellation while waiting without issuing an original read; and configuration validation. HTTP, vault, codec, receiver and local Wiki are real; Feishu responses, identities and wrapping roots are disposable synthetic fixtures. No live account, model call, cloud write, desktop entry or independent audit is represented.

An isolated module-loader mutation bypassed only the delivery-policy decision. The synthesis-denial regression failed because HTTP 200 replaced the expected 403. Production source was unchanged.
