// Words the console puts on times (admin-ui/ui.js). A task's next run, due
// tomorrow at nine, read "刚刚" on the 定时任务 page: the helper knew only
// the past.
import test from "node:test";
import assert from "node:assert/strict";
import { ago } from "../src/control-plane/admin-ui/ui.js";

test("a relative time says ago for the past and after for what is still to come", () => {
  const now = Date.UTC(2026, 9, 2, 7, 0);
  assert.deepEqual([3, 17 * 60, 26 * 60].map((minutes) => ago(now - minutes * 60_000, now)), ["3 分钟前", "17 小时前", "1 天前"]);
  assert.deepEqual([3, 17 * 60, 26 * 60].map((minutes) => ago(now + minutes * 60_000, now)), ["3 分钟后", "17 小时后", "1 天后"]);
  assert.equal(ago(now + 20_000, now), "刚刚");
  assert.equal(ago(null, now), "从未");
});
