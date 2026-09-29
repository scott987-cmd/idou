import { randomUUID } from "node:crypto";

// What a scheduled task produced, where a person goes looking for their work.
//
// A finished run is recorded on the control plane and shown in 定时任务 -
// 运行记录, which is correct and is also one tab away from everything else. The
// person who asked a schedule to write a document each morning does not think
// of that as "a run record"; they think of it as this morning's document, and
// they look for it in 工作任务 with the rest of their work. Measured: a real run
// completed, its result sat in the run record, and it was reported as having
// gone nowhere.
//
// Two decisions worth stating, because neither is forced:
//
// One task per schedule, not one per run. A schedule that fires daily would
// otherwise pile thirty records into the list in a month, all with the same
// name. As one conversation, each run is a turn -- which is also how a person
// describes it: "my morning digest", singular, with a history.
//
// The desktop pulls; the control plane is untouched. Task records are JSON
// files under the signed-in account's own directory, they require a `cwd` that
// exists on *this* machine, and in a real deployment the control plane is not
// even the same machine. Only the desktop knows which account is live and where
// its files are, so only the desktop can write one.
//
// The control plane now keeps only the structured Drive receipt and a short
// status sentence. The sentence includes the verified report link, which the
// normal message renderer makes clickable; report bytes remain in Feishu Drive.
const MAX_TEXT = 12_000;

const trim = (value, limit = MAX_TEXT) => {
  const said = `${value ?? ""}`.replace(/\r\n?/g, "\n").trim();
  return said.length > limit ? `${said.slice(0, limit)}…` : said;
};

export class ScheduleMirror {
  // Closures rather than the task service itself, the way every other
  // collaborator in this directory takes them: `getTask` hands back the live
  // record, `saveTask` persists it and tells the renderer.
  constructor({ listTasks, getTask, createTask, saveTask, schedules, folder, now = Date.now, log = () => {} }) {
    for (const [name, value] of [["listTasks", listTasks], ["getTask", getTask], ["createTask", createTask], ["saveTask", saveTask], ["folder", folder]]) {
      if (typeof value !== "function") throw new Error(`定时任务镜像缺少 ${name}`);
    }
    if (!schedules) throw new Error("定时任务镜像需要定时任务客户端");
    Object.assign(this, { listTasks, getTask, createTask, saveTask, schedules, folder, now, log });
    this.syncing = null;
  }

  // Collapsed: a timer and a person opening the section can ask at the same
  // moment, and two passes would mirror the same run twice.
  async sync() {
    if (this.syncing) return this.syncing;
    this.syncing = this.#sync().catch((error) => {
      // Never fatal. The run records are the source of truth and they are
      // already safe on the control plane; failing to mirror them is a missing
      // convenience, not lost work.
      this.log(`定时任务结果同步失败：${String(error?.message ?? error).slice(0, 200)}`);
      return { mirrored: 0 };
    }).finally(() => { this.syncing = null; });
    return this.syncing;
  }

  async #sync() {
    const [listed, recorded] = await Promise.all([this.schedules.list(), this.schedules.runs()]);
    const rules = new Map((listed?.schedules ?? []).map((row) => [row.id, row]));
    // Oldest first, so a conversation reads in the order the runs happened.
    const runs = (recorded?.runs ?? [])
      .filter((run) => run.outcome === "completed" && Number.isSafeInteger(run.finishedAt))
      .sort((left, right) => left.finishedAt - right.finishedAt);

    let mirrored = 0;
    for (const run of runs) {
      const rule = rules.get(run.scheduleId);
      // A deleted schedule keeps its runs on the control plane. Its results are
      // still the person's, but there is no prompt to show as the turn that
      // asked for them, so the run record stays the only home for those.
      if (!rule) continue;
      if (await this.#mirror(rule, run)) mirrored += 1;
    }
    return { mirrored };
  }

  #idFor(scheduleId) {
    return this.listTasks().find((task) => task.scheduleMirror?.scheduleId === scheduleId)?.id ?? null;
  }

  async #mirror(rule, run) {
    const known = this.#idFor(rule.id);
    // The live record, not the snapshot's clone: mutating a clone would save
    // nothing and report success.
    const target = known ? this.getTask(known)
      : await this.createTask({ mode: "cowork", cwd: await this.folder(), title: rule.title });
    if ((target.scheduleMirror?.lastFinishedAt ?? 0) >= run.finishedAt) return false;

    // Two turns per run: what was asked, and what came back. The prompt is
    // repeated each time on purpose -- a schedule can be edited between runs,
    // and a turn that showed yesterday's wording beside today's answer would be
    // quietly wrong.
    target.messages.push({ id: randomUUID(), role: "user", createdAt: run.startedAt ?? run.finishedAt,
      text: trim(rule.prompt, 4000) || "（这个定时任务没有提示词）" });
    target.messages.push({ id: randomUUID(), role: "assistant", createdAt: run.finishedAt,
      text: trim(run.detail) || "任务已完成，没有输出。" });
    target.scheduleMirror = { scheduleId: rule.id, lastFinishedAt: run.finishedAt };
    target.status = "completed";
    target.updatedAt = run.finishedAt;
    if (!target.startedAt) target.startedAt = run.startedAt ?? run.finishedAt;

    await this.saveTask(target);
    return true;
  }
}
