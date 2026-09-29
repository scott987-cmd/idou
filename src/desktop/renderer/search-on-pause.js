// Typing and then waiting is the same intent as pressing Enter, so a search box
// runs itself once the person stops typing. Enter still works and simply skips
// the wait. The same value is never searched twice in a row, and the timer is
// cancelled whenever the field is cleared or the caller tears the view down.
const DELAY_MS = 1000;

export function searchOnPause(input, run, { delay = DELAY_MS, ready = () => true } = {}) {
  let timer = null, last = null;
  const cancel = () => { clearTimeout(timer); timer = null; };
  const fire = () => {
    cancel();
    const value = input.value.trim();
    if (!value || value === last || !ready(value)) return;
    last = value;
    run(value);
  };
  input.addEventListener("input", () => {
    cancel();
    const value = input.value.trim();
    if (!value) { last = null; return; }
    timer = setTimeout(fire, delay);
  });
  // Enter submits the surrounding form; the pending timer would otherwise fire a
  // second, identical search a moment later.
  input.addEventListener("keydown", event => { if (event.key === "Enter") { cancel(); last = input.value.trim() || null; } });
  return { cancel, reset: () => { cancel(); last = null; } };
}
