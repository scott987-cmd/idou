// Findings of the UI rules that are known and accepted, each with the reason.
// An entry here is a decision, not a way to make the suite pass: it names the
// finding exactly and says why the application is right as it is.
//
// kind   the rule (「被遮挡」, 「英文」, ...)
// where  a regular expression the finding's element must match
// detail optional regular expression for the finding's detail
// why    the reason it is accepted
export const ACCEPTED = [
  { kind: "英文", where: /#approvals/, detail: /^Allow the \w+ MCP server to run tool/,
    why: "MCP 确认卡正文是 Codex 的英文原句。另一个会话（Show MCP approval cards in Chinese，工作树 practical-bouman-f3dd2b）正在改成中文；合并后删掉这一条，规则会重新盯住它。" },
];

export function acceptedFinding(row) {
  return ACCEPTED.some((entry) => entry.kind === row.kind && entry.where.test(row.where) && (!entry.detail || entry.detail.test(row.detail ?? "")));
}
