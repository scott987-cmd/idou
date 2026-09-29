import { appManifest, appHash } from "../../src/apps/manifest.js";
export function staticAppFixture() {
  const files = { "index.html": '<!doctype html><meta charset="utf-8"><title>隔离运行验收</title><link rel="stylesheet" href="assets/site.css"><main><small>MYDOUBAO / ISOLATED RUNTIME</small><h1>静态应用已在隔离节点就绪</h1><p>版本包经容器独立校验，内容由只读运行节点提供。</p><button id="counter">已完成 0 项</button><p id="result">这是合成验收应用，不是已发布的企业服务。</p></main><script src="assets/app.js"></script>',
    "assets/site.css": 'body{background:#f4f4ee;color:#30362b;font:17px system-ui;margin:0}main{max-width:780px;margin:12vh auto;padding:40px}small{letter-spacing:.16em;font-size:11px}h1{font-weight:500;font-size:32px}p{line-height:1.8;color:#69715f}button{padding:15px 22px;background:#30362b;color:#fff;border:0;border-radius:7px;font:inherit}',
    "assets/app.js": 'let count=0;document.querySelector("#counter").onclick=()=>{document.querySelector("#counter").textContent=`已完成 ${++count} 项`;};', "assets/empty.json": "" };
  const checked = appManifest({ schemaVersion: 1, runtime: "static", network: "none", entry: "index.html", files: Object.entries(files).map(([path, text]) => ({ path, bytes: Buffer.byteLength(text), sha256: appHash(text) })) });
  const bytes = Buffer.from(JSON.stringify({ manifest: checked.manifest, blobs: checked.manifest.files.map(file => ({ path: file.path, base64: Buffer.from(files[file.path]).toString("base64") })) }));
  return { bytes, digest: checked.digest, sha256: appHash(bytes), manifest: checked.manifest, files };
}
