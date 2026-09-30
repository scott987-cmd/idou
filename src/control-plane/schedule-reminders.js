// What the owner of scheduled tasks would otherwise learn only by opening i豆,
// told through the application's bot, in a message to them alone: that the
// unattended authorization their tasks run on is about to end, and that tasks
// of theirs have been suspended.
//
// Found in the long-running review (2026-09-29): the authorization lasts at
// most 30 days (unattended-consent.js); when it ended, the tasks were suspended
// and nothing was said to anyone -- the suspension was reported nowhere -- and
// a task suspended for 30 days loses its prompt. A monthly task ran once, at
// most, and its owner found out by looking.
//
// Only through the bot. A message as the owner needs a session of theirs, and
// the moment these matter is exactly the moment there is none; the bot speaks
// as the application, to the owner and nobody else (schedule-push.js keeps the
// same bound). Without a bot this says nothing and the desktop's own banner is
// what remains.
const DAY_MS = 86400_000;
// Before the authorization ends: a week, then a day. Each once per grant.
export const REMINDER_DAYS = Object.freeze([7, 1]);
// Many tasks of one person suspend in the same minute (they share the one
// authorization): said in one message, and not again that day.
const GATHER_MS = 60_000;
const SUSPENDED_QUIET_MS = DAY_MS;
const LISTED_TITLES = 5;

const quote = (titles) => {
  const shown = titles.slice(0, LISTED_TITLES).map((title) => `「${title}」`).join("");
  return titles.length > LISTED_TITLES ? `${shown}等 ${titles.length} 个` : shown;
};

export class ScheduleReminders {
  constructor({ store, unattended, bot, feishu, allowedTenants = null, promptDays = 30, now = Date.now,
    timers = { set: setTimeout, clear: clearTimeout }, log = () => {} }) {
    if (!store || !feishu) throw new Error("定时任务提醒需要任务库和飞书部署");
    Object.assign(this, { store, unattended, bot, feishu, promptDays, now, timers, log });
    this.allowedTenants = allowedTenants ? new Set(allowedTenants) : null;
    this.gathering = new Map();
    this.lastSuspendedNotice = new Map();
  }

  #reachable({ tenantId, userId }) {
    if (!this.bot) return "no_bot";
    if (this.allowedTenants && !this.allowedTenants.has(tenantId)) return "tenant_not_allowed";
    if (!this.feishu.ids.user(userId)) return "owner_not_feishu";
    return null;
  }

  async #send(who, text, kind) {
    const refused = this.#reachable(who);
    const answer = refused ? { sent: false, reason: refused } : await this.bot.sendText({ openId: who.userId, text }).catch((error) => ({ sent: false, reason: String(error?.message ?? error).slice(0, 120) }));
    this.log(JSON.stringify({ component: "schedule-reminders", kind, sent: answer.sent === true, reason: answer.reason ?? null }));
    return answer.sent === true;
  }

  // The owner's tasks that would run, by title, and the time zone they are set
  // in, for saying when.
  async #tasks(who) {
    const mine = (await this.store.list(who, { mine: true })).filter((row) => row.state === "active" && !row.suspendedAt && row.capability);
    return { titles: mine.map((row) => row.title), timeZone: mine.find((row) => row.spec?.timeZone)?.spec.timeZone ?? "Asia/Shanghai" };
  }

  #when(at, timeZone) {
    return new Intl.DateTimeFormat("zh-CN", { timeZone, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(at);
  }

  // Everyone with a task that will run, and the authorization it runs on: a
  // week and a day before that ends, once each for this grant. What was sent is
  // kept with the authorization, so a restart sends nothing twice and a new
  // grant starts over. Returns how many were told.
  async sweep() {
    if (!this.unattended || !this.bot) return 0;
    let told = 0;
    for (let after = null; ;) {
      const page = await this.store.owners({ after, limit: 500 });
      for (const who of page) {
        try { if (await this.#remind(who)) told += 1; }
        catch (error) { this.log(`定时任务：到期提醒没有发出（${String(error?.message ?? error).slice(0, 120)}）。`); }
      }
      if (page.length < 500) break;
      after = page.at(-1);
    }
    return told;
  }

  async #remind(who) {
    const status = await this.unattended.status(who);
    if (!status.authorized || !Number.isFinite(status.expiresAt)) return false;
    const left = status.expiresAt - this.now();
    const reached = REMINDER_DAYS.filter((days) => left <= days * DAY_MS);
    if (!reached.length) return false;
    const record = await this.unattended.store.read(who.tenantId, who.userId);
    const sent = record?.reminders?.for === status.expiresAt ? record.reminders.sent ?? [] : [];
    if (reached.every((days) => sent.includes(days))) return false;
    const { titles, timeZone } = await this.#tasks(who);
    if (!titles.length) return false;
    const soon = Math.min(...reached);
    const remaining = left < DAY_MS ? "不到一天" : `约 ${Math.round(left / DAY_MS)} 天`;
    const text = `i豆：你的定时任务${quote(titles)}靠无人值守授权运行，这份授权将在 ${this.#when(status.expiresAt, timeZone)} 到期（还剩${remaining}）。`
      + "到期后这些任务会暂停。打开 i豆 → 定时任务，重新授权后会接着运行。";
    if (!await this.#send(who, text, `unattended_expiry_${soon}d`)) return false;
    await this.unattended.store.patch(who.tenantId, who.userId, { reminders: { for: status.expiresAt, sent: [...new Set([...sent, ...reached])] } });
    return true;
  }

  // A task of theirs was suspended (the scheduler's event). Gathered for a
  // minute, so the tasks that stopped together are named in one message, and
  // not said again for a day.
  suspended(schedule, reason) {
    if (!schedule?.tenant || !schedule.owner) return;
    const key = `${schedule.tenant}\n${schedule.owner}`;
    const gathered = this.gathering.get(key);
    if (gathered) { gathered.titles.add(schedule.title); return; }
    const entry = { who: { tenantId: schedule.tenant, userId: schedule.owner }, titles: new Set([schedule.title]), reason };
    entry.timer = this.timers.set(() => this.#tellSuspended(key, entry), GATHER_MS);
    entry.timer?.unref?.();
    this.gathering.set(key, entry);
  }

  async #tellSuspended(key, entry) {
    this.gathering.delete(key);
    const last = this.lastSuspendedNotice.get(key);
    if (last && this.now() - last < SUSPENDED_QUIET_MS) return false;
    // The day is taken before the message goes, so a second batch flushing
    // while this one is still being sent cannot send as well; given back if
    // this one does not go.
    this.lastSuspendedNotice.set(key, this.now());
    const reason = String(entry.reason ?? "无人值守授权已不可用").replace(/[。.]+$/u, "");
    const text = `i豆：你的定时任务${quote([...entry.titles])}已暂停：${reason}。打开 i豆 → 定时任务，重新授权后会自动恢复。`
      + `暂停超过 ${this.promptDays} 天的任务，提示词会被清除，需要重新编辑。`;
    const sent = await this.#send(entry.who, text, "schedules_suspended");
    if (!sent) this.lastSuspendedNotice.delete(key);
    return sent;
  }

  // What is still gathering is said now (a stopping server says it rather than
  // dropping it).
  async close() {
    const pending = [...this.gathering.entries()];
    for (const [key, entry] of pending) { this.timers.clear(entry.timer); await this.#tellSuspended(key, entry).catch(() => false); }
  }
}
