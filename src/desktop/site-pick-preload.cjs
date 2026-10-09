// The toolbar laid over a site's preview (site-pick.html): this application's
// own page, not the site's. It asks this process to start picking, and hands
// over the one sentence the person typed; which element was picked is held in
// the main process, never taken from here.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sitePick", {
  toggle: (on) => ipcRenderer.invoke("idou:site-pick-toggle", on === true),
  send: (text) => ipcRenderer.invoke("idou:site-pick-send", String(text ?? "").slice(0, 2000)),
  cancel: () => ipcRenderer.invoke("idou:site-pick-cancel"),
  onState: (handler) => { ipcRenderer.on("idou:site-pick-state", (_event, value) => handler(value)); },
});
