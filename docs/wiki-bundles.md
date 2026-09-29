# Portable Wiki bundles — native development implementation

The native layer can now export freshly checked local sources, seal a portable encrypted package, validate downloaded bytes against a coordinator publication, and import cited facts under a different reader's freshly verified source permissions. Imported facts are searchable through the existing **企业知识库** UI and labelled **同步归纳（发布者声明）**. The [native publisher](wiki-publisher.md) now connects leases, budgeted upload and byte verification. This is not an enabled automatic Drive synchronization feature: production key authorization and integration of the [implemented native scheduler](wiki-scheduler.md) are still missing. No new renderer import/export IPC or default key has been added.

## Content and wire format

`src/knowledge/bundle.js` implements `portablePage`, `sealWikiBundle` and `openWikiBundle`. A source record carries tenant/provider/resource identity, canonical source URL, revision, upstream content hash, title and normalized full text, plus optional cited synthesis. Sender principal, cached ACL evidence, local owner ID and model-cost reservations are excluded. The recipient reconstructs those fields from fresh reads.

Packages contain 1–200 unique sources, all in one provider/tenant, with a 10 MiB encoded ceiling. They do not compress input. Sources are sorted by hashed tenant/provider/resource identity; the source-set digest includes each revision, upstream content hash and an independent SHA-256 of normalized text. It does not prove permission or authenticate an author.

The version-one binary layout is:

```text
MDBWIKI1 (8 bytes) | header length (uint32 BE) | canonical UTF-8 JSON header
                  | random IV (12 bytes) | authentication tag (16 bytes) | ciphertext
```

The header contains format, shard hash, generation, fence, publisher-node hash, key-reference hash, provider/Drive-tenant/folder, source-set hash and count. It is bounded to 2048 bytes and authenticated along with the magic and length. Titles, source URLs, principal identities and document bodies are encrypted; the header's routing metadata and ciphertext size remain visible. Plaintext is versioned JSON with `records`. The coordinator manifest stores the SHA-256 and byte count of the **whole encoded package**; its JSON manifest hash is a different digest.

