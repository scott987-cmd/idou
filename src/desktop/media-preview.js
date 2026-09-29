import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { MediaDownloader } from "../application/media-download.js";

// A temporary result is part of the task, not a separate application, so it is
// shown inside the window beside the conversation rather than in a floating
// window of its own. It is still its own web contents with its own partition:
// the bytes are written to a private temporary file and rendered by a page that
// may load nothing else, so nothing about a generated result is handed to the
// application's renderer.
export class MediaPreview {
  constructor({ WebContentsView, window, allowedAddressRanges = [] }) {
    Object.assign(this, { WebContentsView, window });
    this.current = null; this.downloader = new MediaDownloader({ allow: allowedAddressRanges }); this.opening = 0;
  }
  live() { const contents = this.current?.view.webContents; return contents && !contents.isDestroyed() ? contents : null; }
  async open(result, unchanged) {
    if (this.opening) throw new Error("请先等待当前媒体预览打开");
    this.opening++;
    try { await this.close(); return await this.openReserved(result, unchanged); }
    finally { this.opening--; }
  }
  async openReserved(result, unchanged) {
    const media = await this.downloader.download(result); await unchanged();
    const directory = await mkdtemp(path.join(os.tmpdir(), "idou-media-preview-"));
    let view = null;
    try {
      const file = path.join(directory, `result.${media.extension}`), html = path.join(directory, "index.html");
      await writeFile(file, media.bytes, { flag: "wx", mode: 0o600 });
      const tag = result.kind === "image" ? `<img src="result.${media.extension}" alt="生成的临时图片">` : `<video src="result.${media.extension}" controls preload="metadata"></video>`;
      await writeFile(html, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none'"><title>临时成果预览</title><style>html,body{height:100%}body{margin:0;background:#eeede8;color:#363a37;font:13px system-ui;display:flex;flex-direction:column}header{padding:10px 14px;flex:none}main{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:0 14px 14px}img,video{max-width:100%;max-height:100%;object-fit:contain}small{color:#626862;display:block}</style><header>临时成果预览<small>尚未保存到飞书云盘 · 关闭即清理本次预览缓存</small></header><main>${tag}</main></html>`, { flag: "wx", mode: 0o600 });
      view = new this.WebContentsView({ webPreferences: { partition: `media-preview-${randomUUID()}`, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: false } });
      const contents = view.webContents;
      const allowed = new Set([pathToFileURL(file).href, pathToFileURL(html).href]);
      contents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !allowed.has(details.url) }));
      contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      contents.session.setPermissionCheckHandler(() => false);
      contents.session.on("will-download", (event) => event.preventDefault());
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
      contents.on("will-navigate", (event) => event.preventDefault());
      this.current = { view, directory };
      this.window.contentView.addChildView(view);
      // Off-screen until the renderer reports where the panel actually is, so a
      // result never flashes over the conversation on its way in.
      view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      await contents.loadFile(html); await unchanged();
      return { kind: result.kind };
    } catch (error) {
      this.current = null;
      if (view) { try { this.window.contentView.removeChildView(view); } catch { /* already detached */ } const contents = view.webContents; if (contents && !contents.isDestroyed()) contents.close(); }
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
  bounds(rect) {
    if (!this.current) return;
    const [width, height] = this.window.getContentSize();
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) throw new Error("Invalid media preview bounds");
    const x = Math.max(0, Math.min(width, Math.round(rect.x))), y = Math.max(0, Math.min(height, Math.round(rect.y)));
    const bounds = { x, y, width: Math.max(0, Math.min(width - x, Math.round(rect.width))), height: Math.max(0, Math.min(height - y, Math.round(rect.height))) };
    this.current.view.setBounds(bounds);
    this.current.view.setVisible(bounds.width > 0 && bounds.height > 0);
  }
  async close() {
    const current = this.current; this.current = null;
    if (!current) return;
    try { this.window.contentView.removeChildView(current.view); } catch { /* already detached */ }
    const contents = current.view.webContents;
    if (contents && !contents.isDestroyed()) contents.close();
    await rm(current.directory, { recursive: true, force: true }).catch(() => {});
  }
}
