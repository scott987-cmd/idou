// What the administration console shows of the usage ledger
// (model-usage.js): per day, per model, per person -- for one tenant.
//
// Sized for a hundred thousand people: a day is up to a hundred thousand rows
// of the ledger (a person, a model, a day each), so a quarter's chart read
// straight from it would add up nine million rows every time somebody opened
// the page. A day that is over does not change, so it is added up once, into a
// summary table beside the ledger, and read from there ever after; only today
// is added up as it is asked for. The ranking of people over a month is the
// one question that has to read the month, and its answer is kept for a few
// minutes.
//
// One set of SQL for both ledgers: `run(sql, params)` is SQLite's or
// PostgreSQL's (`?` placeholders either way), `table` the ledger's name.
const DAY_MS = 86_400_000;
export const utcDay = (at) => new Date(at).toISOString().slice(0, 10);
// A day is final this long after it ended: the replicas write what they
// counted once a second, and a day summed before the last of it arrived would
// be wrong for good.
const SETTLED_MS = 10 * 60_000;
const RANKING_MS = 5 * 60_000;
export const REPORT_LIMITS = Object.freeze({ days: 400, ranking: 500 });

export function summarySchema(dialect, table) {
  const big = dialect === "postgres" ? "bigint" : "INTEGER";
  return `CREATE TABLE IF NOT EXISTS ${table}_days (
      tenant text NOT NULL, day text NOT NULL, model text NOT NULL,
      requests ${big} NOT NULL, input_tokens ${big} NOT NULL, output_tokens ${big} NOT NULL, total_tokens ${big} NOT NULL,
      downgraded ${big} NOT NULL, people ${big} NOT NULL, computed_at ${big} NOT NULL,
      PRIMARY KEY (tenant, day, model));
    CREATE INDEX IF NOT EXISTS ${table}_tenant_day ON ${table} (tenant, day);`;
}

const number = (value) => Number(value ?? 0);
const days = (value) => Math.max(1, Math.min(REPORT_LIMITS.days, Number(value) || 30));

export class UsageReports {
  constructor({ run, table, keyFor, flush = async () => {}, now = Date.now }) {
    Object.assign(this, { run, table, keyFor, flush, now });
    this.rankings = new Map();
  }

  // Day by day, and model by model, for the last `count` days up to today.
  async summary({ tenantId, days: count = 30, at = this.now() } = {}) {
    const wanted = Array.from({ length: days(count) }, (_, index) => utcDay(at - (days(count) - 1 - index) * DAY_MS));
    const today = utcDay(at);
    await this.flush();
    const held = await this.run(`SELECT day, model, requests, input_tokens, output_tokens, total_tokens, downgraded, people FROM ${this.table}_days
      WHERE tenant = ? AND day >= ? AND day <= ?`, [tenantId, wanted[0], wanted.at(-1)]);
    const have = new Set(held.map((row) => row.day));
    const rows = held.map(present);
    for (const day of wanted) {
      if (have.has(day)) continue;
      const settled = Date.parse(`${day}T00:00:00Z`) + DAY_MS + SETTLED_MS <= at;
      const computed = await this.#sum(tenantId, day);
      rows.push(...computed);
      // A finished day is written down once; today, and a day only just
      // over, are added up again next time.
      if (settled && day !== today) await this.#keep(tenantId, day, computed.length ? computed : [{ day, model: "*", requests: 0, input: 0, output: 0, tokens: 0, downgraded: 0, people: 0 }]);
    }
    const byDay = wanted.map((day) => {
      const all = rows.find((row) => row.day === day && row.model === "*");
      return { day, requests: all?.requests ?? 0, tokens: all?.tokens ?? 0, people: all?.people ?? 0 };
    });
    const models = new Map();
    for (const row of rows) {
      if (row.model === "*") continue;
      const into = models.get(row.model) ?? { model: row.model, requests: 0, tokens: 0, input: 0, output: 0, downgraded: 0, personDays: 0 };
      into.requests += row.requests; into.tokens += row.tokens; into.input += row.input; into.output += row.output;
      into.downgraded += row.downgraded; into.personDays += row.people;
      models.set(row.model, into);
    }
    const byModel = [...models.values()].sort((a, b) => b.tokens - a.tokens)
      .map((model) => ({ ...model, dailyPeople: Math.round((model.personDays / wanted.length) * 10) / 10 }));
    const totals = byDay.reduce((sum, day) => ({ requests: sum.requests + day.requests, tokens: sum.tokens + day.tokens }), { requests: 0, tokens: 0 });
    return { days: wanted.length, from: wanted[0], to: wanted.at(-1), totals, byDay, byModel };
  }

