import { diffReviewLines } from "../../application/diff-lines.js";

export function reviewFiles(result) {
  return (result?.files ?? []).map((file) => ({ ...file, revision: result.revision, lines: diffReviewLines(file.diff) }));
}

export function diffReference(result, file, line, comment) {
  const opinion = String(comment ?? "").trim();
  if (!result?.revision || !file?.path || !line?.side || !Number.isSafeInteger(line.line) || !opinion) throw new Error("请先选择一行并填写意见");
  const side = line.side, number = line.line;
  return {
    kind: "diff",
    key: `diff:${result.scope}:${result.turnKey ?? ""}:${file.path}:${side}:${number}:${result.revision}:${result.scope === "turn" ? file.currentRevision ?? "missing" : ""}`,
    title: `${file.path} · ${side === "old" ? "旧" : "新"}侧第 ${number} 行`,
    path: file.path,
    scope: result.scope,
    ...(result.scope === "turn" ? { turnKey: result.turnKey } : {}),
    side,
    startLine: number,
    endLine: number,
    revision: result.revision,
    ...(result.scope === "turn" ? { fileRevision: file.currentRevision ?? "missing" } : {}),
    comment: opinion.slice(0, 4_000),
    excerpt: String(line.text ?? "").slice(0, 8_000),
    state: "current",
  };
}
