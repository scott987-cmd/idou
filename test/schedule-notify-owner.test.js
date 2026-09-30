import test from "node:test";
import assert from "node:assert/strict";
import { notifyOwner } from "../src/control-plane/scheduled-tasks.js";

// A finished run's result, pushed to its owner (scheduled-tasks.js notifyOwner).
// Found in the long-running review (2026-09-29): with the bot missing its
// permission, every result went nowhere and every run still read 成功. With the
// bot on, one that did not reach its owner is now said on the run; without a
// bot, a push this server does not allow is its setup, not a failure.
const finished = { schedule: { tenant: "tenant-a", owner: "ou_owner" }, runId: "run-1", outcome: "completed" };

function harness(answer, { bot = {}, markFails = false } = {}) {
  const marked = [], logged = [];
  const store = { markUndelivered: (tenant, runId, line) => { if (markFails) throw new Error("database away"); marked.push({ tenant, runId, line }); } };
  const notify = notifyOwner({ push: { deliver: async () => answer }, store, bot, log: (line) => logged.push(line) });
  return { notify, marked, logged };
}

test("a result the bot did not deliver is said on the run, in the bot's own words", async () => {
  const { notify, marked, logged } = harness({ sent: false, reason: "bot: 400 code=99991672 Access denied（应用缺少 im:message:send_as_bot 权限）" });
  await notify(finished);
  assert.deepEqual(marked, [{ tenant: "tenant-a", runId: "run-1", line: "结果没有推送给你：机器人没有发出（400 code=99991672 Access denied（应用缺少 im:message:send_as_bot 权限））" }]);
  assert.equal(logged.length, 1);
});

test("a result that was delivered, or a push this server does not make, marks nothing", async () => {
  for (const [answer, options] of [
    [{ sent: true, as: "bot" }, {}],
    [{ sent: false, reason: "403 feishu_cli_write_not_enabled" }, { bot: null }],
    [{ sent: false, reason: "owner_not_feishu" }, {}],
  ]) {
    const { notify, marked } = harness(answer, options);
    await notify(finished);
    assert.deepEqual(marked, [], JSON.stringify(answer));
  }
});

test("a mark that cannot be written is logged, and never fails the run's notification", async () => {
  const { notify, logged } = harness({ sent: false, reason: "bot: unavailable: timeout" }, { markFails: true });
  await notify(finished);
  assert.match(logged.at(-1), /推送失败没有记进运行记录（database away）/);
});
