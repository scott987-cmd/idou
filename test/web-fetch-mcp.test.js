import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { isBlockedIp, htmlToText, assertPublicHost, fetchUrl, webSearch, parseDuckDuckGo, WEB_FETCH_TOOLS } from "../bin/mcp/web-fetch.js";

test("blocks loopback, private, link-local and IPv4-mapped addresses; allows public ones", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "172.16.0.1", "172.31.255.255", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "fe80::1", "fc00::1", "fd12::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"]) {
    assert.equal(isBlockedIp(ip), true, `${ip} must be blocked`);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.0.1", "172.32.0.1", "2606:4700::1"]) {
    assert.equal(isBlockedIp(ip), false, `${ip} must be allowed`);
  }
});

test("assertPublicHost refuses localhost, .local and private IP literals", async () => {
  for (const host of ["localhost", "app.localhost", "printer.local", "127.0.0.1", "192.168.1.1", "169.254.169.254", "::1"]) {
    await assert.rejects(assertPublicHost(host), /内网|私有|本机/, `${host} must be refused`);
  }
});

test("fetch_url refuses non-http(s) and internal targets before any network", async () => {
  for (const url of ["ftp://example.com/x", "file:///etc/passwd"]) {
    const result = await fetchUrl(url);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /http\/https/);
  }
  for (const url of ["http://127.0.0.1/", "http://localhost:8080/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://192.168.1.1/admin"]) {
    const result = await fetchUrl(url);
    assert.equal(result.isError, true, `${url} must be refused`);
    assert.match(result.content[0].text, /内网|私有|本机/);
  }
});

test("htmlToText strips scripts/tags and decodes entities", () => {
  const html = "<html><head><style>x{}</style></head><body><h1>Title</h1><script>evil()</script><p>Hello&nbsp;&amp; <b>world</b> &#39;q&#39; &lt;ok&gt;</p></body></html>";
  const text = htmlToText(html);
  assert.match(text, /Title/);
  assert.match(text, /Hello & world 'q' <ok>/);
  assert.doesNotMatch(text, /evil|<script|<b>|x\{\}/);
});

test("the tool schema advertises fetch_url and web_search with their required args", () => {
  assert.deepEqual(WEB_FETCH_TOOLS.map((tool) => tool.name), ["fetch_url", "web_search"]);
  assert.deepEqual(WEB_FETCH_TOOLS.find((tool) => tool.name === "fetch_url").inputSchema.required, ["url"]);
  assert.deepEqual(WEB_FETCH_TOOLS.find((tool) => tool.name === "web_search").inputSchema.required, ["query"]);
});

test("parseDuckDuckGo decodes the uddg redirect, normalizes // links, dedupes and honors the cap", () => {
  const html = [
    '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2Ffs.html&amp;rut=abc">Node.js <b>fs</b> docs</a>',
    '<a class="result__a" href="//example.com/direct">Direct link</a>',
    '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2Ffs.html&amp;rut=xyz">Duplicate target</a>',
    '<a class="result__a" href="javascript:void(0)">Not a link</a>',
  ].join("\n");
  const results = parseDuckDuckGo(html, 5);
  assert.deepEqual(results, [
    { title: "Node.js fs docs", url: "https://nodejs.org/api/fs.html" },
    { title: "Direct link", url: "https://example.com/direct" },
  ]);
  assert.equal(parseDuckDuckGo(html, 1).length, 1);
  assert.deepEqual(parseDuckDuckGo("<p>no results here</p>", 5), []);
});

test("parseDuckDuckGo drops paid placements and DuckDuckGo's own pages", () => {
  // The real HTML endpoint puts an ad first, as a y.js redirect back through
  // duckduckgo.com — it must never reach the agent as a search result.
  const html = [
    '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fy.js%3Fad_domain%3Dudemy.com%26ad_provider%3Dbingv7aa&amp;rut=1">Learn Node.js — Udemy</a>',
    '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fduckduckgo-help-pages%2Fcompany%2Fads&amp;rut=2">About our ads</a>',
    '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2Ffs.html&amp;rut=3">File system | Node.js</a>',
  ].join("\n");
  assert.deepEqual(parseDuckDuckGo(html, 10), [{ title: "File system | Node.js", url: "https://nodejs.org/api/fs.html" }]);
});

test("parseDuckDuckGo falls back to class-less result anchors (the lite endpoint)", () => {
  const lite = [
    '<a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2Ffs.html&amp;rut=a">File system</a>',
    '<a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fguide&amp;rut=b">A guide</a>',
    '<a href="/settings">Settings</a>',
  ].join("\n");
  assert.deepEqual(parseDuckDuckGo(lite, 10), [
    { title: "File system", url: "https://nodejs.org/api/fs.html" },
    { title: "A guide", url: "https://example.com/guide" },
  ]);
});

test("web_search refuses an empty query before touching the network", async () => {
  for (const query of ["", "   ", undefined]) {
    const result = await webSearch(query);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /关键词/);
  }
});

test("speaks MCP over stdio: initialize, tools/list, and a refused fetch", async () => {
  const server = spawn(process.execPath, [fileURLToPath(new URL("../bin/mcp/web-fetch.js", import.meta.url))], { stdio: ["pipe", "pipe", "inherit"] });
  const replies = [];
  let buffer = "";
  server.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (line.trim()) replies.push(JSON.parse(line)); }
  });
  const request = (obj) => server.stdin.write(`${JSON.stringify(obj)}\n`);
  try {
    request({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    request({ jsonrpc: "2.0", method: "notifications/initialized" }); // notification: no reply
    request({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    request({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "fetch_url", arguments: { url: "http://127.0.0.1/" } } });
    request({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "web_search", arguments: { query: "" } } });
    const deadline = Date.now() + 10_000;
    while (replies.length < 4 && Date.now() < deadline) await once(server.stdout, "data").catch(() => {});
    const byId = Object.fromEntries(replies.map((r) => [r.id, r]));
    assert.equal(byId[1].result.serverInfo.name, "idou-web-fetch");
    assert.deepEqual(byId[2].result.tools.map((tool) => tool.name), ["fetch_url", "web_search"]);
    assert.equal(byId[3].result.isError, true);
    assert.match(byId[3].result.content[0].text, /内网|私有|本机/);
    assert.equal(byId[4].result.isError, true);
    assert.match(byId[4].result.content[0].text, /关键词/);
    assert.equal(replies.some((r) => r.id === undefined), false, "notifications get no reply");
  } finally { server.kill(); }
});
