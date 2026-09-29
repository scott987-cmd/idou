# Native Wiki publication — development pipeline

`WikiBundlePublisher` now connects the local Wiki, portable encrypted codec, node coordinator, shared Drive budget and replaceable Drive provider. A separate recipient can fetch the resulting publication and import it using the existing source-revalidated receiver. This is verified with actual HTTP/SQLite/filesystem and synthetic Feishu/key authority, not enabled production synchronization. The desktop still has no publish button or automatic publisher schedule, and no production key authority exists.

## One native operation, one upload permit

The caller supplies a stable UUID, shard hash, retained local source IDs, explicit folder reference and `confirmed: true` to `publish(input, { signal })`. Confirmation is a native caller responsibility, not a permission that may be taken from arbitrary renderer/Agent JSON. Future administrator-approved automatic scopes must bind that authorization to the exact sources, identity, target and budget; the boolean alone is not an enterprise policy system.

The implementation performs these steps:

1. Run the read-only version preflight below: check native business access, current product session/node, allowed CLI folder, fresh source content and the current head against the OS-encrypted publication journal. Reject an existing operation ID; a new ID for unchanged content returns without writing or acquiring a lease. A new version requires available journal space and key authorization.
2. Save the operation identity and expected head generation **before** requesting a node lease under that same UUID. The journal owner binds server origin, server-derived product user/device node and CLI principal/tenant.
3. Start periodic renewal while sources are read and key authorization is requested. Export freshly checked sources, acquire an explicitly approved publication key, and seal the immutable package for this generation/fence/node/Drive destination. The key authority receives source identity/revision/hash metadata, never source bodies through this interface.
4. Check the server Drive policy and exact encoded byte budget. Bind the key grant to package metadata and persist it. The package's encrypted bytes are kept native; the journal retains metadata, not a second copy of content or the key.
5. Immediately before upload, recheck source-set identity/text versions, key/session and node lease. Reserve the exact bytes, durably record `dispatching`, then obtain the existing once-only server dispatch permit. The SaaS adapter checks CLI identity again after this awaited callback.
6. Upload one new file named `idou-<operation UUID>.wiki.bundle`. Never overwrite a file, choose root implicitly, grant sharing permissions, switch to bot or use CLI directory sync. Save the acknowledged file token before later verification can fail.
7. Download that exact token from the original folder. Check actual byte count and full ciphertext SHA-256, recheck sources/key/session/lease, then report the token to the budget ledger. A filename/listing alone is not byte verification.
8. Persist `publishing`, renew, stop and drain the renewal timer, and commit the manifest under the exact fence/expected generation. Verify the returned immutable receipt before saving `published`.

The underlying `SaasDriveFiles` adapter now accepts `.wiki.bundle` alongside its existing managed media/app extensions. It continues to use the pinned bundled CLI, relative temporary filenames, explicit `--as user`, exact-token folder listing and bounded downloads. A later private CLI can replace the same provider object without changing the publisher.

## Persistence and recovery

Journal phases are `created → prepared → dispatching → recorded → publishing → published`. The file is encrypted by the injected OS cipher, created privately (0600), replaced atomically after file sync, and followed by directory sync. Reading rejects symlinks at the file, hard-linked/non-file/insecure or oversized files and invalid state. This is not a multi-process lock, backup or proof of survival through every storage/power-loss failure. The desktop's single native owner per account directory remains required; a process-local filename lock prevents concurrent publisher instances from writing that journal in one process.

Bounds are 1,000 entries and 2 MiB encrypted bytes. Old entries are never automatically evicted: forgetting uncertain uploads can cause duplicates. The journal contains operation/shard/source hashes, owner binding, folder metadata, lease identity, package metadata, policy hash, phase and optional file token. It contains no document text, prompts, raw data keys, model keys, product session tokens or ciphertext payload. Native caller configuration owns its path.

`recover(id, { signal })` never calls upload or obtains another dispatch permit:

