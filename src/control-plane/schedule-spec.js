// When a scheduled task runs, said the way a person says it: once at a moment,
// every day at 09:00, Monday/Wednesday/Friday at 09:00, the 1st of each month.
//
// The first cut stored an interval in milliseconds. That can express "every 24
// hours from now" but not "every weekday at 09:00", and the two are not the same
// thing: an interval drifts across a daylight-saving boundary and cannot skip a
// weekend at all. Every product that does this well stores the wall-clock rule
// and computes the next instant from it, so that is what this does.
//
// A wall clock without a time zone is not a time. "09:00" is a different instant
// in Shanghai and in Berlin, and a schedule that ignored that would be wrong for
// half its life and hardest to diagnose exactly when it mattered.
// 双周, 每年 and 按间隔 came with the reference toolbar's own list (WorkBuddy:
// 每天 / 每周 / 双周 / 每月 / 每年, and 按间隔 "{days}，每间隔 {count} 小时"). 每个
// 工作日 is not a rule of its own: it is 每周 on Monday to Friday, offered as a
// shortcut and named that way when read back.
//
// Every rule this build reads and runs. A stored rule outside this list was
// written by a newer build this one has been rolled back underneath, and it is
// never run here (knownRule; the store leaves it out of what is due): running
// it as the nearest rule this build does know is how the build before this one
// would have run a 双周 task every day.
export const FREQUENCIES = Object.freeze(["once", "daily", "weekly", "biweekly", "monthly", "yearly", "interval"]);
// The rules this build lets a person create, or change a task to. It can be
// smaller than the list above, and was for one release: 双周, 每年 and 按间隔 were
// read and run by 0.1.0-20260918.30 and created only from the build after it,
// because the build before .30 read 双周 and 每年 as 每天 and would have run them
// every day after a rollback. A new rule arrives the same way: readable one
// release before it is creatable. Told to the desktop with the list, so its
// dialog offers exactly what the server will accept.
export const CREATABLE = FREQUENCIES;
export const knownRule = (spec) => FREQUENCIES.includes(spec?.frequency);
const WEEKDAY_NAMES = Object.freeze(["周日", "周一", "周二", "周三", "周四", "周五", "周六"]);
const DAY_MS = 86_400_000;

const MINUTE = 60_000;

function validTimeZone(zone) {
  if (typeof zone !== "string" || zone.length === 0 || zone.length > 64) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return true; } catch { return false; }
}

// What a given instant reads as on the wall in that zone, and therefore what the
// zone's offset is at that instant. Intl is the only thing in the platform that
// knows the rules, so the conversion is built from it rather than from a table.
function offsetAt(instant, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second)) - instant;
}

// A wall-clock time in a zone, as an instant. Two passes: the offset depends on
// the instant, and the instant depends on the offset. The second pass settles
// everything except the hour that a DST jump deletes, where the result lands
// just after the jump rather than at a time that does not exist.
export function zonedInstant({ year, month, day, hour, minute }, timeZone) {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const once = naive - offsetAt(naive, timeZone);
  return naive - offsetAt(once, timeZone);
}

// The calendar date an instant falls on in that zone.
function zonedDate(instant, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  }).formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

const time = (value) => {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(value)) return null;
  const [hour, minute] = value.split(":").map(Number);
  return { hour, minute };
};

const weekdayList = (value, what) => {
  const days = Array.isArray(value) ? [...new Set(value.map(Number))].sort((a, b) => a - b) : [];
  if (days.length === 0 || days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) throw new Error(`${what}需要选择星期几（0 表示周日）`);
  return Object.freeze(days);
};

// The Monday that opens the week a calendar date falls in, as YYYY-MM-DD.
const mondayOf = ({ year, month, day }) => {
  const probe = new Date(Date.UTC(year, month - 1, day));
  probe.setUTCDate(probe.getUTCDate() - (probe.getUTCDay() + 6) % 7);
  return probe.toISOString().slice(0, 10);
};
const isoDate = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number), probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day ? probe : null;
};

