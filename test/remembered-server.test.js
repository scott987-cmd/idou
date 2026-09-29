import test from "node:test";
import assert from "node:assert/strict";
import { rememberedServerUrl, rememberedServerFile } from "../src/desktop/remembered-server.js";

// The pointer beside the account holds the control plane it signed in to. Opened
// from Finder there is nothing else to go on, and a packaged app with no address
// skips the sign-in entirely.
test("the address the last account signed in to is read back, and only a real one", () => {
  assert.equal(rememberedServerUrl({ serverUrl: "http://127.0.0.1:3041" }), "http://127.0.0.1:3041", "loopback is how a local deployment is reached");
  assert.equal(rememberedServerUrl({ serverUrl: "https://control.example.com" }), "https://control.example.com");
  assert.equal(rememberedServerUrl({ serverUrl: "https://control.example.com/path?x=1" }), null, "an address with a path or a query is not a control plane");
  assert.equal(rememberedServerUrl({ serverUrl: "http://example.com" }), null, "plain HTTP off the loopback is refused");
  for (const pointer of [null, undefined, {}, { serverUrl: 42 }, { serverUrl: "" }, { namespace: "abc" }]) assert.equal(rememberedServerUrl(pointer), null);
});

test("an unreadable or damaged pointer leaves the app signed out rather than failing to start", async () => {
  const read = async () => JSON.stringify({ namespace: "a".repeat(64), serverUrl: "http://127.0.0.1:3041" });
  assert.equal(await rememberedServerFile("/wherever", read), "http://127.0.0.1:3041");
  assert.equal(await rememberedServerFile("/wherever", async () => "{ not json"), null);
  assert.equal(await rememberedServerFile("/wherever", async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); }), null, "a machine that never signed in has no pointer");
});