- Without a durably recorded file token, recovery refuses to guess. An upload or budget permit may already have happened; inspect the original operation externally. Do not generate a replacement UUID automatically.
- With a token and an active original lease, a separately authorized resumed key grant permits exact-token download/hash verification, current source checks, repeat-safe budget reporting and publication. It does not regenerate or re-encrypt the package.
- If the coordinator already committed, the original request ID retrieves that immutable receipt. Recovery verifies its manifest/fence/node and returns `historicalReceipt: true`; this is not evidence that it remains the current head, and cannot resurrect a later tombstone.
- An expired/superseded lease, changed policy/owner/session, revoked key/source or corrupt remote package stops recovery. Previously uploaded bytes and charged budget are retained; no deletion/refund is inferred.

Journal or response failure before final acknowledgment remains unconfirmed. This is conservative at-most-one dispatch **per operation ID under the shared budget ledger**, not exactly-once upload. The local version preflight now prevents known unchanged content from producing a new operation under a different UUID. It is not global cross-device content deduplication; administrator review/reconciliation and garbage collection remain future scheduling work.

## Read-only version preflight

`plan({ shardKey, sourceIds, folderReference }, { signal })` is a native-only read operation. It validates the product/CLI identity and server-configured destination, freshly exports every selected source, computes a canonical portable-content digest and rereads the coordinator head to reject concurrent head changes. It creates no lease, budget reservation, key grant or journal entry; it does not call a model or check remote bundle bytes. Preflight holds no renewable lease; lease renewal begins only after an actual publication claim. Source reads remain bounded/cancelable by the existing provider contract, but large source sets can take time.

| State | Meaning / next step |
| --- | --- |
| `ready` | No known conflicting operation, or a proven local current publication differs from the fresh content. A native-authorized publish may proceed, subject to later lease/key/quota checks. It is not a guarantee of available budget. |
| `unchanged` | Fresh portable content matches a local published record whose exact manifest/fence/node/generation still matches the head. A new operation ID is skipped without upload, charge, lease or journal write. `remoteBytesVerified: false` is explicit: a remote file could have been deleted or its key revoked. |
| `review-required` | An unresolved prior operation, tombstone, missing former head, changed destination or legacy record without content proof needs reconciliation. The operation ID is returned when known. The publisher does not bypass this with a new UUID. |
| `remote-head` | A head exists but this account/device journal cannot prove its portable content. Retrieve and verify it through an authorized receiver; do not automatically overwrite another node's publication. |

`publish` runs the same preflight itself, under the process-local journal lock, so callers cannot bypass deduplication by skipping `plan`. Existing operation IDs retain their original error/recovery behavior; only a *new* ID for proven unchanged content returns `unchanged`. This no-op requires no key grant, including when no key authority is configured. Source denial, identity change or a concurrent head change fails the check instead of returning a cached `unchanged` decision.

`bundleContentDigest` hashes the normalized, sorted portable records with a versioned domain prefix. It includes source identities, URL, title, revision, upstream hash, text and optional cited synthesis. It excludes encryption nonces, device/observer identity and timestamps, and is distinct from both the source-set hash and ciphertext hash. Text, title and synthesis-only changes therefore produce a new version; repeated encryption or a new request UUID alone does not. The digest is saved from the exact records sealed for publication, not from an earlier preview. No plaintext or new digest field is added to the server protocol or bundle header.

The local journal now writes schema version 2 and reads versions 1 and 2. Version-1 records without `contentDigest` remain usable for receipt recovery, but cannot establish content equality; the reader never invents the missing proof from an upstream source hash. Read-only planning never migrates or writes the file. The next authorized journal write uses version 2 and preserves legacy records; older app builds that only understand version 1 must not be used to write that journal. This is a local application-data change, not a Codex/Feishu CLI pin change.

These decisions now feed the [native automatic scheduler](wiki-scheduler.md), verified with synthetic scope/key authority but not enabled in the production desktop. They are not administrator policy or authorization to read/decrypt other users' bundles. Unresolved operations are deliberately not automatically discarded. A tombstone is not automatically resurrected by local activity. Cross-device version proof, key/source revocation propagation, automatic reconciliation and explicit administrator override remain open.

## Key and lifecycle contracts

