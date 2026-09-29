import { SPELLINGS } from "../product-names.js";

// The hard ceiling on how long one browser authorization may be extended, kept
// with the proof helpers because the client and the control plane both enforce
// it independently: a server can never hand out a longer window than a client
// will accept.
export const MAX_SESSION_WINDOW_MS = 30 * 86400_000;

// Where a sign-in comes back to the device that started it (RFC 8252 §7.3):
// once Feishu has said who authorized it, the control plane sends that browser
// here, on its own machine's loopback address, with the one-time secret that
// completes the sign-in. The port is the one the device listens on for this
// sign-in, and nothing else is ever redirected to. A device answers the path
// under either spelling of the product's name (product-names.js); a server
// sends the old one still, the only one a device older than
// 0.1.0-20260929.257 answers, since a server cannot tell which it is talking to.
export const LOGIN_RETURN_PATH = "/mydoubao/login-complete";
export const LOGIN_RETURN_PATHS = Object.freeze(SPELLINGS.map((name) => `/${name}/login-complete`));
export const loginReturnUrl = (port) => `http://127.0.0.1:${port}${LOGIN_RETURN_PATH}`;
export const loginReturnPort = (value) => Number.isSafeInteger(value) && value >= 1024 && value <= 65535;

// Shared, public protocol. No application secret or Feishu token belongs here.
export function loginProofMessage(origin, flowId, nonce, action) {
  return Buffer.from(JSON.stringify(["mydoubao-feishu-login-v1", origin, flowId, nonce, action]));
}

export function renewalProofMessage(origin, sessionId, challengeId, nonce) {
  return Buffer.from(JSON.stringify(["mydoubao-feishu-renewal-v1", origin, sessionId, challengeId, nonce]));
}
