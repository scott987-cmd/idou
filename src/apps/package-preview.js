import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import path from "node:path";
import { appPackage } from "./archive.js";
import { APP_CONTENT_TYPES, appManifest, appHash } from "./manifest.js";

const types = APP_CONTENT_TYPES;
export async function createPackagePreview({ bytes, digest, expiresAt, onExpired = () => {} }) {
  const pkg = appPackage(bytes, digest);
  // Decode into a private map. No extraction, mutable workspace or cache reads
  // occur after validation; a caller cannot alter the served bytes via its Buffer.
  const files = new Map(pkg.blobs.map((blob) => [blob.path, Buffer.from(blob.base64, "base64")]));
  return createStaticGateway({ manifest: pkg.manifest, expiresAt, onExpired, readFile: async relative => files.get(relative), onClose: () => files.clear() });
}

// The gateway holds a manifest, not a workspace or executable package. A runtime
// reader may be in another process/container; validate every returned file anew.
export async function createStaticGateway({ manifest, readFile, expiresAt, onExpired = () => {}, onClose = () => {} }) {
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 300000 || typeof readFile !== "function") throw new Error("归档预览授权期限无效");
  const checked = appManifest(manifest), entry = checked.manifest.entry;
  const files = new Map(checked.manifest.files.map(file => [file.path, file]));
  const prefix = `/${randomBytes(24).toString("base64url")}/`;
  let origin, timer, closed = false;
  const relativePath = (value) => {
    const u = new URL(value);
    if (closed || Date.now() >= expiresAt || u.origin !== origin || u.username || u.password || !u.pathname.startsWith(prefix)) return null;
    const relative = decodeURIComponent(u.pathname.slice(prefix.length));
    return files.has(relative) ? relative : null;
  };
  const allows = (value) => { try { return relativePath(value) !== null; } catch { return false; } };
  const server = createServer(async (req, res) => {
    try {
      if (!["GET", "HEAD"].includes(req.method) || req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) throw new Error();
      const relative = relativePath(new URL(req.url, origin).href), expected = files.get(relative);
      if (!expected) throw new Error();
      const contents = await readFile(relative);
      if (closed || Date.now() >= expiresAt || !Buffer.isBuffer(contents) || contents.length !== expected.bytes || appHash(contents) !== expected.sha256) throw new Error();
      res.writeHead(200, { "content-type": types[path.extname(relative)], "content-length": contents.length, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cross-origin-resource-policy": "same-origin",
        "content-security-policy": "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'" });
      res.end(req.method === "HEAD" ? undefined : contents);
    } catch { if (!res.destroyed) { res.writeHead(404, { "cache-control": "no-store" }); res.end("Not found"); } }
  });
  server.on("upgrade", (_req, socket) => socket.destroy());
  const close = () => { if (closed) return; closed = true; clearTimeout(timer); files.clear(); server.close(); server.closeAllConnections(); onClose(); };
  server.listen(0, "127.0.0.1"); await once(server, "listening"); origin = `http://127.0.0.1:${server.address().port}`;
  timer = setTimeout(() => { close(); onExpired(); }, Math.max(0, expiresAt - Date.now()));
  return { origin, entry, expiresAt, allows, url: (relative) => `${origin}${prefix}${relative.split("/").map(encodeURIComponent).join("/")}`, close };
}
