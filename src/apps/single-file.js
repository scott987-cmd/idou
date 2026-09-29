// A pure front-end app has no server to be published to, so publishing it means
// making it portable: one HTML file that carries its own stylesheets, scripts
// and images and opens from anywhere — a chat, a Drive folder, a USB stick —
// with nothing to install and nothing to keep running.
//
// Only references that resolve to a file inside the collected bundle are
// inlined. An external URL is left exactly as written and reported, because
// silently rewriting it would change what the page loads, and silently dropping
// it would ship a page that is quietly broken.
import { APP_CONTENT_TYPES } from "./manifest.js";
const MIME = APP_CONTENT_TYPES;
const extension = (value) => { const match = /\.[a-z0-9]+$/i.exec(value); return match ? match[0].toLowerCase() : ""; };
export const mimeFor = (value) => MIME[extension(value)] ?? "application/octet-stream";

// A closing tag inside inlined code would end the element early and turn the
// remainder of the file into markup. This is the one escape that must not be
// forgotten, so it lives next to both call sites.
export const escapeForElement = (text, tag) => String(text).replace(new RegExp(`</(?=${tag})`, "gi"), "<\\/");

export function resolveAppPath(from, reference) {
  const raw = String(reference ?? "").trim();
  if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//") || raw.startsWith("#")) return null;
  const [withoutHash] = raw.split("#");
  const [target] = withoutHash.split("?");
  if (!target) return null;
  const base = target.startsWith("/") ? [] : from.split("/").slice(0, -1);
  const parts = [];
  for (const part of [...base, ...target.replace(/^\//, "").split("/")]) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!parts.length) return null; parts.pop(); continue; }
    parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}

export function bundleStaticApp({ entry, files }) {
  const lookup = new Map(files.map((file) => [file.path, file.bytes]));
  const html = lookup.get(entry);
  if (!html) throw new Error("找不到应用入口文件");
  const inlined = new Set(), external = new Set(), missing = new Set();
  const dataUri = (path) => `data:${mimeFor(path)};base64,${lookup.get(path).toString("base64")}`;
  // Resolve a reference to bundled bytes, recording why it could not be used.
  const take = (from, reference) => {
    const raw = String(reference ?? "").trim();
    if (!raw) return null;
    const target = resolveAppPath(from, raw);
    if (!target) { if (/^https?:/i.test(raw) || raw.startsWith("//")) external.add(raw); return null; }
    if (!lookup.has(target)) { missing.add(target); return null; }
    inlined.add(target); return target;
  };
  const inlineCss = (css, from) => escapeForElement(String(css).replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (whole, quote, reference) => {
    const target = take(from, reference);
    return target ? `url("${dataUri(target)}")` : whole;
  }), "style");

  let output = html.toString("utf8");
  // Stylesheets become style elements, carrying their own images with them.
  output = output.replace(/<link\b[^>]*>/gi, (tag) => {
    const rel = /\brel\s*=\s*(['"])([^'"]*)\1/i.exec(tag)?.[2]?.toLowerCase() ?? "";
    const href = /\bhref\s*=\s*(['"])([^'"]*)\1/i.exec(tag)?.[2];
    if (!href) return tag;
    const target = take(entry, href);
    if (!target) return tag;
    if (rel.split(/\s+/).includes("stylesheet")) return `<style>\n${inlineCss(lookup.get(target).toString("utf8"), target)}\n</style>`;
    return tag.replace(href, dataUri(target));
  });
  output = output.replace(/<script\b([^>]*)\bsrc\s*=\s*(['"])([^'"]*)\2([^>]*)>\s*<\/script>/gi, (tag, before, quote, src, after) => {
    const target = take(entry, src);
    if (!target) return tag;
    const attributes = `${before} ${after}`.replace(/\b(?:defer|async)\b/gi, "").replace(/\s+/g, " ").trim();
    return `<script${attributes ? ` ${attributes}` : ""}>\n${escapeForElement(lookup.get(target).toString("utf8"), "script")}\n</script>`;
  });
  // Everything else that points at a bundled asset becomes a data URI.
  output = output.replace(/\b(src|poster|data-src)\s*=\s*(['"])([^'"]*)\2/gi, (whole, attribute, quote, reference) => {
    const target = take(entry, reference);
    return target ? `${attribute}=${quote}${dataUri(target)}${quote}` : whole;
  });
  output = output.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (whole, css) => whole.replace(css, inlineCss(css, entry)));

  return { html: output, bytes: Buffer.byteLength(output),
    inlined: [...inlined].sort(), external: [...external].sort(), missing: [...missing].sort(),
    unused: files.map((file) => file.path).filter((path) => path !== entry && !inlined.has(path)).sort() };
}
