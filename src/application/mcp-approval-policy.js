// How a turn answers the Agent's MCP tool calls, by the permission it runs with.
//
// Every call used to be its own card, whatever the permission: recording the
// 电脑操作 demo on 2026-09-25 took ten clicks of 允许这一次 for one short
// document typed into 文本编辑, in 标准 -- "高授模式应该不需要操作这么多次". Codex
// already has the ladder (untrusted / on-request / never / full access) and, for
// MCP, "allow for this session"; computer use grants an application once, not
// each click in it. So:
//
//   逐步确认 / 只读计划   every call asks, as before
//   标准 / 自动           a call asks once for the rest of the turn per grant:
//                         for 电脑操作 an application (and the whole screen on
//                         its own), for the other built-in connectors the
//                         connector, for a connection the person imported one
//                         of its tools. Listing the running applications asks
//                         nothing -- it names them and touches none.
//   完全访问              nothing asks
//
// A grant lasts the turn and no further: every turn runs in its own Codex
// process, and nothing about it is written into the task's record.

// Codex 0.155's elicitation message for an MCP tool call:
// `Allow the <server> MCP server to run tool "<tool>"?`
export function mcpToolName(message) {
  const match = /to run tool "([^"\n]{1,80})"/.exec(String(message ?? ""));
  return match ? match[1] : null;
}

export function mcpApprovalPolicy(permission) {
  if (permission === "full") return "never";
  if (permission === "standard" || permission === "auto") return "grant";
  return "every";
}

const COMPUTER = "computer";
const clip = (text, limit) => (text.length > limit ? `${text.slice(0, limit)}…` : text);

// What answering this call once would cover, or null when nothing can be
// granted for it. `free` is a call that never needs asking under a grant policy.
export function mcpGrant({ server, tool, params, builtin = false, title = server }) {
  if (typeof server !== "string" || !server || typeof tool !== "string" || !tool) return null;
  if (builtin && server === COMPUTER) {
    if (tool === "computer_apps") return { key: `${server}\napps`, free: true };
    const app = typeof params?.app === "string" ? params.app.trim() : "";
    if (app && app.length <= 120) return { key: `${server}\napp\n${app}`, label: `允许在「${clip(app, 40)}」里操作（这一轮）`, target: `${title} · ${clip(app, 40)}` };
    if (tool === "computer_screenshot") return { key: `${server}\nscreen`, label: "这一轮都允许截整个屏幕", target: `${title} · 整个屏幕` };
    return { key: `${server}\ntool\n${tool}`, label: `这一轮都允许「${clip(tool, 40)}」`, target: title };
  }
  if (builtin) return { key: `${server}\nserver`, label: `这一轮都允许「${clip(title, 40)}」`, target: title };
  return { key: `${server}\ntool\n${tool}`, label: `这一轮都允许「${clip(tool, 40)}」`, target: `${server} · ${clip(tool, 40)}` };
}
