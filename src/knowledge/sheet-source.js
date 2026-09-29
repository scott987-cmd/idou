// A spreadsheet as a knowledge source.
//
// Until now the local copy held documents only: a spreadsheet the person opened
// in the application was read, shown, and forgotten, so a question whose answer
// sits in a 台账 could not be answered from the knowledge copy at all — and the
// evaluation corpus, being Markdown documents, never noticed.
//
// What this turns a sheet into is the same kind of evidence page a document
// becomes: a bounded, verifiable text projection with its own source link,
// revision and content hash, re-read and permission-checked before any of it
// can reach an answer. Two honesty rules shape it:
//
//   * One version. The reader takes the sheet page by page, checks every page
//     against the revision the workbook reported first and reads the revision
//     again at the end, so the projection is a consistent snapshot rather than
//     a stitched-together walk over a moving sheet.
//   * The projection says what it does not contain. A sheet larger than the
//     bound keeps its first rows and says so, in the text the model reads and
//     in the warnings the person sees — it is never presented as the whole
//     sheet.
import { sheetColumn, isTableNote } from "../providers/feishu/sheet-reader.js";

// A whole worksheet, read page by page under one revision
// (src/providers/feishu/sheet-reader.js keeps every page within 200 rows and
// 2,000 cells). The bounds are the store's, not the API's: at most 5,000 rows,
// 100,000 cells and 450,000 characters of projection, whichever binds first --
// an evidence page may not exceed half a million characters.
export const SHEET_COVERAGE = Object.freeze({ maxRows: 5000, maxCells: 100_000, maxChars: 450_000 });
// What a reader without whole-table reads can still be asked for.
const SINGLE_READ = Object.freeze({ maxRows: 200, maxCells: 2000 });
// The first thing a copy taken by a whole-table read says: what it leaves out
// and the bounds it was taken under. It is also how a stored copy is known to be
// one this source would take today -- a copy without this exact note was cut by
// the earlier single read (200 rows at most) or under other bounds, and a
// revision that has not moved does not make it whole.
export const coverageNote = ({ maxRows, maxCells, maxChars }) =>
  `表格值快照：本机副本每张表最多整理 ${maxRows} 行、${maxCells} 个单元格、${maxChars} 字；公式、样式、图表和权限信息未复制。`;
// A cell that holds an essay is a document in disguise; the grid is what makes
// a sheet worth quoting, so long values are cut rather than allowed to crowd it.
const MAX_VALUE = 200;

const cell = (value) => {
  if (value === null || value === undefined) return "";
  const text = typeof value === "boolean" ? (value ? "TRUE" : "FALSE") : String(value);
  // Newlines and pipes would break the row into something that is no longer the
  // row it came from.
  const flat = text.replace(/\s+/gu, " ").replaceAll("|", "｜").trim();
  return flat.length > MAX_VALUE ? `${flat.slice(0, MAX_VALUE)}…` : flat;
};

// A Markdown-shaped grid, because that is what the rest of the pipeline already
// understands: retrieval carries a table's header row alongside an excerpt taken
// from its middle, and the model reads tables in this shape every day.
export function sheetProjection(snapshot) {
  const { sheets, sheetId, cells, rowIndices, colIndices, title } = snapshot;
  const sheet = (sheets ?? []).find((item) => item.id === sheetId);
  const covered = `${colIndices[0]}${rowIndices[0]}:${colIndices.at(-1)}${rowIndices.at(-1)}`;
  const size = sheet ? `共 ${sheet.rows} 行 × ${sheet.columns} 列` : "整表大小未知";
  const complete = sheet ? rowIndices.length >= sheet.rows && colIndices.length >= sheet.columns : false;
  const header = [
    `# ${title}`,
    `> 飞书电子表格的值快照 · 范围 ${covered}（${size}）${complete ? "" : " · 本副本只包含这个范围，表格其余部分未整理"} · 不含公式、样式与图表`,
    "",
    `| 行 | ${colIndices.join(" | ")} |`,
    `|---|${colIndices.map(() => "---").join("|")}|`,
  ];
  const rows = rowIndices.map((row, index) => `| ${row} | ${cells[index].map((value) => cell(value?.unsupported ? "复杂单元格（未展开）" : value?.value)).join(" | ")} |`);
  return { text: `${[...header, ...rows].join("\n")}\n`, complete, covered };
}

