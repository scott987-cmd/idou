// ↑ and ↓ in the input box bring back what the person sent before, as they do
// in Codex and Claude Code: only from an empty box, or from one still showing a
// prompt brought back and not edited since; ↑ only with the caret on the first
// line and ↓ only on the last, so moving the caret inside a longer draft still
// works as it always did.
//
// Pure: the page passes in the box and the tasks, and shows the answer.

// What the person sent in coding tasks, newest first and without repeats: the
// open task's first, then the other tasks in the same folder, most recently
// active first. Words added mid-turn count; they were typed too.
export function sentPrompts(tasks, { taskId = null, cwd = null, mode = "coding", limit = 100 } = {}) {
  const scoped = (Array.isArray(tasks) ? tasks : []).filter((task) => task?.mode === mode && (mode !== "coding" || !cwd || task.cwd === cwd));
  const ordered = [...scoped].sort((a, b) => Number(b.id === taskId) - Number(a.id === taskId) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const seen = new Set(), entries = [];
  for (const task of ordered) {
    for (const message of [...(task.messages ?? [])].reverse()) {
      // What the person typed. A turn the application sent on their behalf --
      // 开始做 is one -- is in the conversation but was never in this box, so
      // offering it back as something they wrote would be a small lie.
      const text = message?.role === "user" && message.authored !== false && typeof message.text === "string" ? message.text.trim() : "";
      if (!text || seen.has(text)) continue;
      seen.add(text); entries.push(text);
      if (entries.length >= limit) return entries;
    }
  }
  return entries;
}

// One press of ↑ (step 1, older) or ↓ (step -1, newer). Null when the key is
// the box's own; otherwise what to show and where in the list it is (-1 is
// the empty box the person started from).
export function recallPrompt({ value, selectionStart, selectionEnd, entries, index }, step) {
  const recalling = index >= 0 && value === entries[index];
  if (!recalling && value !== "") return null;
  if (step > 0 && value.slice(0, selectionStart).includes("\n")) return null;
  if (step < 0 && value.slice(selectionEnd).includes("\n")) return null;
  const from = recalling ? index : -1, next = from + step;
  if (next >= entries.length) return { value, index: from };
  if (next < 0) return { value: "", index: -1 };
  return { value: entries[next], index: next };
}
