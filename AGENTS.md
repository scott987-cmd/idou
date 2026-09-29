# i豆 (idou) repository guidance

## Architectural invariants

- Treat Codex as an upstream runtime. Integrate through `codex app-server`; do not patch upstream Rust code for product features.
- Treat Feishu as a provider contract. SaaS `lark-cli` is the current provider; private-cloud support must be added as another provider, not as conditionals in application code.
- Ship the native Feishu CLI and LICENSE as application resources. Resolve the bundled absolute path, verify its pinned digest, and never fall back to system PATH or download at startup. Both provider calls and the Agent's shell must use this runtime.
- Keep tenant identity, resource identity, ACL evidence, and source revision on every knowledge record.
- An indexed document is not proof that a caller may read it. Query results must be filtered by the caller's current authorization.
- Feishu documents are the source of truth. Derived wiki shards and generated media are persisted in Feishu Drive; the control plane must not store their bytes.
- Model-provider keys and Feishu application secrets are server-only. A client may hold only a device-bound session and short-lived scoped agent token.
- A confirmation card — a Feishu write, a send, a deletion, enabling a local skill — is answered only by the person. Tests and automation may stop at a card or cancel it, never confirm it; a deletion is confirmed in code (`cli.delete`, the red deletion card, `approveDeletion`), not by convention.
- By default the Agent asks before every outward action; once the person authorizes, it finishes on its own. Choosing 完全访问 for a task is that authorization: the Agent's writes, deletions, sends, uploads, images, calendar and Feishu tasks, scheduled tasks and the skills it enables then raise no card (`permitsUnattendedActions`), and a deletion is authorized in code by `approveDeletionForFullAccess`, never as a forged card answer. A video always asks: the Qwen Token Plan allows interactive use only. Server policy, one-shot grants and read-before-write checks apply either way. A new outward action must consult the task's full access (`test/full-access-authorization.test.js` checks every Agent action module).
- Do not copy embedded Feishu skill instructions into this repository. Read them from the selected CLI so instructions and the binary remain version-aligned.
- If the selected CLI reports an unavailable Keychain, do not retry business commands or `--dry-run`: this binary may initialize credentials before its dry-run path. Continue with local `skills`/`--help` metadata and isolated fixtures until the user repairs the credential environment. Never reset or downgrade key storage to unblock tests.

## Names

- The product was called 我的豆包 (MyDouBao) until September 2026. Code, and every name written for the first time, uses `idou`; an installation or deployment made before the rename keeps its old names, and old `MYDOUBAO_*` settings are still read (`src/env-names.js`).
- A new name written outside the process — a Drive file, a request header, a container label, a cookie — goes through `src/product-names.js`; a new local path through `src/install-names.js`; a new PostgreSQL table is written `idou_…` and opened through `namedDatabase` (`src/control-plane/database-names.js`), which keeps a database created under the old name on its old tables.
- The sealing and signing labels pinned in `test/product-names.test.js` never change: data sealed under them has to stay readable.

## Verification

- Run `npm run check` for every source change.
- Run `node bin/idou.js doctor` when changing an upstream adapter.
- Update `upstreams.lock.json` only after adapter contract tests pass with the new binary. Upgrade lark-cli or Codex only through `docs/upgrading-upstreams.md`: stage with `scripts/upgrade-upstream.js`, build the sandbox with `--candidate`, sign, then run the gate. A plain sandbox build checks against the signed release and refuses any new version, by design.
- A source checkout is not held to the release signature (development mode, `src/providers/release-manifest.js`): `npm run check` runs whatever the source is, and the bundled binaries are still checked against `upstreams.lock.json`. A release is: sign it with a new release id (never reused), run `npm run check:release` (strict), and do not touch `src/` or `bin/` between signing and packaging or deploying. Tests of the signed release itself skip in development and run under `check:release`. The installed app, a server's release directory and the packaging, signing and sandbox scripts are always strict.
- Run the desktop schedules smoke as `IDOU_SMOKE_NO_LIVE=1 npm run test:schedules-desktop` unless a paid live run was approved.
- Model Feishu the way it was measured: a refusal is HTTP 400 with a JSON body carrying the code (131005, 1063001, 99991672 seen live); a proven "no" is HTTP 200, code 0, `auth_result: false`. A fixture that answers a refusal with 200 exercises a path production never takes.
- When changing how links resolve to resources, also run `node scripts/acceptance-wiki-pinning.js <cases.json>` against a real tenant, with a cases file that names resources already in it (the script's header describes the file). It only reads.
- Every problem found becomes a test, written so that it fails without the fix; tests use synthetic tenants, tokens and identities, never ones copied from a real account.

## Maintainer notes

`docs/internal/` holds the maintainers' own working notes: their server, their Feishu tenant, handoffs between agents, evidence from live runs. It is not published. When it exists in your checkout, read `docs/internal/README.md` before anything else.
