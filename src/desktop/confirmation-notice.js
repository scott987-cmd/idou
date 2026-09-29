// A confirmation card is drawn in this window and nowhere else. With the window
// behind another application, nothing said one was waiting: a work task's video
// card sat its five minutes and lapsed, twice in a row, while the person was
// working in another app (2026-09-23). So a card is also announced when the
// window is not the one the person is looking at.

// Not while they are: a notification for a card already in front of them is
// noise, and it would teach them to ignore the ones that matter.
export function shouldAnnounceConfirmation({ focused, minimized, visible }) {
  return !(focused === true && minimized !== true && visible !== false);
}

// What the notification says. Only the card's title -- what kind of decision it
// is -- because a notification can be read on a locked screen, and the details
// (who a document goes to, what a command runs) belong in the window.
export function confirmationNoticeText(title, validForMs) {
  const kind = typeof title === "string" ? title.replace(/\s+/g, " ").trim().slice(0, 40) : "";
  const validFor = !Number.isFinite(validForMs) || validForMs <= 0 ? ""
    : validForMs >= 60_000 ? `，${Math.round(validForMs / 60_000)} 分钟内有效` : `，${Math.ceil(validForMs / 1000)} 秒内有效`;
  return { title: "i豆 需要你确认", body: `${kind || "有一项操作"}：回到 i豆 点确认或取消${validFor}。` };
}

// A task's own cards: a command to run, files to change, a connector to use, or
// a question the Agent asks. They come from the task rather than from this
// application's confirmations, and were never announced -- in a real coding
// task a command card waited seven minutes, unseen, behind another app
// (2026-09-23). Only the kind of card, as above: never the command.
const APPROVAL_KIND = Object.freeze({ command: "任务要运行一条命令", file: "任务要修改文件", mcp: "任务要使用一个连接器" });
export function approvalNoticeText(kind) {
  if (kind === "question") return { title: "i豆 在等你回答", body: "任务向你提了一个问题：回到 i豆 回答它。" };
  return { title: "i豆 需要你确认", body: `${APPROVAL_KIND[kind] ?? "任务有一项操作"}：回到 i豆 点允许或拒绝。` };
}

// Each such card is announced once, when it appears, and the announcement goes
// when the card does -- answered, withdrawn by the task, or gone with the
// account it belonged to. `announce(text)` returns a handle with `close()`, or
// nothing when the window is in front of the person; a card they have already
// seen is not announced later.
export class ApprovalNotices {
  constructor(announce) { this.announce = announce; this.open = new Map(); }
  update(approvals) {
    const waiting = new Map((Array.isArray(approvals) ? approvals : []).filter((item) => typeof item?.id === "string").map((item) => [item.id, item]));
    for (const [id, notice] of this.open) {
      if (waiting.has(id)) continue;
      this.open.delete(id);
      try { notice?.close(); } catch { /* already gone */ }
    }
    for (const [id, item] of waiting) {
      if (this.open.has(id)) continue;
      let notice = null;
      try { notice = this.announce(approvalNoticeText(item.kind), item) ?? null; } catch { /* the card itself is up */ }
      this.open.set(id, notice);
    }
  }
  clear() { this.update([]); }
}
