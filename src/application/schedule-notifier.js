// A system notification when a scheduled task finishes, while the app is open.
//
// The reference products do this (WorkBuddy: 「桌面通知 — 任务完成或有新消息时，
// 通过系统弹窗提醒你」), and here it is also the one timely channel there is: the
// bot push needs a permission an administrator has not granted, and 运行记录 is
// only read by someone who thinks to look.
//
// The desktop asks; the control plane is not told anything new. Every 30 seconds
// it reads the person's own recent runs and says which have finished since it
// last looked. What it compares is the control plane's own `finishedAt`, never
// this machine's clock, so a skew between the two cannot drop or repeat one.
//
// The first look only sets the mark: history is not news, and opening the app
// in the morning must not replay the night as a burst of banners. Nor is a
// change of account, or turning the switch back on -- each starts from a fresh
// look. What a notification says is the task's name and how it ended; never the
// report, which the control plane does not hold anyway.
const OUTCOMES = Object.freeze({
  completed: "定时任务已完成",
  failed: "定时任务执行失败",
  skipped: "定时任务没有执行",
});

const firstLine = (value, limit) => {
  const line = `${value ?? ""}`.split("\n").map((part) => part.trim()).find(Boolean) ?? "";
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
};

// What one finished run becomes on screen. Exported for the renderer-free test.
export function scheduleNotice(run) {
  const title = OUTCOMES[run.outcome] ?? "定时任务已结束";
  const name = firstLine(run.title, 40) || "定时任务";
  let body;
  if (run.outcome === "completed") body = run.artifact ? `「${name}」已完成，报告已保存到飞书云盘。` : `「${name}」已完成。`;
  else body = `「${name}」：${firstLine(run.detail, 80) || "请看运行记录"}`;
  return { title, body, runId: run.id };
}

export class ScheduleNotifier {
  // `runs` reads the person's recent runs (ScheduleClient.runs), `identity`
  // names whose they are (the account scope), `enabled` is the switch, and
  // `notify` shows one. `onFinished` hears about each batch, so what depends on
  // a new result -- mirroring it into 工作任务 -- need not wait for its own timer.
  constructor({ runs, identity, enabled = () => true, notify, onFinished = () => {}, limit = 20, log = () => {} }) {
    for (const [name, value] of [["runs", runs], ["identity", identity], ["enabled", enabled], ["notify", notify]]) {
      if (typeof value !== "function") throw new Error(`定时任务通知缺少 ${name}`);
    }
    Object.assign(this, { runs, identity, enabled, notify, onFinished, limit, log });
    // The mark is the latest finishedAt seen; `atMark` the runs already told at
    // that very millisecond, so a second run finishing in it is not lost.
    this.mark = null; this.atMark = new Set(); this.owner = null; this.polling = null;
  }

  // Collapsed, like the mirror's sync: a timer and a request can meet.
  poll() {
    if (this.polling) return this.polling;
    this.polling = this.#poll().then((result) => { this.failure = null; return result; }, (error) => {
      // Never fatal and never noisy: signed out, offline or a control plane
      // restarting all look like this, and the next look will do. The same
      // failure every 30 seconds is logged once.
      const said = String(error?.message ?? error).slice(0, 160);
      if (said !== this.failure) this.log(`定时任务通知读取失败：${said}`);
      this.failure = said;
      return { notified: 0 };
    }).finally(() => { this.polling = null; });
    return this.polling;
  }

  async #poll() {
    if (!this.enabled()) { this.mark = null; return { notified: 0 }; }
    const owner = await this.identity();
    if (!owner) { this.mark = null; return { notified: 0 }; }
    const listed = await this.runs(this.limit);
    // Asked about a different account, or switched off meanwhile: this answer
    // belongs to nobody who should be told.
    if (owner !== await this.identity() || !this.enabled()) return { notified: 0 };
    const finished = (listed?.runs ?? []).filter((run) => Number.isSafeInteger(run?.finishedAt) && typeof run?.id === "string");
    const latest = finished.reduce((most, run) => Math.max(most, run.finishedAt), 0);
    const settle = () => { this.atMark = new Set(finished.filter((run) => run.finishedAt === latest).map((run) => run.id)); };
    if (this.mark === null || this.owner !== owner) {
      this.mark = latest; this.owner = owner; settle();
      return { notified: 0 };
    }
    const fresh = finished.filter((run) => run.finishedAt > this.mark || (run.finishedAt === this.mark && !this.atMark.has(run.id)))
      .sort((a, b) => a.finishedAt - b.finishedAt);
    if (!fresh.length) return { notified: 0 };
    if (latest > this.mark) { this.mark = latest; settle(); } else for (const run of fresh) this.atMark.add(run.id);
    for (const run of fresh) {
      try { this.notify(scheduleNotice(run)); }
      catch (error) { this.log(`定时任务通知没有显示：${String(error?.message ?? error).slice(0, 160)}`); }
    }
    try { await this.onFinished(fresh); } catch { /* its own business */ }
    return { notified: fresh.length };
  }
}
