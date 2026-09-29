import "../../src/adopt-legacy-env.js";
import { app, BrowserWindow } from "electron";
const url = new URL(process.env.APP_RUNTIME_FIXTURE_URL);
if (url.origin !== `http://127.0.0.1:${url.port}` || !url.port) throw new Error("Fixture requires a loopback runtime URL");
app.setPath("userData", process.env.APP_RUNTIME_FIXTURE_DATA);
// Do not top-level await readiness: Electron waits for its ESM entry to finish
// before emitting ready. Keep the startup callback outside module evaluation.
void app.whenReady().then(async () => {
const window = new BrowserWindow({ width: 1100, height: 760, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
window.webContents.on("will-navigate", (event, next) => { if (new URL(next).origin !== url.origin) event.preventDefault(); });
window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
await window.loadURL(url.href);
}).catch(error => { console.error(error); app.exit(1); });
