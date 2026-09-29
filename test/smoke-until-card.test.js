// The acceptance run takes the smokes only a person can finish as far as their
// first card that needs a person's yes, and stops there: it never answers the
// card, never raises the window over whatever the person is doing, and lets
// the UI rules see the card first (a screenshot is their checkpoint).
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function harness(untilCard) {
  const saved = process.env.IDOU_SMOKE_UNTIL_CARD;
  if (untilCard) process.env.IDOU_SMOKE_UNTIL_CARD = "1"; else delete process.env.IDOU_SMOKE_UNTIL_CARD;
  try { return await import(`../scripts/fixtures/agent-harness.js?until-card=${untilCard}`); }
  finally { if (saved === undefined) delete process.env.IDOU_SMOKE_UNTIL_CARD; else process.env.IDOU_SMOKE_UNTIL_CARD = saved; }
}

function fakes() {
  const seen = { shots: 0, clicks: 0, fronted: 0, raised: 0 };
  const page = { isClosed: () => false, screenshot: async () => { seen.shots += 1; }, bringToFront: async () => { seen.fronted += 1; } };
  const button = { waitFor: async () => {}, click: async () => { seen.clicks += 1; } };
  const card = { waitFor: async () => {}, getByRole: () => button, page: () => page, evaluate: async () => "卡片" };
  const app = { evaluate: async () => { seen.raised += 1; } };
  return { seen, page, card, app };
}

test("run as far as the first card, every way a smoke waits for a person stops there without answering", async () => {
  const h = await harness(true);
  const { seen, page, card, app } = fakes();
  const stopped = (error) => error instanceof h.ReachedCard && error.message.startsWith(h.REACHED_CARD);
  await assert.rejects(h.waitForHumanChoice(card, "确认发送私信"), stopped);
  await assert.rejects(h.waitForHumanConfirm({ locator: () => card }, "确认修改原文档"), stopped);
  await assert.rejects(h.presentHumanChoice(app, page, "i豆 M05 · 文档私信确认"), stopped);
  await assert.rejects(h.bringToPerson(page, "确认写入多维表格"), stopped);
  await assert.rejects(h.untilCard(page, "企业连接器「添加」"), stopped);
  assert.equal(seen.clicks, 0, "nothing is answered");
  assert.equal(seen.raised + seen.fronted, 0, "the window is never raised over the person's work");
  assert.equal(seen.shots, 5, "each card is looked at by the UI rules before stopping");
});

test("with a person there, the helpers wait for them as before", async () => {
  const h = await harness(false);
  const { seen, page } = fakes();
  await h.untilCard(page, "不会停");
  await h.bringToPerson(page, "确认写入多维表格");
  assert.equal(seen.fronted, 1);
  assert.equal(seen.shots, 0);
});

test("the runner asks for the stop only when nobody is there to answer", async () => {
  const runner = await readFile(new URL("../scripts/run-desktop-acceptance.js", import.meta.url), "utf8");
  assert.match(runner, /untilCard = Boolean\(manualIds\) && !withPerson/u);
  assert.match(runner, /IDOU_SMOKE_UNTIL_CARD: "1"/u);
  assert.match(runner, /到卡片为止不是通过/u);
});
