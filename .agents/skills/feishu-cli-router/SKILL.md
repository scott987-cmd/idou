---
name: feishu-cli-router
description: Use the configured Feishu CLI for enterprise documents, wiki, meetings, messages, calendars, tasks, approvals, mail, and related Feishu work.
---

# Feishu CLI router

Use the selected `lark-cli` provider. Its embedded skills are the authority for command syntax and domain workflow because they are built from the same version as the executable.

1. Run `lark-cli skills list` and select the narrow skill matching the request.
2. Read it with `lark-cli skills read <skill>`.
3. Read only referenced files needed for the request with `lark-cli skills read <skill> <relative-path>`.
4. Inspect unfamiliar commands with `lark-cli <domain> --help` or schemas with `lark-cli schema <service.resource.method>` before invoking them.

Keep the configured profile and identity unchanged unless the user explicitly asks to change them. Use `--dry-run` when it materially clarifies a write. Never add `--yes` to a high-risk operation without the user's explicit confirmation.

An indexed knowledge record never grants access to its source. Before returning protected content from a knowledge index, enforce the caller's current source authorization and include the source link.

