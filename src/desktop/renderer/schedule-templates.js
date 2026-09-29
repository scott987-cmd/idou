// 定时任务模板: a filled-in starting point, the way WorkBuddy's 定时任务模版 are
// (shown under an empty list, and one click from the toolbar).
//
// Theirs are a personal assistant's -- the day's AI news, five English words, a
// bedtime story -- and several depend on the open web. A run here reads only the
// Feishu resources it was granted and reaches nothing else, so these are work
// that fits that: a chat's day, a project's week, a table's numbers, a task
// list's deadlines. Each names the kind of resource it reads; which one is still
// the person's choice in the picker, never the template's.
//
// The prompts say "获准读取的" because that is exactly what a run is told it may
// read (the resource section scheduled-run.js writes ahead of the prompt), and a
// prompt that asked for anything else would only be refused at egress.
export const SCHEDULE_TEMPLATES = Object.freeze([
  Object.freeze({ id: "chat-digest", title: "群消息每日要点", resourceKind: "chat",
    description: "每个工作日早上，汇总群里昨天的讨论，列出需要你回复或跟进的事。",
    schedule: Object.freeze({ frequency: "workday", time: "09:00" }),
    prompt: "阅读获准读取的群聊里昨天的消息，整理成不超过三条要点；再列出需要我回复或跟进的事项，写明是谁提出的、什么事。没有新消息就直接说明。" }),
  Object.freeze({ id: "weekly-report", title: "每周工作周报", resourceKind: "document",
    description: "每周五下午，读项目文档和表格，汇总本周进展、风险和下周计划。",
    schedule: Object.freeze({ frequency: "weekly", weekdays: Object.freeze([5]), time: "17:00" }),
    prompt: "阅读获准读取的项目文档和表格，写一份本周工作周报：本周进展、已完成事项、风险与阻塞、下周计划。只根据资料里有的内容写，缺少信息的地方标为待确认。" }),
  Object.freeze({ id: "table-summary", title: "数据表每日摘要", resourceKind: "sheet",
    description: "每个工作日，读指定的表格，总结关键数字，指出异常。",
    schedule: Object.freeze({ frequency: "workday", time: "09:30" }),
    prompt: "读取获准读取的表格，总结关键指标的当前数值；指出看起来异常的数据，例如空缺、明显偏离其他行的数值，并给出一两条需要关注的建议。" }),
  Object.freeze({ id: "due-tasks", title: "到期待办提醒", resourceKind: "base",
    description: "每个工作日上午，列出任务表里今天到期和已经逾期的事项。",
    schedule: Object.freeze({ frequency: "workday", time: "10:00" }),
    prompt: "读取获准读取的任务表，列出今天到期和已经逾期的事项，写明负责人和截止日期，按紧急程度排序。没有这样的事项就直接说明。" }),
  Object.freeze({ id: "feedback-digest", title: "客户反馈归纳", resourceKind: "chat",
    description: "每个工作日傍晚，把客户群里当天的问题和建议分类整理。",
    schedule: Object.freeze({ frequency: "workday", time: "17:30" }),
    prompt: "阅读获准读取的客户群里今天的消息，把客户提出的问题和建议按类别归纳，标出需要今天处理的紧急事项。" }),
  Object.freeze({ id: "monthly-review", title: "月度复盘", resourceKind: "document",
    description: "每月 1 日，回顾上个月的目标完成情况、成果和问题。",
    schedule: Object.freeze({ frequency: "monthly", dayOfMonth: 1, time: "10:00" }),
    prompt: "阅读获准读取的项目资料，回顾上个月：目标完成情况、主要成果、遇到的问题，并提出下个月的改进建议。" }),
]);

export const RESOURCE_KIND_NAMES = Object.freeze({ document: "文档", sheet: "电子表格", base: "多维表格", chat: "会话" });

const WEEKDAY_NAMES = Object.freeze(["周日", "周一", "周二", "周三", "周四", "周五", "周六"]);

// How a template's rule reads on its card -- the same words the list uses once
// the task exists (describeSchedule on the server).
export function templateSchedule({ schedule }) {
  if (schedule.frequency === "workday") return `每个工作日 ${schedule.time}`;
  if (schedule.frequency === "weekly") return `每周${schedule.weekdays.map((day) => WEEKDAY_NAMES[day].slice(1)).join("、")} ${schedule.time}`;
  if (schedule.frequency === "monthly") return `每月 ${schedule.dayOfMonth} 日 ${schedule.time}`;
  return `每天 ${schedule.time}`;
}
