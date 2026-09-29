import { Terminal } from "../../../node_modules/@xterm/xterm/lib/xterm.mjs";
import { FitAddon } from "../../../node_modules/@xterm/addon-fit/lib/addon-fit.mjs";

const MAX_REFERENCE = 8_000;

export function terminalReference(task, text, now = Date.now()) {
  const excerpt = typeof text === "string" ? text.slice(0, MAX_REFERENCE) : "";
  if (!task?.id || !excerpt.trim()) throw new Error("请先在终端中选中要添加到对话的输出");
  const folder = String(task.cwd || "项目").split(/[\\/]/).filter(Boolean).at(-1) || "项目";
  return { kind: "terminal", key: `terminal:${task.id}:${now}`, title: `终端输出 · ${folder}`, excerpt };
}

export function taskTerminalUi({ api, getTask, addReference, reportError, onLayout } = {}) {
  const panel = document.querySelector("#task-terminal"), screen = document.querySelector("#terminal-screen"), status = document.querySelector("#terminal-status");
  const selection = document.querySelector("#terminal-add-selection"), reopen = document.querySelector("#terminal-reopen"), end = document.querySelector("#terminal-end");
  const sessions = new Map(), pendingData = new Map(), pendingExit = new Map();
  let visibleTaskId = null, resizeFrame = null;

  function terminalTheme() {
    // xterm expects resolved colours; CSS custom properties retain the literal
    // light-dark() function in Chromium and therefore cannot be passed through.
    return { background: "#171614", foreground: "#eee9df", cursor: "#e19a5b", selectionBackground: "#8c654b99" };
  }

  function sessionFor(task) {
    let held = sessions.get(task.id);
    if (held) return held;
    const host = document.createElement("div"); host.className = "terminal-host"; host.dataset.taskId = task.id; host.hidden = true; screen.append(host);
    const terminal = new Terminal({ cursorBlink: true, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 12, lineHeight: 1.25,
      scrollback: 5_000, allowProposedApi: false, theme: terminalTheme() });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host);
    held = { taskId: task.id, host, terminal, fit, terminalId: null, state: "opening", lastSeq: 0, input: "", inputTimer: null };
    sessions.set(task.id, held);
    terminal.onData(data => queueInput(held, data));
    terminal.onSelectionChange(() => { if (visibleTaskId === task.id) paint(held); });
    return held;
  }

  function queueInput(held, data) {
    if (held.state !== "running" || !held.terminalId) return;
    held.input += data;
    if (new TextEncoder().encode(held.input).length > 60_000) void flushInput(held);
    else if (!held.inputTimer) held.inputTimer = setTimeout(() => { held.inputTimer = null; void flushInput(held); }, 8);
  }

  async function flushInput(held) {
    if (!held.input || held.state !== "running" || !held.terminalId) return;
    const data = held.input; held.input = "";
    try { await api.terminalWrite(held.taskId, held.terminalId, data); }
    catch (cause) { held.state = "disconnected"; paint(held); reportError(cause); }
  }

  function acceptData(held, value) {
    if (value.seq <= held.lastSeq) return;
    held.lastSeq = value.seq; held.terminal.write(value.data);
  }
  function acceptExit(held, value) { held.state = "exited"; held.exit = { exitCode: value.exitCode, signal: value.signal }; if (visibleTaskId === held.taskId) paint(held); }
  function applyPending(held) {
    const rows = pendingData.get(held.terminalId) ?? [];
    rows.sort((a, b) => a.seq - b.seq).forEach(value => acceptData(held, value)); pendingData.delete(held.terminalId);
    const exited = pendingExit.get(held.terminalId); if (exited) { pendingExit.delete(held.terminalId); acceptExit(held, exited); }
  }

  async function connect(task, { restart = false } = {}) {
    const held = sessionFor(task); held.state = "opening"; paint(held);
    try {
      const size = fittedSize(held), result = restart && held.terminalId
        ? await api.terminalReopen(task.id, held.terminalId, size)
        : await api.terminalOpen(task.id, size);
      held.terminal.reset();
      if (result.truncated) held.terminal.writeln("\x1b[33m… 较早的终端输出已从 1 MiB 缓存中移除 …\x1b[0m");
      if (result.output) held.terminal.write(result.output);
      held.terminalId = result.terminalId; held.lastSeq = result.seq ?? 0; held.state = result.state; held.exit = result.exit;
      applyPending(held); fitSession(held); paint(held);
    } catch (cause) { held.state = "disconnected"; paint(held); reportError(cause); }
  }

  function fittedSize(held) {
    if (!held.host.hidden) { try { held.fit.fit(); } catch { /* measured after the panel becomes visible */ } }
    return { cols: held.terminal.cols || 80, rows: held.terminal.rows || 24 };
  }
  function fitSession(held) {
    if (!held || held.host.hidden || panel.hidden) return;
    cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(() => {
      try { held.fit.fit(); } catch { return; }
      if (held.state === "running" && held.terminalId) void api.terminalResize(held.taskId, held.terminalId, { cols: held.terminal.cols, rows: held.terminal.rows })
        .catch(cause => { held.state = "disconnected"; paint(held); reportError(cause); });
    });
  }
  function paint(held = sessions.get(visibleTaskId)) {
    for (const row of sessions.values()) row.host.hidden = row !== held || panel.hidden;
    const labels = { opening: "正在连接…", running: "运行中", exited: `已退出${held?.exit?.exitCode === null || held?.exit?.exitCode === undefined ? "" : ` · 状态 ${held.exit.exitCode}`}`, closed: "已结束", disconnected: "连接中断 · 可重试" };
    status.textContent = held ? labels[held.state] ?? held.state : "尚未打开";
    selection.disabled = !held?.terminal.hasSelection();
    reopen.hidden = !held || !["exited", "closed", "disconnected"].includes(held.state);
    reopen.textContent = held?.state === "disconnected" ? "重新连接" : "重新打开";
    end.disabled = !held || held.state !== "running";
  }

  api.onTerminalData(value => {
    const held = sessions.get(value?.taskId);
    if (!held) return;
    if (!held.terminalId) {
      const rows = pendingData.get(value?.terminalId) ?? []; rows.push(value);
      let bytes = rows.reduce((sum, row) => sum + new TextEncoder().encode(row.data ?? "").length, 0);
      while (bytes > 1024 * 1024 && rows.length > 1) bytes -= new TextEncoder().encode(rows.shift().data ?? "").length;
      pendingData.set(value?.terminalId, rows); return;
    }
    if (held.terminalId === value.terminalId) acceptData(held, value);
  });
  api.onTerminalExit(value => {
    const held = sessions.get(value?.taskId);
    if (!held) return;
    if (!held.terminalId) { pendingExit.set(value?.terminalId, value); return; }
    if (held.terminalId === value.terminalId) acceptExit(held, value);
  });

  selection.onclick = () => {
    const task = getTask(), held = task && sessions.get(task.id); if (!held) return;
    try { addReference(terminalReference(task, held.terminal.getSelection())); held.terminal.clearSelection(); paint(held); }
    catch (cause) { reportError(cause); }
  };
  reopen.onclick = () => { const task = getTask(), held = task && sessions.get(task.id); if (!task || !held) return; void connect(task, { restart: held.state === "exited" }).then(() => held.terminal.focus()); };
  end.onclick = () => { const task = getTask(), held = task && sessions.get(task.id); if (!task || !held?.terminalId) return; void api.terminalClose(task.id, held.terminalId).then(result => {
    if (!result) return; held.state = "closed"; paint(held);
  }, reportError); };

  const observer = new ResizeObserver(() => fitSession(sessions.get(visibleTaskId))); observer.observe(screen);
  const handle = document.querySelector("#terminal-resizer"); let pointer = null;
  handle.onpointerdown = event => { if (event.button !== 0) return; pointer = { id: event.pointerId, y: event.clientY, height: panel.getBoundingClientRect().height }; handle.setPointerCapture(event.pointerId); event.preventDefault(); };
  handle.onpointermove = event => { if (!pointer || pointer.id !== event.pointerId) return; const stage = document.querySelector("#task-stage").getBoundingClientRect(); const height = Math.max(160, Math.min(stage.height * 0.45, pointer.height + pointer.y - event.clientY)); panel.style.setProperty("--terminal-height", `${Math.round(height)}px`); fitSession(sessions.get(visibleTaskId)); onLayout?.(); };
  handle.onpointerup = handle.onpointercancel = event => { if (pointer?.id !== event.pointerId) return; pointer = null; handle.releasePointerCapture?.(event.pointerId); };

  return {
    sync(task, visible) {
      visibleTaskId = visible && task?.mode === "coding" ? task.id : null; panel.hidden = !visibleTaskId;
      for (const held of sessions.values()) held.host.hidden = held.taskId !== visibleTaskId;
      if (!visibleTaskId) { paint(); return; }
      const held = sessionFor(task); held.host.hidden = false; paint(held);
      if (held.state === "opening" && !held.terminalId) void connect(task);
      requestAnimationFrame(() => { fitSession(held); held.terminal.focus(); });
    },
    focus() { sessions.get(visibleTaskId)?.terminal.focus(); },
  };
}
