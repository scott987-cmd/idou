import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { appManifest, appHash } from "../src/apps/manifest.js";
import { createPackagePreview } from "../src/apps/package-preview.js";

function fixture() {
  const contents = { "index.html": '<!doctype html><script src="assets/app.js"></script><p>Archived version</p>', "assets/app.js": "window.archived = true;", "assets/style.css": "body{color:#333}", "empty.json": "" };
  const checked = appManifest({ schemaVersion: 1, runtime: "static", network: "none", entry: "index.html", files: Object.entries(contents).map(([path, text]) => ({ path, bytes: Buffer.byteLength(text), sha256: appHash(text) })) });
  const bytes = Buffer.from(JSON.stringify({ manifest: checked.manifest, blobs: checked.manifest.files.map(({ path }) => ({ path, base64: Buffer.from(contents[path]).toString("base64") })) }));
  return { bytes, digest: checked.digest, expiresAt: Date.now() + 10000, contents };
}
test("package preview serves only captured verified bytes and static assets, without retaining the caller buffer", async (t) => {
  const f = fixture(), server = await createPackagePreview(f); t.after(() => server.close()); f.bytes.fill(0);
  for (const [file, body] of Object.entries(f.contents)) {
    const response = await fetch(server.url(file)); assert.equal(response.status, 200); assert.equal(await response.text(), body);
    assert.equal(response.headers.get("cache-control"), "no-store"); assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  }
  const head = await fetch(server.url("index.html"), { method: "HEAD" }); assert.equal(await head.text(), "");
  assert.equal(head.headers.get("content-type"), "text/html"); assert.equal(Number(head.headers.get("content-length")), Buffer.byteLength(f.contents["index.html"]));
  const csp = head.headers.get("content-security-policy");
  for (const clause of ["default-src 'none'", "connect-src 'self'", "worker-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'"]) assert.ok(csp.includes(clause));
});
test("package preview denies unknown resources, origin/host forgery, traversal and non-read requests", async (t) => {
  const server = await createPackagePreview(fixture()); t.after(() => server.close());
  for (const url of [server.origin, server.url("missing.html"), server.url("../index.html"), server.url("%2e%2e/index.html"), "file:///index.html", "https://example.invalid/"]) assert.equal(server.allows(url), false, url);
  assert.equal(server.allows(server.url("assets/app.js")), true);
  for (const options of [{ method: "POST" }, { headers: { origin: "https://example.invalid" } }]) assert.equal((await fetch(server.url("index.html"), options)).status, 404);
  const status = await new Promise((resolve, reject) => { const req = request(server.url("index.html"), { headers: { host: "evil.invalid" } }, (res) => { res.resume(); resolve(res.statusCode); }); req.on("error", reject); req.end(); }); assert.equal(status, 404);
  for (const url of [server.origin, server.url("missing.html"), server.url("../index.html")]) assert.equal((await fetch(url)).status, 404);
});
test("expiry invalidates the capability, closes the listener and fires once", async (t) => {
  let expired = 0;
  const server = await createPackagePreview({ ...fixture(), expiresAt: Date.now() + 150, onExpired: () => { expired++; } }); t.after(() => server.close());
  const url = server.url(server.entry); assert.equal((await fetch(url)).status, 200);
  await delay(220); assert.equal(expired, 1); assert.equal(server.allows(url), false); await assert.rejects(fetch(url)); server.close(); assert.equal(expired, 1);
});
test("manual close releases listener and cancels later expiry", async () => {
  let expired = 0; const server = await createPackagePreview({ ...fixture(), expiresAt: Date.now() + 100, onExpired: () => { expired++; } });
  const url = server.url(server.entry); server.close(); server.close(); assert.equal(server.allows(url), false); await assert.rejects(fetch(url)); await delay(150); assert.equal(expired, 0);
});
test("invalid packages and invalid preview lifetimes are rejected before serving", async () => {
  for (const expiresAt of [0, NaN, Infinity, Date.now() + 400000]) await assert.rejects(createPackagePreview({ ...fixture(), expiresAt }));
  await assert.rejects(createPackagePreview({ ...fixture(), bytes: Buffer.from("corrupt") }));
  await assert.rejects(createPackagePreview({ ...fixture(), digest: "f".repeat(64) }));
});
