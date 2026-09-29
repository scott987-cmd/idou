# Server-managed Drive upload budget

This increment puts a shared, persistent byte budget in front of **new media uploads, confirmed application-package archives, and trusted scheduled-report archives made by this product**. Application archives charge the actual canonical JSON/base64 bytes, not the smaller source-file total; see [application archival](app-candidates.md) for its separate once-only catalog intent and recovery states. Scheduled reports are uploaded only after the sandbox exits, by a control-plane postprocessor whose target comes from this policy; the model never receives a Drive write capability. It is not Feishu's tenant-wide storage quota, a security boundary against a modified client, or a claim that the server independently inspected the remote file. The [Wiki coordinator](wiki-coordinator.md) checks exact reported reservations before accepting metadata publication references. Enterprise desktop business operations still require the product-login/CLI identity bridge.

## Configuration

Set server-only `IDOU_DRIVE_CONFIG_FILE` to an absolute JSON file path before starting `node bin/server.js --feishu` or `--dev`. Without this configuration, the desktop refuses to save media and a completed scheduled run cannot retain its report body; generation and temporary preview are unaffected. Existing pre-budget Drive receipts can still be read and opened after fresh CLI authorization, but are not automatically included in the new budget. Use a dedicated empty managed folder or complete an administrator inventory before adopting an existing folder.

Example configuration (replace every example identity and path):

```json
{
  "schemaVersion": 1,
  "databaseFile": "/srv/idou-private/drive-budget.sqlite",
  "tenants": [
    {
      "authProvider": "feishu",
      "tenantId": "verified-product-tenant-key",
      "appId": "cli_your_product_app",
      "providerId": "saas-cli",
      "driveTenantKey": "verified-cli-tenant-key",
      "folderToken": "YourManagedFolderToken",
      "maxBytes": 10737418240
    }
  ]
}
```

For the existing loopback development login, use `authProvider: "development"`, `tenantId: "development"`, `appId: null`; the Drive tenant and folder must still match the actual CLI target. This explicit development mapping is not enterprise identity verification. No policy JSON, SQLite file or credential is bundled into a client.

There is one policy per authentication-provider/tenant, with an exact product App ID and one allowed CLI-provider/Drive-tenant/folder destination. All users/devices in that tenant share `maxBytes`; changing a device/session/App ID does not reset the ledger. Policies permit 1 byte through 1 TiB. Restart the service to load administrator changes. Reducing the limit below charged bytes blocks new reservations; target or limit changes invalidate outstanding dispatch confirmations. Do not run different policy versions against the same database concurrently.

The database's parent must be a private, OS-user-owned, non-symlink directory (0700 on POSIX); the file is created 0600. On Windows, configure equivalent restrictive ACLs separately. The server uses local SQLite WAL transactions and synchronous FULL commits; it stores only tenant/owner/input/policy hashes, reservation IDs, byte counts, states, timestamps and client-reported opaque file tokens. No document, prompt, embedding, image/video byte or provider key is stored. A corrupt database or unsupported schema fails startup without resetting it. Preserve the database and its WAL consistently during backup; deleting/replacing it resets accounting and is not a recovery procedure.

