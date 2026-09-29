import test from "node:test";
import assert from "node:assert/strict";
import { scheduleSpec, nextOccurrence, describeSchedule, zonedInstant, knownRule, CREATABLE, FREQUENCIES } from "../src/control-plane/schedule-spec.js";

const SHANGHAI = "Asia/Shanghai";
// 2026-09-16 is a Wednesday.
const wednesday0800 = zonedInstant({ year: 2026, month: 9, day: 16, hour: 8, minute: 0 }, SHANGHAI);
const at = (y, m, d, hh, mm, zone = SHANGHAI) => zonedInstant({ year: y, month: m, day: d, hour: hh, minute: mm }, zone);

test("a daily rule fires at that wall-clock time, today if it is still ahead", () => {
  const spec = scheduleSpec({ frequency: "daily", time: "09:00", timeZone: SHANGHAI });
  assert.equal(nextOccurrence(spec, wednesday0800), at(2026, 9, 16, 9, 0), "later today");
  assert.equal(nextOccurrence(spec, at(2026, 9, 16, 9, 30)), at(2026, 9, 17, 9, 0), "tomorrow once today has passed");
  // Exactly on the minute is not "after" it -- otherwise a run that finished
  // instantly would immediately be due again.
  assert.equal(nextOccurrence(spec, at(2026, 9, 16, 9, 0)), at(2026, 9, 17, 9, 0));
});

test("a weekly rule skips the days it was not given", () => {
  const spec = scheduleSpec({ frequency: "weekly", time: "09:00", weekdays: [1, 3, 5], timeZone: SHANGHAI });
  assert.equal(nextOccurrence(spec, wednesday0800), at(2026, 9, 16, 9, 0), "Wednesday, later today");
  assert.equal(nextOccurrence(spec, at(2026, 9, 16, 9, 30)), at(2026, 9, 18, 9, 0), "then Friday, not Thursday");
  assert.equal(nextOccurrence(spec, at(2026, 9, 18, 9, 30)), at(2026, 9, 21, 9, 0), "then Monday, skipping the weekend");
  // An interval of milliseconds cannot express this at all -- it was the reason
  // the first storage model had to be replaced.
  assert.deepEqual([...spec.weekdays], [1, 3, 5]);
});

test("the 31st means the last day of a month that has no 31st", () => {
  const spec = scheduleSpec({ frequency: "monthly", time: "09:00", dayOfMonth: 31, timeZone: SHANGHAI });
  assert.equal(nextOccurrence(spec, at(2026, 1, 31, 9, 30)), at(2026, 2, 28, 9, 0), "February, not March 3rd and not skipped");
  assert.equal(nextOccurrence(spec, at(2026, 3, 1, 0, 0)), at(2026, 3, 31, 9, 0));
  const first = scheduleSpec({ frequency: "monthly", time: "09:00", dayOfMonth: 1, timeZone: SHANGHAI });
  assert.equal(nextOccurrence(first, at(2026, 9, 16, 0, 0)), at(2026, 10, 1, 9, 0));
});

test("a one-off that has passed has no next time, rather than one in the past", () => {
  const spec = scheduleSpec({ frequency: "once", at: at(2026, 9, 16, 19, 15) });
  assert.equal(nextOccurrence(spec, wednesday0800), at(2026, 9, 16, 19, 15));
  // Returning a past instant would make it due forever, firing again every tick.
  assert.equal(nextOccurrence(spec, at(2026, 9, 16, 19, 16)), null);
});

test("09:00 is a different instant in different zones, and the rule keeps the zone", () => {
  const shanghai = scheduleSpec({ frequency: "daily", time: "09:00", timeZone: "Asia/Shanghai" });
  const berlin = scheduleSpec({ frequency: "daily", time: "09:00", timeZone: "Europe/Berlin" });
  const from = at(2026, 9, 16, 0, 0);
  assert.notEqual(nextOccurrence(shanghai, from), nextOccurrence(berlin, from));
  assert.equal(nextOccurrence(berlin, from) - nextOccurrence(shanghai, from), 6 * 3600_000, "CEST is six hours behind Shanghai");
});

test("a daylight-saving jump does not drop or double a run", () => {
  // Berlin springs forward at 02:00 on 2026-03-29: 02:30 does not exist that day.
  const spec = scheduleSpec({ frequency: "daily", time: "02:30", timeZone: "Europe/Berlin" });
  const before = at(2026, 3, 28, 12, 0, "Europe/Berlin");
  const first = nextOccurrence(spec, before);
  assert.equal(first, at(2026, 3, 29, 2, 30, "Europe/Berlin"), "the missing hour resolves to a real instant");
  const second = nextOccurrence(spec, first);
  assert.ok(second > first, "and the next day still follows");
  assert.ok(second - first <= 25 * 3600_000, `gap was ${(second - first) / 3600_000}h`);
});

