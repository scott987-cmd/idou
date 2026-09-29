# Desktop automatic Wiki reception

The desktop now composes `DesktopWikiReception` alongside its reading-driven publisher. Eligible application login attempts both independently. Reception requires an explicit enterprise policy; a publisher is not automatically a recipient. This is a development implementation with synthetic Feishu acceptance, not a deployed distributed enterprise service.

## Administrator policy and discovery

Add `automaticReceivingApproved: true` to the existing tenant entry in `IDOU_WIKI_KEY_CONFIG_FILE` only after configuring recipient processing, approved publisher open_ids, coordinator membership, Drive budget/destination, canonical original origin, server bundle reads and CLI identity matching. Omitted/false stays disabled. Recipient and generated-synthesis trust requirements in [key delivery](wiki-recipient-key-api.md) remain unchanged. Configuration is loaded at server startup; changing the file requires a restart, not a live client override. No deployment configuration or account permission is changed by this implementation.

`POST /v1/wiki/keys/discover` accepts exactly `{ "after": null }` or an opaque SHA-256 cursor using the parent native session. It enumerates at most five approved publishers' stable per-app/tenant/user reading shards per page, in hash order, and returns only published version hashes/generations in the configured destination, excluding this device's own publications. Unpublished authors still advance the cursor. A page can therefore contain zero targets and a non-null next cursor. This is bounded publication discovery, not full-text enterprise search or arbitrary shard enumeration.

The response includes the canonical folder/original origin, catalog/policy digest, parent expiry and a session binding. It explicitly reports `permissionsChecked: false`. No source title, source token, content, package key or grant is returned. The native client checks exact fields, ordering, cursor progression, canonical destination and session binding; the renderer receives only aggregate status and the approved folder reference.

## Receiving and lifecycle

One per-account FIFO background queue serializes publication, reception and optional online-login checkpoints. Queued Wiki work can be cancelled immediately; started work drains before the next operation. Four waiting entries are permitted. Identity checks and server request ceilings remain unchanged.

The receiver visits one discovery page per cycle, then waits two minutes. Each new candidate must still appear in a fresh response for the same catalog and publication. The existing coordinator, source registry and key authority independently verify publication metadata, actual encrypted Drive bytes, current originals, recipient identity and synthesis policy. The native Drive adapter downloads and the local Wiki verifies every original again before one encrypted import commit. Candidate/policy checks are repeated through that final commit. Later searches still check current original access; importing a package never proves permission to read it later.

Successful versions and failed versions are remembered only for the current run. The same failed version is not silently retried; a newly published version can be attempted, and an explicit stop/start creates a fresh run. One denied candidate does not block other authors on the page. The next cycle pauses if the catalog, destination or parent session changed. Navigation leaves work running; stop, logout, account switch and process exit abort/drain before closing the Wiki. Parent expiry also stops an otherwise idle run.

The exception to parent-session change is a successful native [online renewal checkpoint](wiki-desktop-publication.md#online-session-checkpoint): after current cloud work drains and login rotates, a running receiver fetches fresh discovery metadata with the same cursor. It requires the same catalog digest, policy digest, folder and original origin before replacing the expiry timer. It preserves cursor, successful/failed-version sets and counts. No package is downloaded by the checkpoint itself, and a previously failed version is not retried merely because login renewed. Changed policy stops reception; stopped/paused/closed receivers are not restarted. Candidate rechecks also compare policy/origin through the final import, not only catalog and target hashes.

**企业知识库 → 企业知识自动取回** exposes received/unavailable counts, state, folder/expiry, stop and configuration-recheck controls. Imported-only evidence is excluded from reading-publication candidates, avoiding a receive/re-publish feedback loop. Separately reading an original locally can make it eligible for that user's publisher.

## Limits and evidence

- Discovery is limited to configured reading publishers (at most 1,000), five per page. Optional online renewal now preserves a running scan within its original Feishu authorization/four-hour horizon; it is not persistent/offline login or fleet-scale scheduling. No throughput or multi-machine production acceptance is claimed.
- Cursors, successes and failures are not persisted across restarts. A new run may re-download an approved current version. Local Wiki retention/capacity still applies; receiving a version does not promise every source remains resident.
- Withdrawal or discovery-policy changes stop future imports but do not purge all previously imported data. Existing queries reauthorize originals; cross-device tombstone/ACL propagation and cryptographic recall are not implemented.
- Generated claims still require explicit trusted publisher-node policy. There is no silent trust expansion, automatic sharing permission change, new cloud upload on receipt, original edit, model call or server content storage.
- The extended publication desktop smoke uses actual Electron, application/native/HTTP services and encrypted packages, two separately logged-in accounts and separate data directories, but synthetic CLI/Feishu/OS-cipher boundaries. It is not real SaaS/private-cloud or different physical-machine acceptance.

The user-supplied document is a read-only acceptance reference and remains untouched.