The runtime floor is now Node **22.16.0** for built-in `node:sqlite` and its busy timeout. Tested with Node 22.22.2 / SQLite 3.51.2; Node still prints an experimental-feature warning. The synchronous API and timeout history are documented by [Node.js](https://nodejs.org/api/sqlite.html). A busy database fails closed after a bounded wait; this is a single-host beta, not a multi-region/distributed database deployment.

## Upload protocol

1. The native client obtains a five-minute, parent-bounded `drive-budget` lease and reads the authenticated tenant policy. Model, media, skill and MCP tokens do not substitute for that audience. No credentials enter the renderer or native journal.
2. It checks the resolved folder and actual downloaded bytes against the policy, then shows the native confirmation with current remaining bytes. This display is advisory; concurrency is settled by the server transaction after confirmation.
3. Before CLI dispatch, `/v1/drive/reserve` atomically allocates bytes using the account-owned media UUID, exact destination, local content hash and policy digest. Retrying the same reservation does not charge again. Other users cannot adopt its ID, and changed content/destination conflicts.
4. After the local upload-intent journal is flushed, `/v1/drive/dispatch` performs a one-time `reserved → dispatched` transition. Only the winning request receives a grant. A lost grant response does **not** grant a retry, even after server/client restart. No CLI upload runs without a successfully received grant.
5. The CLI uploads once. After native exact-token/folder verification, `/v1/drive/report` records the opaque token as `reported`. Reporting is idempotent for the same owner/token and cannot change the byte charge. A lost report leaves the local receipt pending; a later read-only verification can report it again without uploading.

Scheduled reports use the same ledger and CLI write contract with the run UUID as the reservation ID. After the sandbox exits, the trusted postprocessor verifies the run owner, current OAuth binding, configured tenant origin, policy folder and Drive identity, then uploads `idou-<run-id>.schedule.md`. A `reserved` row proves dispatch never began and may be attempted again; `dispatched` is an unknown outcome and is never automatically retransmitted; `reported` may only be verified read-only. The schedule database stores the state, digest, byte count, opaque file token and verified URL—not the report bytes. Failed task stdout/stderr tails are not persisted either.

All routes are bounded native-only JSON POSTs and revalidate the session after body reading. Unknown payload fields (including content) are rejected. There is no client release/delete endpoint. `reserved`, `dispatched` and `reported` all count against the budget, with no expiry-based refund. The ledger has a 100,000-record global bound; reaching it refuses new reservations rather than deleting accounting history.

## Deliberate remaining boundaries

- CLI bytes and remote file evidence are supplied/checked by the native client. A malicious or older client can bypass this protocol or under-report bytes; the user can also upload manually in Feishu. Production hard enforcement needs Feishu-side capacity/access policy or an independently trusted upload/verification channel. This increment must not be advertised as tenant-wide storage enforcement.
- Existing folder contents, legacy receipts, remote deletions/moves/size changes, Feishu free-space floors and externally initiated uploads are not inventoried. Reported success is **not server-verified completion**. Unknown or abandoned reservations retain their charge conservatively.
- Trusted remote reconciliation, administrator release/audit UI, automatic garbage collection and adoption of Wiki shards remain unfinished. Do not manually delete ledger rows to make space without accounting for potentially uploaded files. Increasing a policy limit is not proof of available Feishu capacity.
- Budgets are metadata-only and durable across process crashes on the tested local filesystem. Production backup, migrations, failover and enterprise/private CLI acceptance are not established by synthetic tests.

## Verification

`test/drive-budget.test.js` covers shared tenant aggregation, idempotency/owner isolation, target/policy mismatch, malformed/content payloads, one-shot dispatch, lost response, report conflicts, private-path configuration, corrupt database refusal, HTTP scope/parent revocation and the real server startup/shutdown entry. Eight actual competing Node processes requesting 20 bytes each under a 100-byte cap admit exactly five; a process killed after dispatch retains its charge and cannot issue another grant on reopening.

`test/media-delivery.test.js` additionally proves reservation/dispatch failures invoke no CLI upload and a lost server report recovers without reuploading. `scripts/smoke-media-desktop.js` uses actual Electron, HTTP service and SQLite with synthetic Feishu/MiniMax transports: cancellation charges nothing; one upload charges its actual bytes; lowering remaining budget blocks a second upload; restart/open is read-only. `docs/evidence/desktop-media-budget-denied-fixture.png` records the inspected denial UI. No live Feishu write, live model cost, credential reset or production deployment was performed.

## Scheduled reports go to their owner's own space (`.252`)

A scheduled task's report is no longer saved in the folder a policy names. It goes to the task owner's own root folder (我的空间), which the control plane reads from Feishu as that person. It is still charged to the tenant's `maxBytes`, and its reservation binds the folder it actually went to. Only the control plane can reserve for a destination other than the policy's folder, from inside its own process. No HTTP route accepts that, so a desktop still uploads only into the managed folder: media, files, application archives and Wiki bundles are unchanged.

The reason (security review of 2026-09-27): a policy names one folder per tenant, and every task owner had to be able to save there, so everyone in the tenant could open everyone's reports. Reports saved before the change stay in that folder until their owners or the administrator delete them.
