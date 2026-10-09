// The 选中修改 toolbar over a site's preview (docs/sites-phase1.md §1.2). Draws
// what the main process says -- idle, picking, picked -- and sends back only
// the person's own sentence. What was picked is named by the main process.
const $ = (id) => document.getElementById(id);
const api = window.sitePick;
let mode = "idle";

function paint(state = {}) {
  mode = state.mode || "idle";
  $("bar").hidden = mode === "picked";
  $("panel").hidden = mode !== "picked";
  $("pick-toggle").setAttribute("aria-pressed", mode === "picking" ? "true" : "false");
  $("pick-toggle").textContent = mode === "picking" ? "退出选中" : "选中修改";
  $("pick-hint").hidden = mode !== "picking";
  $("picked-label").textContent = state.label || "";
  $("pick-error").hidden = !state.error;
  $("pick-error").textContent = state.error || "";
  if (mode === "picked" && state.fresh) { $("pick-text").value = ""; $("pick-text").focus(); }
}

const run = async (work) => {
  try { await work(); } catch (error) { paint({ mode, label: $("picked-label").textContent, error: String(error?.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") }); }
};
$("pick-toggle").onclick = () => run(() => api.toggle(mode !== "picking"));
$("pick-again").onclick = () => run(() => api.toggle(true));
$("pick-cancel").onclick = () => run(() => api.cancel());
$("panel").onsubmit = (event) => { event.preventDefault(); void run(() => api.send($("pick-text").value)); };
$("pick-text").onkeydown = (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); $("panel").requestSubmit(); }
  if (event.key === "Escape") { event.preventDefault(); void run(() => api.cancel()); }
};
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && mode === "picking") void run(() => api.toggle(false)); });
api.onState(paint);
paint();