Production key authorization remains the trust boundary described in [Wiki bundles](wiki-bundles.md#key-authority-is-an-unfinished-security-boundary). The publisher adds these native interfaces, not server endpoints:

- `preparePublication({ shardKey, lease, identity, sources, signal })` returns a 32-byte key, opaque `keyId`, `assertCurrent()`, `bind(packageMetadata)` and `release()`.
- `bind` must bind the approved lease/source registry/key to the exact package metadata before upload. It receives no raw package bytes.
- `resumePublication({ shardKey, lease, manifest, identity, signal })` returns `assertCurrent()` and `release()` for the exact prior publication intent. Recovery needs no raw key because it compares remote ciphertext against locally authenticated journal metadata, then independently rereads sources.

A future authority must independently verify source authorization and identity linkage; accepting these client-provided fields without that verification would be insecure. The tests' permissive key fixture is not such an authority. Model/provider secrets remain server-only. Ephemeral authorized content-decryption keys are a distinct native capability, not embedded credentials. Owned temporary key-buffer copies are cleared on exit; this does not guarantee erasure of runtime/OS copies.

Renewal runs every 30 seconds by default from initial source export, with extra checks around dispatch and commit, and is bounded by the existing session/token lifetime. Renewal failures prevent publication and are not silently reacquired. Timers are stopped and pending renewal drained on every path. Already dispatched CLI uploads/downloads are not instantly cancellable through this provider contract: an acknowledged upload token is still recorded after cancellation/logout so it is not forgotten. Native and Feishu authorization checks are point-in-time; they are not an atomic transaction with subsequent external ACL changes.

## Verification and remaining work

`node --test test/wiki-publisher.test.js` exercises real HTTP native clients, scoped tokens, SQLite coordinator and budget, actual codec/journal/provider upload/download code and filesystem bytes. Feishu transport and key authority are synthetic. The successful path publishes as one server user/device and imports via a different server user/device and CLI identity. Twenty-one tests also cover missing authorization, budget/cipher/journal failures, lost dispatch/upload/report/publish responses, reconstructed publisher recovery, source/key/policy changes, logout/cancel, corrupt downloads, slow-source/upload renewal, stopped timers, journal concurrency, foreign CLI identity, expired leases and historical tombstones. New preflight tests verify zero mutations, unchanged new-ID/restart deduplication, separate actual artifacts for text/title/synthesis changes, legacy migration, pending/missing/remote/withdrawn heads and source/head/policy races. Publisher reconstruction is tested; this increment does not claim a new SIGKILL/power-loss or real multi-machine acceptance test.

An isolated test process disabled `SaasDriveFiles.unchanged`. The dispatch-callback identity-race test failed with one upload instead of zero, demonstrating that it detects the intended unauthorized-identity regression. Production code was not altered by the experiment. Existing media and application archive desktop tests passed with the modified adapter, still with synthetic transports and no paid/live writes.

An isolated process forced `unchanged` preflight results to `ready`. The new-ID deduplication test failed because it observed two actual synthetic Drive uploads instead of one. The mutation changed no production file. An old slow-export fixture initially waited for renewal during the newly added read-only preflight; its explicitly held stage was corrected to start after the claim, preserving the original renewal assertion.

The scheduler now supplies an optional `assertCurrent` guard alongside `signal` to `plan` and `publish`. The publisher checks this independent scope authorization around its source/context boundaries and after durable intent storage before lease acquisition. Direct native/manual callers retain their existing business-access, key and explicit-consent contract. The scheduler never invokes recovery automatically. Four additional publisher tests (25 total) cover scheduled real-artifact deduplication, scope revocation with retained receipts, stop during durable intent storage and cancellation during preflight.

Still required: production source-authorized key registry/KMS and write-capable CLI policy; administrator scope and policy UI; production integration of the implemented scheduler, cross-device version proof, retrieval and retry/reconciliation decisions; ACL/deletion propagation, quota reconciliation/garbage collection; live SaaS/private-CLI acceptance, cross-machine deployment and production packaging. The read-only single-login bridge does not complete this publication pipeline or the enterprise knowledge product.
