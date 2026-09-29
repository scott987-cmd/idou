// What a coding task needs to build a site on a Feishu table: what the table
// offers (for the picker), and the contract for a slice the person confirmed.
//
// Everything here goes through the deployment's own parts -- `baseRecords` and
// `sheets` on the Feishu client the definition built -- never through a CLI by
// name. A private deployment ships different parts, and this is the seam where
// that has to hold (docs/table-driven-sites.md, 2.7).
import { parseSlice, sliceId } from "./table-slice.js";
import { readBaseSlice, readSheetSlice, columnLetter } from "./table-snapshot.js";
import { writeContract } from "./table-contract.js";

// How many columns a spreadsheet picker offers. Beyond this the person is
// choosing from a list nobody reads; the slice's own field cap is the limit
// that matters.
const PICKER_COLUMNS = 60;
const originOf = (value) => { try { return new URL(String(value)).origin; } catch { return null; } };

export class TableSites {
  #baseRecords; #sheets; #references; #links; #identity; #renderCell;
  constructor({ baseRecords, sheets, references, links = null, identity = null, renderCell = null }) {
    this.#baseRecords = baseRecords; this.#sheets = sheets; this.#references = references; this.#links = links;
    // How this deployment turns a cell into the text a person reads. Only it
    // knows what a person, an attachment or a formula result looks like there,
    // and without it a page shows those columns empty.
    this.#renderCell = typeof renderCell === "function" ? renderCell : null;
    // Who the read is made as. The Base preview has always bracketed its read
    // with this check (base-records.js `snapshot`); a slice is a bigger read
    // that ends up in a file, so it gets the same treatment -- measured live,
    // where the slice path was the one way into the table that skipped it.
    this.#identity = typeof identity === "function" ? identity : null;
  }

  #kind(url) {
    for (const [kind, parse] of [["base", this.#references?.base], ["sheet", this.#references?.sheet]]) {
      if (typeof parse !== "function") continue;
      try { return { kind, parsed: parse(url) }; } catch { /* the other kind, or neither */ }
    }
    throw new Error("请贴一个多维表格或电子表格的链接");
  }

  // What the slice picker shows. Reads structure only: table and field names,
  // or worksheet names and the header row -- never a page of records.
  async describe(url, { tableId, sheetId, signal } = {}) {
    const { kind, parsed } = this.#kind(url);
    if (kind === "base") {
      const token = parsed.appToken;
      const tables = await this.#baseRecords.tables(token, signal);
      const wanted = tableId ?? parsed.tableId ?? tables[0]?.id;
      const table = tables.find((item) => item.id === wanted) ?? tables[0];
      if (!table) throw new Error("这个多维表格里没有数据表");
      const fields = await this.#baseRecords.fields(token, table.id, signal);
      return { kind, token, title: table.name, tableId: table.id,
        tables: tables.map((item) => ({ id: item.id, name: item.name })),
        fields: fields.map((field) => ({ id: field.id, name: field.name, type: field.type })) };
    }
    // No range of our own: a fixed A1:Z1 is refused outright by a worksheet
    // narrower than 26 columns (measured on a real sheet). The reader's own
    // default is bounded by the actual grid, and its first row is the header.
    const page = await this.#sheets.read(parsed.url ?? url, { ...(sheetId ? { sheetId } : {}), signal });
    const header = page.cells?.[0] ?? [];
    return { kind, token: page.resourceId, title: page.title, sheetId: page.sheetId, origin: originOf(page.sourceUrl ?? url),
      sheets: (page.sheets ?? []).map((item) => ({ id: item.id, name: item.title ?? item.name ?? item.id })),
      // A column with no header has no name to offer and no name a page could
      // ask for, so it is not offered. Trailing blanks are most of a worksheet.
      fields: header.slice(0, PICKER_COLUMNS)
        .map((cell, index) => ({ id: columnLetter(index + 1), name: String(cell?.value ?? "").trim(), type: "text" }))
        .filter((field) => field.name !== "") };
  }

  // The link this deployment would write for that table. A private deployment
  // ships its own builder, so the shape is never spelled out here.
  #reference(slice) {
    if (slice.kind !== "sheet" || !slice.origin || typeof this.#links?.sheet !== "function") return null;
    return this.#links.sheet(slice.origin, slice.token, slice.sheetId);
  }

  async #who(signal) {
    if (!this.#identity) return null;
    const identity = await this.#identity({ signal });
    if (!identity?.principal) throw new Error("读取表格需要已核验的飞书身份。");
    return identity;
  }

  // One read of a confirmed slice, written into the project. Returns what the
  // site should show: which files, how many rows, and when it was read.
  // `title` is what the site is called: the page's own heading, so a template
  // does not have to make one out of the column names.
  async build(folder, input, { signal, now = Date.now, title = "" } = {}) {
    const slice = parseSlice(input);
    const before = await this.#who(signal);
    const { schema, snapshot } = slice.kind === "base"
      ? await readBaseSlice(slice, this.#baseRecords, { signal, now, title, renderCell: this.#renderCell })
      : await readSheetSlice(slice, this.#sheets, { signal, now, reference: this.#reference(slice), title });
    const after = await this.#who(signal);
    if (before && (before.principal !== after?.principal || before.tenantKey !== after?.tenantKey)) {
      throw new Error("读取期间飞书身份已变化，未写入任何数据；请重新读取。");
    }
    const paths = await writeContract(folder, { schema, snapshot });
    return { sliceId: sliceId(slice), paths, rowCount: snapshot.rowCount, truncated: snapshot.truncated, readAt: snapshot.readAt,
      fields: schema.fields.map((field) => field.name) };
  }
}