// `now` decides only which week a new 双周 rule counts from; every other rule
// is the same whenever it is read.
export function scheduleSpec(input, { now = Date.now() } = {}) {
  const frequency = input?.frequency;
  if (!FREQUENCIES.includes(frequency)) throw new Error("执行频率只能是单次、每天、每周、双周、每月、每年或按间隔");
  const timeZone = input?.timeZone ?? "Asia/Shanghai";
  if (!validTimeZone(timeZone)) throw new Error("时区不合法");

  if (frequency === "once") {
    const at = Number(input?.at);
    if (!Number.isSafeInteger(at) || at <= 0) throw new Error("单次任务需要一个执行时间");
    return Object.freeze({ frequency, at, timeZone });
  }

  const clock = time(input?.time);
  if (!clock) throw new Error("需要一个 HH:MM 格式的执行时刻");

  if (frequency === "daily") return Object.freeze({ frequency, time: input.time, timeZone });

  if (frequency === "weekly") return Object.freeze({ frequency, time: input.time, weekdays: weekdayList(input?.weekdays, "每周任务"), timeZone });

  // Every other week, counted from the week it was made in -- which is what a
  // person means by starting one now, and what the reference product does. The
  // week is stored, so reading the rule later never moves it.
  if (frequency === "biweekly") {
    const weekdays = weekdayList(input?.weekdays, "双周任务");
    let anchorWeek = input?.anchorWeek;
    if (anchorWeek === undefined || anchorWeek === null) anchorWeek = mondayOf(zonedDate(now, timeZone));
    const monday = isoDate(anchorWeek);
    if (!monday || monday.getUTCDay() !== 1) throw new Error("双周任务的起始周不合法");
    return Object.freeze({ frequency, time: input.time, weekdays, anchorWeek, timeZone });
  }

  // A date each year. The 29th of February falls on the 28th in other years, by
  // the same rule as the 31st of a short month: the last day of that month.
  if (frequency === "yearly") {
    const month = Number(input?.month), day = Number(input?.dayOfMonth);
    if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error("每年任务需要 1 到 12 之间的月份");
    if (!Number.isInteger(day) || day < 1 || day > daysInMonth(2024, month)) throw new Error("这个月份没有这一天");
    return Object.freeze({ frequency, time: input.time, month, dayOfMonth: day, timeZone });
  }

  // Every N hours, on the wall clock: from a time of day, on the chosen days,
  // until an optional time the same day, and again from the start the next day.
  // The reference product counts N hours on from the moment it was made, which
  // runs through the night and slides across a DST change; slots named by the
  // clock do neither. At least an hour apart, as there.
  if (frequency === "interval") {
    const everyHours = Number(input?.everyHours);
    if (!Number.isInteger(everyHours) || everyHours < 1 || everyHours > 23) throw new Error("按间隔执行需要 1 到 23 小时之间的整数间隔");
    const weekdays = weekdayList(input?.weekdays, "按间隔执行");
    const until = input?.until ?? null;
    if (until !== null) {
      const end = time(until);
      if (!end) throw new Error("结束时刻需要 HH:MM 格式");
      if (end.hour * 60 + end.minute <= clock.hour * 60 + clock.minute) throw new Error("结束时刻要晚于开始时刻");
    }
    return Object.freeze({ frequency, time: input.time, until, everyHours, weekdays, timeZone });
  }

  const day = Number(input?.dayOfMonth);
  // 29–31 do not exist in every month. Rather than silently sliding to the 28th
  // or to the 1st of the next month -- two different products' guesses -- the
  // rule is the last day of that month, which is what "the 31st" means to a
  // person who picked it in February.
  if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error("每月任务需要 1 到 31 之间的日期");
  return Object.freeze({ frequency, time: input.time, dayOfMonth: day, timeZone });
}

const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

