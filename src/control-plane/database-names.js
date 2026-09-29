// What this product's tables are called in PostgreSQL, and the locks and
// notification channels that go with them. The source names them idou_* (and
// its locks 'idou:…'). A database made before the product was renamed holds
// mydoubao_* tables and keeps them: there its tables, locks and channels go on
// being called what they were, so a server of either version reads the same
// rows, takes the same locks and hears the same notifications, and nothing is
// renamed or copied. Which kind a database is is decided once per pool, from
// whether it holds any mydoubao_ table.
const OWN = /\bidou(?=[_:])/g;
const decided = new WeakMap();

function prefixOf(pool) {
  if (!decided.has(pool)) {
    decided.set(pool, pool.query("SELECT 1 FROM pg_catalog.pg_tables WHERE schemaname = current_schema() AND tablename LIKE 'mydoubao\\_%' LIMIT 1")
      .then(({ rows }) => (rows.length ? "mydoubao" : "idou"))
      .catch((error) => { decided.delete(pool); throw error; }));
  }
  return decided.get(pool);
}

// A client or pool whose queries use this database's names. Everything else
// is the object's own, called on the object itself.
function answering(object, rename, { pool = false } = {}) {
  const query = (text, ...rest) => object.query(
    typeof text === "string" ? rename(text) : typeof text?.text === "string" ? { ...text, text: rename(text.text) } : text, ...rest);
  const connect = async (...args) => answering(await object.connect(...args), rename);
  return new Proxy(object, {
    get(target, key) {
      if (key === "query") return query;
      if (pool && key === "connect") return connect;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// A store's pool and its way to make a connection of its own, answering to this
// database's names; `prefix` is "idou" or "mydoubao", and `name` turns a name as
// the source writes it into this database's.
// Renaming is idempotent, so a pool that already answers to them may be given
// again.
export async function namedDatabase({ pool, connect = null }) {
  const prefix = await prefixOf(pool);
  const name = (text) => (prefix === "idou" ? text : text.replace(OWN, prefix));
  if (prefix === "idou") return { pool, connect, prefix, name };
  const renamed = answering(pool, name, { pool: true });
  return { pool: renamed, connect: connect && (async (...args) => answering(await connect(...args), name)), prefix, name };
}