test("the rule reads the way the reference products write it", () => {
  assert.equal(describeSchedule(scheduleSpec({ frequency: "daily", time: "09:00" })), "每天 09:00");
  assert.equal(describeSchedule(scheduleSpec({ frequency: "weekly", time: "09:00", weekdays: [1, 3, 5] })), "每周一、三、五 09:00");
  assert.equal(describeSchedule(scheduleSpec({ frequency: "weekly", time: "18:30", weekdays: [0] })), "每周日 18:30");
  assert.equal(describeSchedule(scheduleSpec({ frequency: "monthly", time: "09:00", dayOfMonth: 1 })), "每月 1 日 09:00");
  assert.match(describeSchedule(scheduleSpec({ frequency: "once", at: at(2026, 9, 16, 19, 15) })), /^单次 2026-09-16 19:15$/);
});

test("a rule that cannot be carried out is refused where it is written", () => {
  assert.throws(() => scheduleSpec({ frequency: "hourly", time: "09:00" }), /执行频率/);
  assert.throws(() => scheduleSpec({ frequency: "daily", time: "9:00" }), /HH:MM/);
  assert.throws(() => scheduleSpec({ frequency: "daily", time: "24:00" }), /HH:MM/);
  assert.throws(() => scheduleSpec({ frequency: "weekly", time: "09:00", weekdays: [] }), /星期几/);
  assert.throws(() => scheduleSpec({ frequency: "weekly", time: "09:00", weekdays: [7] }), /星期几/);
  assert.throws(() => scheduleSpec({ frequency: "monthly", time: "09:00", dayOfMonth: 0 }), /1 到 31/);
  assert.throws(() => scheduleSpec({ frequency: "once", at: 0 }), /执行时间/);
  assert.throws(() => scheduleSpec({ frequency: "daily", time: "09:00", timeZone: "Mars/Olympus" }), /时区/);
});

test("a weekly rule keeps its days sorted and deduplicated, so two writings match", () => {
  const spec = scheduleSpec({ frequency: "weekly", time: "09:00", weekdays: [5, 1, 3, 1] });
  assert.deepEqual([...spec.weekdays], [1, 3, 5]);
  assert.ok(Object.isFrozen(spec));
});

// ---- 每个工作日, 双周, 每年, 按间隔 (the reference toolbar's list) ----

test("Monday to Friday reads as 每个工作日, and every day of the week as 每天", () => {
  assert.equal(describeSchedule(scheduleSpec({ frequency: "weekly", time: "09:00", weekdays: [5, 4, 3, 2, 1] })), "每个工作日 09:00");
  assert.equal(describeSchedule(scheduleSpec({ frequency: "weekly", time: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] })), "每天 09:00");
  assert.equal(describeSchedule(scheduleSpec({ frequency: "weekly", time: "09:00", weekdays: [1, 2, 3, 4] })), "每周一、二、三、四 09:00");
});

test("双周 counts from the week it was made in, and keeps counting from there", () => {
  // Made on Wednesday 16 September: that week (from Monday the 14th) is on.
  const spec = scheduleSpec({ frequency: "biweekly", time: "09:00", weekdays: [1, 4], timeZone: SHANGHAI }, { now: wednesday0800 });
  assert.equal(spec.anchorWeek, "2026-09-14");
  const runs = [];
  for (let after = wednesday0800; runs.length < 5;) { after = nextOccurrence(spec, after); runs.push(after); }
  assert.deepEqual(runs, [at(2026, 9, 17, 9, 0), at(2026, 9, 28, 9, 0), at(2026, 10, 1, 9, 0), at(2026, 10, 12, 9, 0), at(2026, 10, 15, 9, 0)],
    "Thursday this week, then the week after next -- never the week between");
  assert.equal(describeSchedule(spec), "每两周的周一、周四 09:00");
  // Read back months later -- or edited, with the week sent along -- it is the same rule.
  const later = scheduleSpec({ ...spec, weekdays: [...spec.weekdays] }, { now: at(2026, 12, 1, 0, 0) });
  assert.equal(nextOccurrence(later, at(2026, 10, 1, 9, 0)), at(2026, 10, 12, 9, 0));
  assert.throws(() => scheduleSpec({ frequency: "biweekly", time: "09:00", weekdays: [1], anchorWeek: "2026-09-16" }), /起始周/, "a Wednesday is not the start of a week");
  assert.throws(() => scheduleSpec({ frequency: "biweekly", time: "09:00", weekdays: [1], anchorWeek: "2026-02-30" }), /起始周/);
  assert.throws(() => scheduleSpec({ frequency: "biweekly", time: "09:00", weekdays: [] }), /星期几/);
});

test("每年 is a date each year, and the 29th of February falls on the 28th in other years", () => {
  const leap = scheduleSpec({ frequency: "yearly", time: "09:00", month: 2, dayOfMonth: 29, timeZone: SHANGHAI });
  assert.equal(nextOccurrence(leap, at(2026, 9, 16, 0, 0)), at(2027, 2, 28, 9, 0));
  assert.equal(nextOccurrence(leap, at(2027, 3, 1, 0, 0)), at(2028, 2, 29, 9, 0));
  assert.equal(describeSchedule(leap), "每年 2 月 29 日 09:00");
  const newYear = scheduleSpec({ frequency: "yearly", time: "10:30", month: 1, dayOfMonth: 1, timeZone: SHANGHAI });
  assert.equal(nextOccurrence(newYear, wednesday0800), at(2027, 1, 1, 10, 30));
  assert.throws(() => scheduleSpec({ frequency: "yearly", time: "09:00", month: 2, dayOfMonth: 30 }), /没有这一天/);
  assert.throws(() => scheduleSpec({ frequency: "yearly", time: "09:00", month: 4, dayOfMonth: 31 }), /没有这一天/);
  assert.throws(() => scheduleSpec({ frequency: "yearly", time: "09:00", month: 13, dayOfMonth: 1 }), /月份/);
});

