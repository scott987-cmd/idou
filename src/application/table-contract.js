// The three files a table-driven site is built against, written into the
// coding task's own folder. The Agent reads them and writes only the interface.
//
//   data/schema.json     what the columns are and what they mean -- types read
//                        from Feishu, never guessed by the model
//   data/table-data.js   the current values, as a script so the same page works
//                        from a folder, from the preview gateway and inside a
//                        published single file (a `fetch` works in only one of
//                        the three)
//   data/table.js        the runtime the page talks to: rows(), fields(),
//                        onChange(). Shipped, not generated, so every site in
//                        the tenant gets the same escaping and the same
//                        refresh behaviour instead of one per model answer.
//
// Writing is atomic and refuses to leave the project: a slice can be re-read
// hundreds of times a day, and a half-written data file is a broken site.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const CONTRACT_DIR = "data";
export const CONTRACT_FILES = Object.freeze({ schema: "schema.json", data: "table-data.js", runtime: "table.js" });

// Kept here rather than in a template file so it ships inside the signed
// application source and cannot be swapped out next to a project.
export const TABLE_RUNTIME = `// i豆 · 表格站点运行时。由产品生成，请不要修改。
// 用法：
//   <script src="data/table-data.js"></script>
//   <script src="data/table.js"></script>
//   Table.rows().forEach(function (row) { Table.paint(td, row.cell("客户名")); });
// Table.paint 会按字段的含义来画：单选和人员画成标签，链接画成可点的链接，
// 日期和金额按本地格式，其余按文本。
// 单元格内容一律当文本用（textContent），不要拼进 innerHTML：表格里的内容来自
// 别人，不是你的模板。
(function (global) {
  "use strict";
  var loaded = global.__IDOU_TABLE__ || global.__MYDOUBAO_TABLE__ || { schema: { fields: [], refreshSeconds: 0 }, snapshot: { rows: [], readAt: 0, digest: "" } };
  var schema = loaded.schema || { fields: [] };
  var snapshot = loaded.snapshot || { rows: [] };
  var listeners = [];
  var stream = null;

  function fieldId(name) {
    for (var i = 0; i < (schema.fields || []).length; i += 1) {
      if (schema.fields[i].id === name || schema.fields[i].name === name) return schema.fields[i].id;
    }
    return null;
  }
  // A field the visitor may not read is absent, not empty: Feishu's field-level
  // permission decides that, and a page must not crash over it.
  function at(row, name) {
    var id = fieldId(name);
    return id && row.values ? row.values[id] : undefined;
  }
  function wrap(row) {
    return {
      id: row.id,
      values: row.values,
      cell: function (name) { return at(row, name) || null; },
      text: function (name) { var c = at(row, name); return c ? show(c) : ""; },
      value: function (name) { var c = at(row, name); return c ? (c.value !== undefined ? c.value : null) : null; },
      items: function (name) { var c = at(row, name); return c && c.items ? c.items.slice() : []; },
      has: function (name) { return at(row, name) !== undefined; },
    };
  }

  // How a cell reads. The contract carries what a field means (kind) and the
  // value behind it; turning 1789862400000 into a date and 128.5 into 128.50
  // belongs here, once, rather than in every page.
  function show(cell) {
    if (!cell) return "";
    if (cell.kind === "date") return cell.value ? new Date(cell.value).toLocaleDateString("zh-CN") : "";
    if (cell.kind === "boolean") return cell.value ? "是" : "否";
    if (cell.kind === "number" && typeof cell.value === "number") {
      return cell.style === "currency"
        ? cell.value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : cell.value.toLocaleString("zh-CN", { maximumFractionDigits: 4 });
    }
    return cell.text || "";
  }

  // Put a cell into an element. Always as text or as elements this builds --
  // never as markup, because the contents came from somebody else's table. A
  // page written by hand should call this rather than invent its own.
  function paint(node, cell) {
    while (node.firstChild) node.removeChild(node.firstChild);
    node.removeAttribute("data-kind");
    if (!cell) return node;
    node.setAttribute("data-kind", cell.kind || "text");
    if (cell.kind === "link" && cell.href) {
      var anchor = document.createElement("a");
      anchor.href = cell.href; anchor.target = "_blank"; anchor.rel = "noreferrer noopener";
      anchor.textContent = cell.text || cell.href;
      node.appendChild(anchor);
      return node;
    }
    var many = cell.kind === "options" || cell.kind === "option" || cell.kind === "people";
    if (many) {
      var values = cell.items && cell.items.length ? cell.items : (cell.value ? [cell.value] : []);
      for (var i = 0; i < values.length; i += 1) {
        var chip = document.createElement("span");
        chip.className = cell.kind === "people" ? "cell-person" : "cell-chip";
        chip.textContent = values[i];
        node.appendChild(chip);
      }
      if (!values.length) node.appendChild(document.createTextNode(""));
      return node;
    }
    node.appendChild(document.createTextNode(show(cell)));
    return node;
  }
  function announce() { for (var i = 0; i < listeners.length; i += 1) { try { listeners[i](api); } catch (error) { if (global.console) global.console.error(error); } } }
  // Where to read from and where to listen are how this page was published,
  // not part of the data. A refresh that answered without them used to switch
  // the page back to a static one, silently and for good, so they are kept
  // unless the answer names new ones.
  function settle(incoming) {
    var merged = {}, key;
    for (key in incoming) if (Object.prototype.hasOwnProperty.call(incoming, key)) merged[key] = incoming[key];
    if (!merged.endpoint && schema.endpoint) merged.endpoint = schema.endpoint;
    if (!merged.stream && schema.stream) merged.stream = schema.stream;
    return merged;
  }
  function adopt(next) {
    if (!next || !next.snapshot || next.snapshot.digest === snapshot.digest) return false;
    snapshot = next.snapshot;
    if (next.schema) schema = settle(next.schema);
    announce();
    return true;
  }

  function refresh() {
    var endpoint = schema.endpoint;
    if (!endpoint || !global.fetch) return Promise.resolve(false);
    return global.fetch(endpoint, { credentials: "same-origin", headers: { accept: "application/json" } })
      .then(function (response) { if (!response.ok) throw new Error("读取失败：" + response.status); return response.json(); })
      .then(adopt);
  }

  // The control plane knows when the table changed; the page does not poll it.
  function listen() {
    if (stream || !schema.stream || typeof global.EventSource !== "function") return;
    stream = new global.EventSource(schema.stream, { withCredentials: true });
    stream.addEventListener("changed", function () { refresh().catch(function () {}); });
  }

  var api = {
    schema: function () { return schema; },
    fields: function () { return (schema.fields || []).slice(); },
    rows: function () { return (snapshot.rows || []).map(wrap); },
    show: show,
    paint: paint,
    rowCount: function () { return (snapshot.rows || []).length; },
    truncated: function () { return snapshot.truncated === true; },
    readAt: function () { return snapshot.readAt ? new Date(snapshot.readAt) : null; },
    digest: function () { return snapshot.digest || ""; },
    refresh: refresh,
    onChange: function (callback) {
      if (typeof callback !== "function") return function () {};
      listeners.push(callback);
      listen();
      return function () { listeners = listeners.filter(function (item) { return item !== callback; }); };
    },
  };
  global.Table = api;
})(typeof globalThis === "object" ? globalThis : this);
`;

