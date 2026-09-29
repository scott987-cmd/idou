// Lines a person can point at in a unified hunk. Removed lines belong to the
// old side; added and context lines use the new side. Hunk headers are visible
// but cannot become feedback targets. This module stays browser-safe because
// the desktop renderer uses the same line identities as send-time validation.
export function diffReviewLines(diff) {
  const rows = [];
  let oldLine = null, newLine = null;
  for (const text of String(diff ?? "").split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); rows.push({ kind: "hunk", text, oldLine: null, newLine: null, side: null, line: null }); continue; }
    if (oldLine === null || newLine === null) { rows.push({ kind: "meta", text, oldLine: null, newLine: null, side: null, line: null }); continue; }
    if (text.startsWith("-")) { rows.push({ kind: "remove", text, oldLine, newLine: null, side: "old", line: oldLine }); oldLine += 1; continue; }
    if (text.startsWith("+")) { rows.push({ kind: "add", text, oldLine: null, newLine, side: "new", line: newLine }); newLine += 1; continue; }
    if (text.startsWith("\\ No newline")) { rows.push({ kind: "meta", text, oldLine: null, newLine: null, side: null, line: null }); continue; }
    rows.push({ kind: "context", text, oldLine, newLine, side: "new", line: newLine }); oldLine += 1; newLine += 1;
  }
  return rows;
}