test("按间隔 fires every N hours on the clock, inside its window, on its days", () => {
  const spec = scheduleSpec({ frequency: "interval", time: "09:00", until: "18:00", everyHours: 3, weekdays: [1, 2, 3, 4, 5], timeZone: SHANGHAI });
  assert.equal(describeSchedule(spec), "每个工作日 09:00–18:00，每 3 小时一次");
  const friday = [];
  for (let after = at(2026, 9, 18, 8, 0); friday.length < 5;) { after = nextOccurrence(spec, after); friday.push(after); }
  assert.deepEqual(friday, [at(2026, 9, 18, 9, 0), at(2026, 9, 18, 12, 0), at(2026, 9, 18, 15, 0), at(2026, 9, 18, 18, 0), at(2026, 9, 21, 9, 0)],
    "18:00 is inside the window; then nothing over the weekend, and Monday starts again at 09:00");
  // No end time: to the end of the day, and the next day starts from the top.
  const allDay = scheduleSpec({ frequency: "interval", time: "08:00", everyHours: 5, weekdays: [0, 1, 2, 3, 4, 5, 6], timeZone: SHANGHAI });
  assert.equal(describeSchedule(allDay), "每天 08:00 起，每 5 小时一次");
  assert.equal(nextOccurrence(allDay, at(2026, 9, 16, 23, 0)), at(2026, 9, 17, 8, 0), "23:00 was the last slot; 04:00 is not a slot");
  for (const [bad, why] of [[{ everyHours: 0 }, /1 到 23/], [{ everyHours: 24 }, /1 到 23/], [{ everyHours: 1.5 }, /1 到 23/],
    [{ until: "09:00" }, /晚于开始/], [{ until: "8:00" }, /HH:MM/], [{ weekdays: [] }, /星期几/]]) {
    assert.throws(() => scheduleSpec({ frequency: "interval", time: "09:00", everyHours: 2, weekdays: [1], ...bad }), why);
  }
});

test("按间隔 across a daylight-saving jump neither doubles a run nor goes backwards", () => {
  // Berlin, 28 March 2027: 02:00 does not exist. Hourly from midnight.
  const spec = scheduleSpec({ frequency: "interval", time: "00:00", everyHours: 1, weekdays: [0, 1, 2, 3, 4, 5, 6], timeZone: "Europe/Berlin" });
  const runs = [];
  for (let after = at(2027, 3, 28, 0, 30, "Europe/Berlin"); runs.length < 4;) { after = nextOccurrence(spec, after); runs.push(after); }
  for (let index = 1; index < runs.length; index += 1) assert.ok(runs[index] > runs[index - 1], "strictly later each time");
  assert.equal(new Set(runs).size, runs.length, "no instant twice");
  assert.equal(runs[0], at(2027, 3, 28, 1, 0, "Europe/Berlin"));
});

// What a build does with a rule written by a newer one after being rolled back
// underneath it. The build before this one had no such case, and read 双周 and
// 每年 as 每天 -- it ran them every day. Here the answer is: no next time, a
// name that says what it is, and no throw, since a throw while a run is being
// claimed takes the whole control plane down.
test("a rule from a newer build has no next time and says what it is, and nothing here throws", () => {
  const newer = { frequency: "every-minutes", everyMinutes: 30, time: "09:00", weekdays: [1, 2, 3], timeZone: SHANGHAI };
  assert.equal(knownRule(newer), false);
  assert.equal(nextOccurrence(newer, wednesday0800), null);
  assert.equal(describeSchedule(newer), "新版本的执行规则");
  assert.equal(nextOccurrence({ frequency: "daily", time: "9点", timeZone: SHANGHAI }, wednesday0800), null, "a stored time that no longer parses");
  assert.equal(nextOccurrence({ frequency: "daily", time: "09:00", timeZone: "Mars/Olympus_Mons" }, wednesday0800), null, "or a zone");
  assert.equal(nextOccurrence(null, wednesday0800), null);
  assert.equal(describeSchedule({ frequency: "monthly", dayOfMonth: 1, time: "09:00" }), "每月 1 日 09:00", "monthly is named, not fallen through to");
});

// A rule is readable one release before it is creatable: 双周, 每年 and 按间隔
// were run by .30 and created from the build after it, which rolls back to .30.
// Nothing may be creatable that this build could not run.
test("every rule that can be created can be read, and every rule read here can now be created", () => {
  assert.ok(CREATABLE.every((rule) => FREQUENCIES.includes(rule)));
  assert.deepEqual([...CREATABLE], [...FREQUENCIES]);
});
