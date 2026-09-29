# Wiki node coordination — metadata-only development service

The server now arbitrates shard work and immutable publication references across independently authenticated clients. It does **not** store Wiki content, implement encryption/key distribution, upload a bundle, grant source permissions or make the local Wiki distributed by itself. The desktop exposes **企业知识库 → 检查知识节点连接** to check the current node identity, lease duration and remaining managed Drive budget. Navigation alone makes no coordinator request, and the renderer has no acquire/renew/publish IPC.

## Server configuration

Configure `IDOU_DRIVE_CONFIG_FILE` as described in [Drive budget](drive-budget.md), then set server-only `IDOU_WIKI_CONFIG_FILE` to an absolute JSON path:

```json
{
  "schemaVersion": 1,
  "databaseFile": "/srv/idou-private/wiki/coordinator.sqlite",
  "tenants": [
    {
      "authProvider": "feishu",
      "tenantId": "verified-product-tenant-key",
      "appId": "cli_your_product_app",
      "members": ["explicitly-authorized-product-user-id"]
    }
  ]
}
```

Each grant must have a matching Drive budget policy. Members are explicitly trusted **metadata coordinators/publishers**, not everyone in the tenant. They can inspect a known shard hash and publish/tombstone its reference; this is not a grant to read its documents. No tenant-wide manifest enumeration or query-text endpoint exists. Development bootstrap must be configured explicitly with `authProvider: "development"`, `tenantId: "development"`, `appId: null`, and member `local-developer`; it does not establish enterprise identity. Start the normal `bin/server.js --feishu` or `--dev` entry; no model request is needed to use this service.

The database's real parent directory must be private and OS-user-owned (0700), and its file private (0600). Windows requires separately provisioned ACLs. SQLite uses WAL, FULL synchronous commits, a bounded busy timeout and explicit schema checks. Corrupt/unknown databases fail without reset. Use a dedicated database path and preserve its WAL during backup. This is a single control-plane host's durable arbitration, not a multi-region database service.

## Protocol and ownership

All endpoints are native-only JSON POSTs, reject browser Origin, limit bodies to 4096 bytes, reject unknown/content-bearing fields, and revalidate the session after reading the body. `/auth/wiki-token` derives a five-minute, parent-bounded `wiki-coordinator` token with only `wiki:coordinate`. Model, Drive, media, app and skill tokens cannot substitute. Parent revocation invalidates the derived token; these remain bearer credentials after login device-key proof, not hardware-attested per-request signatures.

Node ID is a server-derived hash of auth provider / tenant / App ID / user / enrolled device. Clients cannot nominate another node. Grant and policy checks run on every operation. The native `WikiCoordinatorClient` retains scoped tokens only in memory, validates origin/expiry, rejects content-bearing payloads before network access, bounds responses to 16 KiB, uses 15-second request deadlines, and never retries mutations automatically.

| Endpoint | Request | Behavior |
| --- | --- | --- |
| `/v1/wiki/status` | Empty object | Current node hash, Drive policy/remaining bytes and bounds; creates no lease. |
| `/v1/wiki/head` | `shardKey` | Current publication reference or null, never source text or access evidence. |
| `/v1/wiki/acquire` | `shardKey`, `requestId`, `expectedGeneration` | Atomically claims the shard for 120 seconds, bounded by token expiry. |
| `/v1/wiki/renew` | `shardKey`, `leaseId`, `fence` | Extends only the current uncommitted, unexpired lease owned by this node. |
| `/v1/wiki/publish` | Lease fields, `expectedGeneration`, `manifest` | Commits a new immutable generation, or a tombstone when manifest is null. |

Shard IDs are opaque SHA-256 digests; request and lease IDs are UUIDv4. `expectedGeneration` is a compare-and-swap precondition. Each new claim receives a durable increasing fence, so an expired or superseded worker cannot publish over its replacement. The same request ID returns the same lease without extending it, including an expired result; changing its node/shard/generation is rejected. Keep the original request ID when investigating a lost response—do not manufacture a new request automatically.

