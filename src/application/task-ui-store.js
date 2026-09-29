import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { validateTaskId } from "./task-store.js";

const PANEL_KINDS = new Set(["none", "diff", "files", "browser", "media", "artifacts", "sources", "content"]);
const EMPTY = Object.freeze({
  version: 1,
  draft: { text: "", references: [], imageIds: [] },
  panel: { kind: "none", collapsed: false },
  scroll: { offset: 0, followLatest: true },
  expanded: {},
  revision: 0,
});

const clone = value => structuredClone(value);
const shortString = (value, max) => typeof value === "string" ? value.slice(0, max) : undefined;
function taskKey(value) {
  if (/^draft:(coding|cowork)$/.test(value)) return value;
  return validateTaskId(value);
}
function plainRecord(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function reference(value) {
  const row = plainRecord(value), result = {};
  for (const field of ["kind", "key", "title", "path", "url", "address", "revision", "fileRevision", "resourceKey", "resourceKind", "state", "name", "email", "department", "openId", "scope", "turnKey", "side", "comment", "excerpt"]) {
    const held = shortString(row[field], field === "url" ? 2_000 : 500);
    if (held !== undefined) result[field] = held;
  }
  if (row.kind === "diff" && ["working", "turn"].includes(row.scope) && ["old", "new"].includes(row.side)
      && Number.isSafeInteger(row.startLine) && row.startLine > 0 && Number.isSafeInteger(row.endLine) && row.endLine >= row.startLine) {
    result.startLine = row.startLine; result.endLine = row.endLine;
    result.comment = shortString(row.comment, 4_000) ?? ""; result.excerpt = shortString(row.excerpt, 8_000) ?? "";
  }
  if (row.kind === "terminal") result.excerpt = shortString(row.excerpt, 8_000) ?? "";
  const selection = plainRecord(row.selection);
  if (Number.isInteger(selection.start) && selection.start >= 0 && Number.isInteger(selection.end) && selection.end > selection.start) result.selection = {
    start: selection.start, end: selection.end,
    ...(selection.startLine > 0 ? { startLine: Math.round(selection.startLine) } : {}),
    ...(selection.endLine > 0 ? { endLine: Math.round(selection.endLine) } : {}),
    text: shortString(selection.text, 8_000) ?? "",
  };
  return result.kind && (result.key || result.path || result.url || result.openId || result.name) ? result : null;
}
function normalized(input, revision) {
  const value = plainRecord(input), draft = plainRecord(value.draft), panel = plainRecord(value.panel), scroll = plainRecord(value.scroll);
  const expanded = Object.fromEntries(Object.entries(plainRecord(value.expanded)).slice(-500).filter(([, open]) => typeof open === "boolean"));
  const kind = PANEL_KINDS.has(panel.kind) ? panel.kind : "none";
  const result = {
    version: 1,
    draft: {
      text: shortString(draft.text, 100_000) ?? "",
      references: (Array.isArray(draft.references) ? draft.references : []).slice(0, 20).map(reference).filter(Boolean),
      imageIds: (Array.isArray(draft.imageIds) ? draft.imageIds : []).slice(0, 5).map(value => shortString(value, 200)).filter(Boolean),
      ...(["manual", "standard", "auto", "full"].includes(draft.permission) ? { permission: draft.permission } : {}),
    },
    panel: {
      kind,
      collapsed: panel.collapsed === true,
      ...(Number.isFinite(panel.width) ? { width: Math.max(360, Math.min(1_000, Math.round(panel.width))) } : {}),
      ...(shortString(panel.resourceKey, 2_000) ? { resourceKey: shortString(panel.resourceKey, 2_000) } : {}),
      ...(shortString(panel.resourceRevision, 500) ? { resourceRevision: shortString(panel.resourceRevision, 500) } : {}),
      ...(["document", "sheet", "base"].includes(panel.resourceType) ? { resourceType: panel.resourceType } : {}),
      ...(shortString(panel.relativePath, 2_000) ? { relativePath: shortString(panel.relativePath, 2_000) } : {}),
      ...(["working", "turn"].includes(panel.diffScope) ? { diffScope: panel.diffScope } : {}),
      ...(Number.isInteger(plainRecord(panel.selection).start) && plainRecord(panel.selection).start >= 0 && Number.isInteger(plainRecord(panel.selection).end) && plainRecord(panel.selection).end > plainRecord(panel.selection).start ? { selection: {
        start: panel.selection.start, end: panel.selection.end,
        ...(panel.selection.startLine > 0 ? { startLine: Math.round(panel.selection.startLine) } : {}),
        ...(panel.selection.endLine > 0 ? { endLine: Math.round(panel.selection.endLine) } : {}),
        text: shortString(panel.selection.text, 20_000) ?? "",
      } } : {}),
      includeContext: panel.includeContext !== false,
    },
    scroll: {
      ...(shortString(scroll.messageKey, 500) ? { messageKey: shortString(scroll.messageKey, 500) } : {}),
      offset: Number.isFinite(scroll.offset) ? Math.max(0, Math.round(scroll.offset)) : 0,
      followLatest: scroll.followLatest !== false,
    },
    expanded,
    revision,
  };
  return result;
}
function metadata(input = {}) {
  return { pinned: input.pinned === true, archived: input.archived === true };
}

export class TaskUiStore {
  constructor(filename, cipher, document = { version: 1, tasks: {} }) {
    this.filename = filename;
    this.cipher = cipher;
    this.document = document;
    this.pending = Promise.resolve();
    this.warnings = [];
  }
  static async open(filename, cipher) {
    let document = { version: 1, tasks: {} }, warning = null;
    if (cipher?.available?.()) {
      try {
        const clear = cipher.decrypt(await readFile(filename));
        const parsed = JSON.parse(clear);
        if (parsed?.version !== 1 || !plainRecord(parsed.tasks)) throw new Error("invalid task UI state");
        document = { version: 1, tasks: parsed.tasks };
      } catch (error) {
        if (error?.code !== "ENOENT") warning = "无法读取已保存的任务界面状态，原文件未修改。";
      }
    }
    const store = new TaskUiStore(filename, cipher, document);
    if (warning) store.warnings.push(warning);
    return store;
  }
  get(id) {
    const key = taskKey(id), row = plainRecord(this.document.tasks[key]);
    return Promise.resolve(normalized(row.ui, Number.isSafeInteger(row.ui?.revision) ? row.ui.revision : 0));
  }
  metadata() {
    return Promise.resolve(Object.entries(this.document.tasks).filter(([taskId]) => !taskId.startsWith("draft:"))
      .map(([taskId, row]) => ({ taskId, ...metadata(row?.meta) })));
  }
  save(id, value, expectedRevision) {
    const key = taskKey(id);
    return this.#enqueue(async () => {
      const row = plainRecord(this.document.tasks[key]), current = Number.isSafeInteger(row.ui?.revision) ? row.ui.revision : 0;
      if (expectedRevision !== current) throw new Error("草稿已在其他窗口更新，请重新载入后再保存");
      const ui = normalized(value, current + 1);
      this.document.tasks[key] = { ui, meta: metadata(row.meta) };
      await this.#persist();
      return clone(ui);
    });
  }
  setMetadata(id, patch) {
    const key = taskKey(id);
    return this.#enqueue(async () => {
      const row = plainRecord(this.document.tasks[key]);
      this.document.tasks[key] = { ui: normalized(row.ui, Number.isSafeInteger(row.ui?.revision) ? row.ui.revision : 0), meta: metadata({ ...metadata(row.meta), ...plainRecord(patch) }) };
      await this.#persist();
      return { taskId: key, ...this.document.tasks[key].meta };
    });
  }
  remove(id) {
    const key = taskKey(id);
    return this.#enqueue(async () => { delete this.document.tasks[key]; await this.#persist(); });
  }
  flush() { return this.pending; }
  #enqueue(operation) {
    const next = this.pending.catch(() => {}).then(operation);
    this.pending = next;
    return next;
  }
  async #persist() {
    if (!this.cipher?.available?.()) throw new Error("草稿尚未保存：系统安全加密不可用；内容仍保留在本次运行中");
    await mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    try {
      const sealed = this.cipher.encrypt(JSON.stringify(this.document));
      await writeFile(temporary, sealed, { flag: "wx", mode: 0o600 });
      await rename(temporary, this.filename);
    } finally { await unlink(temporary).catch(error => { if (error?.code !== "ENOENT") throw error; }); }
  }
}

export function emptyTaskUiState() { return clone(EMPTY); }