// What the page in this folder currently holds. Read back from the same file
// the page loads, so publishing cannot send numbers the local page never had.
export async function readContract(folder) {
  const file = path.join(folder, CONTRACT_DIR, CONTRACT_FILES.data);
  let source;
  try { source = await readFile(file, "utf8"); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  const opened = source.indexOf("{"), closed = source.lastIndexOf("}");
  if (opened < 0 || closed <= opened) return null;
  try {
    const value = JSON.parse(source.slice(opened, closed + 1));
    return value?.snapshot?.digest ? { schema: value.schema ?? null, snapshot: value.snapshot } : null;
  } catch { return null; }
}

const inside = async (root, target) => {
  const base = await realpath(root);
  let here = target;
  try { here = await realpath(target); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const relative = path.relative(base, here);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

async function put(file, contents) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}

// The contract as bytes, keyed by the path a page asks for. One place decides
// what the three files are, so a folder on disk and a demo served from memory
// can never be given different contracts.
export function contractFiles({ schema, snapshot }) {
  if (!schema || !snapshot || typeof snapshot.digest !== "string") throw new Error("数据契约不完整");
  return new Map([
    [path.posix.join(CONTRACT_DIR, CONTRACT_FILES.schema), `${JSON.stringify(schema, null, 2)}\n`],
    // Under both names: a page written before the product was renamed may read
    // __MYDOUBAO_TABLE__ itself rather than through Table.
    [path.posix.join(CONTRACT_DIR, CONTRACT_FILES.data), `globalThis.__IDOU_TABLE__ = globalThis.__MYDOUBAO_TABLE__ = ${JSON.stringify({ schema, snapshot })};\n`],
    [path.posix.join(CONTRACT_DIR, CONTRACT_FILES.runtime), TABLE_RUNTIME],
  ]);
}

// Writes the contract into `folder`, replacing any earlier one. Returns the
// paths written, relative to the folder, for the step shown in the task.
export async function writeContract(folder, { schema, snapshot }) {
  if (typeof folder !== "string" || !path.isAbsolute(folder)) throw new Error("需要项目目录的绝对路径");
  const files = contractFiles({ schema, snapshot });
  const directory = path.join(folder, CONTRACT_DIR);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await inside(folder, directory))) throw new Error("data 目录指向了项目外面，已拒绝写入");
  for (const [name, contents] of files) await put(path.join(folder, name), contents);
  return [...files.keys()];
}
