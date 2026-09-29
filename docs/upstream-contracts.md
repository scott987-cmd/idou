# Upstream contracts

## Codex runtime

Boundary: `codex app-server --stdio`, JSON-RPC v2 methods and notifications.

Upgrade procedure:

1. Install the candidate Codex CLI without changing the production pin.
2. Generate its schema with `codex app-server generate-json-schema` and compare it with the validated version.
3. Run adapter tests for initialization, thread start, one turn, approval callbacks, interruption, and resume.
4. Update the application event translator, then `upstreams.lock.json`.
5. Roll out to a canary runner pool before general deployment.

The application persists its own stable session/event schema. Raw app-server messages may be retained for diagnostics but are never the database contract.

## Feishu provider v1

### Choosing a deployment

A Feishu deployment is a **definition** (`src/providers/feishu/provider-definition.js`), and the only place one is chosen is the registry (`src/providers/feishu/provider-registry.js`), asked once by each composition root: the desktop main process (`feishu.provider` / `IDOU_FEISHU_PROVIDER`), the control plane (`FEISHU_PROVIDER`) and `doctor`. This build ships one, `saas-cli` (`src/providers/feishu/saas-definition.js`); asking for any other name stops startup with the list of names it knows. A definition declares:

| Part | What it answers | SaaS |
| --- | --- | --- |
| `id`, `label` | which deployment a record, grant or tenant row names | `saas-cli`, 飞书 |
| `capabilities` | each of documents, document search, document writes, sheets, Base, chat reading, message sending, Drive, Wiki, application bot, embedded pages — every one declared | all present |
| `openApi` | the OpenAPI and sign-in origins, for the one protocol the control plane speaks (`feishu-openapi-v1`, `src/providers/feishu/openapi.js`) | `open.feishu.cn`, `accounts.feishu.cn` |
| `ids` | the shape of an application, person and chat id; for `feishu-openapi-v1` a deployment may only narrow the protocol's `ou_`/`oc_` | `cli_…`, `ou_…`, `oc_…` |
| `web` | which hosts' links name its resources, which hosts the embedded browser may stay on, where the sign-in cookie lives, each section's path, the client chrome hidden in it, and where its messenger names the open conversation (handed to the page preload; a deployment that does not say gets no chat names) | `feishu.cn`, `larksuite.com`, `doubao.com` / `feishu.net` |
| `references`, `links` | reading a link into a resource and building the canonical link back; a built link must read back as the same resource or it is not used | `/docx/`, `/sheets/`, `/base/`, `/drive/folder/`, `/drive/file/` |
| `runtime` | which bundled binary and which lock entry | `lark-cli`, `feishu` |
| `client` | the adapters: the CLI client, the Wiki source reader, the Base reader, the CLI bridge sidecar | the `Saas*` classes |

Business code asks the definition and never which definition it has. A capability a deployment lacks is refused by the definition itself — an adapter it did not declare is replaced by one whose every call throws `FeishuCapabilityUnavailable` with a sentence naming the deployment and the capability — so nothing falls back to another deployment's service. The desktop shows those sentences where the person would reach for the capability (`feishu-deployment` IPC).

The origins a person's credentials are sent to are part of reviewed code, or of an administrator's deployment that a definition validates; a definition that takes no deployment settings (SaaS) refuses any that are given. Every upstream request is `redirect: "error"`, and the CLI bridge refuses a CLI that names any origin but the deployment's.

`test/feishu-provider-contract.test.js` runs one set of business contracts — sign-in, link resolution, reading, permission checks, Drive, notification, the Wiki copy and the Wiki verifier, the CLI bridge and sandbox reads — against SaaS and against `scripts/fixtures/private-feishu.js`, a private deployment that does not exist: its own domains, identifier rules and link shapes, and six capabilities missing. `npm run test:private-deployment-desktop` runs the real desktop configured for it by name. Neither says anything about a real private Feishu: no private CLI exists yet to write its adapter against.

### What a replacement CLI must provide

The SaaS implementation uses `lark-cli 1.0.78`. A private-cloud replacement must provide:

The native executable and LICENSE are shipped with the application; end users do not install lark-cli. See [runtime packaging](runtime-packaging.md) for target pins, validation, and release steps.

The SaaS package is compiled from the pinned upstream commit with its `authsidecar` build tag. The provider accepts a native-process environment contract so application login can authorize read-only CLI calls without placing the OAuth token or App Secret in the CLI process. Private-cloud replacements may implement a different broker internally, but must preserve the same token-custody and provider boundary. See [single-login bridge](feishu-cli-bridge.md).

- a machine-readable semantic version;
- `skills list` returning an object with `ok: true` and a `skills` array;
- `skills read` for `SKILL.md` and referenced text resources;
- JSON stdout for successful business commands and non-zero exit codes for failures;
- named profiles without silently changing the active profile;
- an explicit high-risk confirmation mechanism;
- a way to inspect command schema/help without performing the action.

Authentication file locations and vendor-specific error payloads are adapter-private. The product maps errors to `unauthenticated`, `forbidden`, `not_found`, `conflict`, `rate_limited`, `unavailable`, or `invalid_request`.

The current SaaS provider also relies on:

- `auth login` Device Flow only for the separate development/fallback profile;
- `drive +status` and `drive +push` for file-level wiki synchronization;
- `drive quota_details get` for quota preflight;
- `contact +search-user` for recipient resolution;
- `im +messages-send` for direct/group delivery with idempotency keys;
- `drive +member-add` only after a separate high-risk permission confirmation.

The private provider must offer equivalent behavior, but its command names may differ inside the adapter.

The document-reader increment additionally exposes semantic `readDocument(reference)` and `documentConnection()` methods. Read results must bind resource ID, source URL, revision, content hash, readable projection, partial/resource limitations and verified caller identity. The SaaS implementation uses `auth status --json --verify` and `docs +fetch --as user`; a private implementation must translate its own CLI output into that contract. See [reader evidence and outstanding auth compatibility](feishu-document-reader.md).