Encryption uses a 32-byte key, AES-256-GCM and a fresh random nonce. Decryption supplies the authenticated header and fixed-length tag, then waits for final authentication before parsing any plaintext. This follows the [Node crypto authenticated-decryption contract](https://nodejs.org/api/crypto.html#deciphersetauthtagbuffer-encoding). Whole-file hash/size, exact canonical header and publication binding, version, source-set/count, record schemas and citations must all pass. Unknown formats fail; there is no plaintext or older-format fallback. Tests additionally decrypt using the independent WebCrypto API. These checks are not a cryptographic audit or publisher signature; any holder of the symmetric key can author ciphertext.

## Recipient workflow and authorization

`WikiBundleReceiver.receive(shardKey, folderReference, { signal })` is a native-only dependency-injected consumer:

1. Check business access, cancellation, current published generation and exact authorized Drive folder/provider/tenant.
2. Acquire a separately authorized, generation-bound key grant. Missing authority stops before downloading.
3. Download the exact manifest file token, bounded by the declared byte count, under `idou-<reservation UUID>.wiki.bundle` (a bundle written before the rename keeps `mydoubao-`). Validate bytes and authenticated package binding.
4. Freshly read **every** original document as the recipient. Require exact identity, provider/resource, canonical URL, title, revision, content hash and normalized text; refuse partial sources. A denial or mismatch rejects the entire import.
5. Reconstruct recipient-scoped pages and quote offsets, recheck publication/key/session, encrypt locally, recheck again immediately before atomic rename, then commit once. Imported cached ACLs are never used. Current local count/byte/retention bounds still apply, and the result reports retained/requested counts.
6. Release the key grant and clear internal key-buffer copies. Only counts return from the receiver; ordinary knowledge search independently rechecks source access before showing any result.

Only one receiver operation runs at a time. There is no automatic retry, old-head fallback or overwrite of an unreadable existing local cache. Cancellation/close during a read and logout during the final coordinator check prevent commit. Release errors are not forwarded and cannot turn a successful import into a retry request. The current Drive download API is not abortable; cancellation still prevents the subsequent import but does not promise immediate termination of a dispatched CLI download.

Synthesis is optional and imported without a new model request. Quote validation establishes source traceability, not the truth of the conclusion or proof that the advertised model generated it. The UI distinguishes imported publisher claims from locally requested model synthesis, renders all text inertly, and offers original citations and **在工作任务中打开**. A source version change discards stale synthesis via the existing local version key.

## Key authority is an unfinished security boundary

The injected contract is `acquire({ shardKey, publication, identity, signal })` returning `{ key: Buffer(32), assertCurrent(), release() }`. This is an internal native interface, **not** an implemented server endpoint, bundled secret or renderer API. The authority owns its returned key; the receiver copies it and calls release without overwriting authority-owned bytes.

Before a production implementation may release a key, it must independently bind the product session/device to the actual Feishu identity, bind the grant to the exact publication and authenticated source registry, and authorize that identity for **all** sources encrypted with the key. The current metadata coordinator's opaque `sourceSetHash` cannot establish those permissions. A client's claim that it checked permissions is insufficient. Neither tenant membership nor permission to download a broadly shared Drive file authorizes its document contents.

An optional [server-side source-permission verifier](feishu-source-access.md) now uses session-bound OAuth credentials to check current-user Docx read permission independently of the CLI. It is not connected to key issuance: the caller-supplied probe list does not prove the complete package source set, and the result is point-in-time, not a key/scope grant.

The [source declaration registry](wiki-source-registry.md) now persists an immutable list under the publication lease and binds its digest/count at manifest commit. Recipient checks use that stored list. It still reports `contentVerified: false`: publisher-declared hashes and ciphertext binding alone do not independently prove the payload's complete contents or original-source provenance.

Production therefore still needs a trusted source/ACL registry or equivalent independently verifiable authorization, per-package or identical-ACL-cohort data keys, server/customer KMS custody and wrapping, lifetime/rotation/revocation policy, and authenticated native key delivery. Do not substitute one enterprise-wide decrypt key. Provider/model secrets stay server-side; ephemeral, explicitly authorized content-decryption keys are a distinct capability needed for client-side indexing.

Zeroing temporary Buffers is best effort, not guaranteed erasure of V8 strings, copies, OS swap or dumps. A compromised authorized endpoint can retain plaintext or a received key. Point-in-time source checks and a local rename are not a distributed atomic transaction with Feishu ACL changes. Search rechecks source access, but already displayed results and offline caches are not live revocation subscriptions; coordinator tombstones currently do not purge previously imported pages automatically.

## Evidence and remaining integration

`node --test test/wiki-bundle.test.js` covers real crypto and encrypted files in separate publisher/recipient Wiki instances, WebCrypto compatibility, tampered header/tag/body with recomputed outer hash, substituted generation/fence/node/shard/key, bounds/duplicates/cross-tenant sources, citations, multi-source all-or-nothing access/version/content checks, expired export sources, restart/search revocation, missing/revoked keys, cancelled/closed nodes, final-check logout, single-flight, cleanup failure and unreadable cache preservation. Transport, identities, keys and source content are synthetic, not live enterprise acceptance.

`node scripts/smoke-wiki-bundle-desktop.js` runs actual Electron/main/preload/renderer and the actual codec/receiver/local Wiki. Only the fixture invokes native import; production has no such UI entry yet. It verifies a publisher-marked cited result, inert script-looking text, encrypted restart without another download, opening the original document beside the Agent, and hiding revoked sources. Drive, key authority, Feishu and OS encryption are test substitutes. No paid model call or live write occurs. Screenshot: `evidence/desktop-wiki-bundle-fixture.png`.

The native publisher and bundled-provider `.wiki.bundle` upload support are now implemented and covered by synthetic Feishu/key-authority tests with actual HTTP/SQLite and receiver import. Still required: the production key boundary above, automatic publisher/retrieval scheduling and policy UI; ACL/deletion propagation; quota reconciliation and garbage collection; multi-machine/live Feishu acceptance and private-provider compatibility. The control plane continues to store only coordination/accounting metadata, not document or package bytes.
