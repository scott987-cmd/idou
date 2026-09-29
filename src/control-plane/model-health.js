// Which of the server's chat models can answer right now, kept by the server
// for everyone, because a model the upstream has stopped serving is not a
// per-person matter.
//
// Measured on 2026-09-19: the GLM route's upstream answered every request with
// InvalidSubscription -- the account's plan had lapsed -- and every conversation
// on the default model failed with 502 until an administrator edited the
// deployment by hand. Scheduled runs kept working only because they happened to
// be pinned to the other model.
//
// Only failures that will not go away on their own mark a model: the upstream
// refusing the account (a lapsed subscription or plan, no balance, a key it no
// longer accepts). A timeout, a rate limit or a 5xx is weather, and switching
// models on it would move people between models for nothing. A marked model is
// passed over for a cooling-off period, then given one real request again; if
// that succeeds it is back, and if it fails the same way it is marked again.
//
// Nothing here reads or keeps what the upstream said beyond the one word that
// classifies it. The body may echo a prompt or a key; it is looked at, not kept.
const LASTING = [
  ["subscription", /InvalidSubscription|subscription[^"]{0,40}(expired|invalid|inactive)|AgentPlan/i],
  ["billing", /insufficient[_ ]?(quota|balance)|AccountOverdue|Arrearage|overdue|out of credit|billing/i],
  ["auth", /invalid[_ ]?api[_ ]?key|authentication[_ ]?(failed|error)|unauthori[sz]ed|AccessDenied/i],
];
export const COOLING_OFF_MS = 10 * 60_000;

// What kind of lasting failure an upstream answer is, or null for one that is
// not (including every success). `text` is a bounded prefix of the body.
export function lastingFailure(status, text = "") {
  if (status >= 200 && status < 300) return null;
  if (status === 429 || status === 408 || status >= 500) {
    // A proxy in front of the real upstream reports the account problem inside
    // whatever status it chose; the words decide, not the status.
    return LASTING.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
  }
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "billing";
  return LASTING.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}

export const LASTING_REASONS = Object.freeze({
  subscription: "上游订阅无效或已过期",
  billing: "上游账户余额或额度不足",
  auth: "上游不再接受服务端的密钥",
});

export class ModelHealth {
  // `order` is the server's own list, default first: where a request goes when
  // the model it named cannot answer.
  constructor({ order, now = Date.now, coolingOffMs = COOLING_OFF_MS, log = () => {} }) {
    if (!Array.isArray(order) || !order.length) throw new Error("ModelHealth needs the server's model list");
    Object.assign(this, { order: [...order], now, coolingOffMs, log });
    this.marks = new Map();
  }

  // Passed over until its cooling-off period ends; then tried again.
  usable(model) {
    const mark = this.marks.get(model);
    return !mark || this.now() >= mark.retryAt;
  }

  // Where a request for `model` should go: the model itself if it can answer,
  // else the first in the server's order that can, else the model itself -- with
  // nothing usable, the one asked for is as good a try as any.
  route(model) {
    if (this.usable(model)) return model;
    return this.order.find((candidate) => candidate !== model && this.usable(candidate)) ?? model;
  }

  // The next model to try after these have failed, or null.
  next(tried) {
    return this.order.find((candidate) => !tried.has(candidate) && this.usable(candidate)) ?? null;
  }

  fail(model, reason) {
    const at = this.now(), known = this.marks.get(model);
    this.marks.set(model, { reason, since: known?.since ?? at, retryAt: at + this.coolingOffMs });
    if (!known) this.log(JSON.stringify({ component: "model-health", kind: "model_unavailable", model, reason, at }));
  }

  succeed(model) {
    if (!this.marks.delete(model)) return;
    this.log(JSON.stringify({ component: "model-health", kind: "model_available", model, at: this.now() }));
  }

  // For the settings page: which models are passed over, why, and since when.
  unavailable() {
    return this.order.filter((model) => this.marks.has(model) && !this.usable(model))
      .map((model) => ({ model, reason: this.marks.get(model).reason, since: this.marks.get(model).since, retryAt: this.marks.get(model).retryAt }));
  }
}
