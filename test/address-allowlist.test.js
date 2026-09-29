import test from "node:test";
import assert from "node:assert/strict";
import { addressAllowlist } from "../src/control-plane/address-allowlist.js";

test("no list is no restriction, which is what every deployment does today", () => {
  assert.equal(addressAllowlist(""), null);
  assert.equal(addressAllowlist(null), null);
  assert.equal(addressAllowlist("  ,  "), null);
});

test("a v4 network lets its own in and keeps everything else out", () => {
  const list = addressAllowlist("10.0.0.0/8, 192.168.1.0/24");
  assert.equal(list.allows("10.0.0.1"), true);
  assert.equal(list.allows("10.255.255.254"), true);
  assert.equal(list.allows("192.168.1.42"), true);
  assert.equal(list.allows("192.168.2.42"), false);
  assert.equal(list.allows("11.0.0.1"), false);
  assert.equal(list.allows("203.0.113.9"), false);
  // A bare address is that address and nothing else.
  const one = addressAllowlist("203.0.113.9");
  assert.equal(one.allows("203.0.113.9"), true);
  assert.equal(one.allows("203.0.113.10"), false);
});

test("loopback is always in, however the list is written", () => {
  // Otherwise an operator cannot curl the server from the server, which is the
  // first thing anybody does when a site will not open.
  const list = addressAllowlist("203.0.113.0/24");
  assert.equal(list.allows("127.0.0.1"), true);
  assert.equal(list.allows("127.9.9.9"), true);
  assert.equal(list.allows("::1"), true);
});

test("v6, and the v4 addresses that arrive wearing a v6 spelling", () => {
  const list = addressAllowlist("fd00::/8, 10.0.0.0/8");
  assert.equal(list.allows("fd00::1"), true);
  assert.equal(list.allows("fd12:3456:789a::1"), true);
  assert.equal(list.allows("2001:db8::1"), false);
  // Node reports a v4 peer on a dual-stack listener like this. Comparing it as
  // v6 against a v4 rule would never match and the rule would look broken.
  assert.equal(list.allows("::ffff:10.1.2.3"), true);
  assert.equal(list.allows("::ffff:203.0.113.9"), false);
});

test("an address that cannot be read is not allowed, and a typo stops the server", () => {
  const list = addressAllowlist("10.0.0.0/8");
  for (const value of ["", "nonsense", null, undefined, "10.0.0", "10.0.0.0/8"]) assert.equal(list.allows(value), false);
  // A list that fails open is worse than no list, because somebody believes it.
  assert.throws(() => addressAllowlist("10.0.0.0/33"), /网段长度/);
  assert.throws(() => addressAllowlist("10.0.0.0/-1"), /网段长度/);
  assert.throws(() => addressAllowlist("not-an-address/8"), /不是一个地址/);
  assert.throws(() => addressAllowlist("10.0.0.0/8, oops"), /不是一个地址/);
});