// The first occurrence strictly after `after`. Null when a one-off has passed:
// a schedule with nothing left to do says so rather than reporting a time in the
// past that would fire immediately and forever.
//
// Never throws on a stored rule. It is called while a run is being claimed, and a
// throw there escapes the scheduler and takes the control plane down with it, so
// a rule this build does not know -- or a stored one that no longer parses -- has
// no next time instead.
export function nextOccurrence(spec, after) {
  if (!knownRule(spec)) return null;
  const { timeZone } = spec;
  if (spec.frequency === "once") return spec.at > after ? spec.at : null;
  const clock = time(spec.time);
  if (!clock || !validTimeZone(timeZone)) return null;
  const { hour, minute } = clock;

  // Start from the calendar day `after` falls on in that zone and walk forward.
  // 400 days covers a once-a-year rule, which is the longest real gap.
  const start = zonedDate(after, timeZone);
  const anchor = spec.frequency === "biweekly" ? isoDate(spec.anchorWeek).getTime() : 0;
  for (let offset = 0; offset < 400; offset += 1) {
    const probe = new Date(Date.UTC(start.year, start.month - 1, start.day + offset));
    const year = probe.getUTCFullYear(), month = probe.getUTCMonth() + 1, weekday = probe.getUTCDay();
    let day = probe.getUTCDate();

    if (["weekly", "biweekly", "interval"].includes(spec.frequency) && !spec.weekdays.includes(weekday)) continue;
    if (spec.frequency === "biweekly") {
      const weeks = Math.round((isoDate(mondayOf({ year, month, day })).getTime() - anchor) / (7 * DAY_MS));
      if (Math.abs(weeks) % 2 !== 0) continue;
    }
    if (spec.frequency === "yearly" && month !== spec.month) continue;
    if (spec.frequency === "monthly" || spec.frequency === "yearly") {
      const target = Math.min(spec.dayOfMonth, daysInMonth(year, month));
      if (day !== target) continue;
      day = target;
    }
    if (spec.frequency === "interval") {
      const until = spec.until ? time(spec.until) : { hour: 23, minute: 59 };
      for (let at = hour * 60 + minute; at <= until.hour * 60 + until.minute; at += spec.everyHours * 60) {
        const instant = zonedInstant({ year, month, day, hour: Math.floor(at / 60), minute: at % 60 }, timeZone);
        if (instant > after) return instant;
      }
      continue;
    }
    const instant = zonedInstant({ year, month, day, hour, minute }, timeZone);
    if (instant > after) return instant;
  }
  return null;
}

// How the rule reads in a list, the way the reference products write it:
// "每天 09:00", "每周一、三、五 09:00", "每月 1 日 09:00", "单次 2026-09-16 19:15".
export function describeSchedule(spec) {
  if (spec.frequency === "once") {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("zh-CN", {
      timeZone: spec.timeZone, hourCycle: "h23", year: "numeric", month: "2-digit",
      day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(new Date(spec.at)).map((part) => [part.type, part.value]));
    return `单次 ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  }
  if (spec.frequency === "daily") return `每天 ${spec.time}`;
  if (spec.frequency === "weekly") return `${onDays(spec.weekdays)} ${spec.time}`;
  if (spec.frequency === "biweekly") return `每两周的${spec.weekdays.map((day) => WEEKDAY_NAMES[day]).join("、")} ${spec.time}`;
  if (spec.frequency === "yearly") return `每年 ${spec.month} 月 ${spec.dayOfMonth} 日 ${spec.time}`;
  if (spec.frequency === "interval") {
    return `${onDays(spec.weekdays)} ${spec.until ? `${spec.time}–${spec.until}` : `${spec.time} 起`}，每 ${spec.everyHours} 小时一次`;
  }
  if (spec.frequency === "monthly") return `每月 ${spec.dayOfMonth} 日 ${spec.time}`;
  // Written by a newer build. Named as that rather than read as the nearest
  // rule this one knows: "每月 undefined 日" is what falling through said.
  return "新版本的执行规则";
}

// 每周一、三、五 -- the 周 is said once, then the days. Writing it as `每` +
// `一、三、五` produced "每一、三、五", which is not Chinese; the first test
// asserted that output because it was written from the code rather than from how
// the reference products phrase it. Monday to Friday is 每个工作日, as there.
function onDays(days) {
  if (days.join(",") === "1,2,3,4,5") return "每个工作日";
  if (days.length === 7) return "每天";
  return `每周${days.map((day) => WEEKDAY_NAMES[day].slice(1)).join("、")}`;
}

// The shortest gap this rule can produce, so callers can refuse a schedule that
// would run more often than the server is willing to serve.
export const MIN_GAP_MS = 5 * MINUTE;