// The reader this hands LocalWiki is deliberately the same shape as the document
// reader: one `readDocument(url)` that either returns a verified evidence
// document or throws. Nothing here decides what may be stored — evidencePage
// still validates identity, link and size.
//
// `reference` is the deployment's own reading of a spreadsheet link
// (`feishu.references.sheet`): which links are spreadsheets is the deployment's
// to say, never this module's.
export function sheetKnowledgeSource(reader, { reference, coverage = SHEET_COVERAGE } = {}) {
  if (!reader || (typeof reader.read !== "function" && typeof reader.readTable !== "function")) throw new Error("缺少飞书表格读取器");
  if (typeof reference !== "function") throw new Error("缺少飞书表格链接的解析");
  const sheetReference = reference;
  return {
    matches(url) {
      try { sheetReference(url); return true; } catch { return false; }
    },
    async readDocument(url, { signal, known = null } = {}) {
      const parsed = sheetReference(url);
      // Re-verification of a stored sheet. Every question re-checks its sources,
      // and re-reading a five-thousand-row sheet page by page for each one would
      // make a large table unaffordable to ask about. A spreadsheet has its own
      // revision: asked as this user, it proves the person can still open the
      // sheet and that the cells stored are the cells Feishu holds. Only when it
      // moved, or when the stored copy is not one this source takes today (see
      // coverageNote), is the sheet read again. A value a formula recomputes
      // without anyone editing the sheet -- TODAY(), a reference to another
      // workbook -- may move no revision, so it is as fresh as the last edit.
      const whole = typeof reader.readTable === "function";
      const note = whole ? coverageNote(coverage) : null;
      // A copy this source takes today opens with today's note and says nothing a
      // whole-table read would not say. Earlier builds also kept Feishu's
      // `warning_message` among the warnings -- advice to the program reading the
      // sheet, shown under every hit as if something were wrong with the sheet --
      // and a revision that has not moved would keep it there for good. Such a
      // copy is read once more; its replacement no longer carries that text, so
      // its digest differs and it is written to disk.
      const said = Array.isArray(known?.warnings) ? known.warnings : [];
      if (whole && known && typeof known.text === "string" && known.sourceRevision && typeof reader.revision === "function"
          && said.includes(note) && said.every((line) => line === note || isTableNote(line))) {
        const current = await reader.revision(url, { signal });
        if (current.revision === String(known.sourceRevision)) {
          return { kind: "feishu-sheet", identity: current.identity, providerId: known.providerId, resourceId: known.resourceId,
            sourceUrl: known.sourceUrl, sourceRevision: current.revision, contentHash: known.contentHash, title: known.title,
            text: known.text, partial: false, warnings: said.slice(0, 20) };
        }
      }
      const snapshot = whole
        ? await reader.readTable(url, { ...(parsed.sheetId ? { sheetId: parsed.sheetId } : {}), coverage, signal })
        : await reader.read(url, { ...(parsed.sheetId ? { sheetId: parsed.sheetId } : {}), coverage: SINGLE_READ, signal });
      const projection = sheetProjection(snapshot);
      return {
        kind: "feishu-sheet", identity: snapshot.identity, providerId: snapshot.providerId,
        // One page per worksheet: two sheets of one workbook answer different
        // questions and must not overwrite each other.
        resourceId: `${snapshot.resourceId}:${snapshot.sheetId}`,
        sourceUrl: snapshot.sourceUrl, sourceRevision: snapshot.sourceRevision,
        contentHash: snapshot.contentHash, title: snapshot.title, text: projection.text, partial: false,
        warnings: [...(note ? [note] : []), ...(snapshot.warnings ?? []), ...(projection.complete || snapshot.truncated ? [] : [`本副本只整理了 ${projection.covered} 范围内的单元格，表格其余部分未包含。`])].slice(0, 20),
      };
    },
  };
}

// A Base table, projected the same way: the field names as the header row, one
// line per record. A Base has no document revision, so the projection's digest
// is its version -- any change to the records this copy holds is a new revision
// and replaces the stored page.
export function baseProjection(snapshot) {
  const { title, fields, records, tables, tableId, truncated } = snapshot;
  const others = (tables ?? []).filter((item) => item.id !== tableId).map((item) => item.name).slice(0, 20);
  const header = [
    `# ${title}`,
    `> 飞书多维表格的记录快照 · ${records.length} 条记录 × ${fields.length} 个字段${truncated ? " · 本副本只包含前若干条记录与字段，其余未整理" : ""}${others.length ? ` · 同一个多维表格里还有数据表：${others.join("、")}` : ""} · 附件、公式与视图筛选未展开`,
    "",
    `| ${fields.join(" | ")} |`,
    `|${fields.map(() => "---").join("|")}|`,
  ];
  const rows = records.map((record) => `| ${record.values.join(" | ")} |`);
  return { text: `${[...header, ...rows].join("\n")}\n`, complete: !truncated };
}

export function baseKnowledgeSource(reader, { reference, coverage = null } = {}) {
  if (!reader || typeof reader.read !== "function") throw new Error("缺少飞书多维表格读取器");
  if (typeof reference !== "function") throw new Error("缺少飞书多维表格链接的解析");
  const baseReference = reference;
  return {
    matches(url) {
      try { baseReference(url); return true; } catch { return false; }
    },
    async readDocument(url, { signal } = {}) {
      const snapshot = await reader.read(url, { ...(coverage ? { coverage } : {}), signal });
      const projection = baseProjection(snapshot);
      return {
        kind: "feishu-base", identity: snapshot.identity, providerId: snapshot.providerId, resourceId: snapshot.resourceId,
        sourceUrl: snapshot.sourceUrl, sourceRevision: snapshot.sourceRevision, contentHash: snapshot.contentHash,
        title: snapshot.title, text: projection.text, partial: false,
        warnings: ["飞书多维表格的记录快照；附件、公式结果与视图筛选未展开。", ...(projection.complete ? [] : ["记录或字段超出一次整理的范围，本副本只包含前面的部分。"])],
      };
    },
  };
}

// What LocalWiki is given as its provider: the document reader, plus the readers
// for the links only they can read. Dispatch is by link shape, so a stored page
// is always re-verified through the same route it was stored from.
export function knowledgeSourceReader(documents, sheets = null, bases = null) {
  return {
    documentIdentity: (options) => documents.documentIdentity(options),
    normalizeObservedDocument: documents.normalizeObservedDocument?.bind(documents),
    readDocument: (url, options) => (sheets?.matches(url) ? sheets.readDocument(url, options)
      : bases?.matches(url) ? bases.readDocument(url, options)
      : documents.readDocument(url, options)),
  };
}

export { sheetColumn };
