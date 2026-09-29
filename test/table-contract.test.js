import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, symlink, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { CONTRACT_DIR, CONTRACT_FILES, TABLE_RUNTIME, writeContract } from "../src/application/table-contract.js";

const schema = { version: 1, sliceId: "abc", source: { kind: "base" }, refreshSeconds: 60,
  fields: [{ id: "fldName", name: "客户名", type: "text", writable: false }, { id: "fldAmount", name: "金额", type: "number", writable: true }] };
const snapshot = { sliceId: "abc", readAt: 1_700_000_000_000, truncated: false, rowCount: 2, digest: "d1",
  rows: [{ id: "rec1", values: { fldName: { text: "甲", value: "甲" }, fldAmount: { text: "10", value: 10 } } },
    { id: "rec2", values: { fldName: { text: "<img onerror=alert(1)>", value: "<img onerror=alert(1)>" }, fldAmount: { text: "20", value: 20 } } }] };

// The page as a browser would load it: the data script, then the runtime.
function page(files, { fetchImpl } = {}) {
  const context = vm.createContext({ console, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  vm.runInContext(files.data, context);
  vm.runInContext(files.runtime, context);
  return context.Table;
}

async function written(directory) {
  const at = (name) => path.join(directory, CONTRACT_DIR, name);
  return {
    schema: JSON.parse(await readFile(at(CONTRACT_FILES.schema), "utf8")),
    data: await readFile(at(CONTRACT_FILES.data), "utf8"),
    runtime: await readFile(at(CONTRACT_FILES.runtime), "utf8"),
  };
}

test("the contract is three files in the project, written whole", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-contract-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = await writeContract(directory, { schema, snapshot });
  assert.deepEqual(paths, ["data/schema.json", "data/table-data.js", "data/table.js"]);
  const files = await written(directory);
  assert.deepEqual(files.schema, schema, "the schema is readable as JSON, for the Agent and for us");
  assert.equal(files.runtime, TABLE_RUNTIME, "the runtime ships with the application, it is not generated");
  assert.equal((await stat(path.join(directory, CONTRACT_DIR))).mode & 0o777, 0o700);
  for (const name of Object.values(CONTRACT_FILES)) assert.equal((await stat(path.join(directory, CONTRACT_DIR, name))).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(path.join(directory, CONTRACT_DIR))).sort(), Object.values(CONTRACT_FILES).sort(), "no temporary file left behind");
  // Written again, with new values, over the old ones.
  await writeContract(directory, { schema, snapshot: { ...snapshot, digest: "d2", rowCount: 0, rows: [] } });
  assert.match((await written(directory)).data, /"digest":"d2"/);
  assert.deepEqual((await readdir(path.join(directory, CONTRACT_DIR))).sort(), Object.values(CONTRACT_FILES).sort());
});

// The product was renamed. A page written before then may read the data
// global under its old name instead of through Table; it still finds it, and
// the runtime reads what an older data file defined.
test("the data is there under the product's new name and its old one", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-contract-names-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeContract(directory, { schema, snapshot });
  const files = await written(directory);
  const context = vm.createContext({ console });
  vm.runInContext(files.data, context);
  assert.equal(context.__IDOU_TABLE__.snapshot.digest, "d1");
  assert.equal(context.__MYDOUBAO_TABLE__, context.__IDOU_TABLE__, "the old name is the same data");
  const older = vm.createContext({ console });
  vm.runInContext(`globalThis.__MYDOUBAO_TABLE__ = ${JSON.stringify({ schema, snapshot })};\n`, older);
  vm.runInContext(files.runtime, older);
  assert.equal(older.Table.rowCount(), 2, "a data file from before the rename still loads");
});

test("the runtime hands the page values, never markup", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-contract-run-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeContract(directory, { schema, snapshot });
  const Table = page(await written(directory));
  assert.equal(Table.rowCount(), 2);
  assert.deepEqual(Array.from(Table.fields(), (field) => field.name), ["客户名", "金额"]);
  const [first, second] = Table.rows();
  // A column may be asked for by name or by id; both are the same column.
  assert.equal(first.text("客户名"), "甲");
  assert.equal(first.text("fldName"), "甲");
  assert.equal(first.value("金额"), 10);
  assert.equal(second.text("客户名"), "<img onerror=alert(1)>", "a cell is a string, and stays one");
  assert.equal(Table.readAt().getTime(), 1_700_000_000_000);
  assert.equal(Table.digest(), "d1");
  assert.equal(Table.truncated(), false);
});

test("a field this visitor may not read is absent, and the page survives it", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-contract-perm-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Feishu's field-level permission returns fewer fields for this visitor.
  await writeContract(directory, { schema, snapshot: { ...snapshot, rows: [{ id: "rec1", values: { fldName: { text: "甲", value: "甲" } } }] } });
  const Table = page(await written(directory));
  const [row] = Table.rows();
  assert.equal(row.has("金额"), false);
  assert.equal(row.text("金额"), "", "no value, and no crash");
  assert.equal(row.value("金额"), null);
  assert.equal(row.has("客户名"), true);
  assert.equal(row.text("不存在的字段"), "");
});

test("onChange takes the control plane's word for it and re-reads once", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-contract-change-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let asked = 0;
  const next = { schema, snapshot: { ...snapshot, digest: "d9", rowCount: 1, rows: [{ id: "rec9", values: { fldName: { text: "丙", value: "丙" }, fldAmount: { text: "1", value: 1 } } }] } };
  const fetchImpl = async () => { asked += 1; return { ok: true, json: async () => next }; };
  await writeContract(directory, { schema: { ...schema, endpoint: "/v1/sites/s1/data" }, snapshot });
  const Table = page(await written(directory), { fetchImpl });
  const seen = [];
  const stop = Table.onChange((table) => seen.push(table.digest()));
  assert.equal(await Table.refresh(), true);
  assert.deepEqual(seen, ["d9"]);
  assert.equal(Table.rows()[0].text("客户名"), "丙");
  // The same digest again is not a change, so the page is not redrawn for nothing.
  assert.equal(await Table.refresh(), false);
  assert.deepEqual(seen, ["d9"]);
  stop();
  // The answer carried a schema with no endpoint in it; that must not turn the
  // page back into a static one.
  next.snapshot = { ...next.snapshot, digest: "d10" };
  assert.equal(await Table.refresh(), true);
  assert.deepEqual(seen, ["d9"], "a listener that stopped is not called again");
  assert.equal(asked, 3);
});

test("with no endpoint the page still works, and asks nobody", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-contract-static-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeContract(directory, { schema, snapshot });
  let asked = 0;
  const Table = page(await written(directory), { fetchImpl: async () => { asked += 1; throw new Error("不该发生"); } });
  assert.equal(await Table.refresh(), false);
  assert.equal(asked, 0);
  assert.equal(Table.rowCount(), 2, "a published snapshot needs no network at all");
});

test("writing refuses a data directory that leaves the project", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-contract-escape-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = path.join(directory, "project"), outside = path.join(directory, "outside");
  await mkdir(project); await mkdir(outside);
  await symlink(outside, path.join(project, CONTRACT_DIR));
  await assert.rejects(() => writeContract(project, { schema, snapshot }), /指向了项目外面/);
  assert.deepEqual(await readdir(outside), []);
  await assert.rejects(() => writeContract("relative/path", { schema, snapshot }), /绝对路径/);
  await assert.rejects(() => writeContract(project, { schema }), /数据契约不完整/);
});
