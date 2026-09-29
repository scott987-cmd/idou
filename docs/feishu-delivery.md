# Feishu delivery and mentions

## Implemented: reviewed document-link private message

**文件与协作 → 打开飞书文档 → 发送到飞书… → 同事私信** provides a working native workflow. This section describes current implementation; the broader design below remains a target, not a claim that every artifact or permission option is implemented.

- Search same-tenant active users by name/email, select one explicitly, optionally add a plain-text note, preview the exact message, then confirm in a native dialog. Same-name matches show department, email and stable ID; none is selected automatically. Partial search results ask the user to refine their query.
- Only the document title, source URL and optional note are sent. The source title is bounded and normalized (including full-width `<`); the displayed preview is the actual sent text. Notes are limited to 1000 characters and reject `<` mention markup and control/bidi characters. Literal-text CLI mode avoids Markdown image uploads or fabricated group mentions. No full document body or model-generated summary is forwarded.
- The sending identity is the existing, verified **CLI user**, not the bot or an assumed application SSO identity. The dialog includes the CLI tenant/principal fingerprint, recipient ID/details, full message and permission warning. Enterprise SSO-to-CLI linkage remains unavailable; the existing enterprise business gate rejects this workflow too.
- `DocumentDelivery` owns native recipient handles and expiring previews. Renderer-supplied names, IDs and preview text cannot replace native data. Source handle, provider/resource, revision/hash and CLI identity are revalidated; recipient metadata and same-tenant activation status are rechecked before sending. A final source read occurs after recipient preflight. Concurrent document edits and same-task Agent sends are guarded. Reads and send are not one atomic Feishu transaction: external credential/ACL changes can still race between the final checks and the CLI process, whose server-side authorization remains authoritative.
- The SaaS provider exposes `messages.search(query)` and `messages.send(request, beforeDispatch)`. Search returns `{identity, users:[{id,name,department,email}], hasMore, excluded}`. Send validates the expected identity/recipient, awaits the application callback exactly once **before** its one external send, then returns `{messageId,chatId}` or an ambiguous error. Private-cloud CLI replacement must preserve these semantics; application/UI code contains no SaaS command syntax. Both calls use the bundled, hash-verified binary and explicit `--as user`.
- The task file saves the exact intent and idempotency key before dispatch, then the receipt or unknown outcome. No automatic retry occurs. Same-task/sender/resource/recipient/exact-text fingerprint blocks duplicate submission even after reopening/restart; a changed source revision alone does not authorize resending the same link text. This is not global cross-device deduplication or guaranteed power-loss durability. CLI idempotency only promises a one-hour window; the application does not rely on it for later retries. Deliberately different messages require a new preview and confirmation.
- `acknowledged` means a structurally valid CLI receipt, **not** delivery/read status or recipient document access. Unknown or restored in-flight entries ask the user to inspect Feishu manually. The UI shows the latest 10 matching document records; all are retained locally, with a 100-record per-task beta cap. It does not query message status, recall messages, clear unknown attempts, or automatically resend them. No record/body bytes go to the control server in this path.
- No Drive permission calls, bot fallback, implicit login or model calls are made. The user's supplied real test document remains read-only and untouched. Real CLI authentication, contact response shape, permissions, message formatting and send behavior still need live acceptance; fixture success is not proof of them.
- These checks protect this native document-delivery workflow, not arbitrary Agent shell/CLI execution or a modified client. Enterprise-wide outbound-tool policy, server-side enforcement/audit and DLP remain unfinished; a UI confirmation alone is not that security boundary.

Verification: `node --test test/document-delivery.test.js` and `node scripts/smoke-document-delivery-desktop.js`. The latter now drives the Agent's `doc-share-search` / `doc-share` operations as a real `bin/agent.js` child process — the dialog is gone, the application layer is the same — through actual Electron, production native services/IPC, the loopback Agent bridge, the in-app confirmation card and real task persistence, with **synthetic CLI upstreams only**. It covers same-name candidates, refusal of a typed `open_id` and of a handle no search issued, cancellation, confirmation-time source change, the `dispatching` record observed from inside the send, accepted/unknown outcomes and restart duplicate refusal. It sends two synthetic messages, zero live messages, zero document/ACL writes and makes zero model calls. The confirmation and post-restart screenshots are `docs/evidence/desktop-document-delivery-preview-fixture.png` and `-restart-fixture.png`; the message scrolls inside the card while the boundary statement and the answer buttons stay on screen.

## Implemented: group delivery with explicit member mentions

The same dialog now also offers **群聊与 @ 提醒**. Select one group, optionally choose up to 10 returned members, review the exact group/mention identities and title/link/note, then confirm a native group-send dialog. The feature sends one new group message, not a private message to each mentioned person and not a reply to an existing topic.

