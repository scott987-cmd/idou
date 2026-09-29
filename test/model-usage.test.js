import test from "node:test";
import assert from "node:assert/strict";
import { ModelUsage, USAGE_LIMITS, utcDay } from "../src/control-plane/model-usage.js";

const WHO = { tenantId: "t1", userId: "ou_a" };
const OTHER = { tenantId: "t1", userId: "ou_b" };
const DAY = Date.parse("2026-09-21T10:00:00Z");

test("a request is counted once, and tokens add up across a day", () => {
  const usage = new ModelUsage({ now: () => DAY });
  usage.record({ who: WHO, model: "MiniMax-M3", usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } });
  usage.record({ who: WHO, model: "MiniMax-M3", usage: { input_tokens: 30, output_tokens: 5, total_tokens: 35 } });
  assert.deepEqual(usage.today(WHO), { tokens: 155, requests: 2 });
  // Per model and per day, so two models are two rows.
  usage.record({ who: WHO, model: "GLM-5.3", usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } });
  assert.deepEqual(usage.perModel().map((row) => [row.model, row.tokens, row.requests]),
    [["MiniMax-M3", 155, 2], ["GLM-5.3", 11, 1]]);
  usage.close();
});

test("what a provider reports is taken carefully, and never as a gap", () => {
  const usage = new ModelUsage({ now: () => DAY });
  // Providers disagree about whether total is given or implied.
  usage.record({ who: WHO, model: "M", usage: { prompt_tokens: 7, completion_tokens: 3 } });
  assert.equal(usage.today(WHO).tokens, 10, "没给 total 就自己加");
  usage.record({ who: OTHER, model: "M", usage: { input_tokens: 5, output_tokens: 5, total_tokens: 2 } });
  assert.equal(usage.today(OTHER).tokens, 10, "total 比分项还小，说明它不可信");
  // Nothing useful reported is a request and no tokens, not a row nobody wrote.
  usage.record({ who: OTHER, model: "M", usage: null });
  assert.deepEqual(usage.today(OTHER), { tokens: 10, requests: 2 });
  usage.record({ who: OTHER, model: "M", usage: { input_tokens: -5, output_tokens: 1.5 } });
  assert.deepEqual(usage.today(OTHER), { tokens: 10, requests: 3 }, "负数和小数不作数");
  // A caller with no person or no model writes nothing at all.
  assert.equal(usage.record({ who: {}, model: "M" }), null);
  assert.equal(usage.record({ who: WHO, model: "" }), null);
  usage.close();
});

test("days are UTC, and each stands on its own", () => {
  const usage = new ModelUsage({ now: () => DAY });
  usage.record({ who: WHO, model: "M", usage: { total_tokens: 100 }, at: DAY });
  usage.record({ who: WHO, model: "M", usage: { total_tokens: 50 }, at: DAY - 86_400_000 });
  // A deployment spanning time zones has to agree on one boundary.
  assert.equal(utcDay(Date.parse("2026-09-21T23:59:59Z")), "2026-09-21");
  assert.equal(utcDay(Date.parse("2026-09-22T00:00:01Z")), "2026-09-22");
  assert.deepEqual(usage.today(WHO), { tokens: 100, requests: 1 }, "今天只算今天");
  assert.equal(usage.perPerson({ days: 30 })[0].tokens, 150, "看一段时间就两天都算");
  usage.close();
});

test("the ledger has nowhere to put what anybody said", () => {
  const usage = new ModelUsage({ now: () => DAY });
  usage.record({ who: WHO, model: "M", usage: { total_tokens: 1 } });
  // This is the mechanism, not a rendering choice: the console cannot show what
  // this cannot hold.
  const columns = usage.db.prepare("PRAGMA table_info(model_usage)").all().map((column) => column.name);
  assert.deepEqual(columns.sort(), ["day", "downgraded", "input_tokens", "model", "output_tokens",
    "person", "requests", "tenant", "total_tokens", "updated_at", "user_id"]);
  for (const forbidden of ["prompt", "input", "output", "text", "content", "arguments", "answer"]) {
    assert.equal(columns.some((column) => column === forbidden), false, `不该有 ${forbidden} 这一列`);
  }
  usage.close();
});

test("the console's two views, heaviest first", () => {
  const usage = new ModelUsage({ now: () => DAY });
  usage.record({ who: WHO, model: "M", usage: { total_tokens: 10 } });
  usage.record({ who: OTHER, model: "M", usage: { total_tokens: 900 } });
  usage.record({ who: OTHER, model: "N", usage: { total_tokens: 90 }, downgraded: true });
  const people = usage.perPerson();
  assert.deepEqual(people.map((row) => [row.userId, row.tokens, row.models]), [["ou_b", 990, 2], ["ou_a", 10, 1]]);
  assert.equal(people[0].downgraded, 1, "降级的次数也记着，虽然这一版还不会降级");
  assert.equal(usage.perModel()[0].people, 2);
  assert.ok(USAGE_LIMITS.keepDays > 0);
  usage.close();
});

test("several replicas open one ledger at once, on a new file, and every answer they count is there", { timeout: 60_000 }, async (t) => {
  // The coordinator and each model replica open the same file at startup and
  // count into it (docs/scaling-plan.md §2.3); systemd starts them together.
  const { spawn } = await import("node:child_process");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { once } = await import("node:events");
  const os = await import("node:os"), path = await import("node:path");
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-usage-replicas-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "model-usage.sqlite");
  const module = new URL("../src/control-plane/model-usage.js", import.meta.url).href;
  const script = `const { ModelUsage } = await import(${JSON.stringify(module)});
    const usage = await ModelUsage.open({ file: ${JSON.stringify(file)} });
    for (let i = 0; i < 50; i += 1) usage.record({ who: { tenantId: "tenant", userId: "user" }, model: "MiniMax-M3", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
    usage.close();`;
  const replicas = Array.from({ length: 4 }, () => {
    const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe"] });
    let error = ""; child.stderr.on("data", (chunk) => { error += chunk; });
    return once(child, "close").then(([code]) => ({ code, error }));
  });
  for (const { code, error } of await Promise.all(replicas)) assert.equal(code, 0, error);
  const usage = await ModelUsage.open({ file });
  t.after(() => usage.close());
  assert.equal(usage.perPerson({ days: 1 })[0].requests, 200);
});
