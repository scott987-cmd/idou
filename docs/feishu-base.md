# Feishu Base workspace: typed page, proposals and confirmed record edits

In a work task, open **文件与协作 → 打开飞书内容**, choose **多维表格** and paste a SaaS Base link (`https://…/base/<token>?table=<tblId>`). Title search and Wiki-wrapped Base links are not supported yet. The application shows one page of one table beside the conversation — at most 20 records and 30 fields, starting from a chosen record — and lists which fields can be edited. **数据表** and **从第几条读起** move to another table or page.

With the reference checked, a question sends that page as context. **生成记录修改建议 · 核对确认后才写入** asks for a tool-free proposal of up to 20 new values across at most 10 records. Under a valid proposal, **核对并写入飞书多维表格** writes them after a confirmation card, and a write whose outcome is fully known can be undone once with **撤销这次写入**. A write whose read-back did not settle it can be read again with **重新读回核对**.

## Reading

`SaasBaseRecords` (`src/providers/feishu/base-records.js`) reads through the pinned CLI's own `base` shortcuts, always as the current user. `+table-list`, `+field-list` and `+record-list` are GETs. `+record-get` is `POST /open-apis/base/v3/bases/<token>/tables/<tblId>/records/batch_get`, which the control plane admits as a named read with a closed body — 1–100 unique `rec…` ids and at most 50 field names, nothing else (`src/providers/feishu/cli-read-contract.js`). The request shapes were recorded with `--dry-run` from the pinned 1.0.78, and the responses read live from a test Base:

- a field list names each field's `type` as a string (`text`, `number`, `select`, `user`, …) with its `style`;
- a record list, and records read by id, come back as columns — `fields`, `field_id_list` and `field_type_list` beside `record_id_list` and `data` — one row per record in that response's own field order, which is not the field list's order, so cells are aligned by field id, never by position;
- text arrives as a string and a number as a number.

A response whose columns do not line up, that repeats a record, or that names a field the field list does not know is refused rather than displayed. Values are rendered as text only. The page is read between two identity checks. A Base has no version a write could be conditioned on: its `rev` is read with a lag (measured live), so the page's content digest stands for its version, and a reference is read again and compared before it is sent. The knowledge copy keeps its own text projection (`src/providers/feishu/base-reader.js`).

### Every field kind, as read (2026-10-06)

Recorded from a test Base with one field of each kind the CLI creates and a second table its links point into, in `test/fixtures/base-field-shapes.json` (lark-cli 1.0.94, as the user; every id and person replaced):

- `+field-list` and `+table-get` list fields in a different order on every call. The order a person sees is the first grid view's: `+view-get-visible-fields` (a GET) gives it — by field **name** — and `+table-get` names the `primary_field` by id. Sites lay their columns out in that order.
- Type names: `text` (with `style.type` `plain`, `phone`, `url`, `email`, `barcode`), `number` (`plain`, `currency`, `progress`, `rating`; `style.percentage` for a percentage), `select` (`multiple: true` for several options), `datetime`, `created_at`, `updated_at` (`style.format`, e.g. `yyyy-MM-dd HH:mm`), `checkbox`, `user`, `group_chat`, `created_by`, `updated_by`, `link` (to records of `link_table`), `auto_number`, `location`, `attachment`, `formula`.
- Values: a date or time is an ISO 8601 string with its offset (`"2026-10-06T09:30:00.000+08:00"`), never milliseconds; a select, single or not, is a list of option names; a person is `[{ "id": "ou_…", "name": "…" }]`; a `link` is `[{ "id": "rec…" }]` and nothing else — its names are the linked table's primary field, read by id; a `url` text is Markdown, `"[北极星官网](https://…)"`, and a bare address `"[https://…](https://…)"`; a location is `{ full_address, lat, lng }`; an attachment is `[{ file_token, name, size }]`; an auto number is a string (`"T-001"`); an empty cell is `null`.
- A formula's result is a string whatever it computes, and its field says nothing of its type: a number is `"3370.35"`, and a date is a day count — `[截止日期]+7` gives `"46030"`. Sites show formulas as text; a formula meant to be read as a date should format it itself (`TEXT(...)`).
- A change in a linked table (a project renamed, a budget changed) shows in this table's links and formulas within two seconds, and this table's `rev` does not move. `+table-list` gives every table's `rev` in one call, so a site's probe includes the tables its links point into, and every table when it shows a formula.

## Editable fields