- Search uses the bundled `im +chat-search` with `private,public_joined` and explicit user identity. External/dissolved/incompatible results are excluded, and empty results never trigger enumeration or automatic joining. Same-name groups show description and stable ID; no default selection. This is not enterprise-wide chat search.
- Selecting a group calls `im chats get` (its current schema was inspected), verifies internal tenant/type/status/name/owner, then reads user members with `im +chat-members-list`. Both regular and topic groups are accepted; private/public type is shown in review. Member loading is capped at 10 pages of 100 and one MiB/30 seconds. `has_more` and server `truncations` are surfaced as incomplete results; client filtering only covers loaded users. Only positively returned same-tenant member IDs can be selected; unavailable members are not guessed from a directory and bots/@all are not offered. Membership is not proof that an account is activated or will receive a notification.
- Opaque native handles bind the selected group, roster and mention set to the task/source/identity. A late member-list result cannot replace a newer group choice. Duplicate/forged/other-group handles and more than 10 selections are refused. IDs are sorted by code-point order, so reversing checkbox selection does not evade same-intent deduplication.
- `messages.searchGroups(query)` returns `{identity, groups, hasMore, excluded}`. `messages.groupMembers(group, identity)` returns `{group, members, partial, excluded}`. Group descriptors include `kind:"group"`, ID/name/owner/description, tenant key, chat type/mode and nullable member count; member descriptors contain ID/name/tenant key. Application/UI code contains no CLI flags or SaaS URL parsing. Private-cloud adapters must preserve these identity, roster and pre-dispatch semantics.
- Group send uses `im +messages-send --chat-id ... --msg-type post --content ... --as user`. Its static post contains only typed `at`, `text` and `a` nodes. The body text equals the reviewed title/link/note; one hyperlink's displayed text and `href` both equal the canonical source URL. Arbitrary link targets, raw `<at>` input, media uploads, interactive cards and `all` mentions are not accepted. Typed `a`/`href` link structure follows the [Feishu official rich-text example](https://www.feishu.cn/content/7271149634339422210); `at` node/identity/envelope semantics come from the bundled IM/shared skills. The current CLI has no `im.messages.create` schema, so no guessed native create endpoint was used. Actual Feishu rendering/clickability/notification delivery still need live acceptance.
- Native confirmation shows group name/ID/type, owner ID, reported user count, selected @ member names/IDs, source message and sending CLI identity. **Everyone within the group's visibility scope may see the message; @ only selects whom to notify.** Mentioning people does not limit the audience or grant document access. A joined public group can have broader visibility than its current member roster. Permissions remain unchanged; the source body is not sent.
- Immediately before dispatch, group metadata and selected member identities are re-read, then the source is reauthorized through the existing intent callback. Rename/owner/type/mode/count/tenant changes, departed/renamed/unavailable selected members or failed reads reject the operation. These reads and send are not atomic; unselected roster changes and changes after the final checks can race. Server-side authorization remains authoritative. Receipt `chat_id` must equal the confirmed group; mismatch is unknown, never a successful receipt for another chat.
- Existing save-before-send, one-shot confirmation, unknown-result retention and restart no-resend behavior apply. Group deduplication additionally binds the sorted mention IDs. Private-message fingerprints and prior task records remain compatible. The UI locks recipient/roster/note controls while a send is pending and keeps the footer visible in a narrow window. Confirmation and audit do not enforce policy on arbitrary Agent shell commands; server-side outbound policy/DLP remains open.

Verification: `node --test test/document-group-delivery.test.js` (10 tests) and `node scripts/smoke-document-group-delivery-desktop.js`. Actual Electron/production IPC/task files use synthetic CLI upstreams and intercepted native-dialog choices. The desktop test covers two same-name groups and users, member filtering, partial-list warning, cancellation, selected member removal during confirmation, exact typed @ and hyperlink nodes, locked controls while dispatch waits, a visible footer at 850×700, persisted accepted/unknown records and restart duplicate refusal with reversed member selection. Two synthetic group messages, zero live messages, zero document/ACL writes, zero model calls. Preview/narrow/receipt screenshots are under `docs/evidence/desktop-document-group-*-fixture.png`.

Still to implement: multiple independent recipients/groups per delivery, answers/media/coding artifact delivery, snapshots with DLP, explicit permission grants, message readback/reconciliation, server audit policy, multi-device coordination, complete large-group member discovery and live SaaS/private CLI acceptance. Embedded chat browsing/replies are separate unfinished workflows.

## Broader product design (not all implemented)

Every generated document, answer, image, video, or Coding artifact exposes one `Send to Feishu…` action. It creates a draft; it never sends immediately.

## Delivery draft

The draft contains:

- exact recipient people and/or group chat;
- sending identity (`user` by default for a human-authored action, `bot` for an automation);
- content mode: link, snapshot, image/file, or video;
- document permission policy: keep current permissions, grant view, or grant edit;
- exact message preview and an idempotency key.

Names and emails resolve through `contact +search-user` to stable `open_id` values. Ambiguous matches require user selection. A direct send uses `im +messages-send --user-id`; a group send uses `--chat-id` and a structured `<at user_id="ou_…">name</at>` mention. Images, files, and videos use the media flags; videos also require a cover.

## Permission is separate from notification

Sending a document link does not imply granting access. The UI presents these choices explicitly:

1. Send link with current permissions.
2. Grant view, then send link.
3. Grant edit, then send link.
4. Send a content snapshot without changing document permissions.

Granting access uses `drive +member-add`, is high-risk, and receives its own confirmation. Snapshot delivery can disclose content to someone who cannot open the source, so DLP and recipient confirmation apply to it as well. If a permission step fails, the message is not sent unless the user chooses link-only after seeing the failure.

## Reliable execution

Resolve recipients and preview first, then confirm recipient, content, and sending identity immediately before the external write. Use the delivery ID-derived idempotency key for the message. Persist the resulting message ID, chat ID, document token, permission result, and audit trace without storing the full document body.
