// The clock behind the schedules. It owns no policy: it wakes when a row says
// something is due, claims that occurrence (the store makes the claim atomic, so
// the same occurrence cannot run twice), hands it to whoever executes, and
// records what happened.
//
// It is deliberately separable from execution: a schedule that fires reliably --
// on time, once, surviving a restart, stopping when paused or finished -- is the
// part that is hard to see going wrong once an agent is attached to it, so it is
// built and tested on its own first.
//
// The store may answer values (this machine's file) or promises (the shared
// database, schedule-store-postgres.js); everything here awaits it. A database
// can also be away for a while, which a file never was: then the clock asks
// again later rather than stopping, and a finished run's result is written
// again rather than lost.
const keyOf = (schedule) => `${schedule.tenant}/${schedule.id}`;
// A refusal of a request a person made, with the status it should reach them as.
export class SchedulerRefusal extends Error { constructor(status, message) { super(message); this.status = status; } }
const CANNOT_RUN_NOW = "这个任务现在不能运行：它可能已被删除、已过结束日期、已挂起，或没有资源授权";

export class Scheduler {
  #timer = null;
  #ticking = null;
  #arming = null;
  #rearm = false;
  #failures = 0;
  // `notify` is told what a finished run concluded, so the owner can be sent it.
  // Separate from `onEvent` on purpose: `onEvent` is a general sink an operator
  // may log, and what a notification needs includes the owner's session token.
  // A credential does not belong in something whose whole job is to be recorded.
  constructor({ store, execute, now = Date.now, timers = { set: setTimeout, clear: clearTimeout }, maxConcurrent = 2, onEvent = () => {},
    authorize = () => ({ ok: true }), postprocess = null, notify = () => {}, recordRetryMs = [1000, 5000, 30_000] }) {
    if (!store || typeof execute !== "function") throw new Error("Scheduler needs a store and an executor");
    Object.assign(this, { store, execute, now, timers, maxConcurrent, onEvent, authorize, postprocess, notify, recordRetryMs });
    this.running = new Map();
    this.controllers = new Map();
    this.notifying = new Set();
    this.closed = false;
  }