  async #sum(tenantId, day) {
    const rows = await this.run(`SELECT model, SUM(requests) AS requests, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
        SUM(total_tokens) AS total_tokens, SUM(downgraded) AS downgraded, COUNT(DISTINCT person) AS people
      FROM ${this.table} WHERE tenant = ? AND day = ? GROUP BY model`, [tenantId, day]);
    if (!rows.length) return [];
    const [all] = await this.run(`SELECT SUM(requests) AS requests, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
        SUM(total_tokens) AS total_tokens, SUM(downgraded) AS downgraded, COUNT(DISTINCT person) AS people
      FROM ${this.table} WHERE tenant = ? AND day = ?`, [tenantId, day]);
    return [...rows.map((row) => present({ ...row, day })), present({ ...all, day, model: "*" })];
  }

  async #keep(tenantId, day, rows) {
    for (const row of rows) {
      await this.run(`INSERT INTO ${this.table}_days (tenant, day, model, requests, input_tokens, output_tokens, total_tokens, downgraded, people, computed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (tenant, day, model) DO NOTHING`,
      [tenantId, day, row.model, row.requests, row.input, row.output, row.tokens, row.downgraded, row.people, this.now()]);
    }
  }

  // The heaviest users over the last `count` days, most first. Kept for a few
  // minutes: it is the one report that reads every row of the period.
  async ranking({ tenantId, days: count = 30, limit = 100, at = this.now() } = {}) {
    const size = Math.max(1, Math.min(REPORT_LIMITS.ranking, Number(limit) || 100));
    const slot = `${tenantId}\n${days(count)}\n${size}`, held = this.rankings.get(slot);
    if (held && held.until > this.now()) return held.rows;
    await this.flush();
    const rows = (await this.run(`SELECT max(user_id) AS user_id, SUM(requests) AS requests, SUM(total_tokens) AS tokens, SUM(downgraded) AS downgraded,
        COUNT(DISTINCT model) AS models, MAX(updated_at) AS last_at
      FROM ${this.table} WHERE tenant = ? AND day >= ? GROUP BY person ORDER BY tokens DESC LIMIT ?`,
    [tenantId, utcDay(at - (days(count) - 1) * DAY_MS), size])).map(ranked);
    if (this.rankings.size > 100) this.rankings.clear();
    this.rankings.set(slot, { rows, until: this.now() + RANKING_MS });
    return rows;
  }

  // Everybody over the period, for an export: written to the browser as it
  // is read, a page at a time.
  async *everyone({ tenantId, days: count = 30, at = this.now() } = {}) {
    await this.flush();
    const since = utcDay(at - (days(count) - 1) * DAY_MS);
    let after = "";
    for (;;) {
      const rows = await this.run(`SELECT person, max(user_id) AS user_id, SUM(requests) AS requests, SUM(input_tokens) AS input_tokens,
          SUM(output_tokens) AS output_tokens, SUM(total_tokens) AS tokens, SUM(downgraded) AS downgraded, COUNT(DISTINCT model) AS models, MAX(updated_at) AS last_at
        FROM ${this.table} WHERE tenant = ? AND day >= ? AND person > ? GROUP BY person ORDER BY person LIMIT 2000`, [tenantId, since, after]);
      for (const row of rows) yield { ...ranked(row), input: number(row.input_tokens), output: number(row.output_tokens) };
      if (rows.length < 2000) return;
      after = rows.at(-1).person;
    }
  }

  // Thirty days' total for each of a page of people -- the ledger's key is the
  // person, so this is one index lookup each.
  async forPeople({ tenantId, userIds, days: count = 30, at = this.now() } = {}) {
    const ids = [...new Set(userIds)].slice(0, 500);
    if (!ids.length) return new Map();
    await this.flush();
    const keys = ids.map((userId) => this.keyFor({ tenantId, userId }));
    const rows = await this.run(`SELECT max(user_id) AS user_id, SUM(total_tokens) AS tokens, SUM(requests) AS requests FROM ${this.table}
      WHERE person IN (${keys.map(() => "?").join(",")}) AND day >= ? GROUP BY person`, [...keys, utcDay(at - (days(count) - 1) * DAY_MS)]);
    return new Map(rows.map((row) => [row.user_id, { tokens: number(row.tokens), requests: number(row.requests) }]));
  }

  // One person, day by day and model by model.
  async person({ tenantId, userId, days: count = 30, at = this.now() } = {}) {
    await this.flush();
    const wanted = Array.from({ length: days(count) }, (_, index) => utcDay(at - (days(count) - 1 - index) * DAY_MS));
    const rows = await this.run(`SELECT model, day, requests, total_tokens, downgraded, updated_at FROM ${this.table} WHERE person = ? AND day >= ?`,
      [this.keyFor({ tenantId, userId }), wanted[0]]);
    const byDay = wanted.map((day) => rows.filter((row) => row.day === day).reduce((sum, row) => ({ day, requests: sum.requests + number(row.requests), tokens: sum.tokens + number(row.total_tokens) }), { day, requests: 0, tokens: 0 }));
    const models = new Map();
    for (const row of rows) {
      const into = models.get(row.model) ?? { model: row.model, requests: 0, tokens: 0, downgraded: 0, lastAt: 0 };
      into.requests += number(row.requests); into.tokens += number(row.total_tokens); into.downgraded += number(row.downgraded);
      into.lastAt = Math.max(into.lastAt, number(row.updated_at));
      models.set(row.model, into);
    }
    return { days: wanted.length, byDay, byModel: [...models.values()].sort((a, b) => b.tokens - a.tokens) };
  }
}

function present(row) {
  return { day: row.day, model: row.model, requests: number(row.requests), input: number(row.input_tokens), output: number(row.output_tokens),
    tokens: number(row.total_tokens), downgraded: number(row.downgraded), people: number(row.people) };
}
function ranked(row) {
  return { userId: row.user_id, requests: number(row.requests), tokens: number(row.tokens), downgraded: number(row.downgraded),
    models: number(row.models), lastAt: number(row.last_at) };
}
