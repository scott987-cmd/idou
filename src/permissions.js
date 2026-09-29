export const DEFAULT_PERMISSION = "standard";
export const EXECUTION_PERMISSION_IDS = Object.freeze(["manual", "standard", "auto", "full"]);
export const SAFE_DEFAULT_PERMISSION_IDS = Object.freeze(["manual", "standard", "auto"]);

const executionPermissions = new Set(EXECUTION_PERMISSION_IDS);
const safeDefaults = new Set(SAFE_DEFAULT_PERMISSION_IDS);

export function isExecutionPermission(value) {
  return executionPermissions.has(value);
}

export function isSafeDefaultPermission(value) {
  return safeDefaults.has(value);
}

export function normalizeDefaultExecutionPermission(value) {
  return isSafeDefaultPermission(value) ? value : DEFAULT_PERMISSION;
}

// Planning is an effective read-only mode, not a machine-wide execution
// preference. Its target must come from this task alone. Records written before
// that target existed deliberately fall back to standard instead of borrowing a
// wider choice from another task or an old localStorage value.
export function executionPermissionForTask(task) {
  if (task?.stage === "planning") return isExecutionPermission(task.executionPermission) ? task.executionPermission : DEFAULT_PERMISSION;
  return isExecutionPermission(task?.permission) ? task.permission : DEFAULT_PERMISSION;
}

// 完全访问 is the person's standing authorization for one task, given on its
// own card when they choose it (main.js, set-task-permission). What the Agent
// does outward from that task then runs without asking again: Feishu writes
// and deletions, sends, uploads to Drive, images, calendar and Feishu tasks,
// scheduled tasks, a skill it enables. By default it asks; once the person
// authorizes, it finishes (2026-09-28). One thing still asks whatever the
// task: a video, because the Token Plan it is generated on allows interactive
// use only. Server policy, exact-target one-shot grants, read-before-write
// checks and the no-retry rule apply either way -- only the card goes.
//
// Only a task whose *effective, current* permission is full qualifies. A
// coding task that is still planning has permission `plan` and merely
// remembers `full` in executionPermission, so it cannot use this path early;
// new tasks cannot inherit full (TaskService enforces that separately).
export function permitsUnattendedActions(task) {
  return task?.permission === "full";
}
