// What each hand-shaped write asks the CLI to send, on two builds side by side.
//
//   node scripts/compare-cli-write-shapes.js <previous lark-cli> [<new lark-cli>]
//
// The new build defaults to resources/lark-cli/darwin-arm64/lark-cli; during an
// upgrade the previous one is under resources/.upgrade-previous/. Every command
// runs with --dry-run: nothing is sent anywhere, and no credential is involved.
//
// The write contract (src/providers/feishu/cli-write-contract.js) binds a grant
// to the exact request the pinned CLI emits, and a changed shape is refused, not
// repaired. 1.0.96 added a field to `docs +create` and a poll after it; the
// grant refused the write and document creation stopped working. The commands
// below are the ones the product runs, argument for argument (document-authoring,
// document-edits, message-delivery, chat-reader, drive-files); a CHANGED line
// needs a look before the upgrade ships. cli.write and cli.delete are not
// listed: they plan from the CLI's own --dry-run and follow it.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const [previous, current = path.join(root, "resources/lark-cli/darwin-arm64/lark-cli")] = process.argv.slice(2).map((file) => path.resolve(file));
if (!previous) { console.error("usage: node scripts/compare-cli-write-shapes.js <previous lark-cli> [<new lark-cli>]"); process.exit(2); }

const dir = mkdtempSync(path.join(os.tmpdir(), "idou-write-shapes-")), config = mkdtempSync(path.join(os.tmpdir(), "idou-write-shapes-config-"));
writeFileSync(path.join(dir, "draft.md"), "# 标题\n\n正文\n");
writeFileSync(path.join(dir, "append.md"), "追加一段\n");
writeFileSync(path.join(dir, "replacement.xml"), "<p>新文字</p>");
writeFileSync(path.join(dir, "upload.bin"), Buffer.alloc(4096, 1));
const env = { PATH: "/usr/bin:/bin", HOME: dir, LARKSUITE_CLI_AUTH_PROXY: "http://127.0.0.1:9", LARKSUITE_CLI_PROXY_KEY: "dry-run", LARKSUITE_CLI_APP_ID: "cli_dry_run",
  LARKSUITE_CLI_BRAND: "feishu", LARKSUITE_CLI_DEFAULT_AS: "user", LARKSUITE_CLI_STRICT_MODE: "user", LARKSUITE_CLI_REMOTE_META: "off",
  LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1", LARKSUITE_CLI_CONFIG_DIR: config };
const DOC = "doxcnAbCdEf1234567890", FOLDER = "fldcnAbCdEf123456", MSG = "om_abcdef1234567890", USER = "ou_abcdef1234567890", CHAT = "oc_0123456789abcdef0123456789abcdef";
const post = JSON.stringify({ zh_cn: { content: [[{ tag: "text", text: "你好\n" }, { tag: "a", href: "https://x.feishu.cn/docx/A", text: "https://x.feishu.cn/docx/A" }]] } });
const CASES = {
  "document.create": ["docs", "+create", "--doc-format", "markdown", "--content", "@./draft.md"],
  "document.append": ["docs", "+update", "--doc", DOC, "--command", "append", "--content", "@./append.md", "--doc-format", "markdown", "--revision-id", "7"],
  "document.inline-replace": ["docs", "+update", "--doc", DOC, "--command", "str_replace", "--pattern", "旧文字", "--content", "@replacement.xml", "--revision-id", "7", "--doc-format", "xml"],
  "message.send (person)": ["im", "+messages-send", "--user-id", USER, "--text", "你好", "--idempotency-key", "k-1"],
  "message.send (group post)": ["im", "+messages-send", "--chat-id", CHAT, "--msg-type", "post", "--content", post, "--idempotency-key", "k-2"],
  "message.reply": ["im", "+messages-reply", "--message-id", MSG, "--text", "收到", "--idempotency-key", "k-3"],
  "message.reply (thread)": ["im", "+messages-reply", "--message-id", MSG, "--text", "收到", "--reply-in-thread", "--idempotency-key", "k-4"],
  "drive.upload": ["drive", "+upload", "--file", "upload.bin", "--name", "upload.bin", "--folder-token", FOLDER],
};
const plan = (binary, args) => {
  let out;
  try { out = execFileSync(binary, [...args, "--as", "user", "--format", "json", "--dry-run"], { cwd: dir, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (error) { out = String(error.stdout || error.stderr || error.message); }
  try { return (JSON.parse(out.slice(out.indexOf("{"))).data?.api ?? []).map(({ method, url, params, body }) => ({ method, url, params, body })); }
  catch { return { unreadable: out.slice(0, 300) }; }
};
let changed = 0;
for (const [name, args] of Object.entries(CASES)) {
  const [before, after] = [JSON.stringify(plan(previous, args)), JSON.stringify(plan(current, args))];
  if (before === after) { console.log(`SAME     ${name}`); continue; }
  changed += 1;
  console.log(`CHANGED  ${name}\n  before: ${before}\n  after:  ${after}`);
}
// A change is for a person to judge: a request the contract must now admit
// (re-record it), or one it rightly refuses and the CLI survives without (1.0.96's
// upload usage report is that). Either way node scripts/smoke-all-desktop.js
// says whether the product still works.
console.log(`\n${changed ? `${changed} write shape(s) changed: for each, re-record the contract in cli-write-contract.js or confirm the new request is refused harmlessly` : "no write shape changed"}`);
process.exitCode = changed ? 1 : 0;