  // Called at start and after every change, so a restarted server picks up rows
  // written before it went down. Settles once the timer is set from the store
  // as it now is; nothing needs to wait for that but a test.
  start() { return this.closed ? Promise.resolve(this) : this.#arm().then(() => this); }

  async close() {
    this.closed = true;
    this.timers.clear(this.#timer); this.#timer = null;
    // The tick first: deciding a run's identity can be in flight, and closing
    // underneath it would abandon a refresh token mid-exchange.
    await Promise.allSettled([this.#ticking, this.#arming].filter(Boolean));
    await Promise.allSettled([...this.running.values()]);
    // Runs first, then the messages about them: a notification is started when
    // its run ends, so waiting for the runs alone would leave sends in flight.
    await Promise.allSettled([...this.notifying]);
  }

  async status() {
    let nextDueAt = null;
    if (!this.closed) { try { nextDueAt = await this.store.nextDueAt(); } catch { nextDueAt = null; } }
    return { running: this.running.size, nextDueAt, closed: this.closed };
  }

  cancel(tenant, id) { this.controllers.get(`${tenant}/${id}`)?.abort(); }

  // One at a time: two arms reading the store at once would each set a timer,
  // and the first would never be cleared. Asked again while one is under way,
  // it runs once more when that one is done, from the store as it is then.
  #arm() {
    if (this.#arming) { this.#rearm = true; return this.#arming; }
    this.#arming = (async () => {
      try { do { this.#rearm = false; await this.#armOnce(); } while (this.#rearm && !this.closed); }
      finally { this.#arming = null; }
    })();
    return this.#arming;
  }

  async #armOnce() {
    this.timers.clear(this.#timer); this.#timer = null;
    if (this.closed) return;
    let next, at, blocked = false;
    try {
      next = await this.store.nextDueAt();
      at = this.now();
      // Overdue work that cannot be started -- every slot busy, or the schedule's
      // own previous run still going -- must not get a timer: the delay would be
      // zero, and it would wake into the same blocked rows again and again. Wait
      // for a slot instead. #run re-arms the moment one frees.
      if (next !== null && next <= at) {
        blocked = this.running.size >= this.maxConcurrent
          || !(await this.store.due(at, this.running.size + 1)).some((schedule) => !this.running.has(keyOf(schedule)));
      }
      this.#failures = 0;
    } catch (error) {
      // The store could not be read -- the database restarting, say. Every row
      // is still there, so nothing is lost by asking again: soon at first, then
      // less often, and said each time.
      this.#failures += 1;
      this.onEvent({ kind: "store-unavailable", message: String(error?.message ?? error).slice(0, 200) });
      if (!this.closed) this.#wake(Math.min(60_000, 1000 * 2 ** Math.min(this.#failures - 1, 6)));
      return;
    }
    if (this.closed || next === null || blocked) return;
    // Otherwise sleep exactly until it is due -- a row left overdue by a server
    // that was down fires at once -- capped so a far-future row re-checks
    // periodically rather than holding one enormous timer.
    this.#wake(Math.max(0, Math.min(next - at, 60 * 60_000)));
  }

  #wake(delay) {
    this.timers.clear(this.#timer);
    // The tick's promise is returned for a test's timers to wait on; a real
    // timer ignores it, and nothing it rejects with is left unhandled.
    this.#timer = this.timers.set(() => this.tick().catch(() => {}), delay);
    this.#timer?.unref?.();
  }

  // Runs everything due, up to the concurrency limit, then re-arms. Exposed so a
  // test drives it directly instead of waiting on a real clock.
  //
  // Collapsed rather than re-entrant: deciding whether a run is authorized can
  // now await a network exchange, so a tick yields where it never used to, and
  // `#arm` schedules another from `#run`'s finally. Two ticks in the same
  // schedule's claim would be two runs of it.
  tick() {
    if (this.#ticking) return this.#ticking;
    this.#ticking = this.#tick().finally(() => { this.#ticking = null; });
    return this.#ticking;
  }

  // What authorize said, as a verdict this can act on. A thrown error here --
  // a refused exchange, an unreachable Feishu -- would otherwise escape through
  // `void this.tick()` as an unhandled rejection and take the process with it.
  async #verdict(schedule) {
    try { return await this.authorize(schedule); }
    catch (error) { return { ok: false, retry: true, reason: `无法确认这个任务的身份：${String(error?.message ?? error).slice(0, 200)}` }; }
  }

  async #tick() {
    if (this.closed) return this.status();
    try {
      // No more than could be started: after a day down, every daily task is
      // due at once, and each tick would otherwise read them all.
      for (const schedule of await this.store.due(this.now(), this.maxConcurrent + this.running.size)) {
        if (this.running.size >= this.maxConcurrent) break;
        const key = keyOf(schedule);
        if (this.running.has(key)) continue;
        // The slot is held from before the first await, as runNow holds it: a
        // run now of the same task arriving while this one's claim or identity
        // is being settled finds it taken, rather than running beside it.
        let release;
        this.running.set(key, new Promise((resolve) => { release = resolve; }));
        let handedOff = false;
        try {
          const claim = await this.store.claim(schedule, this.now());
          if (!claim) continue;
          // A scheduled task only ever runs inside the lifetime of the login that
          // created it. Once that has lapsed there is no identity to run it as, so
          // the schedule stops itself and says why in its own history, instead of
          // failing the same way every turn until somebody happens to look.
          const verdict = await this.#verdict(claim.schedule);
          const current = await this.store.get({ tenantId: claim.schedule.tenant }, claim.schedule.id);
          if (this.closed || !current || (current.cancellationRevision ?? 0) !== (claim.schedule.cancellationRevision ?? 0)) {
            await this.#record(claim, "skipped", "任务已取消，未启动执行。");
            continue;
          }
          if (!verdict?.ok) {
            // A bad moment is not a lapsed authorization. Suspending on a
            // five-minute outage would stop a daily task until somebody noticed,
            // so a retryable refusal is recorded as a failed turn and tomorrow's
            // occurrence stands.
            if (verdict?.retry) {
              await this.#record(claim, "failed", verdict.reason ?? "这次未能开始，下次仍会尝试");
              this.onEvent({ kind: "failed", key, runId: claim.runId });
              continue;
            }
            await this.#record(claim, "skipped", verdict?.reason ?? "登录已过期，定时任务已暂停，下次登录后自动恢复");
            await this.store.suspend(claim.schedule.tenant, claim.schedule.id);
            this.onEvent({ kind: "suspended", key, runId: claim.runId });
            continue;
          }
          // What authorize returned about the owner travels with the claim: the
          // executor needs the identity this run acts as, and asking a second
          // time could answer differently between the check and the run.
          this.running.delete(key);
          handedOff = true;
          this.#run(verdict.parentToken === undefined ? claim : { ...claim, parentToken: verdict.parentToken });
        } finally {
          if (!handedOff) this.running.delete(key);
          release();
        }
      }
    } catch (error) {
      this.onEvent({ kind: "store-unavailable", message: String(error?.message ?? error).slice(0, 200) });
    } finally { await this.#arm(); }
    return this.status();
  }

  // What became of a run, written until it is: the database may be restarting
  // just then. A run whose result still cannot be written stays open, and the
  // next start records it as interrupted rather than leaving it running.
  async #record(claim, outcome, detail, artifact = null) {
    for (let attempt = 0; ; attempt += 1) {
      try { await this.store.finish(claim.schedule.tenant, claim.runId, outcome, detail, artifact); return true; }
      catch (error) {
        // Not held past a shutdown: the next start records the run as interrupted.
        if (attempt >= this.recordRetryMs.length || this.closed) {
          this.onEvent({ kind: "record-failed", key: keyOf(claim.schedule), runId: claim.runId, message: String(error?.message ?? error).slice(0, 200) });
          return false;
        }
        // Not unref'd: a result still to be written is a reason to stay up.
        await new Promise((resolve) => { setTimeout(resolve, this.recordRetryMs[attempt]); });
      }
    }
  }

  // A run a person asked for now. It goes through exactly what a due run goes
  // through -- the same identity check, executor, archive and notification --
  // and changes nothing about when the task next runs. The slot is taken before
  // the first await, so a due tick cannot claim the same task in between and
  // run it twice.
  //
  // The identity is asked first, and a "no" is answered to the person rather
  // than recorded: they are looking at the screen, the history is for runs
  // nobody was watching, and one manual try is no reason to suspend anything.
  // Nor is the refusal's own reason passed on -- those are written for a due run
  // and say the task has been suspended, which here it has not. Claiming after
  // the answer leaves nothing between the claim and the run to cancel.
  async runNow(schedule) {
    if (this.closed) throw new SchedulerRefusal(503, "定时任务执行已停止");
    // What is known without asking anyone comes first: the identity may cost a
    // Feishu exchange. The claim checks again inside its transaction, and that
    // is the check that counts.
    if (schedule.suspendedAt || !schedule.capability || !schedule.prompt || (schedule.endAt !== null && schedule.endAt <= this.now())) {
      throw new SchedulerRefusal(409, CANNOT_RUN_NOW);
    }
    const key = keyOf(schedule);
    if (this.running.has(key)) throw new SchedulerRefusal(409, "这个任务正在执行，请等它结束后再试");
    if (this.running.size >= this.maxConcurrent) throw new SchedulerRefusal(429, "同时执行的任务已满，请稍后再试");
    let release;
    this.running.set(key, new Promise((resolve) => { release = resolve; }));
    let handedOff = false;
    try {
      const verdict = await this.#verdict(schedule);
      if (!verdict?.ok) {
        throw verdict?.retry
          ? new SchedulerRefusal(503, "暂时无法确认你的身份，这次没有运行，请稍后再试。")
          : new SchedulerRefusal(409, "定时任务现在没有可用的授权，这次没有运行：请先在页面上方授权。");
      }
      if (this.closed) throw new SchedulerRefusal(503, "定时任务执行已停止");
      let claim;
      try { claim = await this.store.claimNow(schedule, this.now()); }
      catch { throw new SchedulerRefusal(503, "定时任务库暂时不可用，这次没有运行，请稍后再试。"); }
      if (!claim) throw new SchedulerRefusal(409, CANNOT_RUN_NOW);
      this.running.delete(key);
      handedOff = true;
      this.#run(verdict.parentToken === undefined ? claim : { ...claim, parentToken: verdict.parentToken });
      return { runId: claim.runId, started: true };
    } finally {
      if (!handedOff) { this.running.delete(key); void this.#arm(); }
      release();
    }
  }

  #run(claim) {
    const key = keyOf(claim.schedule);
    const controller = new AbortController();
    this.controllers.set(key, controller);
    const done = async (outcome, detail, artifact = null) => {
      await this.#record(claim, outcome, detail, artifact);
      this.onEvent({ kind: outcome, key, runId: claim.runId });
      this.#tell(claim, outcome, detail);
    };
    // Turn execution/postprocessing into data before persisting it. If the
    // store itself fails, that persistence error must not be mistaken for an
    // execution failure and followed by a second `finish` attempt.
    const outcome = Promise.resolve()
      .then(() => this.execute({ ...claim, signal: controller.signal }))
      .then(async (result) => {
        // `note` is what the run wants said beside its result -- today, that it
        // ran without the last report it was meant to consult.
        const noted = (detail) => [detail, result?.note].filter(Boolean).join("") || null;
        if (!result?.report) return { outcome: "completed", detail: noted(result?.detail ?? null), artifact: null };
        if (typeof this.postprocess !== "function") throw new Error("报告未保存：服务端没有配置飞书云盘归档");
        const saved = await this.postprocess({ ...claim, report: result.report, signal: controller.signal });
        return { outcome: "completed", detail: noted(saved?.detail ?? "报告已保存到飞书云盘。"), artifact: saved?.artifact ?? null };
      })
      .catch((error) => ({ outcome: "failed", detail: String(error?.message ?? error), artifact: error?.artifact ?? null }));
    const pending = outcome
      .then((result) => done(result.outcome, result.detail, result.artifact))
      // The slot is free before the clock is set again; the run is over once
      // that is done, so whoever waits for it waits for both.
      .finally(() => { this.running.delete(key); this.controllers.delete(key); return this.#arm(); });
    this.running.set(key, pending);
  }

  // Told after the history is written, and tracked apart from the run: a message
  // that takes its time must not hold a concurrency slot the next schedule is
  // waiting for. It also cannot fail anything -- the run is over and recorded,
  // and an undelivered notification does not make a finished task unfinished.
  #tell(claim, outcome, detail) {
    const sending = Promise.resolve()
      .then(() => this.notify({ schedule: claim.schedule, parentToken: claim.parentToken, outcome, detail, runId: claim.runId }))
      .catch(() => {})
      .finally(() => { this.notifying.delete(sending); });
    this.notifying.add(sending);
  }
}