Every publish is recorded in both the immutable lease receipt and current head in one transaction. Replaying an identical committed publish returns that generation even after a newer head exists; it never restores an old head. A changed manifest under the same lease is rejected. A tombstone retires the coordinator reference only; it does not delete a source, remove a Drive file, release budget or push an ACL invalidation into offline caches. A new authorized generation can supersede it, but a stale worker cannot resurrect it.

## Drive accounting and content boundary

A non-null manifest is strictly limited to `format: "wiki-aes256gcm-v1"`, provider/Drive-tenant/folder/file identifiers, a reported budget reservation UUID, ciphertext hash, actual encoded byte count, opaque key-reference hash, source-set hash and source count. Bounds are 10 MiB and 200 source records. There are no titles, source URLs, document bodies, embeddings, queries, prompts, raw encryption keys or bundle bytes.

Before commit, the coordinator checks the existing **reported** Drive reservation belongs to the publishing product user and exactly matches destination, file token, ciphertext hash and bytes. It cannot adopt another user's reservation, publish an unreported upload, change its target or charge a smaller package. The acquire-time policy digest must still match. Coordination itself charges nothing and cannot release reservations; all uploads must continue using the existing reserve/one-shot dispatch/report protocol.

`clientReported: true` is always explicit. This verifies a durable accounting record, **not** the remote bytes, claimed encryption, source ACL or mapping between product and CLI users. Native-controlled encrypted upload and independent current-source/Drive checks still need implementation before automatic publishing is enabled. In particular, never replace those checks with `head()` success or upload plaintext local-Wiki JSON into a broadly shared folder.

Leases have a global 100,000-record bound and heads a per-tenant 10,000-shard bound. Capacity exhaustion refuses new claims without evicting deduplication history; existing valid leases remain renewable. There is no automatic cleanup/admin release tool. Leases survive service restart; session tokens do not. Clock synchronization is required on the coordinator host; fencing, rather than wall-clock ordering, protects against superseded writes. Concurrent server processes must share one consistent policy version and database; rolling mixed-policy operation is not supported.

## Verification / remaining integration

`test/wiki-coordinator.test.js` exercises independent DB connections and actual competing Node processes (one winner out of six), expired/taken-over writers, renewal, immutable publication and tombstones, exact Drive accounting, tenant/user/device/policy separation, strict metadata, capacity, corrupt/private paths, HTTP scopes/revocation, native client recovery, and abrupt SIGKILL after a committed generation. The normal server-entry test enables this configuration and verifies authenticated routing plus clean shutdown. An isolated in-memory mutation removing current-lease checks causes stale-writer and post-commit-renewal assertions to fail.

`scripts/smoke-wiki-coordinator-desktop.js` uses actual Electron/native client/HTTP/SQLite with a synthetic development identity and Feishu fixture. It verifies explicit status reading, budget display, no renderer write API, failure clearing stale success, parent revocation, zero leases and zero uploads/model calls. Screenshot: `evidence/desktop-wiki-node-fixture.png`.

The native [encrypted bundle codec and recipient import](wiki-bundles.md) now bind bytes to these publication fields and reauthorize every source before indexing. The [publisher](wiki-publisher.md) now renews leases through source preparation/upload, obtains a once-only Drive budget permit, verifies downloaded ciphertext bytes and publishes the manifest with recovery records. These are tested with synthetic Feishu/key grants, not connected to automatic production synchronization. The coordinator itself still neither encrypts nor stores content or keys.

Still required: local index scheduling through these leases, customer-key lifecycle and independent per-source authorization of key release, source-to-shard/ACL cohorts, live upload/remote-byte acceptance, automatic retrieval/query routing, deletion/permission propagation and coordinated garbage collection. The current server is not an enterprise content search engine. Real CLI Keychain/SSO linkage and supplied private CLI acceptance remain separate gates.
