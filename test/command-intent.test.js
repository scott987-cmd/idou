import test from "node:test";
import assert from "node:assert/strict";
import { agentActions, executedText, larkShortcut } from "../src/desktop/renderer/command-intent.js";
import { workStepView } from "../src/desktop/renderer/cowork-timeline.js";
import { approvalPresentation } from "../src/desktop/renderer/confirmation-view.js";

// Commands in the shapes the task record keeps them (2026-09-23, the launch
// task): wrapped in /bin/zsh -c "..." with the inner quotes escaped, or in
// /bin/zsh -c '...'. Paths shortened; structure unchanged.
const AGENT = "/Applications/i豆.app/Contents/Resources/app/bin/agent.js";
// The step that rewrote the adoption record. Its heredoc says media-create
// --kind video and its python mentions `media-save`; it runs neither.
const REGISTER = `/bin/zsh -c "cat > /Users/x/campaign/media/media-adoption.md <<'ADOPT_EOF'
# 媒体采用登记（v1.1.0 · 2026-09-23）

| D5-alt | concept-6s 概念视频 | i豆 media-create --kind video，job 9c965670 | previewed |
ADOPT_EOF
wc -l /Users/x/campaign/media/media-adoption.md

# Add P-6 to ClaimLedger
python3 -c \\"
p = '/Users/x/campaign/claims/ClaimLedger.md'
new = '| P-6：D5-alt 候选登记；未 \`media-save\`（A2=否） |'
print('P-6 added')
\\""`;
const CREATE = `/bin/zsh -c "node \\"${AGENT}\\" media-create --kind video \\\\
  --prompt-file /Users/x/campaign/media/concept-6s.happyhorse.model.txt 2>&1"`;
const POLL = `/bin/zsh -c 'JOB="9c965670-f4bd-4190-994d-3b29de7818cc"
for i in $(seq 1 120); do
  RESP=$(node "${AGENT}" media-status --job "$JOB" 2>&1)
  sleep 5
done'`;
const step = (command) => workStepView({ kind: "command", command, entry: { id: "x", type: "commandExecution", status: "completed" } });

test("a command that only writes about an action is not titled as that action", () => {
  // It used to read 生成视频: the name was looked for anywhere in the text.
  assert.equal(step(REGISTER).title, "处理任务");
  assert.equal(approvalPresentation({ kind: "command", command: REGISTER }, "cowork").title, "确认处理任务");
  assert.deepEqual(agentActions(REGISTER), []);
  // The ones that do run it keep their titles.
  assert.equal(step(CREATE).title, "生成视频");
  assert.equal(approvalPresentation({ kind: "command", command: CREATE }, "cowork").title, "确认生成视频");
  assert.equal(step(POLL).title, "查询媒体生成进度");
});

// The card's headline is what the person decides by. A note that mentions
// doc-create must not be put to them as 确认创建飞书文档.
test("an approval is headlined by the action run, never by one named in a note or in backticks", () => {
  const note = `/bin/zsh -c "cat > /tmp/plan.md <<'EOF'
下一步：node agent.js doc-create --content-file report.md
EOF
rm -f /tmp/draft.md"`;
  assert.equal(approvalPresentation({ kind: "command", command: note }, "cowork").title, "确认处理任务");
  const prose = `/bin/zsh -c 'echo "等你确认后我再跑 \`agent.js doc-share\`"'`;
  assert.equal(approvalPresentation({ kind: "command", command: prose }, "cowork").title, "确认处理任务");
  const real = `/bin/zsh -c "node \\"${AGENT}\\" doc-create --content-file \\"/tmp/季度报告.md\\""`;
  assert.deepEqual([approvalPresentation({ kind: "command", command: real }, "cowork").title, approvalPresentation({ kind: "command", command: real }, "cowork").target],
    ["确认创建飞书文档", "季度报告.md"]);
});

// Inside a double-quoted zsh -c the value's quotes arrive escaped; the target
// used to come out as a lone backslash.
test("an option in escaped quotes is read whole", () => {
  const search = step(`/bin/zsh -c "node \\"${AGENT}\\" kb-search --query \\"住宿费 上限\\""`);
  assert.deepEqual([search.title, search.target], ["检索知识库", "住宿费 上限"]);
  assert.equal(step(`/bin/zsh -c 'node "${AGENT}" kb-search --query "住宿费上限"'`).target, "住宿费上限");
});

test("heredocs in every quoting are data, and a here-string is not a heredoc", () => {
  // Inside a single-quoted zsh -c the delimiter's quotes come as '"'"'.
  const nested = `/bin/zsh -c 'cat > a.md <<'"'"'EOF'"'"'
node agent.js media-create --kind image
EOF
node "${AGENT}" media-preview --job 8f14e45f-ceea-467a-9d3a-bd6cb2f5a8f1'`;
  assert.deepEqual(agentActions(nested).map((row) => row.action), ["media-preview"]);
  // <<- lets the terminator be indented with tabs.
  const indented = "cat <<-EOF > a.md\n\tnode agent.js doc-share\n\tEOF\nnode /app/agent.js kb-read --doc aaaaa";
  assert.deepEqual(agentActions(indented).map((row) => row.action), ["kb-read"]);
  // A here-string feeds one line; the lines after it still run. (Read as a
  // heredoc, <<< "x" would swallow every line up to one saying x.)
  const herestring = `python3 -c "import sys; print(sys.stdin.read())" <<< "x"\nnode "${AGENT}" media-status --job 8f14e45f-ceea-467a-9d3a-bd6cb2f5a8f1`;
  assert.deepEqual(agentActions(herestring).map((row) => row.action), ["media-status"]);
  // One the wrapper closes on its last line is data to the end.
  assert.equal(executedText(`/bin/zsh -c "cat > a <<'EOF'\nnode agent.js doc-create\nEOF"`).includes("doc-create"), false);
});

test("a Feishu shortcut counts only when the CLI runs it", () => {
  const cli = "/Applications/i豆.app/Contents/Resources/lark-cli/darwin-arm64/lark-cli";
  assert.deepEqual(larkShortcut(`/bin/zsh -c "\\"${cli}\\" sheets +read --spreadsheet-token abc"`), { domain: "sheets", verb: "read" });
  assert.deepEqual(larkShortcut(`${cli} --as user calendar +agenda`), { domain: "calendar", verb: "agenda" });
  assert.equal(step(`${cli} --as user calendar +agenda`).title, "读取飞书日程");
  assert.equal(larkShortcut(`cat > notes.md <<'EOF'\nlark-cli sheets +write 之后再核对\nEOF`), null);
  assert.equal(step(`echo "改用 sheets +write 写回"`).title, "处理任务");
});
