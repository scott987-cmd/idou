import test from "node:test";
import assert from "node:assert/strict";
import { stalledRedirect } from "../src/desktop/feishu-view-revival.js";

const MESSENGER = "https://tenant.feishu.cn/messenger/";
const LOGIN = "https://accounts.feishu.cn/accounts/page/login?app_id=1&no_trap=1&redirect_uri=https%3A%2F%2Ftenant.feishu.cn%2Fmessenger%2F";

// What the embedded 消息 view looked like on 2026-09-22: warmed while hidden,
// redirected to the sign-in page, loaded, and never started.
test("a view redirected to another host that finished loading without starting is stalled", () => {
  assert.equal(stalledRedirect({ requested: MESSENGER, landed: LOGIN, title: "", settled: true }), true);
  assert.equal(stalledRedirect({ requested: MESSENGER, landed: LOGIN, title: "   ", settled: true }), true);
});

test("a page that started, one still loading, or one that stayed on its own host is left alone", () => {
  assert.equal(stalledRedirect({ requested: MESSENGER, landed: LOGIN, title: "飞书 - 登录", settled: true }), false, "the sign-in page drawn: nothing to fix");
  assert.equal(stalledRedirect({ requested: MESSENGER, landed: LOGIN, title: "", settled: false }), false, "still loading is not stalled");
  assert.equal(stalledRedirect({ requested: MESSENGER, landed: "https://tenant.feishu.cn/messenger/", title: "", settled: true }), false, "no redirect: not this failure");
  assert.equal(stalledRedirect({ requested: MESSENGER, landed: MESSENGER, title: "飞书", settled: true }), false);
});

test("anything that cannot be read as two https pages is never reloaded", () => {
  for (const [requested, landed, title] of [[MESSENGER, "about:blank", ""], ["not a url", LOGIN, ""], [MESSENGER, LOGIN, null], [MESSENGER, "http://accounts.feishu.cn/", ""]]) {
    assert.equal(stalledRedirect({ requested, landed, title, settled: true }), false, `${requested} -> ${landed}`);
  }
});