Only plain text fields and plain or currency number fields are offered for editing. People, options, dates, attachments, links, formulas, phone, URL and email text, and every other kind are shown, and marked read-only, until their value shapes have been recorded.

## Proposals

`baseEditProposal` (`src/application/base-proposal.js`) accepts exactly `{"kind":"feishu-base-edit","changes":[{"record","field","value"}]}`: 1–20 changes across at most 10 records, each record and field once; records on the page that was read and fields marked writable; a non-empty string of at most 2,000 characters for text, or a safe finite number; and a value that actually changes. No clearing, no other field types, no new or deleted records. The proposal model runs with `tools: []` and `tool_choice: none`, and the source is read again before the answer is accepted.

## Writing a reviewed proposal

`BaseEdits` (`src/application/base-edit.js`) and `SaasBaseEdits` (`src/providers/feishu/base-edits.js`):

1. **Plan.** The changes become `{"update_records": {recordId: {fieldName: value}}}`, and the bundled CLI plans `base +record-batch-update` with `--dry-run`. The plan is refused unless it is the `base.records` family, not destructive, `POST …/records/batch_update` for that table, with a body of exactly those records, fields and values.
2. **Confirm.** The card 「确认写入飞书多维表格」 lists each change as record (with a recognisable value) · field · typed before → typed after, and says what a Base cannot promise. The draft is usable once, and the table must still be the page the proposal was made from.
3. **Check just before dispatch.** A fresh identity check, then a read of just those records and fields: every record must still exist, every field must still carry the confirmed name — the update is keyed by name, so a renamed field would send it elsewhere — and every changed field must still hold the value on the card, compared with its type.
4. **Dispatch.** The intent is saved as `dispatching` before the CLI runs, the page on screen is dropped, and the write travels under a one-shot `cli.write` grant bound to the dry run's method, path and body digest. One write per task and per table at a time; nothing is retried.
5. **Verify.** The records are read back and each changed field compared with the confirmed value, typed. Feishu can serve a Base read from before a write for a moment — live, the read-back straight after a confirmed batch update held the old values both times it was tried, and an independent reader first saw an undo's values in a read starting 2.2 s after the update began — so while any field still holds its value from before the write, the fields are read again after waits of 1, 2, 3, 4 and 5 seconds. The outcome is `verified`; `mismatch`, listing each difference and any field the receipt says it ignored; or `unknown`, when a field still holds its old value after the last read, or anything fails after dispatch, including the read-back itself. The write is never repeated.
6. **Read again.** Under an `unknown` or `mismatch` outcome, **重新读回核对** reads the same fields once more, after a fresh identity check, and records what that read finds. It writes nothing, so it has no card. A write whose fields all turn out to hold the confirmed values becomes `verified`, and can then be undone.
7. **Undo.** Once, through its own card, by the same steps in reverse, for a `verified` write or for a mismatch in which Feishu kept each value in another form (a number as text). Every field must still hold what the read-back found; a field that was empty is written back as `null`.

**The gap a Base leaves.** Nothing in a Base lets one writer notice another: `rev` lags, and the batch update answers only with the fields it ignored. The check before the write narrows the window to a second or two and the read-back proves the outcome, but a change someone makes to the same field inside that window is overwritten and cannot be detected afterwards. The confirmation card says so.

**What `rev` is good for: knowing a table has not moved.** Measured on a real Base, 2026-10-04 (`docs/evidence/base-20k-live.txt`): `+table-list` gives each table `id`, `name`, `records_count` and `rev`; that `rev` is the same number as `+record-list`'s and moves by one with every write call -- records added, a text, number or option changed, a field renamed -- whatever the call touched. It shows a write 1–3 seconds after the call returns; in three tries it was never ahead of the records' values. It is not a condition a write can be made on, but it does say "nothing written since", which is what a table site's refresh asks before reading 100 pages again (docs/sites-phase1.md §1.7).

## Limits and verification

- SaaS HTTPS `base` links only; Wiki-wrapped Bases and title search are not supported yet.
- One page: at most 20 records and 30 fields; the context is capped at 24,000 characters.
- Tests: `test/base-records.test.js`, `test/base-service.test.js`, `test/base-proposal.test.js`, `test/base-edit.test.js`. `node scripts/smoke-base-desktop.js` opens a Base, asks a question, generates a proposal, proves cancellation writes nothing, and then waits for the person to confirm one synthetic write in the actual Electron app. The confirmed result is read back field by field; no live account or network is used.
