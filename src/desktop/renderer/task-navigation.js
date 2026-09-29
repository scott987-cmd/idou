const RUNNING = new Set(["running", "awaiting_approval", "stopping"]);
const activity = task => task.messages?.filter(message => message.role === "user" && !message.steered).length ?? 0;
const changedRank = (before, after) => !before || before.title !== after.title || activity(before) !== activity(after)
  || (RUNNING.has(before.status) && !RUNNING.has(after.status));

export function reconcileNavigationOrder(order, previous, next) {
  const before = new Map(previous.map(task => [task.id, task])), after = new Map(next.map(task => [task.id, task]));
  const kept = order.filter(id => after.has(id));
  const promoted = next.filter(task => changedRank(before.get(task.id), task)).sort((a, b) => b.updatedAt - a.updatedAt).map(task => task.id);
  return [...promoted, ...kept, ...next.map(task => task.id)].filter((id, index, all) => all.indexOf(id) === index && after.has(id));
}

export function taskNavigation(tasks, metadataRows, { section, query = "", showArchived = false, currentTaskId = null, order = [] } = {}) {
  const meta = new Map(metadataRows.map(row => [row.taskId, row]));
  const rank = new Map(order.map((id, index) => [id, index]));
  const needle = String(query).trim().slice(0, 200).toLocaleLowerCase("zh-CN");
  const scoped = ["cowork", "coding"].includes(section);
  const visible = tasks.filter(task => (!scoped || task.mode === section)
    && (task.messages?.some(message => message.role === "user") || task.id === currentTaskId)
    && (showArchived ? meta.get(task.id)?.archived === true : meta.get(task.id)?.archived !== true)
    && (!needle || `${task.title}\n${task.cwd}`.toLocaleLowerCase("zh-CN").includes(needle)))
    .sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  const pinned = visible.filter(task => meta.get(task.id)?.pinned === true);
  const ordinary = visible.filter(task => meta.get(task.id)?.pinned !== true);
  const groups = [];
  if (pinned.length) groups.push({ key: "pinned", label: "置顶任务", tasks: pinned });
  if (section === "coding") {
    const projects = new Map();
    for (const task of ordinary) {
      const key = task.cwd, rows = projects.get(key) ?? [];
      rows.push(task); projects.set(key, rows);
    }
    const parts = [...projects.keys()].map(cwd => ({ cwd, parts: cwd.split(/[\\/]/).filter(Boolean) }));
    const duplicates = new Map();
    for (const row of parts) duplicates.set(row.parts.at(-1), (duplicates.get(row.parts.at(-1)) ?? 0) + 1);
    for (const { cwd, parts: bits } of parts) {
      const base = bits.at(-1) || cwd, label = duplicates.get(base) > 1 ? bits.slice(-2).join("/") : base;
      groups.push({ key: `project:${cwd}`, label, path: cwd, tasks: projects.get(cwd) });
    }
  } else if (ordinary.length) groups.push({ key: "recent", label: showArchived ? "已归档" : "最近任务", tasks: ordinary });
  return { groups, count: visible.length, query: needle, showArchived };
}
