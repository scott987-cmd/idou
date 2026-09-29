import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { builtinCatalog, builtinConnectionRow, BuiltinConnectors } from "../src/application/builtin-connectors.js";
import { normalizeMcpConnection } from "../src/application/mcp-connections.js";

test("the catalog ships web-fetch with web_search and fetch_url tools", () => {
  const catalog = builtinCatalog();
  const webFetch = catalog.find((entry) => entry.key === "web-fetch");
  assert.ok(webFetch, "web-fetch must be in the catalog");
  assert.equal(webFetch.id, "web-fetch");
  assert.deepEqual(webFetch.tools.map((tool) => tool.name), ["web_search", "fetch_url"]);
  const computer = catalog.find((entry) => entry.key === "computer");
  assert.ok(computer, "computer must be in the catalog");
  assert.deepEqual(computer.tools.map((tool) => tool.name),
    ["computer_apps", "computer_windows", "computer_screenshot", "computer_click", "computer_type", "computer_key"]);
  // It drives the real desktop, so the description has to say so, and say that
  // macOS will not let it do anything until the person grants the permissions.
  assert.match(computer.description, /确认卡片|辅助功能/);
  assert.match(builtinConnectionRow("computer", { execPath: "/usr/bin/node" }).args[0], /bin[\\/]mcp[\\/]computer\.js$/);
  const browser = catalog.find((entry) => entry.key === "browser");
  assert.ok(browser, "browser must be in the catalog");
  assert.ok(browser.tools.some((tool) => tool.name === "browser_navigate"));
  assert.equal(builtinConnectionRow("browser", { execPath: "/usr/bin/node" }).enabledTools.includes("browser_navigate"), true);
});

test("builtinConnectionRow is a valid stdio MCP connection running the bundled server", () => {
  const row = builtinConnectionRow("web-fetch", { execPath: "/usr/bin/node" });
  assert.equal(row.transport, "stdio");
  assert.equal(row.command, "/usr/bin/node");
  assert.equal(row.args.length, 1);
  assert.match(row.args[0], /bin[\\/]mcp[\\/]web-fetch\.js$/);
  assert.ok(path.isAbsolute(row.args[0]));
  assert.deepEqual(row.enabledTools, ["fetch_url", "web_search"]); // normalizeMcpConnection sorts the allow-list
  // It survives the same validator a user-imported connection goes through.
  assert.deepEqual(normalizeMcpConnection(row), row);
  assert.equal(builtinConnectionRow("nope"), null);
});

test("the browser row carries the task's preview base on argv, and only when given one", () => {
  const plain = builtinConnectionRow("browser", { execPath: "/usr/bin/node" });
  assert.equal(plain.args.length, 1, "no preview server means no extra argv");
  const scoped = builtinConnectionRow("browser", { execPath: "/usr/bin/node", previewBase: "http://127.0.0.1:4321/SECRET/" });
  assert.deepEqual(scoped.args.slice(1), ["--preview-base", "http://127.0.0.1:4321/SECRET/"]);
  assert.ok(scoped.enabledTools.includes("browser_preview"));
  // It still passes the validator that refuses env vars and secrets on a row.
  assert.deepEqual(normalizeMcpConnection(scoped), scoped);
  // Only the browser takes one — web fetch has no browser to point anywhere.
  assert.equal(builtinConnectionRow("web-fetch", { execPath: "/usr/bin/node", previewBase: "http://127.0.0.1:4321/SECRET/" }).args.length, 1);
});

test("enabled state persists, and enabledRows reflects it", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "idou-builtin-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "builtin-connectors.json");
  const store = await new BuiltinConnectors({ file, execPath: "/usr/bin/node" }).load();
  assert.deepEqual(store.enabledRows(), [], "nothing enabled by default");
  assert.equal(store.list().find((row) => row.key === "web-fetch").enabled, false);

  const listed = await store.setEnabled("web-fetch", true);
  assert.equal(listed.find((row) => row.key === "web-fetch").enabled, true);
  assert.equal(store.enabledRows().length, 1);
  assert.equal(store.enabledRows()[0].id, "web-fetch");
  assert.match(JSON.parse(await readFile(file, "utf8")).enabled.join(), /web-fetch/);

  // A fresh instance reads the persisted state.
  const reopened = await new BuiltinConnectors({ file, execPath: "/usr/bin/node" }).load();
  assert.equal(reopened.enabledRows().length, 1);

  await store.setEnabled("web-fetch", false);
  assert.deepEqual(store.enabledRows(), []);
  await assert.rejects(store.setEnabled("does-not-exist", true), /未知/);
});
