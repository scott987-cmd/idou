// Feishu's own unread count, taken from the one place the embedded client
// publishes it to the outside: its page title. Measured against the real client,
// the messenger's title is "消息 - 飞书 (9)" while nine are unread and "消息 - 飞书"
// once they are read, and it keeps changing while the view is hidden -- which is
// what makes a count in the sidebar possible at all, since the person is usually
// somewhere else in the app. Nothing here reads the page: no DOM, no message, no
// conversation, only the title string the browser already shows in a tab.
const AT_END = /[(（](\d{1,4})(\+?)[)）]$/;
const AT_START = /^[(（](\d{1,4})(\+?)[)）]/;

// Only at one end or the other. A number found anywhere in the middle would just
// as likely be part of a conversation's name.
export function unreadFromTitle(title) {
  const text = String(title ?? "").trim();
  const match = AT_END.exec(text) ?? AT_START.exec(text);
  const count = match ? Number(match[1]) : 0;
  return count > 0 ? { count, label: `${count}${match[2]}` } : { count: 0, label: "" };
}

// Reports the count the view has now, and every change after it -- but only real
// changes. While the client syncs it writes the title without any count for a
// moment and then writes a new one: measured, "(9)", then none, then "(10)".
// Believing that middle step makes the badge blink out and come back, so a count
// that goes away has to stay away for a moment before it is passed on. A count
// that appears or grows is passed on at once: that is a message arriving.
const SETTLE_MS = 2000;
export function watchFeishuUnread(contents, report, { settleMs = SETTLE_MS, schedule = setTimeout, cancel = clearTimeout } = {}) {
  let last = null, waiting = null;
  const read = () => { try { return unreadFromTitle(contents.getTitle()); } catch { return { count: 0, label: "" }; } };
  const emit = (value) => {
    if (last && last.count === value.count && last.label === value.label) return;
    last = value;
    report(value);
  };
  const look = () => {
    cancel(waiting); waiting = null;
    const value = read();
    if (value.count === 0 && last && last.count > 0) { waiting = schedule(() => { waiting = null; emit(read()); }, settleMs); return; }
    emit(value);
  };
  // A reload lands on the same title as often as not, so the load itself is also
  // an occasion to look.
  for (const event of ["page-title-updated", "did-finish-load"]) contents.on(event, look);
  look();
  return () => { cancel(waiting); waiting = null; for (const event of ["page-title-updated", "did-finish-load"]) contents.off?.(event, look); };
}

// One number, two places: the sidebar tab, so it reads like Feishu's own, and the
// Dock icon, so it is visible with the app in the background. It is also kept
// here because the renderer starts after the view does and has to be able to ask.
export function unreadReporter({ send, badge }) {
  let current = { count: 0, label: "" };
  const report = (value) => {
    current = value;
    send(value);
    badge(value.count);
  };
  return { report, current: () => current, clear: () => report({ count: 0, label: "" }) };
}
