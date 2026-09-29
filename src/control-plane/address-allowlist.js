// Which addresses may connect at all.
//
// The site listener is the only thing in this deployment that accepts a
// connection from the network; everything else is bound to loopback. Once
// IDOU_SITES_ANONYMOUS is on, anyone who can reach that port can open an
// anonymous site, and "anyone who can reach the port" is a question about the
// network, not about Feishu. This answers it, before any of the rest: an
// address that is not allowed does not learn what the page looks like, whether
// a site id exists, or that there is a sign-in.
//
// It is not authentication. It says which addresses may knock; who may open
// which site is still decided per request by site-access.js, as the person
// Feishu says they are. The two stack and neither replaces the other.
//
// Only the address on the socket is used -- never X-Forwarded-For. A forwarded
// header is a string the client writes, so trusting it is the same as having no
// list at all. A deployment behind a reverse proxy either lets the proxy hold
// the list or puts the proxy in it.
import { isIPv4, isIPv6 } from "node:net";

// Loopback is always in, however the list is written. Otherwise an operator
// cannot curl the server from the server, which is the first thing anybody does
// when a site will not open.
const LOOPBACK = ["127.0.0.0/8", "::1/128"];

const bytesOf = (address) => {
  if (isIPv4(address)) return address.split(".").map(Number);
  if (!isIPv6(address)) return null;
  // ::ffff:10.0.0.1 is an IPv4 address wearing an IPv6 spelling, which is how
  // Node reports one on a dual-stack listener. Comparing it as IPv6 against an
  // IPv4 rule would never match, and the rule would look broken rather than
  // narrow.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return bytesOf(mapped[1]);
  const [head, tail = ""] = address.split("::");
  const parts = (text) => text.split(":").filter(Boolean).map((group) => Number.parseInt(group, 16));
  const left = parts(head), right = parts(tail);
  if (left.some(Number.isNaN) || right.some(Number.isNaN)) return null;
  const groups = address.includes("::")
    ? [...left, ...Array(8 - left.length - right.length).fill(0), ...right]
    : left;
  if (groups.length !== 8 || groups.some((group) => group < 0 || group > 0xffff)) return null;
  return groups.flatMap((group) => [group >> 8, group & 0xff]);
};

function parseRule(text) {
  const [address, width] = String(text).trim().split("/");
  const bytes = bytesOf(address);
  if (!bytes) throw new Error(`不是一个地址：${text}`);
  const bits = width === undefined ? bytes.length * 8 : Number(width);
  if (!Number.isInteger(bits) || bits < 0 || bits > bytes.length * 8) throw new Error(`网段长度不对：${text}`);
  return { bytes, bits, family: bytes.length, text: String(text).trim() };
}

const within = (rule, bytes) => {
  if (bytes.length !== rule.family) return false;
  const whole = rule.bits >> 3, rest = rule.bits & 7;
  for (let at = 0; at < whole; at += 1) if (bytes[at] !== rule.bytes[at]) return false;
  if (!rest) return true;
  const mask = 0xff << (8 - rest) & 0xff;
  return (bytes[whole] & mask) === (rule.bytes[whole] & mask);
};

// `value` is what the operator wrote: a comma-separated list of CIDRs, or empty
// for "no restriction", which is what every deployment does today. Parsed once,
// at startup, so a typo stops the server instead of quietly allowing everyone
// -- a list that fails open is worse than no list, because somebody believes it.
export function addressAllowlist(value) {
  const written = String(value ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  if (!written.length) return null;
  const rules = [...LOOPBACK, ...written].map(parseRule);
  return {
    rules: Object.freeze(written),
    allows(address) {
      const bytes = typeof address === "string" ? bytesOf(address) : null;
      // An address this cannot read is not allowed. It should not happen on a
      // TCP socket, and guessing would be the wrong way to be wrong.
      if (!bytes) return false;
      return rules.some((rule) => within(rule, bytes));
    },
  };
}
