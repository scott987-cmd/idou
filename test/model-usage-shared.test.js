// The usage ledger in the shared PostgreSQL (docs/scaling-plan.md §2.5),
// against the same behaviour as the SQLite one: each case runs on both, and
// what the PostgreSQL one adds -- replicas counting into one table, batches
// written once a second, moving rows between the two -- is checked on its own.
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { ModelUsage, PostgresModelUsage } from "../src/control-plane/model-usage.js";
import { testPostgres } from "./helpers/postgres.js";

const WHO = { tenantId: "t1", userId: "ou_a" };
const OTHER = { tenantId: "t1", userId: "ou_b" };
const DAY = Date.parse("2026-09-21T10:00:00Z");

async function postgres(t) {
  const server = await testPostgres(t), config = await server.database();
  const pools = [];
  const open = async (options = {}) => {
    const pool = new pg.Pool({ ...config, max: 4 }); pool.on("error", () => {}); pools.push(pool);
    const usage = await PostgresModelUsage.open({ pool, now: () => DAY, ...options });
    server.closeFirst(() => usage.close());
    return usage;
  };
  server.closeFirst(async () => { for (const pool of pools) await pool.end(); });
  return { open };
}

const kinds = {
  sqlite: async () => { const usage = new ModelUsage({ now: () => DAY }); return { a: usage, b: usage, done: () => usage.close() }; },
  postgres: async (t) => { const { open } = await postgres(t); return { a: await open(), b: await open(), done: () => {} }; },
};

for (const [kind, make] of Object.entries(kinds)) {
  test(`${kind}: requests are counted per person, model and day, and read back the same way`, { timeout: 60_000 }, async (t) => {
    const { a, b, done } = await make(t);
    a.record({ who: WHO, model: "MiniMax-M3", usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } });
    b.record({ who: WHO, model: "MiniMax-M3", usage: { input_tokens: 30, output_tokens: 5, total_tokens: 35 } });
    b.record({ who: WHO, model: "GLM-5.3", usage: { prompt_tokens: 7, completion_tokens: 3 } });
    a.record({ who: OTHER, model: "GLM-5.3", usage: { input_tokens: 5, output_tokens: 5, total_tokens: 2 } });
    assert.equal(a.record({ who: {}, model: "M" }), null);
    // What each replica counted is written within its second.
    await Promise.all([a.flush(), b.flush()]);
    assert.deepEqual(await a.today(WHO), { tokens: 165, requests: 3 }, "whichever replica counted it");
    assert.deepEqual((await b.perModel()).map((row) => [row.model, row.tokens, row.requests, row.people]), [["MiniMax-M3", 155, 2, 1], ["GLM-5.3", 20, 2, 2]]);
    assert.deepEqual((await a.perPerson()).map((row) => [row.userId, row.tokens, row.requests, row.models]), [["ou_a", 165, 3, 2], ["ou_b", 10, 1, 1]]);
    done();
  });
}

test("postgres: counts wait a second in memory and go out in one write, and none are lost to two replicas writing at once", { timeout: 60_000 }, async (t) => {
  const { open } = await postgres(t);
  const logs = [];
  const a = await open({ flushMs: 60_000, log: (line) => logs.push(line) }), b = await open({ flushMs: 60_000, log: (line) => logs.push(line) });
  let writes = 0;
  const query = a.pool.query.bind(a.pool);
  a.pool.query = (...args) => { if (/INSERT INTO idou_model_usage/.test(args[0])) writes += 1; return query(...args); };
  for (let index = 0; index < 200; index += 1) (index % 2 ? a : b).record({ who: index % 3 ? WHO : OTHER, model: "M", usage: { input_tokens: 1, output_tokens: 1 } });
  await Promise.all([a.flush(), b.flush()]);
  assert.equal(writes, 1, "a hundred counts, one statement");
  assert.deepEqual(logs, [], "no deadlock between the two");
  assert.equal((await a.perModel())[0].requests, 200);
  assert.equal((await b.today(WHO)).requests + (await b.today(OTHER)).requests, 200);
});

test("postgres: a batch the database refuses is written with the next one, not dropped", { timeout: 60_000 }, async (t) => {
  const { open } = await postgres(t);
  const usage = await open({ flushMs: 60_000 });
  const query = usage.pool.query.bind(usage.pool);
  let refuse = true;
  usage.pool.query = (...args) => (refuse && /INSERT INTO idou_model_usage/.test(args[0]) ? Promise.reject(new Error("connection lost")) : query(...args));
  usage.record({ who: WHO, model: "M", usage: { input_tokens: 3, output_tokens: 1 } });
  await usage.flush();
  refuse = false;
  usage.record({ who: WHO, model: "M", usage: { input_tokens: 1, output_tokens: 1 } });
  assert.deepEqual(await usage.today(WHO), { tokens: 6, requests: 2 });
});

test("the ledger moves between SQLite and PostgreSQL as it is, either way", { timeout: 60_000 }, async (t) => {
  const { open } = await postgres(t);
  const local = new ModelUsage({ now: () => DAY });
  t.after(() => local.close());
  local.record({ who: WHO, model: "MiniMax-M3", usage: { input_tokens: 10, output_tokens: 2 } });
  local.record({ who: OTHER, model: "GLM-5.3", usage: { input_tokens: 4, output_tokens: 4 }, downgraded: true });
  const shared = await open();
  await shared.load(local.rows());
  await shared.load(local.rows());
  assert.deepEqual(await shared.rows(), local.rows(), "loaded twice, still once");
  const back = new ModelUsage({ now: () => DAY });
  t.after(() => back.close());
  back.load(await shared.rows());
  assert.deepEqual(back.rows(), local.rows());
});
