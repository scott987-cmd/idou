import { readableError } from "./errors.js";
import { searchOnPause } from "./search-on-pause.js";
import { knowledgeDiscoveryUi } from "./knowledge-discovery.js";
import { knowledgeGraphUi } from "./knowledge-graph.js";
import { knowledgePublicationUi } from "./knowledge-publication.js";
import { renderSheetGrid, renderSheetProposal } from "./sheet-view.js";
import { undoableSheetEdit } from "../../application/sheet-edit.js";
import { renderBaseGrid, renderBaseProposal } from "./base-view.js";
import { undoableBaseEdit } from "../../application/base-edit.js";
import { appReviewUi } from "./app-review.js";
import { appRuntimeUi } from "./app-runtime.js";
import { matchSource, citedByLink } from "./source-links.js";
import { skillCenterUi } from "./skill-center.js";
import { schedulesUi } from "./schedules.js";
import { renderReply } from "./message-markdown.js";
import { conversationFor, UNBOUND_CHAT } from "../feishu-chat-context.js";
import { documentName } from "../feishu-document-name.js";
import { codingTurns, contextLeft, elapsedText, exploreLines, exploreSummary, knowledgeStatus, planSummary, tokenCount } from "./coding-timeline.js";
import { coworkTurns } from "./cowork-timeline.js";
import { approvalPlacement, approvalPresentation, confirmationVisibleForTask } from "./confirmation-view.js";
import { joinSplitAnswers } from "../../application/split-answers.js";
import { recallPrompt, sentPrompts } from "./prompt-history.js";
import { executionPermissionForTask, isSafeDefaultPermission, normalizeDefaultExecutionPermission } from "../../permissions.js";
import { clampPanelWidth, nativeSurfaceBounds, workbenchLayout } from "./task-workbench.js";
import { reconcileNavigationOrder, taskNavigation } from "./task-navigation.js";
import { composerState, dispatchError, draftReferenceKey, referenceContext } from "./task-composer.js";
import { contextPresentation, knowledgeScopeVisible, mediaResultPresentation, selectionReferencePresentation } from "./office-outcomes.js";
import { diffReference, reviewFiles } from "./task-review.js";
import { previewPageReference, textLineNumbers } from "./task-preview.js";
import { taskTerminalUi } from "./task-terminal.js";
const api = window.idou;
const reviewsUi = appReviewUi({ api, element, action });
const runtimeUi = appRuntimeUi({ api, element, action });
for (const id of ["welcome-app-reviews", "open-app-reviews"]) document.getElementById(id).onclick = () => action(async () => { await hidePreview(); await reviewsUi.open(); });
for (const id of ["welcome-app-runtime", "open-app-runtime"]) document.getElementById(id).onclick = () => action(async () => { await hidePreview(); await runtimeUi.open(); });
let discoveryUi = null;
let skillUi = null;
let graphUi = null;
let publicationUi = null;
let receptionUi = null;
// Repaints 企业知识库's synthesis consent when the connection is read again, so
// a model the server confirms later is offered without leaving the section.
let synthesisConsent = null;
let applyingDocumentEdit = false, applyingSheetEdit = false, applyingBaseEdit = false;
// What the person has chosen or typed for the Agent's open questions, by approval
// and question, so a re-render while they answer does not wipe it.
const questionDrafts = new Map();
// Which rows of the activity record (a file change, a command's output) are open, so an update to the task does not fold them again.
const openChanges = new Set();
// A coding step the person opened or closed stays that way across redraws;
// one they never touched follows its default (a failed command and a short
// diff open, browsing closed).
const stepOpen = new Map();
const $ = (selector) => document.querySelector(selector);
// Files, Feishu documents and the web preview share one side panel, so they
// share one collapsed flag rather than each having a place of its own.
const SIDE_PANEL_TABS = ["changes", "files", "browser", "media"];
const state = { section: "cowork", taskId: null, draftPermission: null, draftWorkspace: null, feishuUnread: { count: 0, label: "" }, tab: "chat", panelCollapsed: false, panelWidth: null, mobilePane: "chat", sidebarPreference: "auto", mediaPreview: false, recents: [], snapshot: { tasks: [], approvals: [], warnings: [] }, connection: {}, folder: "", file: null, document: null, sheet: null, selection: null, includeContext: true, diffReview: { scope: "working", turnKey: null, path: null, result: null, selection: null }, preview: false, previewPage: null, archivePreview: null, appConfirmation: null, submitting: false, submittingAction: null, stopPending: false, navigationBusy: false, openSteps: new Set(), terminalPanels: new Set(), feishuView: null, dockedKey: null, pendingBind: null, taskUiMeta: [], taskSearch: "", showArchived: false, navigationOrder: [], scrollState: { offset: 0, followLatest: true } };
let viewEpoch = 0, fileReadEpoch = 0, documentEpoch = 0;
const drafts = new Map();
const draftKey = () => state.taskId || `draft:${state.section === "coding" ? "coding" : "cowork"}`;
// @ picks belong to one draft. They are kept per draft like its text, so a
// pick made in one task can never ride along into another.
const mention = { picks: [], open: false, kind: "people", start: -1, query: "", results: [], active: 0, seq: 0, timer: null, note: "" };
const documentDeliveryUi = { selected: null, members: [], preview: null };
const queueEditDrafts = new Map(); let submitActionOverride = null, queueAttempt = null;
// A coding task's commands, typed as / at the start of a message, the way Codex
// and Claude Code take them (docs/coding-task-parity.md, C5).
const SLASH_COMMANDS = Object.freeze([
  { name: "undo", label: "撤回上一轮", detail: "把对话退回到上一轮之前" },
  { name: "compact", label: "压缩对话", detail: "把之前的对话压缩成摘要，腾出上下文" },
  { name: "diff", label: "查看改动", detail: "工作目录里所有改过的文件和 diff" },
  { name: "review", label: "审查改动", detail: "Codex 的审查模式：未提交的改动、对比某个分支或某次提交；/review 后面写要求就按要求审查" },
  { name: "init", label: "生成 AGENTS.md", detail: "读一遍项目，写出给 Agent 的项目说明" },
  { name: "new", label: "新编程任务", detail: "在当前项目里开一个新任务" },
  { name: "permissions", label: "权限", detail: "切换这个任务的权限档位" },
  { name: "model", label: "模型", detail: "选择对话和编程用的模型，保存在服务端" },
  { name: "status", label: "状态", detail: "项目目录、权限、模型和这段对话的情况" },
]);
// The commands that mean something with words after them. Every other command
// typed with an argument is a message, not a command: "/status 今天" is a
// question about today, not a status request.
const COMMANDS_WITH_ARGUMENTS = new Set(["review"]);
// What /review was pointed at, until the composer sends it (sendReview).
let pendingReview = null;
const INIT_PROMPT = "为这个仓库准备一份 AGENTS.md，作为给编码 Agent 的项目说明。当前是只读规划阶段：先读项目的目录结构、构建和测试命令、代码风格与约定、提交和 PR 习惯，只输出写作计划，不要尝试写文件；"
  + "等我点击“生成 AGENTS.md”开始执行后，再写一份简洁的 AGENTS.md，包括项目结构、常用命令、编码约定、怎么测试、需要注意的坑。已经有 AGENTS.md 的，在原有内容上补充，不要删掉已有内容。";
const mentionDrafts = new Map();
const taskUiRecords = new Map(), taskUiDirty = new Set(), taskUiTimers = new Map(), taskUiSaving = new Map();
const panelKind = () => state.tab === "changes" ? "diff" : SIDE_PANEL_TABS.includes(state.tab) ? state.tab : "none";
function currentTaskUi() {
  return {
    draft: { text: $("#prompt").value, references: mention.picks, imageIds: (pastedImages.get(draftKey()) ?? []).map(image => image.id), ...(!state.taskId && state.draftPermission ? { permission: state.draftPermission } : {}) },
    panel: { kind: panelKind(), collapsed: state.panelCollapsed, width: state.panelWidth, relativePath: state.tab === "changes" ? state.diffReview.path : state.file?.path,
      resourceKey: state.tab === "changes" ? state.diffReview.turnKey : state.document?.sourceUrl || state.sheet?.sourceUrl || state.base?.sourceUrl,
      resourceRevision: state.tab === "changes" ? state.diffReview.result?.revision : state.file?.revision || state.document?.sourceRevision || state.sheet?.sourceRevision || state.base?.sourceRevision,
      ...(state.tab === "changes" ? { diffScope: state.diffReview.scope } : {}),
      resourceType: state.document ? "document" : state.sheet ? "sheet" : state.base ? "base" : undefined,
      selection: state.selection, includeContext: state.includeContext },
    scroll: state.scrollState, expanded: Object.fromEntries([
      ...[...stepOpen.entries()].filter(([key]) => key.startsWith(`${state.taskId}:`)).map(([key, open]) => [`step:${key}`, open]),
      ...[...openChanges].filter(key => key.startsWith(`${state.taskId}:`)).map(key => [`change:${key}`, true]),
      ...[...state.openSteps].filter(key => key.startsWith(`${state.taskId}:`)).map(key => [`cowork:${key}`, true]),
    ]),
  };
}
async function flushTaskUi(key = draftKey(), heal = true) {
  clearTimeout(taskUiTimers.get(key)); taskUiTimers.delete(key);
  if (taskUiSaving.has(key)) await taskUiSaving.get(key).catch(() => {});
  if (!taskUiDirty.has(key)) return;
  taskUiDirty.delete(key);
  const record = taskUiRecords.get(key) ?? { revision: 0 }, payload = record.value;
  let recount = false;
  const saving = api.saveTaskUiState(key, payload, record.revision).then(saved => {
    const latest = taskUiRecords.get(key) ?? record;
    taskUiRecords.set(key, { ...latest, revision: saved.revision });
    if ($("#error-banner").textContent.startsWith("草稿尚未保存：")) error("");
  }).catch(async cause => {
    taskUiDirty.add(key);
    // This window is the only one that writes these drafts, so a newer
    // revision on disk means it lost count of its own -- as onAuthChanged made
    // it do for the docked composer. Take the stored revision and save once
    // more; refusing every keystroke from then on left a banner asking for a
    // reload that nothing on screen could do (2026-09-23).
    if (heal && /草稿已在其他窗口更新/.test(String(cause?.message ?? ""))) {
      const stored = await api.taskUiState(key).catch(() => null);
      if (Number.isSafeInteger(stored?.revision)) { taskUiRecords.set(key, { ...(taskUiRecords.get(key) ?? record), revision: stored.revision }); recount = true; return; }
    }
    error(`草稿尚未保存：${readableError(cause)}`); throw cause;
  }).finally(() => taskUiSaving.delete(key));
  taskUiSaving.set(key, saving); await saving;
  if (recount) return flushTaskUi(key, false);
  if (taskUiDirty.has(key)) return flushTaskUi(key);
}
function queueTaskUiSave(key = draftKey()) {
  taskUiRecords.set(key, { ...(taskUiRecords.get(key) ?? { revision: 0 }), value: currentTaskUi() });
  taskUiDirty.add(key); clearTimeout(taskUiTimers.get(key));
  taskUiTimers.set(key, setTimeout(() => { void flushTaskUi(key).catch(() => {}); }, 300));
}
function saveDraft() {
  drafts.set(draftKey(), $("#prompt").value); mentionDrafts.set(draftKey(), structuredClone(mention.picks)); queueTaskUiSave();
}
// Images pasted into a coding task's box, per draft like the words (paintImageRow).
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const pastedImages = new Map();
let imageModel = null;
function restoreDraft() { $("#prompt").value = drafts.get(draftKey()) || ""; mention.picks = structuredClone(mentionDrafts.get(draftKey()) || []); closeMentions(); paintMentionRow(); paintImageRow(); }
async function loadTaskUi(key = draftKey()) {
  if (taskUiRecords.has(key)) return taskUiRecords.get(key).value;
  const record = await api.taskUiState(key);
  taskUiRecords.set(key, { revision: record.revision, value: record });
  drafts.set(key, record.draft.text); mentionDrafts.set(key, record.draft.references.map(reference => reference.kind === "selection" && reference.resourceKind?.startsWith("feishu-")
    ? { ...reference, state: "unavailable" } : reference));
  return record;
}
function applyTaskUi(record) {
  if (!state.taskId) state.draftPermission = record.draft.permission ?? null;
  state.tab = record.panel.kind === "diff" ? "changes" : SIDE_PANEL_TABS.includes(record.panel.kind) ? record.panel.kind : "chat";
  state.panelCollapsed = record.panel.collapsed === true; state.panelWidth = record.panel.width ?? null;
  state.mobilePane = state.tab === "chat" || state.panelCollapsed ? "chat" : "panel";
  state.file = record.panel.kind !== "diff" && record.panel.relativePath ? { path: record.panel.relativePath } : null;
  state.diffReview = { scope: record.panel.diffScope === "turn" ? "turn" : "working", turnKey: record.panel.diffScope === "turn" ? record.panel.resourceKey ?? null : null,
    path: record.panel.kind === "diff" ? record.panel.relativePath ?? null : null, result: null, selection: null };
  state.selection = record.panel.selection ?? null; state.includeContext = record.panel.includeContext !== false;
  state.scrollState = record.scroll ?? { offset: 0, followLatest: true };
  if (record.draft.imageIds?.length && !(pastedImages.get(draftKey())?.length)) pastedImages.set(draftKey(), record.draft.imageIds.map(id => ({ id, unavailable: true })));
  for (const [key, open] of Object.entries(record.expanded ?? {})) {
    if (key.startsWith("step:")) stepOpen.set(key.slice(5), open);
    else if (open && key.startsWith("change:")) openChanges.add(key.slice(7));
    else if (open && key.startsWith("cowork:")) state.openSteps.add(key.slice(7));
  }
  restoreDraft();
}
async function restoreTaskUi(key = draftKey()) {
  const record = await loadTaskUi(key);
  if (draftKey() !== key) return null;
  applyTaskUi(record); return record;
}
async function consumeNewDraft(key) {
  const held = taskUiRecords.get(key) ?? { revision: 0 };
  drafts.delete(key); mentionDrafts.delete(key);
  taskUiRecords.set(key, { ...held, value: { draft: { text: "", references: [], imageIds: [] }, panel: { kind: "none", collapsed: false }, scroll: { offset: 0, followLatest: true }, expanded: {} } });
  taskUiDirty.add(key); await flushTaskUi(key).catch(() => {});
}
function showFileText(text, { numbered = true } = {}) {
  $("#file-view-empty").hidden = true;
  $("#file-visual").hidden = true; $("#file-image").hidden = true; $("#file-image").removeAttribute("src");
  $("#file-text-view").hidden = false; $("#file-content").hidden = false; $("#file-content").value = text;
  $("#file-line-numbers").textContent = numbered ? textLineNumbers(text) : ""; $("#file-line-numbers").hidden = !numbered;
  $("#quote-selection").hidden = false;
}
function showFileCard(file, note = file.reason || "") {
  $("#file-view-empty").hidden = true;
  $("#file-text-view").hidden = true; $("#quote-selection").hidden = true; $("#file-visual").hidden = false;
  $("#file-card-title").textContent = file.path; $("#file-card-note").textContent = note;
  $("#file-image").hidden = !file.dataUrl; if (file.dataUrl) { $("#file-image").src = file.dataUrl; $("#file-image").alt = file.path; } else $("#file-image").removeAttribute("src");
  $("#open-system-file").hidden = !file.canSystemOpen; $("#reveal-task-file").hidden = file.blocked === true;
  $("#open-readable-copy").hidden = !file.readableCopy;
}
function clearFilePresentation() {
  $("#file-view-empty").hidden = false; $("#file-text-view").hidden = true; $("#file-visual").hidden = true; $("#quote-selection").hidden = true;
  $("#file-content").value = ""; $("#file-line-numbers").textContent = "";
  $("#file-title").textContent = "选择文件查看"; $("#file-note").hidden = true; $("#open-preview").hidden = true;
}
function clearArtifact() {
  state.archivePreview = null;
  state.diffReview = { scope: "working", turnKey: null, path: null, result: null, selection: null };
  $("#changes-content")?.replaceChildren(element("p", "打开后读取当前工作目录的改动。", "diff-dialog-note"));
  $("#app-entry").value = ""; $("#app-candidates").replaceChildren(); $("#apps-notice").textContent = "";
  $("#app-archive-folder").value = "";
  $("#media-notice").textContent = "在对话里描述你要的图片或视频，成果会在这里预览。";
  $("#media-results").replaceChildren();
  clearDocument(); $("#document-url-form").hidden = true; $("#document-url").value = "";
  $("#resource-kind").value = "document";
  fileReadEpoch += 1; state.file = null; state.folder = ""; state.selection = null; state.includeContext = true;
  clearFilePresentation(); $("#file-list").replaceChildren();
  state.previewPage = null; $("#preview-title").textContent = "尚未打开网页成果"; $("#preview-address").textContent = "";
}
function clearDocument() {
  // Closing the document closes its Feishu view with it; a view left mounted
  // would keep covering the panel and would still show the previous document.
  if (state.feishuView === "document") void closeFeishuView().catch(() => {});
  $("#feishu-native-view").hidden = true; feishuViewControls(false);
  closeDocumentDeliveryUi();
  $("#send-document").hidden = true;
  const retiring = state.document || state.sheet || state.base;
  if (retiring) {
    const key = retiring.sourceUrl;
    mention.picks = mention.picks.map(reference => reference.kind === "selection" && reference.resourceKey === key
      ? { ...reference, state: "unavailable", handle: undefined } : reference);
    mentionDrafts.set(draftKey(), structuredClone(mention.picks)); paintMentionRow();
  }
  const hadSheet = Boolean(state.sheet || state.base);
  state.sheet = null; $("#sheet-grid").replaceChildren(); $("#sheet-grid").hidden = true; $("#sheet-range-form").hidden = true; $("#file-text-view").hidden = false; $("#file-content").hidden = false;
  state.base = null; $("#base-grid").replaceChildren(); $("#base-grid").hidden = true; $("#base-page-form").hidden = true;
  if (state.taskId) { api.closeSheet(state.taskId).catch(() => {}); api.closeBase(state.taskId).catch(() => {}); }
  $("#propose-document-edit").checked = false;
  $("#propose-sheet-edit").checked = false; $("#propose-base-edit").checked = false;
  if (state.document || hadSheet) { $("#file-content").value = ""; $("#file-title").textContent = "选择文件查看"; state.selection = null; }
  documentEpoch += 1; state.document = null;
  if (state.taskId) api.closeDocument(state.taskId).catch(() => {});
  $("#document-meta").hidden = true; $("#document-meta").textContent = "";
  $("#file-content").classList.remove("document-text"); $("#files").classList.remove("reading-document");
}
const labels = { cowork: "工作任务", coding: "编程任务", sites: "文档网站", schedules: "定时任务", skills: "技能中心", knowledge: "企业知识库", feishu: "飞书消息", "feishu-docs": "飞书文档", settings: "设置" };
const statuses = { idle: "未开始", running: "进行中", awaiting_approval: "等待确认", stopping: "停止中", completed: "已完成", failed: "执行失败", interrupted: "已停止" };
const RUNNING_STATUSES = new Set(["running", "awaiting_approval", "stopping"]);
function elapsed(since) {
  const seconds = Math.max(0, Math.round((Date.now() - (since ?? Date.now())) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}
const task = () => state.snapshot.tasks.find((item) => item.id === state.taskId);
const busy = () => ["running", "awaiting_approval", "stopping"].includes(task()?.status);
let activeWorkbenchLayout = workbenchLayout({ width: window.innerWidth, taskOpen: false, panelOpen: false });
// Esc pressed once while a turn runs: until when a second press stops it (escapeToStop).
let stopArmedUntil = 0, stopArmTimer = 0;
function applyWorkbenchLayout(panelOpen, current) {
  activeWorkbenchLayout = workbenchLayout({ width: window.innerWidth, taskOpen: Boolean(current), panelOpen,
    nativeSurface: ["feishu", "feishu-docs"].includes(state.section), sidebarPreference: state.sidebarPreference });
  document.body.classList.toggle("sidebar-hidden", !activeWorkbenchLayout.sidebarVisible);
  document.body.classList.toggle("sidebar-overlay", activeWorkbenchLayout.sidebarOverlay);
  const area = $("#work-area");
  area.classList.toggle("layout-split", activeWorkbenchLayout.split);
  area.classList.toggle("layout-single", activeWorkbenchLayout.singlePane);
  area.classList.toggle("panel-view", activeWorkbenchLayout.singlePane && state.mobilePane === "panel");
  area.classList.toggle("chat-view", activeWorkbenchLayout.singlePane && state.mobilePane !== "panel");
  const occupied = activeWorkbenchLayout.sidebarVisible && !activeWorkbenchLayout.sidebarOverlay ? 236 : 0;
  const available = Math.max(0, window.innerWidth - occupied);
  const conversationMin = activeWorkbenchLayout.viewport === "wide" ? 440 : 420;
  const panelMin = activeWorkbenchLayout.viewport === "wide" ? 380 : 360;
  const requested = state.panelWidth ?? Math.round(available * 0.45);
  state.panelWidth = clampPanelWidth({ requested, available, conversationMin, panelMin });
  area.style.setProperty("--workbench-panel-width", `${state.panelWidth}px`);
  $("#workbench-divider").hidden = !activeWorkbenchLayout.split;
  $("#back-to-chat").hidden = !(activeWorkbenchLayout.singlePane && state.mobilePane === "panel");
  const sidebarAction = activeWorkbenchLayout.sidebarVisible ? "收起左侧导航" : "展开左侧导航";
  $("#sidebar-toggle").setAttribute("aria-label", sidebarAction); $("#sidebar-toggle").title = sidebarAction;
  return activeWorkbenchLayout;
}
// A native page is drawn above the DOM, so anything that has to be seen and
// clicked where it lies needs the page out of the way. `surface` narrows that
// to the box the page actually covers: a card waiting in the Feishu sections'
// dock sits beside the page, and hiding the page for it made the conversation
// a 「发送回复」 card was about disappear while the person decided.
function nativeOverlayActive(surface) {
  if (activeWorkbenchLayout.sidebarOverlay || document.querySelector("dialog[open]")) return true;
  const confirmations = $("#confirmations");
  if (confirmations.hidden || !confirmations.querySelector("button:not(:disabled)")) return false;
  if (!surface) return true;
  const card = confirmations.getBoundingClientRect(), box = surface.getBoundingClientRect();
  return card.left < box.right && card.right > box.left && card.top < box.bottom && card.bottom > box.top;
}
function workbenchPanelVisible() {
  if (state.panelCollapsed || !SIDE_PANEL_TABS.includes(state.tab)) return false;
  if (activeWorkbenchLayout.singlePane && state.mobilePane !== "panel") return false;
  return !nativeOverlayActive();
}
function syncNativeBounds() {
  void updateBounds()?.catch(() => {});
  void updateMediaBounds()?.catch(() => {});
  void updateFeishuBounds()?.catch(() => {});
}
// A historical task's directory is immutable and comes only from its persisted
// record. A draft has a separate selection which may either be a one-use picker
// handle or the id of the current task whose directory the main process resolves.
// Keeping those two concepts separate prevents the last picker choice from
// repainting an old task with the wrong project.
const taskProject = () => task()?.mode === "coding" ? { taskId: task().id, path: task().cwd } : null;
const visibleProject = () => taskProject() ?? state.draftWorkspace;
function element(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
// What Feishu itself answered is carried through after 「飞书返回：」 because it
// often names the cause (the missing scope, the size limit) -- and it is in
// English. It is shown as a quotation, set apart from the application's own
// sentence, rather than run on in the same voice (UI rules, 2026-09-25).
function error(message) {
  const banner = $("#error-banner"), text = message || "", at = text.indexOf("飞书返回：");
  if (at < 0) banner.textContent = text;
  else banner.replaceChildren(text.slice(0, at + "飞书返回：".length), element("code", text.slice(at + "飞书返回：".length), "upstream-quote"));
  banner.hidden = !message;
}
const terminalUi = taskTerminalUi({ api, getTask: () => task(), reportError: cause => error(readableError(cause)), onLayout: syncNativeBounds,
  addReference: reference => {
    if (!mention.picks.some(item => draftReferenceKey(item) === draftReferenceKey(reference))) mention.picks = [...mention.picks, reference];
    paintMentionRow(); saveDraft(); renderComposerState(); $("#prompt").focus();
  } });

// Light and dark are already a pair of light-dark() tokens, so an explicit
// choice only has to pin color-scheme on the root. The default stays "follow the
// system", and the choice is a per-machine display preference kept in this
// browser profile only; it is never part of a task, an account or a session.
const THEMES = [
  { id: "system", label: "配色：跟随系统" },
  { id: "light", label: "配色：浅色" },
  { id: "dark", label: "配色：深色" },
];
function applyTheme(id) {
  const theme = THEMES.find(entry => entry.id === id) || THEMES[0];
  if (theme.id === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = theme.id;
  const button = $("#theme-toggle");
  if (button) { button.textContent = theme.label; button.title = "点击切换：跟随系统 → 浅色 → 深色"; }
  // The choice has to reach the main process too. The embedded pages — the
  // browser preview, the Feishu views — are separate web contents that read
  // `prefers-color-scheme` from Electron, not from this document, and the
  // native surface painted behind them is chosen there as well. Without this
  // they follow the operating system while the interface follows the person.
  api.setTheme?.(theme.id).catch(() => { /* a display preference is not worth failing over */ });
  return theme.id;
}
// What this machine remembers between launches: theme, last section and the
// like, under idou-*. One saved before the rename, under mydoubao-*, is still
// read, so an update never resets a choice.
function remembered(key) { return localStorage.getItem(`idou-${key}`) ?? localStorage.getItem(`mydoubao-${key}`); }
function remember(key, value) { localStorage.setItem(`idou-${key}`, value); }
function readTheme() {
  try { return remembered("theme") || "system"; } catch { return "system"; }
}
function setupTheme() {
  let current = applyTheme(readTheme());
  const button = $("#theme-toggle");
  if (!button) return;
  button.onclick = () => {
    current = applyTheme(THEMES[(THEMES.findIndex(entry => entry.id === current) + 1) % THEMES.length].id);
    try { remember("theme", current); } catch { /* a display preference is not worth failing over */ }
  };
}
setupTheme();
// A machine preference is deliberately narrower than a task choice: full
// access and plan never become defaults for another task. The old key is read
// only for compatibility, and an old full value normalizes to standard.
let permissionModes = [];
function preferredPermission() {
  try { return normalizeDefaultExecutionPermission(remembered("default-execution-permission") ?? localStorage.getItem("mydoubao-permission")); }
  catch { return "standard"; }
}
function currentPermission() {
  const current = task();
  if (current?.stage === "planning") return executionPermissionForTask(current);
  return current?.permission ?? state.draftPermission ?? preferredPermission();
}
// Closed, the control says which mode is in force and nothing else; the other
// modes are a choice you go looking for, not standing clutter in the composer.
function closePermissionMenu() {
  $("#permission-menu").hidden = true;
  $("#permission-toggle").setAttribute("aria-expanded", "false");
}
function renderPermission() {
  if (!permissionModes.length) { $("#permission-field").hidden = true; return; }
  $("#permission-field").hidden = false;
  const value = currentPermission(), row = permissionModes.find(item => item.id === value);
  const toggle = $("#permission-toggle");
  // A planning turn is read-only whatever is chosen here, and the chosen one
  // takes over at 开始做. Showing 标准 while the turn cannot write anything is a
  // label that contradicts the run.
  const planning = task()?.stage === "planning" && task()?.mode === "coding";
  toggle.textContent = planning ? `执行时：${row?.label ?? value}` : `权限：${row?.label ?? value}`;
  toggle.title = planning ? `当前方案阶段只读，不会改任何文件；开始执行后按「${row?.label ?? value}」运行。`
    : row ? `${row.label}：${row.summary}` : "";
  // A running turn keeps the rules it started under, so the control waits.
  toggle.disabled = busy();
  if (toggle.disabled) closePermissionMenu();
  for (const item of $("#permission-menu").children) item.setAttribute("aria-checked", item.dataset.permission === value ? "true" : "false");
}
function choosePermission(value) {
  return action(async () => {
    const current = task();
    if (current) {
      await api.setTaskPermission(current.id, value);
      state.snapshot = await api.snapshot();
    } else {
      // Full belongs only to this draft and is consumed when its task is born.
      // Plan is already the coding draft's effective mode, not an execution
      // permission to remember.
      state.draftPermission = value === "plan" ? "standard" : value;
      if (isSafeDefaultPermission(value)) {
        try { remember("default-execution-permission", value); } catch { /* a convenience, never a failure */ }
      }
      queueTaskUiSave();
    }
    render();
  });
}
// 一处定义，两处用：知识库清单和回答下面的来源卡片说的是同一件事。
const STANDING = { current: ["现行", "ok"], amended: ["部分被调整", "warn"], superseded: ["已被替代", "bad"],
  "self-void": ["自述已废止", "bad"], conflict: ["版本不明", "warn"], unknown: ["", ""] };
const standingBadge = (state) => {
  const [label, tone] = STANDING[state] ?? STANDING.unknown;
  return label ? element("span", label, `standing-badge standing-${tone}`) : null;
};
const KINDS = { "feishu-sheet": "电子表格", "feishu-base": "多维表格", "feishu-document": "文档" };

// 回答下面的来源卡片。答案里出现过来源链接的排在前面并标「已引用」，其余的照样
// 列出来：模型没标出处，不等于没用到，人得能一眼看到这次到底带了哪些资料，并且
// 点开原文自己核对。
function answerSources(text, sources, open, { unavailable = 0 } = {}) {
  const list = Array.isArray(sources) ? sources.filter((item) => item?.sourceUrl) : [];
  if (!list.length) return null;
  const answer = String(text ?? "");
  const linked = citedByLink(answer, list);
  const quoted = (source) => answer.includes(source.sourceUrl) || linked.has(source.sourceUrl) || (source.id && answer.includes(source.id))
    || (source.title && source.title.length >= 4 && answer.includes(source.title));
  const cited = list.filter(quoted), rest = list.filter((source) => !quoted(source));
  const box = element("section", undefined, "answer-sources");
  const missing = unavailable > 0 ? `　另有 ${unavailable} 篇这次没能重新核验，没有参与回答` : "";
  box.append(element("span", `${cited.length ? `回答依据 · 已引用 ${cited.length} 篇` : `本次带上了 ${list.length} 篇资料，回答里没有标出处`}${missing}`, "answer-sources-label"));
  const chips = element("div", undefined, "answer-source-chips");
  for (const source of [...cited, ...rest]) {
    const chip = element("button", undefined, `answer-source${quoted(source) ? " answer-source-cited" : ""}`);
    chip.type = "button";
    if (quoted(source)) chip.append(element("span", "已引用", "answer-source-mark"));
    chip.append(element("span", KINDS[source.kind] ?? "文档", "answer-source-kind"), element("span", source.title || source.sourceUrl, "answer-source-title"));
    const mark = standingBadge(source.standing ?? "unknown");
    if (mark) chip.append(mark);
    if (source.copies > 1) chip.append(element("span", `${source.copies} 份副本`, "standing-badge standing-warn"));
    chip.title = [source.docDate ? `文档自述日期 ${source.docDate}` : "", source.sections.length ? `摘录自：${source.sections.join("、")}` : "",
      source.supersededBy ? `已被《${source.supersededBy}》替代` : "", "点开可在工作任务中打开原文"].filter(Boolean).join("\n");
    chip.onclick = () => open(source.sourceUrl);
    chips.append(chip);
  }
  box.append(chips);
  return box;
}

// Which of the person's own knowledge the agent may draw on when answering.
// Off by default: turning it on changes what the model sees, so it is a choice
// somebody makes, not something that quietly starts happening.
const KNOWLEDGE_SCOPE_LABELS = { off: "不使用", all: "全部知识库", selected: "指定文档" };
function taskKnowledgeScope() { return task()?.knowledgeScope ?? null; }
function closeKnowledgeMenu() {
  $("#knowledge-scope-menu").hidden = true;
  $("#knowledge-scope-toggle").setAttribute("aria-expanded", "false");
}
function renderKnowledgeScope() {
  const field = $("#knowledge-scope-field");
  field.hidden = !knowledgeScopeVisible(task());
  if (field.hidden) { closeKnowledgeMenu(); return; }
  const scope = taskKnowledgeScope(), mode = scope?.mode ?? "off";
  const toggle = $("#knowledge-scope-toggle");
  toggle.textContent = `知识：${mode === "selected" ? `${scope.ids.length} 篇` : KNOWLEDGE_SCOPE_LABELS[mode]}`;
  toggle.title = mode === "off" ? "回答时不查你的知识库" : "提问时先检索本机知识副本，并逐篇重新核验飞书权限";
  toggle.disabled = busy();
  if (toggle.disabled) closeKnowledgeMenu();
}
async function chooseKnowledgeScope(value) {
  await api.setTaskKnowledgeScope(await ensureTask(), value);
  state.snapshot = await api.snapshot();
  render();
}
// Attaching a file, generating a picture and choosing a knowledge scope all
// belong to a task — but so does the permission mode, and that one has always
// been settable before the first message. The others were hidden until a task
// existed, which put half the composer out of reach on exactly the screen where
// somebody is deciding what to do. The task is what gets created on demand now,
// not the controls that get hidden.
// The only place a task is born in this renderer.
//
// There used to be two: this one, and another inside the send handler. They
// disagreed about the mode -- the embedded Feishu sections are places to stand
// while working, not task kinds, so a task started there is ordinary 工作任务 --
// and when the messenger's conversation had to be bound to the chat it belongs
// to, the binding went on this path while sending used the other. Every
// conversation started by actually typing something was therefore never bound,
// which is the whole of the bug it was meant to fix. One path, so the next
// thing that has to happen at birth cannot be attached to half of it.
const taskModeFor = (section) => (["feishu-docs", "feishu"].includes(section) ? "cowork" : section);
async function createSectionTask() {
  const mode = taskModeFor(state.section), draft = state.draftWorkspace;
  let created;
  try {
    created = await api.createTask({ mode, ...(draft?.taskId ? { fromTaskId: draft.taskId } : { workspaceId: draft?.id }), permission: state.draftPermission ?? preferredPermission() });
  } catch (cause) {
    if (mode === "coding" && draft && /目录已移动或不可用/.test(readableError(cause))) {
      state.draftWorkspace = { ...draft, unavailable: true };
      render();
    }
    throw cause;
  }
  state.draftPermission = null;
  state.draftWorkspace = null;
  // Started from the messenger, the conversation belongs to the chat that was
  // open at the time. Written on the record rather than kept in memory, because
  // memory is exactly what leaving the section threw away.
  if (state.section === "feishu") {
    // The main process decides the key from its own record of the page; what
    // this side last saw is not passed along.
    const bound = await api.bindFeishuChat(created.id).catch(() => null);
    const name = dockedChat?.name ?? "";
    // Started on the shared conversation -- an ambiguous name, a page not yet
    // matched -- and the person may pick the chat a moment later. Remembered
    // here and re-bound below once the key settles for the same name.
    state.pendingBind = bound?.key === UNBOUND_CHAT && name ? { id: created.id, name } : null;
  }
  return created;
}
async function ensureTask() {
  if (state.taskId) return state.taskId;
  const key = draftKey(), draftUi = currentTaskUi();
  const created = await createSectionTask();
  state.snapshot = await api.snapshot();
  await loadTaskUi(created.id); state.taskId = created.id;
  taskUiRecords.set(created.id, { ...taskUiRecords.get(created.id), value: draftUi }); taskUiDirty.add(created.id);
  if (pastedImages.has(key)) pastedImages.set(created.id, pastedImages.get(key));
  await consumeNewDraft(key);
  render();
  return created.id;
}
// A choice in one of the composer's menus: a short name and a line saying what
// it does. Assistive technology is given the name as the name and the line as
// its description. Read as one long name it was a title automation driving the
// Accessibility API would not use, and it fell back to a hit on the text beside
// the item, which has no action (measured on 权限, 2026-09-24).
// The composer's menus open above their chip. Laid out inside the composer they
// overflowed it, and a hit test -- how automation driving the Accessibility API
// finds an item -- never reached them: it landed on the conversation behind,
// which has no action (measured with a probe window and on 权限, 2026-09-24). So
// each is lifted to the top of the page and placed over its chip when it opens.
//
// It stays inside the column its chip is in, not merely inside the window.
// Beside that column there can be a native page -- Feishu in its two sections, a
// preview in the side panel -- and a native page is drawn above the DOM: in the
// dock beside Feishu's messages, 知识 slid left to fit the window and the start
// of every document's title was under the messenger (installed app, 2026-09-24).
function placeMenu(menu, toggle) {
  if (menu.parentElement !== document.body) document.body.append(menu);
  const box = toggle.getBoundingClientRect();
  const column = toggle.closest("#agent-panel")?.getBoundingClientRect() ?? { left: 0, right: innerWidth };
  const from = Math.max(8, column.left + 8), to = Math.min(innerWidth, column.right) - 8;
  menu.style.setProperty("--menu-room", `${Math.max(0, to - from)}px`);
  menu.style.left = `${Math.max(from, Math.min(box.left, to - menu.offsetWidth))}px`;
  menu.style.bottom = `${Math.max(8, innerHeight - box.top + 6)}px`;
}
function menuChoice(label, hint) {
  const node = element("button"); node.type = "button"; node.setAttribute("role", "menuitemradio");
  node.setAttribute("aria-label", label);
  if (hint) node.setAttribute("aria-description", hint);
  const name = element("strong", label), line = element("small", hint);
  name.setAttribute("aria-hidden", "true"); line.setAttribute("aria-hidden", "true");
  node.append(name, line);
  return node;
}
async function openKnowledgeMenu() {
  const menu = $("#knowledge-scope-menu");
  if (!menu.hidden) { closeKnowledgeMenu(); return; }
  const scope = taskKnowledgeScope(), mode = scope?.mode ?? "off";
  const item = (label, hint, chosen, run) => {
    const node = menuChoice(label, hint);
    node.setAttribute("aria-checked", chosen ? "true" : "false");
    node.onclick = () => action(async () => { closeKnowledgeMenu(); await run(); });
    return node;
  };
  const rows = [
    item("不使用", "回答只依据你附上的内容和现场查飞书", mode === "off", () => chooseKnowledgeScope("off")),
    item("全部知识库", "每次提问先检索全部已读文档", mode === "all", () => chooseKnowledgeScope("all")),
  ];
  // The picker lists what the local copy actually holds. Titles come from the
  // stored copy; the documents themselves are re-verified at question time.
  const snapshot = await api.knowledgeGraphSnapshot().catch(() => null);
  const nodes = snapshot?.nodes ?? [];
  if (!nodes.length) rows.push(item("指定文档", "知识库还是空的：在工作任务里打开完整飞书文档即可入库", false, async () => {}));
  else {
    const chosen = new Set(mode === "selected" ? scope.ids : []);
    const list = element("div", undefined, "knowledge-pick-list");
    for (const node of nodes.slice(0, 60)) {
      const row = element("label", undefined, "knowledge-pick");
      const box = document.createElement("input"); box.type = "checkbox"; box.checked = chosen.has(node.id);
      box.onchange = () => { if (box.checked) chosen.add(node.id); else chosen.delete(node.id); };
      row.append(box, element("span", node.title));
      list.append(row);
    }
    const apply = element("button", "只用选中的这些"); apply.type = "button";
    apply.onclick = () => action(async () => {
      if (!chosen.size) throw new Error("请至少选择一篇文档，或改用「不使用」");
      closeKnowledgeMenu(); await chooseKnowledgeScope({ mode: "selected", ids: [...chosen] });
    });
    rows.push(element("div", "指定文档", "knowledge-pick-title"), list, apply);
  }
  menu.replaceChildren(...rows);
  menu.hidden = false;
  placeMenu(menu, $("#knowledge-scope-toggle"));
  $("#knowledge-scope-toggle").setAttribute("aria-expanded", "true");
}
async function loadPermissionModes() {
  permissionModes = await api.permissionModes().catch(() => []);
  $("#permission-menu").replaceChildren(...permissionModes.map(row => {
    const item = menuChoice(row.label, row.summary);
    item.dataset.permission = row.id;
    item.onclick = () => { closePermissionMenu(); return choosePermission(row.id); };
    return item;
  }));
  renderPermission();
}
$("#knowledge-scope-toggle").onclick = () => action(() => openKnowledgeMenu());
document.addEventListener("pointerdown", event => { if (!$("#knowledge-scope-field").contains(event.target) && !$("#knowledge-scope-menu").contains(event.target)) closeKnowledgeMenu(); }, true);
// A link in a reply opens in the system browser, and only when clicked; the
// main process accepts nothing but https. Middle and modified clicks are
// stopped too, so no reply link can ever navigate or open this window.
for (const type of ["click", "auxclick"]) $("#messages").addEventListener(type, event => {
  const link = event.target.closest?.("a[data-external-link]");
  if (!link) return;
  event.preventDefault();
  if (type === "click" && event.button === 0) void api.openExternalLink(link.dataset.externalLink).catch(cause => error(readableError(cause)));
});
document.addEventListener("keydown", event => { if (event.key === "Escape") closeKnowledgeMenu(); });
$("#permission-toggle").onclick = () => {
  const menu = $("#permission-menu"), opening = menu.hidden;
  menu.hidden = !opening;
  if (opening) placeMenu(menu, $("#permission-toggle"));
  $("#permission-toggle").setAttribute("aria-expanded", opening ? "true" : "false");
};
// Anywhere else, and Escape, put it away again.
document.addEventListener("keydown", event => { if (event.key === "Escape") closePermissionMenu(); });
document.addEventListener("pointerdown", event => { if (!$("#permission-field").contains(event.target) && !$("#permission-menu").contains(event.target)) closePermissionMenu(); }, true);
// Placed where its chip was when it opened, so it does not outlive the chip moving.
window.addEventListener("resize", () => { closePermissionMenu(); closeKnowledgeMenu(); });
async function action(fn) { try { error(""); return await fn(); } catch (cause) { error(readableError(cause)); } }
// Feishu's own unread count, on the tab that leads to it. The embedded messenger
// keeps counting while the person is anywhere else in the app, which is the only
// reason a number here is worth anything; it is written exactly as Feishu writes
// it, 99+ included, and disappears once everything has been read.
function renderFeishuUnread() {
  const tab = document.querySelector('[data-section="feishu"]');
  if (!tab) return;
  const { count, label } = state.feishuUnread ?? { count: 0, label: "" };
  const badge = tab.querySelector(".nav-unread");
  if (!count) { badge?.remove(); tab.removeAttribute("title"); return; }
  (badge ?? tab.appendChild(element("b", "", "nav-unread"))).textContent = label;
  tab.title = `飞书未读 ${label} 条`;
}
// Opening a task: from its row in the sidebar, or from the notification of a
// card waiting in it.
async function openTask(item) {
  if (state.navigationBusy) return;
  state.navigationBusy = true; renderSidebar();
  try {
    if (state.section !== item.mode) { await switchSection(item.mode); state.navigationBusy = true; renderSidebar(); }
    saveDraft(); await flushTaskUi().catch(() => {}); const closing = hidePreview(); clearArtifact();
    state.taskId = item.id; state.draftPermission = null; const restored = await restoreTaskUi(item.id); error(""); state.navigationBusy = false; render(); await closing;
    await restorePanelResource(restored);
  } finally { state.navigationBusy = false; renderSidebar(); }
}
function renderSidebar() {
  for (const button of document.querySelectorAll("[data-section]")) { button.setAttribute("aria-current", button.dataset.section === state.section ? "page" : "false"); button.disabled = state.navigationBusy; }
  renderFeishuUnread();
  $("#new-task").textContent = state.section === "coding" ? "＋ 新编程任务" : "＋ 新工作任务";
  $("#new-task").disabled = state.navigationBusy;
  // The recent list belongs to the section above it: standing in 工作任务 you see
  // work tasks, in 编程任务 you see coding tasks. Sections that own no tasks
  // (skills, knowledge, messages, settings) keep the combined list.
  const scoped = ["cowork", "coding"].includes(state.section);
  const navigation = taskNavigation(state.snapshot.tasks, state.taskUiMeta, { section: state.section, query: state.taskSearch,
    showArchived: state.showArchived, currentTaskId: state.taskId, order: state.navigationOrder });
  $("#recent-label").textContent = state.taskSearch ? `搜索结果 · ${navigation.count}` : state.showArchived ? "已归档任务" : scoped ? `最近的${labels[state.section]}` : "最近任务";
  $("#task-search").value = state.taskSearch; $("#show-archived").setAttribute("aria-pressed", String(state.showArchived));
  const makeRow = (item) => {
    const meta = state.taskUiMeta.find(row => row.taskId === item.id) ?? { pinned: false, archived: false };
    const row = element("div", undefined, "recent-row");
    row.classList.toggle("archived", meta.archived);
    const button = element("button", item.title); button.setAttribute("aria-current", item.id === state.taskId ? "page" : "false");
    button.disabled = state.navigationBusy;
    button.append(element("small", scoped ? statuses[item.status] || item.status : `${labels[item.mode]} · ${statuses[item.status] || item.status}`));
    const waitsForCodex = state.snapshot.approvals.some((approval) => approval.taskId === item.id);
    const waitsForApp = state.appConfirmation?.taskId === item.id && ["pending", "responding"].includes(state.appConfirmation.status);
    if (waitsForCodex || waitsForApp) {
      const waiting = element("b", "等你确认", "task-confirmation-badge");
      waiting.title = "这个任务正在等待你的确认；打开任务后核对卡片"; button.append(waiting);
    }
    // Through switchSection when it changes section, never by assigning it.
    //
    // 飞书消息 and 飞书文档 are native views laid over the window, and taking one
    // down is switchSection's job -- nothing render() does can reach it. Setting
    // state.section by hand left the embedded view attached and visible with
    // stale bounds, and left #library holding the section it had just left.
    // Measured: after clicking a recent task from inside 飞书消息 the messenger
    // view was still visible:true, and #library still held feishu-chat-area and
    // feishu-agent-dock. A screenshot cannot show this -- Playwright captures the
    // page, and a WebContentsView is not part of it.
    button.onclick = () => action(() => openTask(item));
    // Rename and delete belong to the task they are about, so they live on its
    // row rather than in a menu somewhere else that needs a selection first.
    const rename = element("button", "重命名", "row-action"); rename.type = "button"; rename.title = `重命名「${item.title}」`;
    rename.disabled = state.navigationBusy; rename.onclick = (event) => { event.stopPropagation(); startRename(row, button, item); };
    const pin = element("button", meta.pinned ? "取消置顶" : "置顶", "row-action"); pin.type = "button";
    pin.disabled = state.navigationBusy; pin.onclick = event => { event.stopPropagation(); void action(async () => { await setTaskMetadata(item.id, { pinned: !meta.pinned, archived: meta.archived }); }); };
    const archive = element("button", meta.archived ? "恢复" : "归档", `row-action${RUNNING_STATUSES.has(item.status) ? " warn" : ""}`); archive.type = "button";
    archive.title = RUNNING_STATUSES.has(item.status) ? "请先停止任务" : meta.archived ? "恢复到最近任务" : "归档任务（保留文件和会话）";
    archive.disabled = state.navigationBusy || RUNNING_STATUSES.has(item.status);
    archive.onclick = event => { event.stopPropagation(); void action(async () => { await setTaskMetadata(item.id, { pinned: meta.pinned, archived: !meta.archived }); }); };
    const remove = element("button", "✕", "row-action"); remove.type = "button"; remove.title = `删除「${item.title}」`; remove.disabled = state.navigationBusy;
    remove.onclick = (event) => { event.stopPropagation(); action(async () => {
      const removed = await api.deleteTask(item.id);
      if (!removed) return;
      if (state.taskId === item.id) { state.taskId = null; state.draftPermission = null; state.tab = "chat"; await hidePreview(); clearArtifact(); await restoreTaskUi(); }
      taskUiRecords.delete(item.id); taskUiDirty.delete(item.id); clearTimeout(taskUiTimers.get(item.id)); taskUiTimers.delete(item.id);
      state.taskUiMeta = state.taskUiMeta.filter(meta => meta.taskId !== item.id); state.snapshot = await api.snapshot(); render();
    }); };
    row.append(button, rename, pin, archive, remove); return row;
  };
  const children = [];
  for (const group of navigation.groups) {
    const heading = element("div", undefined, "task-group-label"); heading.title = group.path ?? group.label;
    heading.append(element("span", group.label), ...(group.path ? [element("small", group.path)] : [])); children.push(heading, ...group.tasks.slice(0, 40).map(makeRow));
  }
  $("#recent-tasks").replaceChildren(...children);
  if (!navigation.count) $("#recent-tasks").append(element("small", state.taskSearch ? "没有匹配当前账号的任务" : state.showArchived ? "还没有归档任务" : scoped ? `还没有${labels[state.section]}` : "还没有任务", "recent-empty"));
}
async function setTaskMetadata(taskId, patch) {
  const updated = await api.setTaskUiMetadata(taskId, patch);
  state.taskUiMeta = [...state.taskUiMeta.filter(row => row.taskId !== taskId), updated]; renderSidebar();
}
// Renaming happens in place on the row, so the name is edited where it is read.
function startRename(row, button, item) {
  const input = element("input"); input.className = "rename-input"; input.value = item.title; input.setAttribute("aria-label", "任务名称"); input.maxLength = 60;
  const commit = (save) => action(async () => {
    if (!input.isConnected) return;
    const value = input.value.trim();
    input.replaceWith(button);
    if (!save || !value || value === item.title) return;
    await api.renameTask(item.id, value);
    state.snapshot = await api.snapshot(); render();
  });
  input.onkeydown = (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") { event.preventDefault(); commit(true); }
    if (event.key === "Escape") { event.preventDefault(); commit(false); }
  };
  input.onblur = () => commit(true);
  button.replaceWith(input); input.focus(); input.select();
}
// The composer's own state, in one place. It used to be set only by the full
// render(), while a finished turn arrives as a snapshot change that re-renders
// just the conversation — so the button kept saying 补充 ↑ after the task was
// already 已完成, telling the person the Agent was still working when it wasn't.
function renderComposerState() {
  const current = task(), images = pastedImages.get(draftKey()) ?? [];
  const invalidDraftDirectory = !current && state.section === "coding" && state.draftWorkspace?.unavailable;
  const value = composerState({ task: current, submitting: state.submitting, submittingAction: state.submittingAction, stopPending: state.stopPending, text: $("#prompt").value,
    imageCount: images.length, imageModel, invalidDirectory: invalidDraftDirectory });
  $("#send").disabled = value.disabled;
  $("#send").textContent = value.label;
  $("#send").title = value.reason;
  $("#send").dataset.action = value.action;
  if (!busy()) disarmStop();
  $("#queue-send").hidden = !value.queueVisible;
  $("#queue-send").disabled = value.queueDisabled;
  $("#queue-send").title = value.queueDisabled ? value.reason : "不补充当前轮；在本轮正常完成后按顺序发送";
  return value;
}

function renderTaskQueue() {
  const root = $("#task-queue"), current = task(), queue = current?.queue, entries = queue?.entries ?? [];
  root.replaceChildren(); root.hidden = !queue || (!entries.length && !queue.paused && !queue.readOnly); if (root.hidden) return;
  const header = element("header"), title = element("strong", `下一轮 · ${entries.length} 条`), controls = element("div");
  const toggle = element("button", queue.paused ? "按当前设置继续" : "暂停队列"); toggle.type = "button";
  toggle.disabled = queue.readOnly || (!queue.paused && !entries.length) || (queue.paused && RUNNING_STATUSES.has(current.status));
  toggle.onclick = () => action(() => api.setTaskQueuePaused(current.id, !queue.paused)); controls.append(toggle); header.append(title, controls); root.append(header);
  if (queue.reason || queue.readOnly) root.append(element("p", queue.warnings?.[0] || queue.reason, `queue-reason${queue.readOnly ? " bad" : ""}`));
  for (const entry of entries) {
    const row = element("article", undefined, `queue-entry queue-${entry.state}${entry.unknown ? " unknown" : ""}`), top = element("div", undefined, "queue-entry-heading");
    const labels = { queued: "等待本轮完成", paused: "已暂停", dispatching: "正在派发", failed: entry.unknown ? "派发结果待核对" : "派发前检查失败" };
    top.append(element("span", labels[entry.state] || entry.state), element("small", `版本 ${entry.revision}`)); row.append(top);
    const draft = queueEditDrafts.has(entry.id) ? queueEditDrafts.get(entry.id) : entry.payload.text;
    // Named for the Accessibility API; an unnamed text box is one nobody can find by name (UI rules, 2026-09-25).
    const input = document.createElement("textarea"); input.value = draft; input.rows = 2; input.readOnly = entry.state === "dispatching" || entry.unknown;
    input.setAttribute("aria-label", "排队的下一轮内容");
    let save;
    input.oninput = () => {
      queueEditDrafts.set(entry.id, input.value);
      if (save) save.disabled = !input.value.trim() || input.value === entry.payload.text;
    };
    row.append(input);
    if (entry.reason) row.append(element("small", entry.reason, "queue-entry-reason"));
    const actions = element("div", undefined, "queue-entry-actions");
    if (!input.readOnly) {
      save = element("button", "保存修改"); save.type = "button"; save.disabled = !draft.trim() || draft === entry.payload.text;
      save.onclick = () => action(async () => { await api.updateQueuedMessage(current.id, entry.id, entry.revision, { text: input.value }); queueEditDrafts.delete(entry.id); }); actions.append(save);
    }
    if (entry.state !== "dispatching") {
      const remove = element("button", entry.unknown ? "核对后移除记录" : "移除"); remove.type = "button";
      remove.onclick = () => action(async () => { await api.removeQueuedMessage(current.id, entry.id, entry.revision); queueEditDrafts.delete(entry.id); }); actions.append(remove);
    }
    if (actions.childElementCount) row.append(actions); root.append(row);
  }
}
// A reply's nodes depend only on its text, and the conversation is re-rendered
// on every streamed change, so each distinct text is parsed once and cloned.
const replyCache = new Map();
function replyNode(text, sources = null) {
  let template = replyCache.get(text);
  if (template) replyCache.delete(text);
  else template = renderReply(text);
  replyCache.set(text, template);
  if (replyCache.size > 200) replyCache.delete(replyCache.keys().next().value);
  const node = template.cloneNode(true);
  // A link the model copied slightly wrong is pointed at the source it was
  // plainly meant to be -- only when it is nearly one of the documents sent with
  // this question and nearly nothing else. The answer's text stays as written;
  // the correction is said next to it.
  if (Array.isArray(sources) && sources.length) {
    for (const link of node.querySelectorAll("a[data-external-link]")) {
      const found = matchSource(link.dataset.externalLink, sources);
      if (!found?.corrected) continue;
      link.href = found.source.sourceUrl;
      link.dataset.externalLink = found.source.sourceUrl;
      link.title = `回答里的链接抄错了，已按这一问实际引用的来源更正：${found.source.title}`;
      const mark = element("span", "已更正", "md-link-corrected");
      mark.title = link.title;
      link.after(mark);
    }
  }
  return node;
}
let restoringScroll = false;
function refreshLatestButton() { $("#jump-latest").hidden = state.scrollState.followLatest !== false; }
function captureConversationScroll() {
  if (restoringScroll) return;
  const messages = $("#messages"), followLatest = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
  if (followLatest) state.scrollState = { offset: 0, followLatest: true };
  else {
    const anchor = [...messages.children].find(node => node.offsetTop + node.offsetHeight > messages.scrollTop);
    state.scrollState = { messageKey: anchor?.dataset.messageKey, offset: anchor ? messages.scrollTop - anchor.offsetTop : messages.scrollTop, followLatest: false };
  }
  refreshLatestButton(); queueTaskUiSave();
}
function restoreConversationScroll(messages = $("#messages")) {
  restoringScroll = true;
  if (state.scrollState.followLatest !== false) messages.scrollTop = messages.scrollHeight;
  else {
    const anchor = [...messages.children].find(node => node.dataset.messageKey === state.scrollState.messageKey);
    messages.scrollTop = anchor ? anchor.offsetTop + state.scrollState.offset : state.scrollState.offset;
  }
  requestAnimationFrame(() => { restoringScroll = false; });
  refreshLatestButton();
}
function renderConversation() {
  const current = task(); if (!current) return;
  placedApprovalIds.clear();
  renderMcpLabel();
  $("#task-title").textContent = current.title;
  // A long turn and a hung one look identical when the label just says
  // 进行中, so a running task says how long it has been running. The watchdog
  // that would stop it counts from the last sign of life, not from here.
  $("#task-status").textContent = state.tab === "media" ? "媒体工作区"
    : RUNNING_STATUSES.has(current.status) ? `${statuses[current.status]} · ${elapsed(current.startedAt ?? current.updatedAt)}`
    : statuses[current.status] || "";
  const messages = $("#messages");
  // A coding task reads the way Codex and Claude Code show a turn: the Agent's
  // words and its steps in the order they happened (coding-timeline.js).
  if (current.mode === "coding") {
    messages.replaceChildren(...renderCodingTurns(current));
    restoreConversationScroll(messages);
    $("#activity-panel").hidden = true;
    const plan = document.querySelector("#task-plan"); if (plan) plan.hidden = true;
    renderApprovalsAndActions(current);
    return;
  }
  // Work answers keep their existing proposal and source controls. Their
  // messages are then placed into the same factual turn model as the activity,
  // with business-language steps between the words where they happened.
  const shown = joinSplitAnswers(current.messages, current.activity);
  const rendered = shown.map((item, index) => {
    const node = element("div", undefined, `message ${item.role}${item.agent ? " subagent" : ""}`);
    node.dataset.messageKey = `message:${item.id ?? `${item.role}:${item.seq ?? index}`}`;
    // A subagent's words are its own, labelled with its task name, never the Agent's.
    if (item.role === "assistant") node.append(element("span", item.agent ? `子 agent · ${item.agent.replace(/^\/root\//, "")}` : "i豆", "author"));
    // Not a turn and not an answer: something the application needs the person
    // to know, said where they are reading.
    if (item.role === "notice") node.append(element("span", "需要你核查", "author"));
    if (item.context) node.append(element("span", contextPresentation(item.context), "context-reference"));
    if (item.role === "user" && item.steered) node.append(element("span", "运行中补充", "context-reference steer-reference"));
    if (item.mentions?.length) node.append(element("span", `@ 的对象：${item.mentions.map(entry => entry.kind === "group" ? `${entry.name}（群）` : `${entry.name}${entry.department ? ` · ${entry.department}` : ""}`).join("、")}`, "context-reference"));
    if (item.references?.length) node.append(element("span", `引用：${item.references.map(reference => reference.kind === "diff" ? `${reference.path} · ${reference.side === "old" ? "旧" : "新"}侧第 ${reference.startLine}${reference.endLine === reference.startLine ? "" : `–${reference.endLine}`} 行 · ${reference.revision.slice(0, 8)} · ${reference.comment}` : reference.kind === "page" ? `${reference.title} · ${reference.address} · ${reference.revision.slice(0, 8)}` : reference.path).join("、")}`, "context-reference"));
    if (item.skill) node.append(element("span", `${String(item.skill.id ?? "").startsWith("local-") ? "本机技能" : "企业技能"}：${item.skill.title} · ${item.skill.version}`, "context-reference"));
    // A steer belongs to the question already running. It may add words, but it
    // cannot replace the original question's source evidence.
    const asked = shown.slice(0, index).findLast(message => message.role === "user" && !message.steered);
    const context = asked?.context;
    let proposal;
    if (item.role === "assistant" && context?.kind === "feishu-document" && context.intent === "propose-edit") {
      try { const value = JSON.parse(item.text); if (value.kind === "feishu-text-edit" && typeof value.replacement === "string") proposal = value; } catch {}
    }
    if (proposal) {
      const diff = element("section", undefined, "document-proposal");
      const status = item.documentEdit?.state === "verified" ? `已写回并读取核验 · 版本 ${item.documentEdit.revision}` : item.documentEdit ? "已有写入尝试 · 结果待核查，不会重试" : "修改建议 · 尚未写入";
      diff.append(element("strong", status), element("small", "原文"), element("pre", context.selection?.text || context.text), element("small", "建议替换为"), element("pre", proposal.replacement || "（删除选中文字）")); node.append(diff);
    } else if (item.role === "assistant" && context?.kind === "feishu-sheet" && context.intent === "propose-edit") {
      const panel = renderSheetProposal(item.text, context, element); node.append(panel);
      if (panel.dataset.valid === "true") {
        const record = item.sheetEdit, undo = record?.undo, undoable = undoableSheetEdit(record) && !undo;
        const cell = value => value === null ? "空单元格" : `${typeof value === "string" ? "文本" : typeof value === "number" ? "数字" : "布尔"} ${JSON.stringify(value)}`;
        const describe = (entry, offered) => entry.state === "verified" ? `已写入并逐格读回核验 · 版本 ${entry.revision}`
          : entry.state === "conflict" ? `已写入，但期间有其他修改（版本 ${entry.revision}），请到飞书核查原表`
          : entry.state === "mismatch" ? `已写入 · 版本 ${entry.revision}，但飞书存下的值与确认的不同：${(entry.differences ?? []).slice(0, 5).map(difference => `${difference.address} 确认为${cell(difference.expected)}，读回为${cell(difference.actual)}`).join("；")}${offered ? "" : "。请到飞书核查原表"}`
          : "已有写入尝试 · 结果待核查，不会重试";
        // Sent to Feishu only when there is no way back from here, before an undo or after one.
        if (record) node.append(element("small", describe(record, undoableSheetEdit(record)), "sheet-edit-status"));
        if (undo) node.append(element("small", `撤销：${describe(undo, false)}`, "sheet-edit-status"));
        const control = (label, className, call, blocked) => {
          const button = element("button", label, className);
          button.disabled = blocked || busy() || applyingSheetEdit;
          button.onclick = () => action(async () => {
            const id = state.taskId, epoch = viewEpoch; applyingSheetEdit = true; renderConversation();
            try {
              const result = await call(id);
              if (result && id === state.taskId && epoch === viewEpoch && state.tab === "files") await loadSheet(result.sourceUrl, { sheetId: result.sheetId, range: context.range });
            } finally { applyingSheetEdit = false; renderConversation(); }
          });
          node.append(button);
        };
        if (!record) control("核对并写入飞书表格", "apply-sheet-edit", id => api.applySheetEdit(id, item.id),
          state.sheet?.resourceId !== context.resourceId || state.sheet?.sheetId !== context.sheetId || state.sheet?.sourceRevision !== context.sourceRevision);
        else if (undoable) control("撤销这次写入", "undo-sheet-edit", id => api.undoSheetEdit(id, item.id), false);
      }
    } else if (item.role === "assistant" && context?.kind === "feishu-base" && context.intent === "propose-edit") {
      const panel = renderBaseProposal(item.text, context, element); node.append(panel);
      if (panel.dataset.valid === "true") {
        const record = item.baseEdit, undo = record?.undo, undoable = undoableBaseEdit(record) && !undo, latest = undo ?? record;
        const cell = value => value === null || value === undefined ? "空" : `${typeof value === "string" ? "文本" : "数字"} ${JSON.stringify(value)}`;
        const differences = entry => (entry.differences ?? []).slice(0, 5).map(difference => difference.stale ? `${difference.record}「${difference.field}」读回仍是写入前的${cell(difference.actual)}`
          : `${difference.record}「${difference.field}」确认为${cell(difference.expected)}，读回为${difference.missing ? "（记录已不在）" : cell(difference.actual)}`).join("；");
        const describe = (entry, offered) => entry.state === "verified" ? (entry.checkedAt ? "已写入，重新读回核验通过" : "已写入并逐条读回核验")
          : entry.state === "mismatch" ? `已写入，但读回与确认的不同：${differences(entry)}${entry.ignored?.length ? `；飞书忽略了字段：${entry.ignored.join("、")}` : ""}${offered ? "" : "。请到飞书核查多维表格"}`
          : entry.state === "unknown" && entry.differences?.some(difference => difference.stale) ? `飞书已回执写入，但读回一直是写入前的值：${differences(entry)}。多维表格的读取可能比写入慢，暂时无法确认是否生效，可以稍后重新读回核对`
          : "已有写入尝试 · 结果待核查，不会重试";
        // Sent to Feishu only when there is no way back from here, before an undo or after one.
        if (record) node.append(element("small", describe(record, undoableBaseEdit(record)), "sheet-edit-status"));
        if (undo) node.append(element("small", `撤销：${describe(undo, false)}`, "sheet-edit-status"));
        if (applyingBaseEdit === item.id) node.append(element("small", "处理中…飞书的多维表格读回偶尔要多等十几秒", "sheet-edit-status"));
        const control = (label, className, call, blocked) => {
          const button = element("button", label, className);
          button.disabled = Boolean(blocked || busy() || applyingBaseEdit);
          button.onclick = () => action(async () => {
            const id = state.taskId, epoch = viewEpoch; applyingBaseEdit = item.id; renderConversation();
            try {
              const result = await call(id);
              if (result && id === state.taskId && epoch === viewEpoch && state.tab === "files") await loadBase(result.sourceUrl, { tableId: result.tableId, offset: context.offset });
            } finally { applyingBaseEdit = false; renderConversation(); }
          });
          node.append(button);
        };
        if (!record) control("核对并写入飞书多维表格", "apply-sheet-edit apply-base-edit", id => api.applyBaseEdit(id, item.id),
          state.base?.resourceId !== context.resourceId || state.base?.sourceRevision !== context.sourceRevision);
        else if (undoable) control("撤销这次写入", "undo-sheet-edit undo-base-edit", id => api.undoBaseEdit(id, item.id), false);
        // Only reads, for a write whose read-back left its outcome open or different.
        if (latest && !undoable && ["unknown", "mismatch"].includes(latest.state)) control("重新读回核对", "recheck-base-edit", id => api.recheckBaseEdit(id, item.id), false);
      }
    } else node.append(item.role === "assistant" ? replyNode(item.text, asked?.knowledge?.sources) : element("div", item.text, "message-text"));
    if (item.role === "assistant" && context?.kind === "feishu-document" && context.intent === "propose-edit") {
      const button = element("button", "核对并应用到飞书文档", "apply-document-edit");
      button.disabled = Boolean(item.documentEdit) || busy() || applyingDocumentEdit || state.document?.resourceId !== context.resourceId || state.document?.sourceRevision !== context.sourceRevision;
      button.onclick = () => action(async () => {
        const id = state.taskId, epoch = viewEpoch; applyingDocumentEdit = true; renderConversation();
        try {
          const result = await api.applyDocumentEdit(id, item.id);
          if (result && id === state.taskId && epoch === viewEpoch && state.tab === "files") {
            await loadDocument(result.sourceUrl);
            if (id === state.taskId && state.document?.sourceRevision === result.revision) $("#document-meta").append(element("p", `本次修改已写回并读取验证 · 版本 ${result.revision}`, "document-edit-success"));
          }
        } finally { applyingDocumentEdit = false; renderConversation(); }
      }); node.append(button);
    }
    // Under the answer, not under every step: the sources belong to what the
    // turn concluded, and a step is not a conclusion.
    if (item.role === "assistant" && shown[index + 1]?.role !== "assistant" && asked?.knowledge?.sources?.length) {
      const sources = answerSources(item.text, asked.knowledge.sources, (url) => action(() => loadDocument(url)), { unavailable: asked.knowledge.unavailable ?? 0 });
      if (sources) node.append(sources);
    }
    if (item.role === "assistant" && shown[index + 1]?.role !== "assistant") {
      const note = knowledgeStatus(asked?.knowledge);
      // A source card already names the partially unavailable documents. Keep
      // the explicit note for a failed or empty lookup, without saying the
      // same partial result twice below one answer.
      if (note && (!asked?.knowledge?.sources?.length || asked.knowledge.failed)) node.append(element("p", note, "knowledge-status answer-knowledge-status"));
    }
    return node;
  });
  messages.replaceChildren(...renderCoworkTurns(current, shown, rendered));
  restoreConversationScroll(messages);
  $("#activity-panel").hidden = true;
  const plan = document.querySelector("#task-plan"); if (plan) plan.hidden = true;
  renderApprovalsAndActions(current);
}
// One coding turn after another, each laid out as it happened (coding-timeline.js):
// the person's request, then the Agent's words and its steps in order -- what
// it browsed, the commands it ran and how they ended, each file it changed with
// its diff, its plan -- and, once the turn is over, how long it took and what
// it changed. Codex and Claude Code show a turn this way; the record used to be
// a separate list under the whole conversation.
// The images a message was sent with, read back once each and then kept.
const imageLoads = new Map();
function sentImages(taskId, images) {
  const row = element("div", undefined, "message-images");
  for (const image of images) {
    const picture = element("img"); picture.alt = "随消息发送的图片";
    if (!imageLoads.has(image.id)) imageLoads.set(image.id, api.taskImage(taskId, image.id));
    imageLoads.get(image.id).then((data) => { picture.src = data; }, () => { imageLoads.delete(image.id); picture.alt = "图片已经不在了"; });
    row.append(picture);
  }
  return row;
}
const coworkMessageKey = (message) => `${message?.id ?? `${message?.role}:${message?.seq ?? "legacy"}`}:${message?.seq ?? "legacy"}:${message?.lastSeq ?? message?.seq ?? "legacy"}`;
function renderCoworkTurns(current, shown, rendered) {
  const messageNodes = new Map(shown.map((message, index) => [coworkMessageKey(message), rendered[index]]));
  const turns = coworkTurns(current), running = busy(), runningTurn = [...turns].reverse().find((turn) => !turn.legacy);
  const relative = (value) => typeof value === "string" && current.cwd && value.startsWith(`${current.cwd}/`) ? value.slice(current.cwd.length + 1) : value;
  const technical = (node, work) => {
    const details = element("section", undefined, "work-technical");
    details.append(element("strong", "技术详情"));
    if (work.details.command) details.append(element("code", work.details.command));
    if (work.details.commands?.length) for (const row of work.details.commands) {
      if (row.command) details.append(element("code", row.command));
      if (row.output) details.append(element("pre", row.output));
    }
    if (work.details.files?.length) {
      const list = element("ul"); for (const file of work.details.files) list.append(element("li", relative(file))); details.append(list);
    }
    if (work.details.output) details.append(element("pre", work.details.output));
    if (details.childElementCount > 1) node.append(details);
  };
  return turns.flatMap((turn) => {
    const nodes = [];
    if (turn.message) {
      const asked = messageNodes.get(coworkMessageKey(turn.message));
      if (asked) {
        if (!running) {
          const opened = turns.filter((item) => item.message), count = opened.length - opened.indexOf(turn), back = element("button", "回到这里…", "rewind-here"); back.type = "button";
          back.disabled = count > 50;
          back.title = count > 50 ? "当前最多撤回 50 轮；这条对话已超出可撤回范围" : "只撤回这一轮和它之后的对话；不会撤销本地成果、飞书修改或已经发送的内容";
          back.onclick = () => action(() => rewindTo(count, turn.message.text));
          asked.append(back);
        }
        nodes.push(asked);
      }
    }
    const body = element("section", undefined, `work-turn${turn.legacy ? " work-turn-legacy" : ""}`);
    body.dataset.messageKey = `turn:${turn.key}`;
    body.append(element("span", turn.legacy ? "早期执行记录" : "i豆", "author"));
    const stepKey = (entry) => `${current.id}:${turn.key}:work:${entry.entry?.id ?? entry.kind}`;
    for (const entry of turn.entries) {
      if (["text", "steer", "notice"].includes(entry.kind)) {
        const message = messageNodes.get(coworkMessageKey(entry.message));
        if (message) body.append(message);
        continue;
      }
      if (entry.kind === "plan") {
        const summary = planSummary(entry.entry), plan = element("section", undefined, "work-plan"), list = element("ol");
        for (const step of summary.steps) list.append(element("li", `${step.mark} ${step.step}`, `plan-${step.status}`));
        plan.append(element("strong", `计划 · 已完成 ${summary.completed}/${summary.total}`), ...(entry.entry.explanation ? [element("p", entry.entry.explanation)] : []), list);
        body.append(plan); continue;
      }
      const work = entry.work;
      if (!work) continue;
      const row = element("details", undefined, `work-step ${work.tone}`), summary = element("summary");
      row.open = stepOpen.has(stepKey(entry)) ? stepOpen.get(stepKey(entry)) : work.open;
      row.ontoggle = () => { stepOpen.set(stepKey(entry), row.open); queueTaskUiSave(); };
      summary.append(element("span", work.title, "work-step-title"));
      if (work.target) summary.append(element("span", work.target, "work-step-target"));
      summary.append(element("span", work.state, "work-step-state"));
      if (Number.isFinite(entry.entry?.durationMs)) summary.append(element("span", elapsedText(entry.entry.durationMs), "work-step-duration"));
      if (work.automatic) summary.append(element("span", "只读检索，自动允许", "work-step-auto"));
      row.append(summary); technical(row, work); body.append(row, ...approvalsForStep(current, turn, entry));
    }
    const last = turn === runningTurn;
    if (!turn.legacy && turn.summary) {
      const lead = turn.summary.status === "interrupted" ? "已停止" : turn.summary.status === "failed" ? "未完成" : "完成";
      const result = turn.result, parts = [`${lead} · 用时 ${elapsedText(turn.summary.elapsed)}`];
      if (result.files.length) parts.push(`生成或更新 ${result.files.length} 个文件`);
      if (result.verifiedWrites) parts.push(`核验 ${result.verifiedWrites} 项飞书写入`);
      if (result.uncertainWrites) parts.push(`${result.uncertainWrites} 项结果待核对`);
      const footer = element("footer", parts.join(" · "), `work-turn-summary${result.uncertainWrites ? " warn" : ""}`);
      if (result.files.length) {
        const open = element("button", "查看本轮成果", "work-result-open"); open.type = "button";
        open.onclick = () => action(async () => { clearDocument(); state.file = null; await switchTab("files"); const first = relative(result.files[0]); if (first) await loadFile(first); });
        footer.append(" ", open);
      }
      body.append(footer);
      if (result.deliverables.length) {
        const cards = element("section", undefined, "work-deliverables"); cards.setAttribute("aria-label", "本轮成果");
        for (const item of result.deliverables) {
          const card = element("article", undefined, `work-deliverable ${item.kind} ${item.state}`);
          card.append(element("span", item.kind === "local" ? "本机" : "飞书", "work-deliverable-kind"), element("strong", item.title), element("small", item.detail));
          cards.append(card);
        }
        body.append(cards);
      }
    } else if (!turn.legacy && last && running) body.append(element("footer", `进行中 · ${elapsed(current.startedAt ?? current.updatedAt)}`, "work-turn-summary live"));
    if (body.childElementCount > 1 || (last && running)) nodes.push(body);
    return nodes;
  });
}
function renderCodingTurns(current) {
  const shown = (value) => typeof value === "string" && current.cwd && value.startsWith(`${current.cwd}/`) ? value.slice(current.cwd.length + 1) : value;
  const foldable = (key, className, fallback) => {
    const node = element("details", undefined, `coding-step ${className}`);
    node.open = stepOpen.has(key) ? stepOpen.get(key) : fallback;
    node.ontoggle = () => { stepOpen.set(key, node.open); queueTaskUiSave(); };
    return node;
  };
  const verb = (text) => element("span", text, "step-verb");
  const by = (entry) => entry.agent ? [element("span", `子 agent ${entry.agent.replace(/^\/root\//, "")}`, "step-agent")] : [];
  const kinds = { add: "新增", delete: "删除", update: "修改" };
  const turns = codingTurns(current), running = busy();
  const runningTurn = [...turns].reverse().find((turn) => !turn.legacy);
  return turns.flatMap((turn) => {
    const nodes = [];
    if (turn.message) {
      const asked = element("div", undefined, "message user");
      const message = turn.message;
      asked.dataset.messageKey = `message:${message.id ?? turn.key}`;
      if (message.context) asked.append(element("span", `引用：${message.context.title || message.context.path}${message.context.selection ? ` · 第 ${message.context.selection.startLine}–${message.context.selection.endLine} 行` : ""}`, "context-reference"));
      if (message.references?.length) asked.append(element("span", `引用：${message.references.map(reference => reference.kind === "diff" ? `${reference.path} · ${reference.side === "old" ? "旧" : "新"}侧第 ${reference.startLine}${reference.endLine === reference.startLine ? "" : `–${reference.endLine}`} 行 · ${reference.revision.slice(0, 8)} · ${reference.comment}` : reference.kind === "page" ? `${reference.title} · ${reference.address} · ${reference.revision.slice(0, 8)}` : reference.path).join("、")}`, "context-reference"));
      if (message.skill) asked.append(element("span", `${String(message.skill.id ?? "").startsWith("local-") ? "本机技能" : "企业技能"}：${message.skill.title} · ${message.skill.version}`, "context-reference"));
      if (message.command) asked.append(element("span", `项目命令：/${message.command.name} · ${message.command.source}`, "context-reference"));
      asked.append(element("div", message.text, "message-text"));
      if (message.images?.length) asked.append(sentImages(current.id, message.images));
      // Back to before this turn, as Claude Code's rewind and Codex's Esc Esc.
      if (!running) {
        const opened = turns.filter((item) => item.message);
        const back = element("button", "回到这里", "rewind-here"); back.type = "button";
        back.title = "撤回这一轮和它之后的对话，可以选择是否恢复文件；这一轮说的话会回到输入框";
        back.onclick = () => action(() => rewindTo(opened.length - opened.indexOf(turn), message.text));
        asked.append(back);
      }
      nodes.push(asked);
    }
    const body = element("div", undefined, `coding-turn${turn.legacy ? " coding-turn-legacy" : ""}`);
    body.dataset.messageKey = `turn:${turn.key}`;
    body.append(element("span", turn.legacy ? "早期执行记录" : "i豆", "author"));
    const stepKey = (kind, identity) => `${current.id}:${turn.key}:${kind}:${identity}`;
    for (const entry of turn.entries) {
      if (entry.kind === "text") {
        const words = element("div", undefined, `coding-text${entry.message.agent ? " subagent" : ""}`);
        if (entry.message.agent) words.append(element("span", `子 agent · ${entry.message.agent.replace(/^\/root\//, "")}`, "step-agent"));
        words.append(replyNode(entry.message.text));
        body.append(words);
      } else if (entry.kind === "steer") {
        body.append(element("div", `你补充：${entry.message.text}`, "coding-steer"));
      } else if (entry.kind === "notice") {
        body.append(element("div", entry.message.text, "message notice"));
      } else if (entry.kind === "explore") {
        const node = foldable(stepKey("explore", entry.commands[0].id), "explore", false);
        const summary = element("summary"); summary.append(verb(entry.commands.some((command) => command.status === "inProgress") ? "正在浏览" : "已浏览"), element("span", exploreSummary(entry.commands), "step-target"));
        const list = element("ul", undefined, "explore-lines");
        for (const line of exploreLines(entry.commands)) list.append(element("li", line));
        node.append(summary, list);
        body.append(node);
      } else if (entry.kind === "command") {
        const item = entry.entry, failed = item.status === "failed" || (Number.isInteger(item.exitCode) && item.exitCode !== 0);
        const state = item.status === "inProgress" ? "运行中…" : item.status === "withdrawn" ? "已撤销" : item.status === "declined" ? "已拒绝" : failed ? `失败${Number.isInteger(item.exitCode) ? ` · 退出码 ${item.exitCode}` : ""}` : "成功";
        const node = foldable(stepKey("command", item.id), `command${failed ? " failed" : ""}`, failed);
        const summary = element("summary");
        summary.append(verb(item.status === "inProgress" ? "正在运行" : "运行"), element("code", entry.command, "step-target"),
          element("span", state, `step-state${failed ? " bad" : item.status === "inProgress" ? " live" : " ok"}`),
          ...(Number.isFinite(item.durationMs) ? [element("span", elapsedText(item.durationMs), "step-duration")] : []), ...by(item),
          ...(item.ruled ? [element("span", "按记住的规则允许", "step-agent")] : []),
          ...(item.knowledgeRead ? [element("span", "只读检索，自动允许", "step-agent")] : []));
        node.append(summary, element("pre", item.output || (item.status === "inProgress" ? "等待输出…" : "（没有输出）"), "activity-output"));
        body.append(node);
      } else if (entry.kind === "change") {
        for (const file of entry.files) {
          const lines = String(file.diff ?? "").replace(/\n$/, "").split("\n");
          const node = foldable(stepKey("change", `${entry.entry.id}:${file.path}`), "change", lines.length <= 40);
          const summary = element("summary");
          summary.append(verb(kinds[file.kind] ?? "修改"), element("code", `${shown(file.path)}${file.movedTo ? ` → ${shown(file.movedTo)}` : ""}`, "step-target"),
            element("span", `+${file.added}`, "diff-count add"), element("span", `−${file.removed}`, "diff-count remove"),
            ...(["declined", "withdrawn"].includes(entry.entry.status) ? [element("span", entry.entry.status === "withdrawn" ? "已撤销" : "已拒绝", "step-state bad")] : entry.entry.status === "failed" ? [element("span", "未应用", "step-state bad")] : []), ...by(entry.entry));
          if (turn.message && !turn.legacy) {
            const inspect = element("button", "在侧栏查看", "turn-diff-open"); inspect.type = "button";
            inspect.onclick = (event) => { event.preventDefault(); event.stopPropagation(); void action(() => openDiffPanel({ scope: "turn", turnKey: turn.message.id, path: file.path })); };
            summary.append(inspect);
          }
          const diff = element("pre", undefined, "activity-diff");
          for (const line of lines.slice(0, 400)) diff.append(element("span", `${line}\n`, line.startsWith("@@") ? "diff-hunk" : line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-remove" : undefined));
          if (lines.length > 400) diff.append(element("span", `…还有 ${lines.length - 400} 行未显示\n`, "diff-hunk"));
          node.append(summary, diff);
          body.append(node);
        }
      } else if (entry.kind === "plan") {
        const plan = entry.entry, summary = planSummary(plan), node = element("div", undefined, "coding-step plan");
        const list = element("ol");
        for (const step of summary.steps) list.append(element("li", `${step.mark} ${step.step}`, `plan-${step.status}`));
        node.append(verb(`计划 · 已完成 ${summary.completed}/${summary.total}`), ...(plan.explanation ? [element("p", plan.explanation)] : []), list);
        body.append(node);
      } else if (entry.kind === "mcp") {
        const node = element("div", undefined, "coding-step");
        node.append(verb("调用"), element("code", `${entry.entry.server} / ${entry.entry.tool}`, "step-target"), element("span", entry.entry.status === "failed" ? "失败" : entry.entry.status === "withdrawn" ? "已撤销" : entry.entry.status === "inProgress" ? "进行中…" : "完成", "step-state"), ...by(entry.entry),
          ...(entry.entry.allowed ? [element("span", entry.entry.allowed, "step-agent")] : []));
        body.append(node);
      } else if (entry.kind === "subagent") {
        const node = element("div", undefined, "coding-step");
        node.append(verb("派生子 agent"), element("span", String(entry.entry.agent ?? "").replace(/^\/root\//, ""), "step-target"));
        body.append(node);
      } else if (entry.kind === "legacy") {
        const item = entry.entry;
        body.append(element("div", `${item.type || "旧步骤"} · ${item.status === "completed" ? "完成" : item.status === "failed" ? "失败" : item.status === "declined" ? "已拒绝" : item.status === "inProgress" ? "进行中" : "状态未知"}`, "coding-step legacy"));
      }
      body.append(...approvalsForStep(current, turn, entry));
    }
    // Codex closes a turn with "Worked for 45s"; this says it, and what changed.
    const last = turn === runningTurn;
    if (turn.summary) {
      const { elapsed: took, status, files, added, removed } = turn.summary;
      const lead = status === "interrupted" ? "已停止" : status === "failed" ? "未完成" : "完成";
      const footer = element("div", `${lead} · 用时 ${elapsedText(took)}${files ? ` · 改动 ${files} 个文件 +${added} −${removed}` : ""}`, "coding-turn-summary");
      if (files && turn.message && !turn.legacy) {
        const inspect = element("button", "查看本轮改动", "turn-diff-open"); inspect.type = "button";
        inspect.onclick = () => action(() => openDiffPanel({ scope: "turn", turnKey: turn.message.id })); footer.append(" ", inspect);
      }
      body.append(footer);
    } else if (last && running) body.append(element("div", `进行中 · ${elapsed(current.startedAt ?? current.updatedAt)}`, "coding-turn-summary live"));
    if (body.childElementCount > 1 || (last && running)) nodes.push(body);
    return nodes;
  });
}
// A Codex approval carries a task/turn/item identity from TaskService. It is
// rendered beside that exact step when the step exists; an early request or an
// old record with incomplete identity stays in the task-level area. Repaints
// replace nodes but never duplicate an id.
const placedApprovalIds = new Set(), respondingApprovalIds = new Set();
function renderApprovalCard(item, current) {
    const box = element("section", undefined, `approval${respondingApprovalIds.has(item.id) ? " responding" : ""}`);
    box.dataset.approvalId = item.id;
    const presentation = approvalPresentation(item, current.mode);
    if (item.kind === "question") {
      box.append(element("strong", presentation.title), element("p", item.reason));
      for (const question of item.questions) {
        const key = `${item.id}\n${question.id}`, group = element("fieldset", undefined, "approval-question");
        group.append(element("legend", question.header || "问题"), element("p", question.question));
        for (const option of question.options) {
          const label = element("label", undefined, "approval-option"), radio = element("input");
          radio.type = "radio"; radio.name = key; radio.checked = questionDrafts.get(key) === option.label;
          radio.onchange = () => questionDrafts.set(key, option.label);
          label.append(radio, element("span", option.label), ...(option.description ? [element("small", option.description)] : []));
          group.append(label);
        }
        if (question.isOther) {
          const own = element("input"); own.type = "text"; own.placeholder = question.options.length ? "或者写下你的回答" : "写下你的回答";
          if (!question.options.some((option) => option.label === questionDrafts.get(key))) own.value = questionDrafts.get(key) ?? "";
          own.oninput = () => questionDrafts.set(key, own.value);
          group.append(own);
        }
        box.append(group);
      }
      const reply = (answers) => action(async () => {
        respondingApprovalIds.add(item.id); renderConversation();
        try { await api.answer(item.id, answers); for (const question of item.questions) questionDrafts.delete(`${item.id}\n${question.id}`); }
        finally { respondingApprovalIds.delete(item.id); }
      });
      const send = element("button", "回答"), skip = element("button", "不回答");
      send.disabled = skip.disabled = respondingApprovalIds.has(item.id);
      send.onclick = () => reply(Object.fromEntries(item.questions.map((question) => [question.id, String(questionDrafts.get(`${item.id}\n${question.id}`) ?? "").trim()])));
      skip.onclick = () => reply({});
      box.append(send, skip, ...(respondingApprovalIds.has(item.id) ? [element("small", "处理中…", "approval-state")] : []));
      return box;
    }
    box.append(element("strong", presentation.title), ...(presentation.target ? [element("span", presentation.target, "approval-target")] : []), element("p", item.reason));
    if (presentation.detail && current.mode === "cowork") {
      const technical = element("details", undefined, "approval-technical");
      technical.append(element("summary", "技术详情"), element("pre", presentation.detail)); box.append(technical);
    } else if (presentation.detail) box.append(element("pre", presentation.detail));
    box.append(element("small", item.cwd));
    // 本轮同类都允许 reaches no further than this turn: every turn runs in its own
    // Codex process. What is remembered for the project (Claude Code's "don't ask
    // again … in this project") is named on the button, word for word. An MCP
    // card offers the same only where the turn's permission allows one answer to
    // cover more -- an application for 电脑操作, a built-in connector, one tool
    // -- and names exactly what it covers (mcp-approval-policy.js).
    for (const [decision, label] of item.kind === "mcp" ? [["accept", "允许这一次"], ...(item.grant ? [["acceptForSession", item.grant]] : []), ["decline", "拒绝"]] : [["accept", "允许这一次"], ["acceptForSession", "本轮同类都允许"],
      ...(item.remember ? [["acceptAndRemember", `以后这个项目里都允许「${item.remember.join(" ")}」`]] : []), ["decline", "拒绝"]]) {
      const button = element("button", label); button.disabled = respondingApprovalIds.has(item.id);
      button.onclick = () => action(async () => {
        respondingApprovalIds.add(item.id); renderConversation();
        try { await api.approve(item.id, decision); } finally { respondingApprovalIds.delete(item.id); }
      }); box.append(button);
    }
    // Codex's "No, and tell Codex what to do differently", Claude Code's "No,
    // and tell Claude what to do differently": decline this step, and what the
    // person writes reaches the Agent as it carries on.
    if (item.kind !== "mcp") {
      const redirect = element("button", "拒绝，并告诉它怎么做", "approval-redirect");
      const form = element("div", undefined, "approval-feedback"); form.hidden = true;
      const words = element("input"); words.type = "text"; words.placeholder = "比如：别装新依赖，用现有的工具函数";
      const send = element("button", "拒绝并发送");
      redirect.disabled = respondingApprovalIds.has(item.id);
      redirect.onclick = () => { form.hidden = false; redirect.hidden = true; words.focus(); };
      send.onclick = () => action(async () => {
        const said = words.value.trim(), id = item.taskId;
        respondingApprovalIds.add(item.id); renderConversation();
        try { await api.approve(item.id, "decline"); } finally { respondingApprovalIds.delete(item.id); }
        if (!said) return;
        // Into the turn if it is still going; if the refusal ended it, as the next message.
        try { await api.steer(id, said); } catch { await api.send(id, said); }
      });
      words.onkeydown = (event) => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); send.click(); } };
      form.append(words, send);
      box.append(redirect, form);
    }
    if (respondingApprovalIds.has(item.id)) box.append(element("small", "处理中…", "approval-state"));
    return box;
}
function approvalsForStep(current, turn, entry) {
  const ids = entry?.kind === "explore" ? (entry.commands ?? []).map((row) => row.id) : [entry?.entry?.id];
  const cards = [];
  for (const item of state.snapshot.approvals) {
    if (placedApprovalIds.has(item.id)) continue;
    if (!ids.some((itemId) => approvalPlacement(item, { taskId: current.id, turnKey: turn.message?.id, itemId }) === "step")) continue;
    placedApprovalIds.add(item.id); cards.push(renderApprovalCard(item, current));
  }
  return cards;
}
// What waits on the person (approvals and questions) and what they can do to
// the conversation itself (compact, step back). Shared by both layouts.
function renderApprovalsAndActions(current) {
  $("#approvals").replaceChildren(...state.snapshot.approvals.filter((item) => item.taskId === current.id && !placedApprovalIds.has(item.id)).map((item) => renderApprovalCard(item, current)));
  // Compacting and stepping back are operations on the conversation itself, so
  // they are only offered once there is one and while nothing is running.
  const turns = current.messages.filter((message) => message.role === "user" && !message.steered).length;
  $("#task-actions").hidden = !turns;
  // A coding task's working tree, whenever it is wanted (Codex's /diff).
  let review = document.querySelector("#review-changes");
  if (!review) { review = element("button", "查看改动"); review.type = "button"; review.id = "review-changes"; review.onclick = () => action(openDiffPanel); $("#rollback-task").after(review); }
  review.hidden = current.mode !== "coding";
  // 开始做. A coding task reads and plans first; this is the press that ends
  // that and lets it change files. It sits first and looks like the next step,
  // because it is -- and it is absent once the task is building, so nobody has
  // to wonder whether pressing it again does something.
  let begin = document.querySelector("#start-building");
  if (!begin) {
    begin = element("button", "开始做", "primary"); begin.type = "button"; begin.id = "start-building";
    begin.onclick = () => action(() => api.startBuilding(state.taskId));
    $("#task-actions").prepend(begin);
  }
  const planningAfter = Number.isSafeInteger(current.planningAfterSeq) ? current.planningAfterSeq : -1;
  const hasPlan = current.messages.some((message) => message.role === "assistant" && (!Number.isSafeInteger(message.seq) || message.seq > planningAfter));
  const initPlan = current.messages.some((message) => message.role === "user" && message.planningAction === "init"
    && (!Number.isSafeInteger(message.seq) || message.seq > planningAfter));
  const targetPermission = executionPermissionForTask(current);
  const targetLabel = permissionModes.find((mode) => mode.id === targetPermission)?.label ?? targetPermission;
  const beginLabel = initPlan ? "生成 AGENTS.md" : current.planningKind === "explicit" ? "按计划执行" : "开始做";
  begin.textContent = `${beginLabel} · ${targetLabel}`;
  begin.hidden = !(current.stage === "planning" && hasPlan);
  begin.disabled = busy() || state.submitting;
  for (const id of ["#compact-task", "#rollback-task"]) $(id).disabled = busy() || state.submitting;
  $("#rollback-task").hidden = turns < 1;
  // Both task modes use the same Codex thread accounting. A work task needs the
  // same warning before a long office conversation runs out of context.
  const left = contextLeft(current.contextUsage);
  // While planning, say what this stage is instead of counting turns: somebody
  // looking at a plan needs to know that nothing has been changed yet, and that
  // saying more here refines the plan rather than starting the work.
  const planning = current.stage === "planning" && current.mode === "coding";
  $("#task-actions-note").textContent = [
    planning
      ? (begin.hidden ? "先看一遍再动手：这一轮只读，不会改任何文件。"
        : `还没有动任何文件。接着说可以改方案，按「${beginLabel}」才会以${targetLabel}权限开始。`)
      : current.compactedAt
        ? `已在 ${new Date(current.compactedAt).toLocaleString("zh-CN")} 压缩过 · 共 ${turns} 轮`
        : `共 ${turns} 轮对话`,
    left === null ? "" : `上下文剩余 ${left}%`,
  ].filter(Boolean).join(" · ");
  renderComposerState();
  renderPermission();
  renderKnowledgeScope();
  if (current.error) error(taskError(current.error));
}
// The gateway refuses any model but the one it enforces, before any upstream
// call. That happens while this machine has not yet learned the server's model,
// or after the server changed it; the main process asks the server again the
// moment it sees the refusal, so sending once more is the first thing to try.
// A raw status line from Codex would tell the person none of that.
function taskError(message) {
  return /\bmodel_not_allowed\b/.test(message) ? "服务端要求的模型与本机不一致，本次未调用模型、不计费。已重新向服务端确认模型，请再发送一次；仍出现时请重新连接（重新登录飞书，或在「设置 → 模型服务连接」重新选择连接文件）。" : message;
}
function renderMcpLabel() {
  const current = task(), working = ["coding", "cowork"].includes(state.section);
  $("#task-mcp-label").hidden = !working || !current?.mcpConnection;
  $("#task-mcp-label").textContent = current?.mcpConnection ? `MCP：${current.mcpConnection.title} · ${busy() && current.mcpStatus?.length ? "本次工具发现已通过" : "发送时重新检查连接"} · 工具调用按任务权限确认` : "";
}
// The sections that carry a conversation, and therefore a composer and an agent
// panel. render() and placeConfirmations() have to agree on this, so it is
// asked once rather than spelled out in each.
const agentSection = () => ["coding", "cowork", "feishu-docs", "feishu"].includes(state.section);
// A confirmation must be answerable from wherever the person is standing.
// It lives above the composer when there is a conversation on screen -- that
// is where the Agent is talking, and it keeps the document column untouched --
// but sections without one (设置, 技能中心, 企业知识库) have no agent panel and
// would hide it inside a collapsed subtree, leaving an operation with no way
// to answer it. So it moves to a top-level home instead.
// A modal <dialog> is the same problem in its sharpest form: it makes the whole
// page behind it inert, so a card drawn there can be read and never clicked --
// and 应用清单审核 and 应用运行验收 both raise their confirmation from inside one.
// Wherever a modal is open, that is where the card has to be.
function placeConfirmations() {
  const confirmations = $("#confirmations"), modal = document.querySelector("dialog:modal");
  const visible = confirmationVisibleForTask(state.appConfirmation, state.taskId);
  confirmations.hidden = !visible;
  if (!visible) { syncNativeBounds(); return; }
  const agentVisible = agentSection();
  const host = modal || (agentVisible ? $("#composer").parentElement : $("#confirmations-home"));
  if (confirmations.parentElement === host) return;
  if (!modal && agentVisible) host.insertBefore(confirmations, $("#composer"));
  else host.append(confirmations);
}
// Closing a modal would otherwise leave an unanswered card inside it, out of
// sight and out of reach, until the main process times the operation out.
for (const node of document.querySelectorAll("dialog")) node.addEventListener("close", () => { placeConfirmations(); syncNativeBounds(); });
// A temporary result belongs to the media panel of the task it was shown in.
// Leaving that panel by its own tabs took it down (switchTab); leaving the task
// or the section did not, and the result's view stayed on the window, out of
// sight -- its 播放 and 静音 still there for a screen reader (seen while
// recording, 2026-09-23). Whatever the way out, it now goes the same way.
function retireMediaPreview() {
  if (!state.mediaPreview || (state.tab === "media" && state.taskId === state.mediaPreview.taskId)) return;
  state.mediaPreview = false; $("#media-preview-frame").hidden = true;
  void api.closeMediaPreview().catch(() => {});
}
function render() {
  retireMediaPreview();
  renderSidebar();
  const current = task(), working = ["coding", "cowork"].includes(state.section), agentVisible = agentSection();
  renderMcpLabel();
  $("#task-skill-label").hidden = !current?.enterpriseSkill;
  // A skill switched on in 技能中心 is only offered to the Agent, which opens it
  // for a request it describes (task-service.js); one picked for this task is
  // used on every message.
  const skill = current?.enterpriseSkill, shelf = String(skill?.id ?? "").startsWith("local-");
  $("#task-skill-label").textContent = !skill ? "" : shelf
    ? `本机技能：${skill.title} · ${skill.version} · 请求符合它的描述时 Agent 才会打开；在技能中心停用后，新任务不再带它。`
    : `任务技能：${skill.title} · ${skill.version} · 每次发送前复核；不使用此技能请新建任务。`;
  placeConfirmations();
  // Leaving the document section does not always re-render a library section,
  // so the panel is returned here, on whatever path led away from it.
  if (!["feishu-docs", "feishu"].includes(state.section)) undockAgentPanel();
  // Files, documents and the web preview are not places to go any more: they
  // are one panel that opens beside the conversation when there is something to
  // look at, and folds away when there is not. Media and app versions stay
  // tabs, and keep the wider layout they were built for.
  // The same conversation also serves the Feishu document section, where it is
  // docked beside Feishu's own page instead of filling the work area.
  const side = working && Boolean(current) && SIDE_PANEL_TABS.includes(state.tab);
  const split = working && Boolean(current) && state.tab !== "chat" && !side;
  const panelOpen = side && !state.panelCollapsed;
  $("#task-stage").hidden = !working; $("#work-area").hidden = !working;
  $("#work-area").classList.toggle("has-task", Boolean(current));
  $("#work-area").classList.toggle("split", split);
  $("#work-area").classList.toggle("side", panelOpen);
  const layout = applyWorkbenchLayout(panelOpen, working ? current : null);
  const panelShown = panelOpen && (!layout.singlePane || state.mobilePane === "panel");
  // Reading is the point when a document, a sheet or a preview is open: the
  // thing being read takes the wide column and the conversation moves beside
  // it. The old split gave the wide side to an often-empty conversation and
  // squeezed the document into a third of the window.
  // A Feishu document or sheet fills the panel on its own: there is no local
  // file list beside it, and the rows that belong to local files do not apply.
  const feishuOnly = Boolean(state.document || state.sheet || state.base);
  const reading = panelOpen && Boolean(state.document || state.sheet || state.base || state.preview || state.archivePreview);
  $("#work-area").classList.toggle("reading", reading);
  $("#artifact-panel").hidden = !split && !panelOpen; $("#agent-heading").hidden = !split;
  $("#panel-header").hidden = !panelOpen;
  $("#panel-title").textContent = state.tab === "changes" ? "工作目录里的改动" : state.tab === "browser" ? "浏览器预览" : state.tab === "media" ? "图片与视频"
    : state.sheet?.title || state.base?.title || state.document?.title || "任务文件";
  $("#reopen-panel").hidden = !side || !state.panelCollapsed;
  $("#reopen-panel").textContent = `展开${state.tab === "changes" ? "改动" : state.tab === "browser" ? "预览" : state.tab === "media" ? "媒体" : "文件"} ‹`;
  const railToggle = $("#feishu-rail-toggle");
  railToggle.hidden = !["feishu", "feishu-docs"].includes(state.section);
  railToggle.textContent = feishuRailHidden() ? "显示飞书导航栏" : "隐藏飞书导航栏";
  $("#open-files").hidden = !working;
  $("#open-files").setAttribute("aria-pressed", panelShown && state.tab === "files" ? "true" : "false");
  $("#agent-heading strong").textContent = state.tab === "media" ? "与 Agent 讨论创作" : state.archivePreview ? "与 Agent 讨论任务" : "与 Agent 一起修改";
  $("#agent-heading span").textContent = state.tab === "media" ? "在左侧确认生成" : state.archivePreview ? "不自动引用或修改归档版本" : "沿用当前任务对话";
  // The reference top bar: a task title only beside a current conversation, no
  // placeholder anywhere else, and the divider only when there is a title. A
  // page such as 定时任务 has its own toolbar saying what it is.
  const titled = working && Boolean(current);
  $("#section-title").textContent = labels[state.section];
  $("#task-title").textContent = titled ? current.title : ""; $("#task-title").hidden = !titled;
  $(".toolbar .divider").hidden = !titled; $("#task-status").textContent = "";
  $("#task-tools").hidden = !titled;
  $("#workbench-diff").hidden = current?.mode !== "coding";
  $("#workbench-diff").setAttribute("aria-pressed", panelShown && state.tab === "changes" ? "true" : "false");
  $("#workbench-files").setAttribute("aria-pressed", panelShown && state.tab === "files" ? "true" : "false");
  $("#workbench-preview").setAttribute("aria-pressed", panelShown && state.tab === "browser" ? "true" : "false");
  $("#workbench-preview").disabled = !state.file?.canPreview && state.tab !== "browser";
  $("#workbench-preview").title = $("#workbench-preview").disabled ? "先在文件工作区选择一个 HTML 文件" : "打开浏览器预览";
  const terminalVisible = current?.mode === "coding" && state.terminalPanels.has(current.id);
  $("#workbench-terminal").hidden = current?.mode !== "coding";
  $("#workbench-terminal").setAttribute("aria-pressed", terminalVisible ? "true" : "false");
  $("#workbench-terminal").title = terminalVisible ? "收起终端；命令继续运行" : "打开这个任务的终端";
  terminalUi.sync(current, terminalVisible);
  $("#task-tabs").hidden = !working || !current;
  for (const button of document.querySelectorAll("[data-tab]")) {
    // The panel opens beside the conversation rather than replacing it, so the
    // conversation stays the selected tab while a file or preview is showing.
    const active = state.tab === button.dataset.tab || (button.dataset.tab === "chat" && SIDE_PANEL_TABS.includes(state.tab));
    button.setAttribute("aria-current", active ? "page" : "false");
    if (button.dataset.tab === "apps") button.hidden = state.section !== "coding";
    if (button.dataset.tab === "media") button.hidden = current?.mode !== "cowork";
  }
  $("#welcome").hidden = !working || Boolean(current);
  $("#welcome-app-reviews").hidden = state.section !== "coding";
  $("#welcome-app-runtime").hidden = state.section !== "coding";
  $("#media-panel").hidden = !working || !current || state.tab !== "media" || state.panelCollapsed;
  // A work task owns a real folder now — the files a person attached and the
  // results the Agent wrote are both in it — so the list belongs here as much as
  // in a coding task. The single-pane layout is for the one case it was written
  // for: a Feishu document or sheet, which has no local file list to show.
  $("#file-list").hidden = feishuOnly;
  // A Feishu document has no local file list, no file count and nothing to add
  // to, so that whole row goes away and its overflow menu joins the title row.
  // Four stacked strips above the text was most of why it did not read as a
  // document at all.
  const filesHeader = $("#files").querySelector("header"), menu = $(".file-menu-field"), collapse = $("#collapse-panel");
  filesHeader.hidden = feishuOnly;
  if (feishuOnly && menu.parentElement !== $("#file-heading")) $("#file-heading").append(menu);
  if (!feishuOnly && menu.parentElement !== filesHeader) filesHeader.append(menu);
  // The workbench owns closing and returning to the conversation. Keep those
  // controls outside document content so every panel has the same lifecycle.
  if (collapse.parentElement !== $("#panel-header")) $("#panel-header").append(collapse);
  $("#files").classList.toggle("document-only", feishuOnly);
  if (feishuOnly) { $("#files").classList.remove("empty-workspace"); $("#file-empty").hidden = true; }
  $("#files").classList.toggle("work-files", current?.mode === "cowork");
  $("#conversation").hidden = !agentVisible || !current;
  $("#changes-panel").hidden = !working || !current || state.tab !== "changes" || state.panelCollapsed;
  $("#files").hidden = !working || !current || state.tab !== "files" || state.panelCollapsed;
  $("#browser").hidden = !working || !current || state.tab !== "browser" || state.panelCollapsed;
  $("#apps-panel").hidden = !working || !current || state.tab !== "apps";
  $("#library").hidden = working;
  $("#composer").hidden = !agentVisible;
  renderTaskQueue();
  renderComposerState();
  renderPermission();
  renderKnowledgeScope();
  const coding = state.section === "coding";
  renderProjectStep(coding);
  $("#selected-workspace").textContent = coding
    ? (state.draftWorkspace?.unavailable ? "目录已移动或不可用，请重新选择" : state.draftWorkspace?.path ? "" : "也可以直接选一个已经存在的目录")
    : (state.draftWorkspace?.path || "工作文件默认存放在应用目录，无需选择；也可以另选一个本地目录");
  // Choosing a directory is the first step of a coding task and an option for a
  // work task, so it only looks like the primary action for coding.
  $("#pick-workspace").textContent = coding ? (state.draftWorkspace?.unavailable ? "重新选择目录" : state.draftWorkspace ? "改用其他目录" : "选择已有目录") : "改用其他目录";
  $("#pick-workspace").classList.toggle("secondary", true);
  // Wherever the panel is, not only where it lives by default. `working` is the
  // two task sections; the same conversation is also shown docked beside 飞书消息
  // and 飞书文档, and there it was redrawn only when a snapshot happened to
  // arrive. So switching the docked conversation left the previous one on screen
  // -- the state was right, the drawing was stale, and every symptom pointed at
  // the binding instead. Three wrong diagnoses came out of that.
  if (current && agentVisible) renderConversation();
  renderContext();
}
// A coding task is about a directory on this machine. There is no separate
// project to name — the directory's own name is the project's name — so this is
// a list of the directories worked in before, plus the folder picker for
// anything else. Creating a new folder is what the picker's own 新建文件夹 does.
function renderProjectStep(coding) {
  const project = visibleProject(), current = task();
  $("#project-step").hidden = !coding;
  $("#project-chip").hidden = !coding || !project;
  $("#project-chip").disabled = Boolean(current);
  if (coding && project) {
    $("#project-chip").textContent = projectName(project);
    $("#project-chip").title = project.path;
  }
  if (!coding) return;
  const rows = state.recents.some((item) => item.path === project?.path) || !project
    ? state.recents : [project, ...state.recents];
  $("#recent-projects").replaceChildren(...rows.map((project) => {
    const selected = project.path === visibleProject()?.path;
    const row = element("div", undefined, "recent-project");
    row.setAttribute("role", "listitem");
    if (selected) row.setAttribute("aria-current", "true");
    const open = element("button", undefined, "recent-project-open");
    open.type = "button"; open.title = project.path;
    const name = element("span", projectName(project), "project-name"), where = element("span", project.path, "project-path");
    if (selected) { name.id = "project-name"; where.id = "project-path"; }
    open.append(name, where);
    open.onclick = () => action(async () => { state.draftWorkspace = { ...project, unavailable: false }; render(); });
    // Whether the folder is a repository used to be a badge on every row, with
    // an 初始化 Git 仓库 button beside it. Neither reference does that: Codex
    // asks once, when the folder is first trusted (`codex exec` outside one
    // refuses outright -- "Not inside a trusted directory and
    // --skip-git-repo-check was not specified", measured on 0.155.0), and
    // Claude Code never mentions it. Since a folder outside a repository keeps
    // its own snapshots (checkpoints.js), 撤回 works here either way, and the
    // two places that do need a baseline -- 查看改动 and /review -- say so
    // themselves and offer to make one there.
    row.append(open);
    return row;
  }));
}
const projectName = (project) => project.name || project.path.split("/").filter(Boolean).pop() || project.path;
// A long path used to be trimmed by rendering it right-to-left, which keeps the
// end visible but moves the leading "/" to the far side: "/bin/echo hi" was
// shown as "bin/echo hi/". Shortening the middle here keeps both ends, keeps the
// text in its real order, and does not depend on how the box happens to clip.
function shortPath(text, keep = 46) {
  const value = String(text ?? "");
  if (value.length <= keep) return value;
  const parts = value.split("/");
  if (parts.length < 4) return `${value.slice(0, keep - 1)}…`;
  const tail = [];
  for (let index = parts.length - 1; index > 1; index -= 1) {
    tail.unshift(parts[index]);
    if (tail.join("/").length > keep - 12) break;
  }
  return `${parts.slice(0, 2).join("/")}/…/${tail.join("/")}`;
}
function renderContext() {
  if (state.tab === "files") $("#agent-heading strong").textContent = state.sheet ? "与 Agent 一起看表格" : state.base ? "与 Agent 一起看多维表格" : "与 Agent 一起修改";
  $("#prompt").placeholder = state.base && state.tab === "files" ? "询问这一页记录的含义、差异或处理建议…" : state.sheet && state.tab === "files" ? "询问当前范围的数据含义、差异或处理建议…"
    : state.section === "coding" ? "描述要做的改动…（@ 引用文件，/ 查看命令）" : "描述你的任务，或继续提出修改…（@ 选同事或群）";
  const localFile = state.file?.kind === "text" || !state.file?.kind ? state.file : null;
  const source = state.tab === "browser" && state.archivePreview ? null : state.tab === "files" ? state.sheet || state.base || state.document || localFile : localFile;
  const visible = Boolean(task() && source && state.tab !== "chat");
  $("#context-row").hidden = !visible;
  $("#include-context").checked = state.includeContext;
  $("#context-label").textContent = visible ? `${source.title || source.path}${state.sheet ? ` · ${state.sheet.range} · 局部快照` : state.base ? ` · 第 ${state.base.offset + 1}–${state.base.offset + state.base.records.length} 条 · 局部快照` : state.selection ? ` · 已选 ${state.selection.end - state.selection.start} 字` : state.document ? " · 飞书阅读快照" : " · 当前文件"}` : "";
  $("#add-context-reference").hidden = !visible;
  $("#add-context-reference").textContent = state.selection ? "引用选区" : "引用当前内容";
  $("#clear-selection").hidden = !state.selection;
  $("#quote-selection").disabled = !source || Boolean(state.sheet || state.base) || (state.file && state.file.kind !== "text");
  $("#quote-selection").hidden = Boolean(state.sheet || state.base);
  $("#refresh-preview").disabled = (!state.file?.canPreview && !state.archivePreview) || busy();
  $("#preview-back").disabled = !state.previewPage?.canGoBack;
  $("#preview-forward").disabled = !state.previewPage?.canGoForward;
  $("#reference-preview-page").hidden = !state.previewPage?.local;
  // Offered once there is a page to offer: a coding task's own workspace, with
  // something previewed in it. An archive preview is somebody else's version.
  $("#site-from-task").hidden = !(state.preview && !state.archivePreview && task()?.mode === "coding");
  $("#site-from-task").disabled = busy();
  $("#site-from-task").textContent = state.siteFromTask?.taskId === state.taskId ? "去文档网站 ›" : "发布到文档网站";
  $("#close-preview").textContent = state.archivePreview ? "返回应用版本" : "返回文件";
  const previewState = $("#preview-area").dataset.previewState;
  $("#preview-area h2").textContent = state.archivePreview ? previewState === "expired" ? "归档预览已到期" : previewState === "error" ? "归档预览未打开" : "归档版本预览" : "预览你的应用";
  $("#preview-area p").textContent = state.archivePreview ? "刷新将重新读取云盘、核验权限和内容；不会使用工作目录或旧缓存替代。" : "在「任务文件」里选中生成的 HTML，再点「浏览器预览」。";
  $("#preview-area p:last-child").textContent = state.archivePreview ? "这是临时静态快照，不代表安全审查通过或已部署。" : "本地运行与预览已接入；企业发布平台还在开发中。";
  $("#show-local-files").hidden = !state.document && !state.sheet && !state.base;
  const canPropose = state.tab === "files" && state.document && !state.document.partial && state.selection && state.includeContext;
  $("#document-edit-option").hidden = !canPropose;
  if (!canPropose) $("#propose-document-edit").checked = false;
  $("#propose-document-edit").disabled = busy();
  const canProposeSheet = state.tab === "files" && state.sheet && !state.sheet.truncated && state.includeContext;
  $("#sheet-edit-option").hidden = !canProposeSheet;
  if (!canProposeSheet) $("#propose-sheet-edit").checked = false;
  $("#propose-sheet-edit").disabled = busy();
  const canProposeBase = state.tab === "files" && state.base && !state.base.truncated && state.base.records.length > 0 && state.includeContext;
  $("#base-edit-option").hidden = !canProposeBase;
  if (!canProposeBase) $("#propose-base-edit").checked = false;
  $("#propose-base-edit").disabled = busy();
}
function hidePreview() {
  reviewsUi.close();
  runtimeUi.close();
  receptionUi?.dispose(); receptionUi = null;
  publicationUi?.dispose(); publicationUi = null;
  discoveryUi?.dispose(); discoveryUi = null;
  graphUi?.dispose(); graphUi = null;
  viewEpoch += 1; state.preview = false; state.previewPage = null; $("#preview-area").dataset.previewState = "idle";
  // The chat panel this used to follow is gone -- 飞书消息 is Feishu's own
  // embedded view now -- and the reader session expires on its own. Closing it
  // here would also cut a knowledge-discovery watch that is still running.
  // Invalidate pending native opens even before state.feishuView was assigned.
  // This is also used by recent-task navigation, not only sidebar changes.
  return Promise.all([api.hidePreview(), closeFeishuView()]);
}
// Reopening lands in the directory last worked in, without a file dialog, and
// the rest of the list is right there. A work task needs no directory, so this
// is only ever loaded for coding.
async function loadRecentProjects(epoch) {
  const recents = await api.recentWorkspaces().catch(() => []);
  if (epoch !== viewEpoch || state.section !== "coding") return;
  state.recents = recents;
  if (!state.draftWorkspace && !task()) state.draftWorkspace = recents[0] || null;
  render();
}
// Reopening lands where the last session was working. Only the two task
// sections are remembered, so a restart never drops someone into settings, and
// it is a per-machine preference that never leaves this browser profile.
function rememberSection(section) {
  if (!["cowork", "coding"].includes(section)) return;
  try { remember("section", section); } catch { /* a convenience, never a failure */ }
}
function lastSection() {
  try { const value = remembered("section"); return ["cowork", "coding"].includes(value) ? value : "cowork"; }
  catch { return "cowork"; }
}
// Set by a clicked schedule notification, read once by the next 定时任务 render.
let pendingScheduleTab = null, pendingScheduleDraft = null;
async function switchSection(section) {
  closePermissionMenu(); closeKnowledgeMenu();
  state.navigationBusy = true; renderSidebar();
  saveDraft(); await flushTaskUi().catch(() => {}); const closing = hidePreview(), epoch = viewEpoch; clearArtifact();
  rememberSection(section);
  if (activeWorkbenchLayout.sidebarOverlay) state.sidebarPreference = "closed";
  state.section = section; state.taskId = null; state.draftPermission = null; state.draftWorkspace = null; state.recents = []; state.tab = "chat";
  // Forgotten on the way out so that coming back re-binds from whatever chat is
  // open then, rather than trusting a key from the last visit.
  state.dockedKey = null;
  // Restored under the key the composer saves under (draftKey). The Feishu
  // sections dock the 工作任务 composer beside the page, so theirs is the
  // cowork draft; they used to restore nothing, and a draft first typed there
  // after a start was saved against revision 0 -- refused as 「草稿已在其他窗口
  // 更新」 on every keystroke, since the stored draft was further on (2026-09-23).
  if (["coding", "cowork", "feishu", "feishu-docs"].includes(section)) {
    try { await restoreTaskUi(); }
    catch (cause) { state.navigationBusy = false; renderSidebar(); throw cause; }
  } else restoreDraft();
  state.navigationBusy = false; error(""); render();
  // Library sections are distinct destinations, not tabs in one long document.
  // Do not carry a document/site scroll position into the next destination.
  $("#library").scrollTop = 0;
  // What a scheduled task produced belongs beside the rest of the person's
  // work, so opening either section is the moment to go and fetch it. Not
  // awaited: the snapshot it updates arrives on its own channel, and a slow or
  // unreachable control plane must not hold up drawing the section.
  if (["cowork", "schedules"].includes(section)) void api.syncScheduleTasks?.().catch(() => {});
  // Reopening should land where the last coding task left off rather than in a
  // file dialog. A work task needs no directory, so it is never pre-filled.
  if (section === "coding") await loadRecentProjects(epoch);
  await closing;
  if (epoch === viewEpoch && ["sites", "skills", "knowledge", "schedules", "feishu", "feishu-docs", "settings"].includes(section)) await renderLibrary();
}
// The model is whichever one the server enforces, as the main process learned
// it; the vendor rides along for anyone who hovers over the label. Until the
// server has confirmed one the label is 模型未确认 and says why, never a name.
const modelUnconfirmed = () => state.connection.modelConfirmed === false;
function modelName() { return state.connection.modelLabel || state.connection.model || ""; }
function modelPhrase() { return modelUnconfirmed() ? `${modelName()}（${state.connection.modelNotice}）` : [modelName(), state.connection.modelVendor].filter(Boolean).join(" · "); }
// Reading the connection is what has the main process ask an unconfirmed server
// again (at most every 10 s), so it is read again soon rather than leaving
// 模型未确认 up until the 30 s poll. A model this build does not ship needs a
// newer app, not another look.
let modelRecheck = null;
async function updateConnection() {
  state.connection = await api.connection();
  $("#account-name").textContent = state.connection.identity || "未登录";
  $("#connection-state").textContent = state.connection.connected ? "模型网关已连接" : "未连接模型服务";
  $("#model-label").textContent = modelName() ? `${modelName()} · 企业模型网关` : "企业模型网关";
  $("#model-label").title = modelUnconfirmed() ? state.connection.modelNotice || "" : state.connection.modelVendor || "";
  synthesisConsent?.();
  if (!modelRecheck && modelUnconfirmed() && !state.connection.modelUnsupported) modelRecheck = setTimeout(() => { modelRecheck = null; updateConnection().catch(() => {}); }, 10_000);
  if (state.section === "settings" && $("#login-renewal")) {
    const status = await api.authStatus();
    if ($("#login-renewal")) $("#login-renewal").textContent = renewalLabel(status);
    if ($("#login-status")) $("#login-status").textContent = loginSummary(status);
    if ($("#login-begin")) $("#login-begin").disabled = !status.configured || status.renewalState === "renewing";
  }
}
const renewalLabel = status => status.renewalState === "failed"
  ? `自动续期已停止，请重新登录；不会重放未完成操作。${status.renewalFailure ? `原因：${status.renewalFailure}` : ""}`
  : status.renewalState === "reconnecting"
    ? `暂时连不上服务端，稍后会用本机登录凭据自动重连，不用重新扫码。${status.renewalFailure ? `原因：${status.renewalFailure}` : ""}`
    : ({ scheduled: "已启用在线续期；不超过本次飞书授权有效期。", renewing: "正在核验飞书身份并续期…", paused: "登录操作期间已暂停续期，请完成当前登录。",
      recovering: "服务端刚重启过，或电脑睡眠后登录已过期，正在用本机登录凭据自动重连…" })[status.renewalState] || "到期后需重新使用飞书登录。";
// What the app may do in this person's Feishu, said the way they would say it:
// how the CLI bridge works is ours to know, not theirs (2026-09-23). Still
// exact: only the changes the administrator enabled are named as possible,
// and the ones not enabled are named as not yet available.
const feishuReach = identity => {
  if (!identity.cliBridge) return identity.cliIdentityChecks ? "访问飞书内容前，会先核对这台电脑上的飞书命令行登录的是不是你本人。" : "管理员还没有开通飞书内容访问，暂时用不了读写飞书文档和消息的功能。";
  const enabled = [identity.cliDocumentWrites && "修改文档", identity.cliMessageWrites && "发送消息", identity.cliDriveWrites && "上传到云盘", identity.cliDestructiveWrites && "删除"].filter(Boolean);
  const pending = [!identity.cliDocumentWrites && "修改文档", !identity.cliMessageWrites && "发送消息", !identity.cliDriveWrites && "上传到云盘"].filter(Boolean);
  return `i豆 用你的飞书身份读取文档、表格和消息，只能看到你本来就能看的内容。${enabled.length ? `${enabled.join("、")}之前，默认都先请你确认，你点了才执行；把某个任务设成「完全访问」，它就直接做完。${pending.length ? `${pending.join("、")}暂未开放。` : ""}` : "目前只读，不会改动你的飞书内容。"}`;
};
// Names, never identifiers: the people using the app know themselves by name,
// and an open_id or tenant_key tells them nothing (2026-09-23). The one place
// identifiers remain is the administrator's folded block further down.
const loginSummary = status => status.identity ? `${status.identity.displayName || "飞书用户"}${status.renewalState === "failed" ? " · 在线续期未完成，请重新登录" : status.renewalState === "reconnecting" ? " · 正在等待自动重连" : status.expired ? " · 会话已过期，请重新登录" : " · 本次登录有效"}` : "尚未登录飞书账号";
// While a browser authorization is outstanding the app checks for the result by
// itself, so finishing in the browser is enough to reach the account
// confirmation. The confirmation itself stays a deliberate click: it is what
// binds local task data to one Feishu account.
let loginPollTimer = null;
function stopLoginPolling() { clearTimeout(loginPollTimer); loginPollTimer = null; }
function scheduleLoginPolling() {
  stopLoginPolling();
  const epoch = viewEpoch;
  loginPollTimer = setTimeout(async () => {
    if (epoch !== viewEpoch || state.section !== "settings") return stopLoginPolling();
    let next;
    try { next = await api.authPoll(); } catch { return scheduleLoginPolling(); }
    if (epoch !== viewEpoch || state.section !== "settings") return stopLoginPolling();
    if (next.stage === "waiting") return scheduleLoginPolling();
    stopLoginPolling(); await renderLibrary();
  }, 2000);
  loginPollTimer.unref?.();
}
// Where the in-app authorization view should sit, while it exists. Cleared the
// moment the login leaves the stage that owns it, so the view never outlives it.
let loginViewPlacement = null;
async function renderLogin(library) {
  if (loginViewPlacement) { loginViewPlacement = null; await api.closeLoginView().catch(() => {}); }
  const status = await api.authStatus(); if (state.section !== "settings") return;
  if (status.stage === "waiting") scheduleLoginPolling(); else stopLoginPolling();
  const card = element("section", undefined, "login-card"); card.id = "feishu-login";
  card.append(element("h2", "飞书账号"), element("p", "使用飞书确认你的身份。模型密钥和飞书应用密钥保留在服务端。"));
  card.append(element("small", status.configured ? `企业服务端：${status.serverUrl}` : "尚未配置企业服务端。请由管理员设置 IDOU_SERVER_URL；不要在客户端填写应用密钥。"));
  const summary = element("p"); summary.id = "login-status";
  summary.textContent = loginSummary(status);
  card.append(summary);
  const renewal = element("small"); renewal.id = "login-renewal";
  renewal.textContent = renewalLabel(status);
  card.append(renewal);
  const buttons = element("div", undefined, "login-actions");
  let checkNote = null;
  const button = (id, label, fn) => {
    const node = element("button", label); node.id = id;
    node.onclick = () => action(async () => {
      node.disabled = true;
      try { await fn(); }
      catch (cause) {
        // Native auth may have discarded an expired/denied attempt. Reflect that
        // transition even though IPC rejected; never leave stale confirm/poll UI.
        if (state.section === "settings") await renderLibrary().catch(() => {});
        throw cause;
      } finally { node.disabled = false; }
    });
    buttons.append(node); return node;
  };
  if (status.stage === "idle") {
    button("login-begin", status.identity ? "重新登录 / 切换账号" : "使用飞书登录", async () => { await api.authBegin(); await renderLibrary(); }).disabled = !status.configured || status.renewalState === "renewing";
    if (status.identity) button("login-logout", "退出此账号", async () => {
      const result = await api.authLogout();
      sessionStorage.setItem("logout-notice", result.revoked && result.localCredentialRemoved ? "已退出应用账号，i豆 不再访问你的飞书。" : "已退出应用账号，但没能确认服务端已注销这次登录；它最迟 15 分钟后自动失效。如需核查，请联系管理员。" );
      window.location.reload();
    });
    // Whether the app can reach this person's Feishu right now belongs with the
    // account it is about; it used to sit alone at the foot of the page, under
    // the administrator's block (2026-09-23). Read-only: it changes nothing. A
    // developer's run without a server checks the local CLI's own sign-in.
    if (status.identity || !status.configured) {
      const check = element("button", "检查飞书连接"); check.id = "check-document-connection"; check.type = "button";
      check.title = "检查 i豆 现在能不能用你的身份访问飞书。只是检查，不改任何设置。";
      checkNote = element("small", undefined, "login-check"); checkNote.id = "feishu-connection-result"; checkNote.setAttribute("role", "status"); checkNote.hidden = true;
      const note = checkNote;
      check.onclick = () => action(async () => {
        check.disabled = true; note.hidden = false; note.textContent = "正在检查飞书连接…";
        try { const result = await api.documentConnection(); note.textContent = result.connected ? result.message : `飞书连接有问题：${result.message}`; }
        catch (cause) { note.hidden = true; note.textContent = ""; throw cause; }
        finally { check.disabled = false; }
      });
      buttons.append(check);
    }
  } else if (status.stage === "confirm") {
    const identity = status.pendingIdentity;
    const confirmation = element("div", undefined, "login-confirmation"); confirmation.id = "login-identity";
    confirmation.append(element("strong", "请核对即将使用的账号"), element("p", identity.displayName || "飞书用户"), element("small", status.serverUrl ? `企业服务端：${status.serverUrl}` : ""));
    card.append(confirmation);
    button("login-confirm", "确认账号并进入", async () => {
      const result = await api.authConfirm();
      if (!result.revoked || !result.localCredentialRemoved) sessionStorage.setItem("logout-notice", "已切换账号，但没能确认上一个账号的登录已在服务端注销；它最迟 15 分钟后自动失效。如需核查，请联系管理员。");
      window.location.reload();
    });
    button("login-cancel", "不是我的账号 / 取消", async () => { await api.authCancel(); await renderLibrary(); });
  } else {
    card.append(element("p", "在下面完成飞书授权。完成后这里会自动继续，无需手动检查。授权入口五分钟内有效。"));
    // Feishu's own consent page, inside this window. It is a native view placed
    // over the page, so it has to be told where this box is and taken away when
    // the box goes.
    const area = element("div"); area.id = "login-view-area";
    card.append(area);
    const place = () => { const rect = area.getBoundingClientRect(); return api.loginViewBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }); };
    loginViewPlacement = place;
    requestAnimationFrame(() => { void place()?.catch(() => {}); });
    // The in-app view is not always what someone wants, and it can fail on a
    // machine we cannot predict. Without a way out there is no way in at all.
    button("login-open-external", "改用系统浏览器打开", async () => {
      loginViewPlacement = null; await api.closeLoginView().catch(() => {}); await api.openLoginExternal();
    });
    // The system browser does not always open, and some people authorize in a
    // different browser. Without the link there is no way in at all. It works
    // only in a browser on this computer: that browser is sent back to this
    // machine's loopback address to finish (login-return.js).
    if (status.launchUrl) {
      const row = element("div", undefined, "login-launch");
      row.append(element("label", "浏览器没有自动打开？复制授权链接，在这台电脑的浏览器里打开："));
      const field = document.createElement("input");
      field.id = "login-launch-url"; field.type = "text"; field.readOnly = true;
      field.value = status.launchUrl; field.setAttribute("aria-label", "飞书授权链接");
      field.onclick = () => field.select();
      row.append(field); card.append(row);
      // Through the main process: this window denies every web permission, so
      // navigator.clipboard is refused here and document.execCommand is
      // deprecated. Selecting the field still shows what was copied.
      button("login-copy-launch", "复制授权链接", async () => {
        field.select();
        if (!await api.copyText(field.value)) throw new Error("没能复制授权链接");
      });
    }
    button("login-poll", "立即检查结果", async () => {
      const next = await api.authPoll(); await renderLibrary();
      if (next.stage === "waiting") error("暂未收到授权结果，请完成浏览器中的授权后再检查。");
    }).disabled = status.stage !== "waiting";
    button("login-cancel", "取消登录", async () => { await api.authCancel(); await renderLibrary(); });
  }
  // The embedded Feishu view keeps its own web session, separate from the
  // OAuth login above. Signing into it is a one-time, account-level action, so
  // it lives here rather than in a document toolbar.
  if (status.identity) {
    const web = element("section", undefined, "login-web-view"); web.id = "feishu-web-session";
    web.append(element("strong", "飞书网页视图"),
      element("small", "用于按飞书原样显示文档和聊天。它使用你自己的飞书网页登录，与上面的授权是两回事；这个登录只保存在本机、按账号隔离，退出账号即清除。"));
    const open = element("button", state.feishuView === "settings" ? "关闭飞书网页视图" : "打开并登录飞书");
    open.id = "feishu-web-login";
    open.onclick = () => action(async () => {
      if (state.feishuView === "settings") { await closeFeishuView(); await renderLibrary(); return; }
      const epoch = viewEpoch;
      const opened = await api.openFeishuView({ kind: "home" });
      if (opened?.cancelled || epoch !== viewEpoch || state.section !== "settings") return;
      state.feishuView = "settings";
      await renderLibrary();
      await updateFeishuBounds();
    });
    web.append(open);
    // The view is mounted into this box, never over the panel, so the control
    // that closes it can never end up underneath it.
    const area = element("div"); area.id = "feishu-web-area"; area.hidden = state.feishuView !== "settings";
    web.append(area); card.append(web);
    if (state.feishuView === "settings") requestAnimationFrame(() => {
      area.scrollIntoView({ block: "nearest" });
      requestAnimationFrame(() => { void updateFeishuBounds()?.catch(() => {}); });
    });
  }
  card.append(buttons, ...(checkNote ? [checkNote] : []), element("p", status.identity ? `${feishuReach(status.identity)}任务按账号分开保存；退出账号后，i豆 立即停止访问你的飞书，任务不会删除。` : "登录后，任务按飞书账号分开保存；退出账号也不会删除任务。", "login-boundary"));
  library.append(card);
}
// Where 技能中心 hands off to a conversation. A created task is opened the same
// way the composer opens one; a coding skill only goes as far as the section,
// because a coding task needs its folder chosen first.
async function openSkillTask(created, mode) {
  await switchSection(mode); state.snapshot = await api.snapshot(); state.taskId = created.id; await restoreTaskUi(created.id); render(); $("#prompt").focus();
}
async function startSkillTask({ mode, create, prefill = "" }) {
  if (!create) { await switchSection(mode); $("#prompt").focus(); return; }
  const created = await api.createTask({ mode, permission: preferredPermission() });
  await openSkillTask(created, mode);
  if (prefill) { $("#prompt").value = prefill; $("#prompt").setSelectionRange(prefill.length, prefill.length); saveDraft(); }
}
async function renderLibrary() {
  synthesisConsent = null;
  receptionUi?.dispose(); receptionUi = null;
  publicationUi?.dispose(); publicationUi = null;
  discoveryUi?.dispose(); discoveryUi = null;
  graphUi?.dispose(); graphUi = null;
  skillUi?.dispose(); skillUi = null;
  const section = state.section, library = $("#library");
  // The full-bleed layout belongs to the Feishu sections only; every other
  // section gets the normal padded page back.
  library.classList.remove("feishu-fill", "feishu-docs-split", "knowledge-library");
  // Before the section is wiped: the Agent panel is a real element on loan, not
  // markup this function owns, and clearing it here would delete it.
  undockAgentPanel();
  library.replaceChildren(element("h1", labels[section]));
  if (section === "sites") return renderSites(library);
  if (section === "skills") {
    // The whole section is its own module now; see skill-center.js for why it
    // is laid out the way it is. The page title lives in its toolbar, so the
    // generic <h1> above is dropped rather than shown twice.
    library.replaceChildren();
    skillUi = skillCenterUi({ api, root: library, element, action, readableError, detail: $("#skill-detail"), placeConfirmations,
      // Section identity, not viewEpoch: hidePreview() bumps the epoch without
      // leaving the page, which would silently freeze it. Leaving the section
      // re-renders the library, and that disposes this module first.
      isCurrent: () => state.section === section,
      startTask: startSkillTask, openCreatedTask: openSkillTask });
  } else if (section === "schedules") {
    // Its own module, for the same reason the skill centre is: the layout comes
    // from the two products people already use, and mixing it into this file
    // would bury that.
    library.replaceChildren();
    // A clicked notification asks for 运行记录; any other arrival opens the list.
    const tab = pendingScheduleTab; pendingScheduleTab = null;
    // An Agent's draft opens here, in the ordinary dialog; see onScheduleDraft.
    const draft = pendingScheduleDraft; pendingScheduleDraft = null;
    schedulesUi({ api, root: library, element, action, readableError, tab, draft }).render();
  } else if (section === "settings") {
    await updateConnection();
    await renderLogin(library); if (state.section !== section) return;
    const login = await api.authStatus(); if (state.section !== section) return;
    // A connection file is how a developer points the app at a local control
    // plane. Where an organisation's server is configured the Feishu sign-in
    // above is the way in, so the people using the app are not shown a file
    // picker meant for testing, nor notes about work still in progress
    // (2026-09-23). A connection file already in use is still shown.
    const developer = !login.configured || (state.connection.connected && state.connection.provider !== "feishu");
    if (developer) {
      const row = element("div", undefined, "settings-row"), text = element("div"); text.append(element("strong", "模型服务连接"), element("p", state.connection.connected ? `${state.connection.serverUrl} · ${modelPhrase()}` : "选择本地开发服务端签发的短期连接文件"));
      const button = element("button", "选择连接文件"); button.id = "connect-session"; button.onclick = () => action(async () => { await api.connect(); await renderLibrary(); }); row.append(text, button); library.append(row);
      button.disabled = state.connection.provider === "feishu";
      library.append(element("p", "连接文件入口仅供开发测试，不等同于飞书登录。客户端不需要也不接受模型密钥。"), element("p", "自建企业应用平台：在编程任务中生成、预览和修改应用。企业发布、隔离运行环境与业务数据服务尚在开发，不依赖妙搭。"));
    }
    // Which of the models this server offers to use. One model means nothing to
    // pick; several lets the person choose (e.g. MiniMax-M3 for vision).
    const modelBox = element("section", undefined, "model-select");
    modelBox.append(element("h2", "对话 / 编程模型"));
    const modelHint = element("p", "正在读取可选模型…"), modelSelect = element("select");
    modelSelect.id = "model-select"; modelSelect.disabled = true;
    modelBox.append(modelHint, modelSelect); library.append(modelBox);
    // The server keeps each person's model and knows which can answer
    // (control-plane/model-choice.js): "跟随服务端默认" keeps no pick, so an
    // administrator's change reaches this person too. An older server keeps
    // the choice on this desktop, as before.
    const drawModels = (options) => {
      modelSelect.replaceChildren();
      if (!options.available.length) { modelHint.textContent = "服务端尚未确认可用模型。"; modelSelect.hidden = true; return; }
      const label = (slug) => options.available.find((model) => model.slug === slug)?.label ?? slug;
      const passedOver = new Map((options.unavailable ?? []).map((row) => [row.slug, row]));
      const kept = options.kept === "server";
      if (kept) { const follow = element("option", `跟随服务端默认（${label(options.default)}）`); follow.value = ""; modelSelect.append(follow); }
      for (const model of options.available) {
        const option = element("option", `${model.label}${!kept && model.slug === options.default ? "（服务端默认）" : ""}${passedOver.has(model.slug) ? "（暂不可用）" : ""}`);
        option.value = model.slug; modelSelect.append(option);
      }
      modelSelect.value = kept ? options.choice ?? "" : options.current ?? options.default ?? options.available[0].slug;
      const single = options.available.length < 2;
      modelSelect.disabled = single;
      const said = single ? "服务端当前只提供这一个模型。要换模型（比如能看图的 MiniMax-M3），需要管理员在服务端开启多模型。"
        : kept ? "选择保存在服务端，换电脑也一样，下一轮任务生效；定时任务也用这个模型。选「跟随服务端默认」时，管理员改默认会自动跟着改。"
          : "选择本连接使用的模型，下一轮任务生效。";
      const clock = (at) => (Number.isFinite(at) ? new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "");
      const notes = [...passedOver.values()].map((row) => `${row.label} 暂不可用：${row.reason}${row.since ? `（${clock(row.since)} 起）` : ""}，现在用的是 ${label(options.current)}。`);
      modelHint.textContent = [said, ...notes].join(" ");
    };
    action(async () => {
      const options = await api.modelOptions(); if (state.section !== section) return;
      drawModels(options);
      modelSelect.onchange = () => action(async () => { const updated = await api.selectModel(modelSelect.value === "" ? null : modelSelect.value); if (updated) drawModels(updated); });
    });
    // What each coding project may run without asking again (approval-rules.js),
    // each forgotten here -- as Claude Code lists its rules under /permissions.
    const rulesBox = element("section", undefined, "model-select"); rulesBox.id = "approval-rules";
    const rulesList = element("div");
    rulesBox.append(element("h2", "编程任务里记住的命令"), rulesList); library.append(rulesBox);
    const drawRules = (rules) => rulesList.replaceChildren(...(rules.length ? rules.map((rule) => {
      const row = element("div", undefined, "settings-row"), text = element("div");
      text.append(element("strong", rule.prefix.join(" ")), element("p", `${rule.folder} · 这个项目里以这几个词开头、不夹带别的命令时不再问`));
      const forget = element("button", "撤销"); forget.onclick = () => action(async () => { await api.forgetApprovalRule({ folder: rule.folder, prefix: rule.prefix }); drawRules(await api.approvalRules()); });
      row.append(text, forget); return row;
    }) : [element("p", "还没有。编程任务里确认执行命令时选「以后这个项目里都允许」，就会记在这里。")]));
    action(async () => { const rules = await api.approvalRules(); if (state.section !== section) return; drawRules(rules); });
    // 通知, laid out after WorkBuddy's: one switch for desktop notifications,
    // worded as what this app actually tells you about, a way to see now whether
    // the system lets them through, and a way to the system's own setting (their
    // 去授权) -- whether an app may notify is macOS's decision, not this one's.
    const notices = element("section", undefined, "notification-settings");
    notices.append(element("h2", "通知"));
    const noticeRow = element("label", undefined, "settings-row notification-row");
    const noticeText = element("div");
    noticeText.append(element("strong", "桌面通知"), element("p", "定时任务跑完时，通过系统通知提醒你。需要应用开着；关掉应用时，结果留在「定时任务 → 运行记录」。"));
    const noticeSwitch = element("input"); noticeSwitch.type = "checkbox"; noticeSwitch.id = "desktop-notifications"; noticeSwitch.disabled = true;
    noticeRow.append(noticeText, noticeSwitch);
    const noticeActions = element("div", undefined, "notification-actions");
    const tryNotice = element("button", "发一条测试通知"); tryNotice.type = "button"; tryNotice.id = "test-notification";
    const systemNotice = element("button", "打开系统通知设置"); systemNotice.type = "button"; systemNotice.id = "open-notification-settings";
    const noticeNote = element("p", "", "notification-note");
    noticeActions.append(tryNotice, systemNotice);
    notices.append(noticeRow, noticeActions, noticeNote); library.append(notices);
    const showNoticeState = (value) => {
      noticeSwitch.checked = value.desktop === true; noticeSwitch.disabled = value.supported !== true;
      tryNotice.disabled = value.supported !== true;
      systemNotice.hidden = value.platform !== "darwin";
      if (value.supported !== true) noticeNote.textContent = "这台电脑不支持系统通知。";
    };
    action(async () => { const value = await api.notificationPreferences(); if (state.section === section) showNoticeState(value); });
    noticeSwitch.onchange = () => action(async () => {
      showNoticeState(await api.setNotificationPreferences({ desktop: noticeSwitch.checked }));
      noticeNote.textContent = noticeSwitch.checked ? "已开启。之后跑完的定时任务会提醒你。" : "已关闭。结果仍在「定时任务 → 运行记录」。";
    });
    tryNotice.onclick = () => action(async () => {
      const { shown } = await api.testNotification();
      noticeNote.textContent = shown ? "已发出。没看到的话，多半是系统没允许「i豆」发通知，点「打开系统通知设置」去允许。" : "这台电脑不支持系统通知。";
    });
    systemNotice.onclick = () => action(() => api.openNotificationSettings());
    // 飞书消息 (G9): a finished task's result also goes to the person in
    // Feishu, and WorkBuddy's 测试通知 shows whether it arrives -- and which
    // way it was sent. Nothing is asked of the server until it is pressed: a
    // read on opening this page would hold 退出此账号 until it answered.
    const feishuRow = element("div", undefined, "settings-row notification-row notification-feishu");
    const feishuText = element("div");
    feishuText.append(element("strong", "飞书消息"), element("p", "定时任务跑完后，会在飞书里通知你，这条通知只发给你本人（任务里指定的文档和会话另外写入）。按「测试通知」发一条给自己，看看能不能收到。"));
    feishuRow.append(feishuText);
    const feishuActions = element("div", undefined, "notification-actions");
    const tryFeishu = element("button", "测试通知"); tryFeishu.type = "button"; tryFeishu.id = "test-feishu-notification";
    feishuActions.append(tryFeishu);
    const feishuNote = element("p", "", "notification-note notification-feishu-note");
    notices.append(feishuRow, feishuActions, feishuNote);
    const SENT = {
      bot: "由应用机器人发送，请到飞书查看它发来的消息。",
      self: "以你本人的身份发到了你和自己的会话里（没有未读提醒）。管理员给应用开通机器人发消息的权限后，会改由机器人发送。",
    };
    tryFeishu.onclick = async () => {
      tryFeishu.disabled = true; tryFeishu.textContent = "发送中..."; feishuNote.textContent = "";
      try {
        const result = await api.testScheduleNotify();
        feishuNote.textContent = result?.sent ? `测试通知发送成功！${SENT[result.as] ?? ""}` : `测试通知发送失败：${result?.message ?? "原因未知"}`;
      } catch (cause) { feishuNote.textContent = `测试通知发送失败：${readableError(cause)}`; }
      finally { tryFeishu.disabled = false; tryFeishu.textContent = "测试通知"; }
    };
    // Which account this is, in the form an administrator needs. These three
    // values are what server-side configuration is keyed on — a publisher
    // allow-list, a tenant entry. Only an administrator configures the server,
    // so only an administrator is shown them, and folded even then: everyone
    // else sees names alone (2026-09-23, before handing the app to more people).
    // Whether this person administers comes from the server (the skill shelf).
    const administrator = login.identity ? (await api.skillShelf().catch(() => null))?.administrator === true : false;
    if (state.section !== section) return;
    if (administrator) {
      const account = element("details", undefined, "account-identity");
      account.append(element("summary", "管理员信息：配置服务端用的账号标识"),
        element("p", "配置服务端时需要这三项：IDOU_SKILL_ADMINS 填 open_id 决定谁能上架企业技能，FEISHU_ALLOWED_TENANTS 填 tenant_key。它们只是标识，不是密钥。只有管理员能看到这一栏。"));
      const table = element("div", undefined, "identity-rows");
      for (const [label, value] of [["用户 open_id", login.identity.userId], ["租户 tenant_key", login.identity.tenantId], ["飞书应用 app_id", login.identity.appId]]) {
        const row = element("div", undefined, "identity-row");
        const code = element("code", value);
        const copy = element("button", "复制"); copy.type = "button";
        copy.onclick = () => action(async () => {
          if (!await api.copyText(value)) throw new Error("没能复制");
          copy.textContent = "已复制"; setTimeout(() => { copy.textContent = "复制"; }, 1500);
        });
        row.append(element("span", label, "identity-label"), code, copy);
        table.append(row);
      }
      account.append(table);
      library.append(account);
    }
  } else if (section === "knowledge") {
    // The consent below names the model, so it is read fresh rather than from the last poll.
    const epoch = viewEpoch; await updateConnection(); const status = await api.knowledgeStatus(); if (epoch !== viewEpoch) return;
    library.classList.add("knowledge-library"); library.replaceChildren();
    const page = element("div", undefined, "knowledge-page");
    const hero = element("section", undefined, "knowledge-hero");
    const heroCopy = element("div", undefined, "knowledge-hero-copy");
    heroCopy.append(element("small", "本机企业知识"), element("h1", "把读过的资料，变成随时可查的知识"),
      element("p", "完整阅读或主动加入的飞书资料会自动形成加密副本；每次查找仍会重新核验原文权限与版本。"));
    const metrics = element("div", undefined, "knowledge-metrics");
    const sourceMetric = element("strong", "—"), synthesisMetric = element("strong", status.synthesis.enabled ? "已开启" : "未开启"), retentionMetric = element("strong", "30 天");
    for (const [value, label] of [[sourceMetric, "本机来源"], [synthesisMetric, "自动归纳"], [retentionMetric, "未使用后清理"]]) {
      const metric = element("div", undefined, "knowledge-metric"); metric.append(value, element("span", label)); metrics.append(metric);
    }
    hero.append(heroCopy, metrics); page.append(hero);

    const primary = element("section", undefined, "knowledge-primary");
    const searchBlock = element("div", undefined, "knowledge-primary-block");
    searchBlock.append(element("strong", "查找知识"), element("small", "只展示当前账号此刻仍有权读取的原文依据。"));
    const addBlock = element("div", undefined, "knowledge-primary-block knowledge-add-block");
    addBlock.append(element("strong", "添加来源"), element("small", "粘贴飞书文档、电子表格或多维表格链接。"));
    primary.append(searchBlock, addBlock); page.append(primary);
    const results = element("div", undefined, "knowledge-results"); results.id = "knowledge-results"; page.append(results);
    const sourcesPanel = element("section", undefined, "knowledge-sources-panel");
    const sourcesHead = element("div", undefined, "knowledge-section-head"), sourcesSummary = element("small", "正在读取本机来源…");
    sourcesHead.append(element("h2", "知识来源"), sourcesSummary); sourcesPanel.append(sourcesHead); page.append(sourcesPanel);
    const advanced = element("details", undefined, "knowledge-advanced");
    const advancedSummary = element("summary");
    advancedSummary.append(element("span", "自动化与高级设置"), element("small", "自动发现、云盘同步、模型归纳、节点协调和文档关系"));
    const advancedBody = element("div", undefined, "knowledge-advanced-body");
    advanced.append(advancedSummary, advancedBody); page.append(advanced); library.append(page);
    const synthesisRow = element("section", undefined, "synthesis-controls");
    const synthesisInfo = element("p"), consent = element("small"), toggle = element("button"), refreshStatus = element("button", "刷新整理状态"); toggle.id = "toggle-knowledge-synthesis"; refreshStatus.id = "refresh-knowledge-status"; consent.id = "knowledge-synthesis-consent";
    // Offered only under a model the server confirmed. Without one the line says
    // so instead of naming the default, and synthesis cannot be switched on;
    // switching it off always stays possible.
    const showSynthesisConsent = () => {
      consent.textContent = modelUnconfirmed()
        ? `当前模型网关：${state.connection.serverUrl || "未连接"}。${modelName()}：${state.connection.modelNotice}。确认前不能开启自动归纳，正文不会发送给任何模型。`
        : `当前模型网关：${state.connection.serverUrl || "未连接"}。开启后，后续阅读的正文（每篇最多 12000 字）会经该网关发送给 ${modelPhrase() || "服务端配置的模型"}，可能产生费用。每次最多 ${state.connection.modelSynthesisTokens} 输出 token；失败不自动重试。在线续期会重新核对同一账号和网关，不增加本次 6 次上限；重启后仍需手动开启。该授权不替代企业数据策略。`;
      toggle.disabled = modelUnconfirmed() && toggle.dataset.enabled !== "true";
    };
    const showSynthesisStatus = (value) => {
      synthesisInfo.textContent = `${value.synthesis.enabled ? `自动归纳已开启 · ${value.synthesis.serverUrl}${value.synthesis.model ? ` · ${value.synthesis.model}` : ""}` : "自动归纳未开启"} · 本次启动剩余 ${value.synthesis.remaining} 次${value.synthesis.busy ? " · 正在处理" : ""}。`;
      synthesisMetric.textContent = value.synthesis.enabled ? "已开启" : "未开启";
      toggle.textContent = value.synthesis.enabled || value.synthesis.busy ? "关闭并取消归纳" : "本次会话开启自动归纳";
      toggle.dataset.enabled = String(value.synthesis.enabled || value.synthesis.busy);
      showSynthesisConsent();
    };
    showSynthesisStatus(status);
    synthesisConsent = () => { if (epoch === viewEpoch && state.section === "knowledge") showSynthesisConsent(); };
    graphUi = knowledgeGraphUi({ api, root: advancedBody, element, isCurrent: () => epoch === viewEpoch && state.section === "knowledge" });
    discoveryUi = knowledgeDiscoveryUi({ api, root: advancedBody, element, isCurrent: () => epoch === viewEpoch && state.section === "knowledge", onStatus: value => showSynthesisStatus({ synthesis: value.synthesis }) });
    publicationUi = knowledgePublicationUi({ api, root: advancedBody, element, isCurrent: () => epoch === viewEpoch && state.section === "knowledge" });
    receptionUi = knowledgePublicationUi({ api, root: advancedBody, element, kind: "reception", isCurrent: () => epoch === viewEpoch && state.section === "knowledge" });
    synthesisRow.append(synthesisInfo, consent, toggle, refreshStatus);
    advancedBody.prepend(synthesisRow);
    const note = element("p", status.message, "knowledge-status"); note.id = "knowledge-status";
    // Switching on names the model this consent named; main refuses it if the
    // server has moved since. The connection is read again either way, so the
    // consent in front of the person names the model in force before any retry.
    toggle.onclick = () => action(async () => { toggle.disabled = true; try { const next = await api.setKnowledgeSynthesis(toggle.dataset.enabled !== "true", state.connection.model); if (epoch === viewEpoch) { showSynthesisStatus(next); note.textContent = next.message; } } finally { toggle.disabled = false; await updateConnection().catch(() => {}); showSynthesisConsent(); } });
    refreshStatus.onclick = () => action(async () => { const next = await api.knowledgeStatus(); if (epoch === viewEpoch) { showSynthesisStatus(next); note.textContent = next.message; } });
    searchBlock.append(note, element("small", `本机上限 ${Math.round(status.maxBytes / 1024 / 1024)} MiB / ${status.maxDocuments} 篇 · 查询时核验原文权限`));
    const form = element("form", undefined, "knowledge-search"), input = element("input"), button = element("button", "查找知识");
    input.id = "knowledge-query"; input.placeholder = "搜索阅读过的文档，留空查看近期来源"; input.maxLength = 200; input.setAttribute("aria-label", "搜索本机知识");
    button.type = "submit"; button.id = "search-knowledge"; form.append(input, button); searchBlock.insertBefore(form, note);
    // Adding a source on purpose. Until now a document only entered the copy as
    // a side effect of having been opened in a task, and spreadsheets and Base
    // tables could not enter it at all.
    const addForm = element("form", undefined, "knowledge-search"), addInput = element("input"), addButton = element("button", "加入知识库");
    addInput.id = "knowledge-add-link"; addInput.placeholder = "粘贴飞书资料链接"; addInput.maxLength = 2048; addInput.setAttribute("aria-label", "加入知识库");
    addButton.type = "submit"; addButton.id = "add-knowledge"; addForm.append(addInput, addButton); addBlock.append(addForm);
    const addNote = element("p", "", "knowledge-status"); addNote.id = "knowledge-add-status"; addBlock.append(addNote);
    addForm.onsubmit = (event) => { event.preventDefault(); action(async () => {
      const link = addInput.value.trim(); if (!link) return;
      addButton.disabled = true; addNote.textContent = "正在按当前飞书身份读取并核验这个来源…";
      try {
        const added = await api.addKnowledge(link); if (epoch !== viewEpoch) return;
        addInput.value = "";
        const kind = { "feishu-sheet": "电子表格", "feishu-base": "多维表格" }[added.kind] ?? "文档";
        addNote.textContent = `已加入：${kind}《${added.title}》${added.warnings?.length ? ` · ${added.warnings[0]}` : ""}`;
        await showInventory();
      } catch (cause) { if (epoch === viewEpoch) addNote.textContent = "没有加入：这个链接读不到，或当前身份没有权限。"; throw cause; }
      finally { if (epoch === viewEpoch) addButton.disabled = false; }
    }); };
    // What is stored, as a list the person can actually read and act on. No
    // network call, no excerpt text: this says what is here, not what it says.
    const inventory = element("section", undefined, "knowledge-inventory"); inventory.id = "knowledge-inventory"; sourcesPanel.append(inventory);
    const when = (value) => (Number.isSafeInteger(value) ? new Date(value).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" }) : "—");
    // What this machine worked out about a document's standing, from the
    // documents' own words. Never a percentage: a judgement drawn from one
    // sentence does not deserve the precision a number would imply.
    // The judgement always travels with the sentence it was drawn from, and the
    // document is never hidden: a text-marker judgement is sometimes wrong, and
    // the person is the one who can see that.
    const standingBanners = (source) => {
      const banners = [];
      if (source.supersededBy) {
        const banner = element("div", undefined, "standing-banner standing-bad");
        banner.append(element("strong", `已被《${source.supersededBy.title}》替代${source.supersededBy.docDate ? `（${source.supersededBy.docDate}）` : ""}`));
        if (source.standingEvidence) banner.append(element("blockquote", source.standingEvidence));
        banner.append(element("small", "依据是文档自己的这句话，本机据此判断；判断可能出错，这篇内容仍然完整保留在下面。"));
        banners.push(banner);
      }
      for (const amendment of source.amendedBy ?? []) {
        const banner = element("div", undefined, "standing-banner standing-warn");
        banner.append(element("strong", `部分内容可能已被《${amendment.title}》${amendment.docDate ? `（${amendment.docDate}）` : ""}调整`));
        if (amendment.evidence) banner.append(element("blockquote", amendment.evidence));
        banners.push(banner);
      }
      return banners;
    };
    // A thousand rows in one table is a wall, not a list: the panel shows a page
    // at a time and filters by title, and says how many the filter matched.
    const PAGE = 50;
    let inventoryFilter = "", inventoryShown = PAGE;
    const showInventory = async (value = null) => {
      value = value ?? await api.knowledgeList(); if (epoch !== viewEpoch) return;
      inventory.replaceChildren();
      const counts = value.counts ?? {};
      sourceMetric.textContent = `${value.sources.length} 篇`;
      retentionMetric.textContent = `${value.retentionDays} 天`;
      sourcesSummary.textContent = value.sources.length ? `${value.sources.length} 篇本机副本；打开或查询时重新核验飞书原文` : "还没有来源；阅读文档或粘贴链接即可自动建立";
      const tally = [["现行", counts.current], ["部分被调整", counts.amended], ["已被替代", counts.superseded], ["自述已废止", counts["self-void"]], ["版本不明", counts.conflict], ["组近似重复", value.duplicateGroups]]
        .filter(([, n]) => n).map(([label, n]) => `${label} ${n}`).join(" · ");
      const head = element("p", `本机知识副本：${value.sources.length} 篇 · 上限 ${value.maxDocuments} 篇 · ${value.retentionDays} 天未再用到会清理${tally ? ` · ${tally}` : ""}`, "knowledge-status");
      const reload = element("button", "刷新清单"); reload.id = "knowledge-refresh-list";
      reload.onclick = () => action(showInventory);
      inventory.append(head, reload);
      // What left without the person removing it, and why. Shown before the
      // list and even when the list is empty: an empty copy that used to hold
      // thirty documents needs to say where they went.
      if (value.gone?.length) {
        const why = { expired: `${value.retentionDays} 天没有再用到`, count: `超过 ${value.maxDocuments} 篇上限，最久没用到的先清理`,
          bytes: "超过本机容量上限", unreadable: "连续 3 次无法从飞书重新读取", "changed-source": "链接现在读到的是另一篇文档或另一个账号" };
        const notice = element("div", undefined, "standing-banner standing-warn knowledge-gone");
        notice.id = "knowledge-gone";
        notice.append(element("strong", `最近有 ${value.gone.length} 篇来源被清理出本机副本`));
        for (const item of value.gone.slice(0, 8)) notice.append(element("small", `《${item.title}》 · ${why[item.reason] ?? "已清理"} · ${new Date(item.at).toLocaleDateString("zh-CN")}`));
        if (value.gone.length > 8) notice.append(element("small", `另有 ${value.gone.length - 8} 篇未列出。`));
        notice.append(element("small", "飞书原文不受影响；重新打开文档或粘贴链接即可恢复本机副本。"));
        inventory.append(notice);
      }
      if (!value.sources.length) { inventory.append(element("p", "还没有任何来源。在任务里打开飞书文档，或在上面粘贴链接加入。", "empty")); return; }
      const filter = element("input"); filter.id = "knowledge-filter"; filter.placeholder = "按标题筛选"; filter.value = inventoryFilter; filter.maxLength = 100;
      filter.oninput = () => { inventoryFilter = filter.value.trim(); inventoryShown = PAGE; void action(() => showInventory(value)); };
      inventory.append(filter);
      const matched = inventoryFilter ? value.sources.filter((source) => source.title.toLocaleLowerCase().includes(inventoryFilter.toLocaleLowerCase())) : value.sources;
      if (!matched.length) { inventory.append(element("p", `没有标题含「${inventoryFilter}」的来源。`, "empty")); return; }
      const shown = matched.slice(0, inventoryShown);
      const table = element("table"), head2 = element("thead"), body = element("tbody"), header = element("tr");
      for (const label of ["来源", "字数", "本人阅读", "最近用到", ""]) header.append(element("th", label));
      head2.append(header); table.append(head2, body);
      for (const source of shown) {
        const row = element("tr"), cell = element("td");
        const link = element("a", source.title); link.href = source.sourceUrl; link.className = "source-title"; link.target = "_blank"; link.rel = "noreferrer";
        cell.append(element("span", KINDS[source.kind] ?? "文档", "source-kind"), link);
        const badge = standingBadge(source.standing);
        if (badge || source.docDate) {
          const line = element("small");
          if (badge) line.append(badge);
          if (source.docDate) line.append(element("span", `${badge ? " · " : ""}文档自述日期 ${source.docDate}`));
          if (source.supersededBy) line.append(element("span", ` · 被《${source.supersededBy.title}》替代`));
          cell.append(line);
        }
        if (source.stale) cell.append(element("small", `上次核验失败 ${source.stale} 次，暂时不参与回答`, "source-stale"));
        if (source.embeds) cell.append(element("small", `内嵌 ${source.embeds} 个表格`));
        if (source.duplicates) {
          const copies = element("small", undefined, "source-duplicate");
          copies.append(element("span", `${source.duplicates.copies} 份近似副本`, "standing-badge standing-warn"),
            element("span", source.duplicates.speaksForGroup ? "回答时用这一份代表这组" : `回答时用《${source.duplicates.others[0]?.title ?? "另一份"}》代表这组`));
          cell.append(copies);
        }
        row.append(cell, element("td", `${source.chars.toLocaleString("zh-CN")} 字`, "source-when"),
          element("td", when(source.readAt ?? source.observedAt), "source-when"), element("td", when(source.usedAt), "source-when"));
        const remove = element("button", "移除"); remove.className = "knowledge-remove";
        remove.onclick = () => action(async () => {
          remove.disabled = true;
          try { const done = await api.removeKnowledge(source.id); if (epoch !== viewEpoch) return; note.textContent = done.message; await showInventory(); }
          finally { if (epoch === viewEpoch) remove.disabled = false; }
        });
        const last = element("td"); last.append(remove); row.append(last); body.append(row);
      }
      inventory.append(table);
      if (matched.length > shown.length) {
        const more = element("button", `显示更多（还有 ${matched.length - shown.length} 篇）`); more.id = "knowledge-more";
        more.onclick = () => { inventoryShown += PAGE; void action(() => showInventory(value)); };
        inventory.append(more);
      } else if (inventoryFilter) inventory.append(element("small", `共 ${matched.length} 篇匹配`, "knowledge-status"));
    };
    void action(showInventory);
    const nodeSection = element("section", undefined, "synthesis-controls"), nodeInfo = element("p", "尚未检查。服务端只协调分片与发布清单，不保存知识正文。"), nodeCheck = element("button", "检查知识节点连接");
    nodeInfo.id = "knowledge-node-status"; nodeCheck.id = "knowledge-node-check";
    nodeSection.append(element("strong", "分布式节点协调"), nodeInfo, nodeCheck, element("small", "连接检查不触发上传。发布和取回需各自获得企业批准；缓存和版本摘要不代表原文访问权限。")); advancedBody.append(nodeSection);
    nodeCheck.onclick = () => action(async () => {
      nodeCheck.disabled = true; nodeInfo.textContent = "正在检查当前账号的节点与云盘预算…";
      try {
        const value = await api.knowledgeNodeStatus(); if (epoch !== viewEpoch) return;
        nodeInfo.textContent = `协调服务已连接 · 节点 ${value.nodeId.slice(0, 12)} · 分片租约 ${value.limits.leaseMs / 1000} 秒 · 托管云盘剩余 ${(value.policy.remainingBytes / 1048576).toFixed(2)} MiB。此次检查仅查询元数据。`;
      } catch (cause) { if (epoch === viewEpoch) { nodeInfo.textContent = "节点协调尚未连接或未获管理员授权；没有上传或改变分片。"; throw cause; } }
      finally { nodeCheck.disabled = false; }
    });
    form.onsubmit = (event) => { event.preventDefault(); action(async () => {
      results.replaceChildren(); button.disabled = true; note.textContent = "正在重新核验来源权限与版本…";
      try {
        const response = await api.searchKnowledge(input.value.trim()); if (epoch !== viewEpoch) return;
        note.textContent = `已核验 ${response.hits.length} 个来源${response.unavailable ? "；部分来源这次没能重新核验，已排除在结果之外" : ""}${response.limited ? "。每次最多核验 10 个候选来源，请缩小搜索范围" : ""}。`;
        if (!response.hits.length) results.append(element("p", "没有可展示的来源。可先在工作任务中打开完整飞书文档，或尝试其他关键词。", "empty"));
        else {
          const resultHead = element("div", undefined, "knowledge-section-head knowledge-results-head");
          resultHead.append(element("h2", "查找结果"), element("small", `${response.hits.length} 个已重新核验的来源`)); results.append(resultHead);
        }
        for (const hit of response.hits) {
          const card = element("article", undefined, "knowledge-card");
          const heading = element("h2", hit.title);
          const mark = standingBadge(hit.standing ?? (hit.docDate ? "unknown" : "unknown"));
          if (mark) heading.append(mark);
          for (const banner of standingBanners(hit)) card.append(banner);
          if (hit.duplicates?.copies > 1) {
            const copies = element("div", undefined, "standing-banner standing-warn");
            copies.append(element("strong", `库里有 ${hit.duplicates.copies} 份几乎相同的副本，这里只展示其中一份`),
              element("small", `其余：${hit.duplicates.others.map((item) => item.title).join("、")}。正文里没有任何一句说明哪一份现行，需要你自己确认。`));
            card.append(copies);
          }
          card.append(heading, element("small", `原文摘录 · 版本 ${hit.revision} · 已重新核验${hit.docDate ? ` · 文档自述日期 ${hit.docDate}` : ""}${hit.section ? ` · ${hit.section.split("\n")[0]}` : ""}`), element("p", hit.excerpt, "knowledge-excerpt"), element("small", hit.sourceUrl));
          if (hit.synthesis) {
            const synthesis = element("section", undefined, "knowledge-synthesis"), coverage = hit.synthesis.coverage;
            synthesis.append(element("strong", hit.synthesis.origin ? "同步归纳（发布者声明）" : "模型归纳"), element("small", `${hit.synthesis.origin ? "来源包标注模型：" : ""}${hit.synthesis.model} · 覆盖 ${coverage.includedChunks}/${coverage.totalChunks} 个文本片段 · 引文已核验，推论仍需判断`));
            for (const fact of hit.synthesis.facts) {
              const point = element("div", undefined, "synthesis-fact"); point.append(element("p", fact.text));
              const citations = element("details"); citations.append(element("summary", `查看原文依据（${fact.evidence.length}）`));
              for (const citation of fact.evidence) citations.append(element("blockquote", citation.quote));
              point.append(citations); synthesis.append(point);
            }
            card.append(synthesis);
          }
          if (hit.warnings.length) card.append(element("p", hit.warnings.join(" "), "knowledge-warning"));
          const open = element("button", "在工作任务中打开 →"); open.className = "knowledge-open";
          open.onclick = () => action(async () => {
            if (epoch !== viewEpoch) return;
            await switchSection("cowork"); const openingEpoch = viewEpoch;
            const created = await api.createTask({ mode: "cowork", permission: preferredPermission() }); if (openingEpoch !== viewEpoch) return;
            if (!state.snapshot.tasks.some((item) => item.id === created.id)) state.snapshot.tasks.push(created);
            state.taskId = created.id; await restoreTaskUi(created.id); await loadDocument(hit.sourceUrl);
          }); card.append(open); results.append(card);
        }
      } catch (cause) { if (epoch === viewEpoch) { note.textContent = "未能完成权限核验，不展示缓存内容。"; throw cause; } }
      finally { button.disabled = false; }
    }); };
  } else if (section === "feishu") {
    const epoch = viewEpoch;
    // Reading and chatting are things a person does, so these sections are
    // Feishu's own pages and nothing else. They open on entry: there is no
    // second mode to choose between here.
    await mountFeishuSection(library, "messenger", epoch);
    // Under the page, in its column (see .feishu-docs-split). Appended after the
    // page was placed, it takes room from it, and opening it takes more: the
    // native layer is measured again each time, or it would cover this row --
    // and, before the row existed, this panel fell out of the two-column grid
    // and showed as a sliver along the bottom (2026-09-23).
    const extras = element("details", undefined, "feishu-extras");
    extras.append(element("summary", "消息文档自动整理"));
    library.append(extras);
    extras.ontoggle = () => { if (epoch === viewEpoch) void updateFeishuBounds()?.catch(() => {}); };
    requestAnimationFrame(() => { if (epoch === viewEpoch) void updateFeishuBounds()?.catch(() => {}); });
    discoveryUi = knowledgeDiscoveryUi({ api, root: extras, element, isCurrent: () => epoch === viewEpoch && state.section === "feishu" });
  } else if (section === "feishu-docs") {
    await mountFeishuSection(library, "drive", viewEpoch);
  }
}
async function loadFiles() {
  const id = state.taskId, folder = state.folder, epoch = viewEpoch;
  const entries = await api.listFiles(id, folder); if (state.taskId !== id || state.folder !== folder || epoch !== viewEpoch) return;
  // The panel frame already carries the title, so repeating it here just ate a
  // line. At the root this says how many files the task holds; inside a
  // subfolder it becomes the breadcrumb. Either way it is new information.
  $("#folder-name").textContent = folder || "";
  $("#folder-name").hidden = !folder;
  $("#file-count").hidden = Boolean(folder);
  $("#parent-folder").hidden = !folder;
  // The task's own folder is where files are attached and results are written,
  // so that view carries the size and the converted-copy note. A subdirectory is
  // just a directory listing.
  const attached = folder ? [] : await api.taskFiles(id).catch(() => []);
  if (state.taskId !== id || state.folder !== folder || epoch !== viewEpoch) return;
  const detail = new Map(attached.map((row) => [row.name, row]));
  $("#file-count").textContent = attached.length ? `${attached.length} 个文件` : "还没有文件";
  $("#attach-files").hidden = Boolean(folder); $("#reveal-folder").hidden = Boolean(folder);
  // A converted copy belongs to its source, not to the person: it is offered on
  // the source's own row and never as a file of its own.
  const derived = new Set(attached.map((row) => row.readableCopy).filter(Boolean));
  const visibleEntries = entries.filter((entry) => !derived.has(entry.name));
  $("#files").classList.toggle("empty-workspace", visibleEntries.length === 0);
  $("#file-empty").hidden = visibleEntries.length !== 0;
  $("#file-empty-title").textContent = folder ? "这个文件夹是空的" : "把资料放进这个任务";
  $("#file-empty-copy").textContent = folder ? "返回上一级选择其他文件，或在访达中整理任务目录。" : "Agent 可以读取你添加的文件，也会把生成结果保存在这里。";
  $("#empty-attach-files").hidden = Boolean(folder); $("#empty-open-document").hidden = Boolean(folder);
  $("#file-list").replaceChildren(...visibleEntries.map((entry) => {
    const row = detail.get(entry.name);
    const button = element("button");
    button.dataset.filePath = entry.path;
    if (row?.readableCopy) button.dataset.readableCopy = row.readableCopy;
    const suffix = entry.name.includes(".") ? entry.name.split(".").pop().toLowerCase() : "";
    const type = entry.directory ? "夹" : ["png", "jpg", "jpeg", "gif", "webp"].includes(suffix) ? "图" : ["xlsx", "xls", "csv"].includes(suffix) ? "表" : ["doc", "docx", "pdf", "md", "txt"].includes(suffix) ? "文" : ["html", "css", "js", "ts", "tsx", "jsx", "json"].includes(suffix) ? "码" : "件";
    const icon = element("span", type, "file-type"); icon.setAttribute("aria-hidden", "true");
    const copy = element("span", undefined, "file-copy"); copy.append(element("span", `${entry.directory ? "▸ " : ""}${entry.name}`, "file-name"));
    if (row) {
      button.title = row.readableCopy ? `${fileSize(row.bytes)} · 已转出文字副本供 Agent 阅读` : fileSize(row.bytes);
      // The size is decoration beside the name; keeping it out of the
      // accessible name leaves the button identified by the file it opens.
      const meta = element("small", row.readableCopy ? `${fileSize(row.bytes)} · 可读取` : fileSize(row.bytes), "file-meta");
      meta.setAttribute("aria-hidden", "true");
      copy.append(meta);
    }
    button.append(icon, copy);
    if (state.file && [entry.path, row?.readableCopy].includes(state.file.path)) button.setAttribute("aria-current", "page");
    button.onclick = () => action(async () => {
      if (entry.directory) { state.folder = entry.path; await loadFiles(); }
      else { markFileSelected(entry.path); await loadFile(entry.path); }
    });
    if (!row) return button;
    // Removing is a per-file action, so it sits on the file rather than in the
    // header where it would need a selection first.
    const wrapper = element("div", undefined, "file-row");
    const remove = element("button", "✕", "file-remove"); remove.type = "button"; remove.title = `从任务中删除 ${entry.name}`;
    remove.onclick = (event) => { event.stopPropagation(); action(async () => {
      await api.removeTaskFile(id, entry.name);
      // The viewer and the prompt's reference both point at a file that is now
      // gone; leaving them up offers the Agent content that no longer exists.
      if (state.file && [entry.name, row?.readableCopy].includes(state.file.path)) {
        state.file = null; state.selection = null;
        clearFilePresentation();
        renderContext();
      }
      await loadFiles();
    }); };
    wrapper.append(button, remove); return wrapper;
  }));
}
function markFileSelected(path) {
  for (const button of $("#file-list").querySelectorAll("button[data-file-path]")) {
    const selected = button.dataset.filePath === path || button.dataset.readableCopy === path;
    if (selected) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
  }
}
async function loadFile(relative) {
  clearDocument();
  // Reading a file opens the panel, but never steals it from the preview: the
  // preview reloads the same file on its way up.
  if (!SIDE_PANEL_TABS.includes(state.tab)) state.tab = "files";
  state.panelCollapsed = false;
  const id = state.taskId, epoch = viewEpoch, readEpoch = ++fileReadEpoch;
  let file;
  try { file = await api.readFile(id, relative); }
  catch (cause) {
    if (id !== state.taskId || epoch !== viewEpoch || readEpoch !== fileReadEpoch) return;
    const reason = readableError(cause);
    if (/已不在原位置/.test(reason)) {
      file = { path: relative, kind: "missing", reason: "文件已不在原位置。可以刷新文件清单；应用不会在电脑其他位置自动查找替代文件。", blocked: true };
      state.file = file; state.selection = null; state.includeContext = false; $("#file-title").textContent = relative; $("#file-note").textContent = "文件已丢失"; $("#file-note").hidden = false;
      showFileCard(file); renderContext(); queueTaskUiSave(); return;
    }
    const blocked = { path: relative, kind: "blocked", reason, blocked: true };
    state.file = blocked; state.selection = null; state.includeContext = false; $("#file-title").textContent = relative; $("#file-note").textContent = "无法打开"; $("#file-note").hidden = false;
    showFileCard(blocked); renderContext(); queueTaskUiSave(); throw cause;
  }
  if (id !== state.taskId || epoch !== viewEpoch || readEpoch !== fileReadEpoch) return;
  state.file = file; state.selection = null; state.includeContext = true;
  markFileSelected(file.path);
  // A converted copy is shown as what it is — the spreadsheet's text, not a file
  // the person wrote — and the marker line that says so belongs in the heading
  // rather than as the first line of the content.
  const derived = /^(.*)\.读取版\.md$/.exec(file.path);
  const text = file.kind === "text" ? derived ? file.text.replace(/^<!--[^]*?-->\n*/, "") : file.text : "";
  $("#file-title").textContent = derived ? derived[1] : file.path;
  $("#file-note").textContent = derived ? "自动转换的文字版 · 只读" : file.kind === "office" ? `${file.extension} · ${fileSize(file.bytes)}` : file.kind === "image" ? `图片 · ${fileSize(file.bytes)}` : file.kind === "binary" ? fileSize(file.bytes) : "";
  $("#file-note").hidden = !$("#file-note").textContent;
  if (file.kind === "text") {
    showFileText(text); $("#file-content").setSelectionRange(0, 0); $("#file-content").scrollTop = 0; $("#file-content").scrollLeft = 0; $("#file-line-numbers").scrollTop = 0;
  } else {
    state.includeContext = false;
    const note = file.kind === "office" ? `${file.extension} 文件不会当成文本打开。${file.readableCopy ? "可查看自动转换的文字版，也可以交给系统应用打开。" : "可以交给系统应用打开或显示所在位置。"}`
      : file.kind === "image" && file.dataUrl ? "图片在应用内只读预览；也可以用系统应用打开。" : file.reason;
    showFileCard(file, note);
  }
  $("#open-preview").hidden = !file.canPreview || state.section !== "coding"; renderContext(); queueTaskUiSave();
}
async function loadSheet(reference, options = {}) {
  const id = state.taskId, closing = hidePreview(); clearDocument();
  const epoch = viewEpoch, readEpoch = documentEpoch; fileReadEpoch++;
  state.file = null; state.selection = null; state.tab = "files"; state.panelCollapsed = false;
  showFileText("", { numbered: false }); $("#file-title").textContent = "正在读取电子表格…"; $("#open-preview").hidden = true; render(); await closing;
  try {
    const sheet = await api.openSheet(id, reference, options);
    if (id !== state.taskId || epoch !== viewEpoch || readEpoch !== documentEpoch) return;
    state.sheet = sheet; state.includeContext = true; render();
    $("#file-title").textContent = sheet.title; $("#file-text-view").hidden = true; $("#files").classList.add("reading-document");
    $("#document-meta").hidden = false;
    $("#document-meta").textContent = `版本 ${sheet.sourceRevision} · ${sheet.range} · ${sheet.sourceUrl}${sheet.warnings.length ? `\n${sheet.warnings.join(" ")}` : ""}`;
    $("#sheet-selector").replaceChildren(...sheet.sheets.map(row => { const option = element("option", `${row.title}${row.hidden ? "（隐藏）" : ""}${row.kind !== "sheet" ? "（非网格）" : ""}`); option.value = row.id; option.disabled = row.kind !== "sheet"; return option; }));
    $("#sheet-selector").value = sheet.sheetId; $("#sheet-range").value = sheet.range; $("#sheet-range-form").hidden = false;
    renderSheetGrid($("#sheet-grid"), sheet, element); $("#sheet-grid").hidden = false; renderContext(); queueTaskUiSave();
  } catch (cause) { if (epoch === viewEpoch && readEpoch === documentEpoch) { $("#file-title").textContent = "表格读取失败"; throw cause; } }
}
async function loadBase(reference, options = {}) {
  const id = state.taskId, closing = hidePreview(); clearDocument();
  const epoch = viewEpoch, readEpoch = documentEpoch; fileReadEpoch++;
  state.file = null; state.selection = null; state.tab = "files"; state.panelCollapsed = false;
  showFileText("", { numbered: false }); $("#file-title").textContent = "正在读取多维表格…"; $("#open-preview").hidden = true; render(); await closing;
  try {
    const base = await api.openBase(id, reference, options);
    if (id !== state.taskId || epoch !== viewEpoch || readEpoch !== documentEpoch) return;
    state.base = base; state.includeContext = true; render();
    $("#file-title").textContent = base.title; $("#file-text-view").hidden = true; $("#files").classList.add("reading-document");
    const writable = base.fields.filter(field => field.writable).map(field => field.name);
    $("#document-meta").hidden = false;
    $("#document-meta").textContent = `内容摘要 ${base.sourceRevision} · ${base.sourceUrl}\n可修改的字段：${writable.length ? writable.join("、") : "无（目前只支持纯文本和数字字段）"}${base.truncated ? "\n字段较多，只显示了前 30 个" : ""}`;
    $("#base-table-selector").replaceChildren(...base.tables.map(table => { const option = element("option", table.name); option.value = table.id; return option; }));
    $("#base-table-selector").value = base.tableId; $("#base-offset").value = String(base.offset + 1); $("#base-page-form").hidden = false;
    renderBaseGrid($("#base-grid"), base, element); $("#base-grid").hidden = false; renderContext(); queueTaskUiSave();
  } catch (cause) { if (epoch === viewEpoch && readEpoch === documentEpoch) { $("#file-title").textContent = "多维表格读取失败"; throw cause; } }
}
async function loadDocument(reference) {
  const id = state.taskId, closing = hidePreview(); clearDocument();
  const epoch = viewEpoch, readEpoch = documentEpoch; fileReadEpoch += 1;
  state.file = null; state.selection = null; state.tab = "files"; state.panelCollapsed = false;
  showFileText("", { numbered: false }); $("#file-title").textContent = "正在读取飞书文档…"; $("#open-preview").hidden = true; render();
  await closing;
  try {
    const document = await api.openDocument(id, reference);
    if (id !== state.taskId || epoch !== viewEpoch || readEpoch !== documentEpoch) return;
    state.document = document; state.includeContext = true; render();
    $("#feishu-native-view").hidden = false;
    // Feishu's own rendering is what a document actually looks like, so that is
    // what opening one shows. The text projection stays one click away and is
    // still what the model reads and what a confirmed edit is checked against.
    void openFeishuDocumentView().catch(() => { /* the text view is already on screen */ });
    $("#file-title").textContent = document.title; showFileText(document.text, { numbered: false });
    $("#file-content").setSelectionRange(0, 0); $("#file-content").scrollTop = 0;
    $("#file-content").classList.add("document-text"); $("#files").classList.add("reading-document");
    $("#document-meta").hidden = false;
    $("#document-meta").textContent = `版本 ${document.sourceRevision}${document.partial ? " · 局部内容" : ""} · ${document.sourceUrl}${document.warnings.length ? `\n${document.warnings.join(" ")}` : ""}`;
    $("#send-document").hidden = document.partial;
    renderContext(); queueTaskUiSave();
  } catch (cause) {
    if (epoch === viewEpoch && readEpoch === documentEpoch) { $("#file-title").textContent = "文档读取失败"; throw cause; }
  }
}

function resetDocumentDeliveryUi() {
  documentDeliveryUi.selected = null; documentDeliveryUi.members = []; documentDeliveryUi.preview = null;
  $("#document-recipient-results").replaceChildren(); $("#document-delivery-members").replaceChildren();
  $("#document-delivery-members").hidden = true; $("#document-delivery-selection").hidden = true;
  $("#document-delivery-selection").textContent = ""; $("#document-delivery-preview").hidden = true; $("#document-delivery-preview").textContent = "";
  $("#prepare-document-delivery").disabled = true; $("#send-document-delivery").disabled = true;
  $("#document-delivery-status").textContent = "尚未选择收件人，也没有发送。";
}
function closeDocumentDeliveryUi() {
  const panel = $("#document-delivery"); if (!panel) return;
  panel.hidden = true; resetDocumentDeliveryUi();
  if (state.taskId) void api.discardDocumentDelivery(state.taskId).catch(() => {});
}
function chosenDocumentRecipient(entry, kind) {
  documentDeliveryUi.selected = { ...entry, kind }; documentDeliveryUi.preview = null;
  $("#document-delivery-selection").hidden = false;
  $("#document-delivery-selection").textContent = `已选择${kind === "group" ? "群聊" : "收件人"}：${entry.name}${entry.department ? ` · ${entry.department}` : ""}${entry.email ? ` · ${entry.email}` : ""} · 尚未发送`;
  $("#prepare-document-delivery").disabled = false; $("#send-document-delivery").disabled = true;
  $("#document-delivery-preview").hidden = true;
  $("#document-delivery-status").textContent = "选择已经记下；还没有向飞书发送任何消息，也没有改变文档权限。";
}
async function chooseDocumentRecipient(entry, kind) {
  const id = state.taskId, handle = state.document?.handle, epoch = documentEpoch;
  chosenDocumentRecipient(entry, kind);
  const members = $("#document-delivery-members"); members.replaceChildren(); members.hidden = true; documentDeliveryUi.members = [];
  if (kind !== "group") return;
  $("#prepare-document-delivery").disabled = true; $("#document-delivery-status").textContent = "正在读取所选群的成员；尚未发送。";
  const result = await api.documentRecipientMembers(id, handle, entry.handle);
  if (id !== state.taskId || handle !== state.document?.handle || epoch !== documentEpoch || documentDeliveryUi.selected?.handle !== entry.handle) return;
  documentDeliveryUi.members = result.members; members.hidden = false;
  members.append(element("strong", `可选 @ 成员${result.partial ? "（成员列表不完整）" : ""}`), element("small", "最多 10 人；不支持 @所有人。选择提醒对象不会授予文档权限。"));
  for (const member of result.members) {
    const label = element("label", undefined, "document-delivery-member"), box = document.createElement("input"); box.type = "checkbox"; box.value = member.handle;
    box.onchange = () => { const checked = members.querySelectorAll("input:checked"); if (checked.length > 10) { box.checked = false; error("最多选择 10 位 @ 成员"); } documentDeliveryUi.preview = null; $("#send-document-delivery").disabled = true; };
    label.append(box, element("span", member.name)); members.append(label);
  }
  $("#prepare-document-delivery").disabled = false; $("#document-delivery-status").textContent = "群聊已选择；尚未发送。可选需要提醒的群成员。";
}
// quiet: a refresh nobody asked for -- the Agent moved a record -- keeps the
// list on screen until the new one is in hand, rather than blanking it at every
// status check the Agent makes.
async function loadMediaResults({ quiet = false } = {}) {
  const id = state.taskId, epoch = viewEpoch, root = $("#media-results"); if (!id || task()?.mode !== "cowork") return;
  if (!quiet) { $("#media-notice").textContent = "正在读取当前任务的图片与视频成果…"; root.replaceChildren(); }
  let rows;
  try { rows = await api.listMedia(id); }
  catch (cause) { if (!quiet && id === state.taskId && epoch === viewEpoch) $("#media-notice").textContent = readableError(cause); return; }
  if (id !== state.taskId || epoch !== viewEpoch || state.tab !== "media") return;
  $("#media-notice").textContent = rows.length ? `${rows.length} 项媒体记录 · 临时成果与云盘成果分别标明` : "当前任务还没有图片或视频成果。可以在对话里描述要生成的内容。";
  const cards = [];
  for (const row of rows) {
    const view = mediaResultPresentation(row), card = element("article", undefined, `media-card media-${view.state}`), heading = element("div", undefined, "media-card-heading");
    heading.append(element("strong", view.title), element("span", view.status, "media-state")); card.append(heading, element("p", view.detail));
    const actions = element("div", undefined, "media-card-actions");
    // The list is this machine's record and never says whether the result is
    // still held (hasResult comes only from asking the server), so gating on it
    // left every 可预览 card without its preview. Opening one asks the server,
    // and says so plainly if the temporary result has lapsed.
    if (row.state === "awaiting_acceptance") {
      const preview = element("button", "预览临时成果"); preview.type = "button"; preview.onclick = () => action(() => api.previewMedia(id, row.id)); actions.append(preview);
    }
    if (!["failed", "canceled", "expired"].includes(row.state) && !row.persisted) {
      const refresh = element("button", "刷新状态"); refresh.type = "button"; refresh.onclick = () => action(async () => { await api.refreshMedia(id, row.id); await loadMediaResults(); }); actions.append(refresh);
    }
    if (actions.childElementCount) card.append(actions); cards.push(card);
  }
  root.replaceChildren(...cards);
}

$("#send-document").onclick = () => {
  const panel = $("#document-delivery"); panel.hidden = !panel.hidden;
  if (!panel.hidden) { resetDocumentDeliveryUi(); $("#document-recipient-query").focus(); }
  else closeDocumentDeliveryUi();
};
$("#close-document-delivery").onclick = closeDocumentDeliveryUi;
$("#document-recipient-kind").onchange = () => { resetDocumentDeliveryUi(); if (state.taskId) void api.discardDocumentDelivery(state.taskId).catch(() => {}); };
$("#document-recipient-search").onsubmit = (event) => { event.preventDefault(); action(async () => {
  if (!state.taskId || !state.document?.handle) throw new Error("请先打开要发送的飞书文档");
  const id = state.taskId, handle = state.document.handle, epoch = documentEpoch;
  resetDocumentDeliveryUi(); const kind = $("#document-recipient-kind").value, query = $("#document-recipient-query").value.trim();
  $("#document-delivery-status").textContent = "正在搜索；尚未发送。";
  const result = await api.searchDocumentRecipients(id, handle, query, kind); if (id !== state.taskId || handle !== state.document?.handle || epoch !== documentEpoch) return;
  const rows = kind === "group" ? result.groups : result.users;
  $("#document-recipient-results").replaceChildren(...rows.map(entry => {
    const button = element("button", undefined, "document-recipient"); button.type = "button"; button.setAttribute("role", "option");
    button.append(element("strong", entry.name), element("small", kind === "group" ? `${entry.memberCount ?? "?"} 位成员` : [entry.department, entry.email].filter(Boolean).join(" · ")));
    button.onclick = () => action(() => chooseDocumentRecipient(entry, kind)); return button;
  }));
  $("#document-delivery-status").textContent = rows.length ? `找到 ${rows.length} 项；请明确选择一项。尚未发送。` : "没有找到可选对象；尚未发送。";
}); };
$("#prepare-document-delivery").onclick = () => action(async () => {
  const selected = documentDeliveryUi.selected; if (!selected || !state.document?.handle) throw new Error("请先明确选择收件人或群聊");
  const id = state.taskId, handle = state.document.handle, epoch = documentEpoch;
  const mentions = selected.kind === "group" ? [...$("#document-delivery-members").querySelectorAll("input:checked")].map(input => input.value) : [];
  const preview = await api.prepareDocumentDelivery(id, handle, selected.handle, $("#document-delivery-note").value, mentions);
  if (id !== state.taskId || handle !== state.document?.handle || epoch !== documentEpoch || selected.handle !== documentDeliveryUi.selected?.handle) return;
  documentDeliveryUi.preview = preview; $("#document-delivery-preview").textContent = preview.text; $("#document-delivery-preview").hidden = false;
  $("#send-document-delivery").disabled = false; $("#document-delivery-status").textContent = `已选择：${preview.recipient.name} · 发送预览已准备 · 尚未发送，也未改变文档权限。`;
});
$("#send-document-delivery").onclick = () => action(async () => {
  const preview = documentDeliveryUi.preview; if (!preview) throw new Error("请先预览要发送的内容");
  const id = state.taskId, epoch = documentEpoch;
  $("#send-document-delivery").disabled = true; $("#document-delivery-status").textContent = `已选择：${preview.recipient.name} · 等待你在确认卡片中决定 · 尚未发送。`;
  const result = await api.sendDocumentDelivery(id, preview.id); if (id !== state.taskId || epoch !== documentEpoch || preview !== documentDeliveryUi.preview) return;
  if (!result) { $("#document-delivery-status").textContent = `已选择：${preview.recipient.name} · 已取消，未发送，也未改变文档权限。`; return; }
  $("#document-delivery-status").textContent = result.state === "acknowledged" ? `发送结果：飞书已确认送达 ${result.recipient.name}。文档权限未改变。` : `发送结果待核对；请到飞书确认，不会自动重试。`;
});
async function switchTab(tab) {
  const closing = hidePreview(), epoch = viewEpoch; state.archivePreview = null;
  // A temporary result belongs to the media panel; leaving it takes the result
  // view down rather than leaving it floating over whatever comes next.
  if (tab !== "media" && state.mediaPreview) { state.mediaPreview = false; $("#media-preview-frame").hidden = true; await api.closeMediaPreview().catch(() => {}); }
  state.tab = tab;
  // Asking for something to look at is also asking for the panel back.
  if (SIDE_PANEL_TABS.includes(tab)) { state.panelCollapsed = false; state.mobilePane = "panel"; }
  else state.mobilePane = "chat";
  render(); await closing;
  if (epoch !== viewEpoch) return;
  if (tab === "files") { await loadFiles(); if (epoch === viewEpoch && state.sheet) await loadSheet(state.sheet.sourceUrl, { sheetId: state.sheet.sheetId, range: state.sheet.range }); else if (epoch === viewEpoch && state.base) await loadBase(state.base.sourceUrl, { tableId: state.base.tableId, offset: state.base.offset }); else if (epoch === viewEpoch && state.document) await loadDocument(state.document.sourceUrl); else if (epoch === viewEpoch && state.file) await loadFile(state.file.path); }
  if (tab === "browser" && state.file?.canPreview) await openPreview();
  if (tab === "changes") await openDiffPanel();
  if (tab === "apps") { if (!$("#app-entry").value && state.file?.canPreview) $("#app-entry").value = state.file.path; await loadAppCandidates(); }
  if (tab === "media") await loadMediaResults();
  queueTaskUiSave();
}

async function restorePanelResource(record) {
  if (!record || !state.taskId || record.panel.collapsed || record.panel.kind === "none") return;
  const intended = record.panel.kind;
  if (intended === "media") { state.tab = "media"; render(); await loadMediaResults(); return; }
  if (intended === "diff") { await openDiffPanel({ scope: record.panel.diffScope, turnKey: record.panel.resourceKey, path: record.panel.relativePath }); return; }
  if (intended === "files" || intended === "browser") {
    const savedSelection = record.panel.selection, savedRevision = record.panel.resourceRevision;
    state.tab = "files"; await loadFiles();
    if (record.panel.resourceKey && record.panel.resourceType === "document") await loadDocument(record.panel.resourceKey).catch(cause => error(`上次打开的文档需要重新读取：${readableError(cause)}`));
    else if (record.panel.resourceKey && record.panel.resourceType === "sheet") await loadSheet(record.panel.resourceKey).catch(cause => error(`上次打开的表格需要重新读取：${readableError(cause)}`));
    else if (record.panel.resourceKey && record.panel.resourceType === "base") await loadBase(record.panel.resourceKey).catch(cause => error(`上次打开的多维表格需要重新读取：${readableError(cause)}`));
    else if (record.panel.relativePath) await loadFile(record.panel.relativePath).catch(cause => error(`上次打开的文件已不可用：${readableError(cause)}`));
    const currentRevision = state.file?.revision || state.document?.sourceRevision || state.sheet?.sourceRevision || state.base?.sourceRevision;
    if (currentRevision) state.includeContext = record.panel.includeContext !== false;
    if (savedSelection && savedRevision && currentRevision === savedRevision) { state.selection = savedSelection; renderContext(); queueTaskUiSave(); }
    else if (savedSelection && savedRevision && currentRevision && currentRevision !== savedRevision) error("上次引用的内容版本已变化，选区没有自动恢复，请重新选择。");
    else if (currentRevision) { renderContext(); queueTaskUiSave(); }
    if (intended === "browser" && state.file?.canPreview) await switchTab("browser");
    else { state.tab = "files"; render(); }
  }
}

async function loadAppCandidates() {
  const id = state.taskId, epoch = viewEpoch; if (!id || state.tab !== "apps") return;
  // A failure here is about this panel, so it is reported inside it. Letting it
  // reach only the window-wide banner left the panel blank, which reads as
  // "nothing submitted yet" rather than "the service could not be reached".
  let result;
  try { result = await api.listAppCandidates(id); }
  catch (cause) {
    if (epoch !== viewEpoch || id !== state.taskId || state.tab !== "apps") return;
    $("#apps-notice").textContent = readableError(cause);
    $("#app-candidates").replaceChildren();
    throw cause;
  }
  if (epoch !== viewEpoch || id !== state.taskId || state.tab !== "apps") return;
  const rows = result.rows;
  // Version submission needs a catalogue on the control plane. Where there is
  // none, offering the buttons only produces the same refusal every time, so
  // they are turned off and the panel says what would turn them on. Publishing
  // a single-file page is local and keeps working either way.
  const unconfigured = Boolean(result.unconfigured);
  $("#apps-panel").classList.toggle("unconfigured", unconfigured);
  for (const id of ["#submit-app-candidate", "#open-app-reviews", "#open-app-runtime", "#app-archive-folder", "#welcome-app-reviews", "#welcome-app-runtime"]) {
    const node = $(id); if (node) node.disabled = unconfigured;
  }
  $("#apps-notice").textContent = unconfigured ? result.reason
    : rows.length ? `${rows.length} 个当前账号的版本 · 企业审核人可查看清单 · 均未部署` : "暂无提交记录。保存版本不会执行构建或发布服务。";
  $("#app-candidates").replaceChildren(...rows.map((row) => {
    const card = element("article", undefined, "app-candidate");
    const status = row.state === "withdrawn" ? "已撤回 · 未部署" : row.review ? row.review.decision === "approved" ? "清单通过 · 未部署" : "退回修改 · 未部署" : "已提交待审 · 未部署";
    card.append(element("h3", row.title), element("span", status, "app-candidate-state"), element("p", `${row.entry} · ${row.fileCount} 个文件 · ${row.totalBytes} 字节`), element("code", row.digest), element("small", new Date(row.createdAt).toLocaleString("zh-CN")));
    if (row.review) card.append(element("p", `审核说明：${row.review.note}`, "app-review-result"), element("small", `${new Date(row.review.reviewedAt).toLocaleString("zh-CN")} · 仅对这个版本的清单作出结论，不授予部署权限。`));
    if (row.state === "submitted") {
      const button = element("button", "撤回版本", "withdraw-app-candidate"); button.onclick = () => action(async () => { button.disabled = true; try { await api.withdrawAppCandidate(id, row.digest); await loadAppCandidates(); } finally { button.disabled = false; } }); card.append(button);
    }
    const archive = row.archive;
    if (archive) {
      const states = { prepared: "归档已准备 · 尚未取得上传许可", uploading: "归档结果待核查 · 不会自动重传", recorded: "已记录上传回执 · 待核验目录", listed: "已归档 · 客户端已核验目录" };
      card.append(element("p", states[archive.state], "app-archive-state"), element("small", `${archive.input.bytes} 字节 · ${archive.input.folder.title}`), element("p", archive.input.folder.url), element("small", "归档回执仅含目录核验；取回可校验包内容。撤回版本不会删除云盘文件。"));
      if (!archive.fileToken && archive.state !== "prepared") card.append(element("p", "请在上述原文件夹人工核查上传结果。不要通过另建任务重复归档。"));
    }
    const canUpload = row.state === "submitted" && (!archive || archive.state === "prepared");
    if (canUpload || archive?.fileToken) {
      const button = element("button", canUpload ? "归档到飞书云盘" : "重新核验云盘目录", canUpload ? "archive-app-candidate" : "verify-app-archive");
      button.onclick = () => action(async () => { button.disabled = true; try {
        if (canUpload) await api.archiveAppCandidate(id, row.digest, $("#app-archive-folder").value.trim()); else await api.verifyAppArchive(id, row.digest);
      } finally { button.disabled = false; await loadAppCandidates(); } }); card.append(button);
    }
    if (archive?.fileToken) {
      const preview = element("button", "校验并预览归档版本", "preview-app-archive");
      preview.onclick = () => action(() => openArchivedPreview(id, row.digest)); card.append(preview);
      const button = element("button", "取回并校验版本包", "retrieve-app-archive"), status = element("p", "取回时会重新检查当前权限及完整内容，不执行代码。", "app-retrieval-state");
      button.onclick = () => action(async () => {
        const epoch = viewEpoch; button.disabled = true; status.textContent = "正在取回并校验…";
        try {
          const result = await api.retrieveAppArchive(id, row.digest);
          if (epoch !== viewEpoch || id !== state.taskId || !card.isConnected) return;
          status.textContent = `本次取回内容校验通过 · ${result.bytes} 字节 · ${new Date(result.verifiedAt).toLocaleString("zh-CN")} · 已保存本机版本包，未执行或部署`;
        } catch (error) { if (card.isConnected) status.textContent = "未完成本次取回校验；不会使用旧包冒充本次成功。"; throw error; }
        finally { button.disabled = false; }
      }); card.append(button, status);
    }
    return card;
  }));
}
$("#refresh-apps").onclick = () => action(() => loadAppCandidates());
$("#app-candidate-form").onsubmit = (event) => { event.preventDefault(); action(async () => {
  const id = state.taskId, epoch = viewEpoch; $("#submit-app-candidate").disabled = true;
  try { await api.submitAppCandidate(id, $("#app-entry").value.trim()); }
  finally { $("#submit-app-candidate").disabled = false; if (epoch === viewEpoch && id === state.taskId) await loadAppCandidates(); }
}); };

async function openPreview() {
  const relative = state.file?.path, id = state.taskId; if (!relative) return;
  const closing = hidePreview(), epoch = viewEpoch; state.archivePreview = null; state.tab = "browser"; state.panelCollapsed = false; state.mobilePane = "panel"; render(); await closing;
  if (epoch !== viewEpoch) return;
  $("#preview-area").dataset.previewState = "loading";
  await loadFile(relative); if (epoch !== viewEpoch || id !== state.taskId) return;
  $("#preview-title").textContent = `正在打开 ${relative}`; $("#preview-address").textContent = `/${relative}`;
  const loading = setTimeout(() => { if (epoch === viewEpoch && id === state.taskId && $("#preview-area").dataset.previewState === "loading") $("#preview-title").textContent = `${relative} · 仍在加载…`; }, 10_000);
  let page;
  try { page = await api.previewFile(id, relative); }
  catch (cause) {
    if (epoch !== viewEpoch) return;
    $("#preview-area").dataset.previewState = "error"; $("#preview-title").textContent = "网页预览未打开 · 可以刷新重试"; $("#preview-address").textContent = `/${relative}`; renderContext(); throw cause;
  } finally { clearTimeout(loading); }
  if (epoch !== viewEpoch || id !== state.taskId) return;
  state.preview = true; state.previewPage = page; $("#preview-title").textContent = page.title || relative; $("#preview-address").textContent = page.address || `/${relative}`;
  await updateBounds();
  if (epoch !== viewEpoch || id !== state.taskId) return;
  $("#preview-area").dataset.previewState = "ready"; renderContext(); queueTaskUiSave();
}
async function openArchivedPreview(id, digest) {
  const closing = hidePreview(), epoch = viewEpoch;
  state.archivePreview = { id, digest }; state.tab = "browser"; state.panelCollapsed = false; state.mobilePane = "panel"; render(); await closing;
  if (epoch !== viewEpoch || id !== state.taskId) return;
  $("#preview-title").textContent = `正在重新核验归档版本 ${digest.slice(0, 12)}…`;
  $("#preview-area").dataset.previewState = "loading";
  let result;
  try { result = await api.previewAppArchive(id, digest); }
  catch (cause) { if (epoch !== viewEpoch) return; $("#preview-area").dataset.previewState = "error"; $("#preview-title").textContent = "归档预览未打开 · 未使用工作目录或旧缓存替代"; renderContext(); throw cause; }
  if (epoch !== viewEpoch || id !== state.taskId) return;
  state.archivePreview = { id, digest, previewId: result.previewId }; state.preview = true; state.previewPage = result;
  $("#preview-title").textContent = `归档 ${digest.slice(0, 12)} · ${result.title} · 隔离快照，${new Date(result.expiresAt).toLocaleTimeString("zh-CN")} 到期 · 不代表工作目录`;
  $("#preview-address").textContent = result.address || "归档快照";
  await updateBounds(); if (epoch !== viewEpoch || id !== state.taskId) return;
  $("#preview-area").dataset.previewState = "ready"; renderContext();
}
function updateBounds() {
  if (!state.preview) return;
  const visible = state.tab === "browser" && workbenchPanelVisible() && !$("#preview-area").hidden;
  return api.previewBounds(nativeSurfaceBounds(visible ? $("#preview-area").getBoundingClientRect() : null, visible));
}
// The embedded Feishu view is the person's own Feishu client. It renders the
// document exactly as Feishu does; the text projection beside it is what the
// model reads and what a confirmed edit is checked against, and the two never
// substitute for each other.
function updateMediaBounds() {
  if (!state.mediaPreview) return;
  const area = $("#media-preview-area");
  const visible = state.tab === "media" && workbenchPanelVisible() && area && !$("#media-preview-frame").hidden;
  return api.mediaPreviewBounds(nativeSurfaceBounds(visible ? area.getBoundingClientRect() : null, visible));
}
function updateFeishuBounds() {
  if (!state.feishuView) return;
  const area = state.feishuView === "document" ? $("#feishu-native-area")
    : FEISHU_SECTION_OF[state.feishuView] ? $("#feishu-chat-area") : $("#feishu-web-area");
  const documentVisible = state.feishuView !== "document" || (state.tab === "files" && workbenchPanelVisible());
  const visible = Boolean(area && !area.hidden && documentVisible && !nativeOverlayActive(area) && area.getClientRects().length);
  return api.feishuViewBounds(nativeSurfaceBounds(visible ? area.getBoundingClientRect() : null, visible));
}
function feishuViewControls(visible) { $("#feishu-view-reload").hidden = !visible; }
// The Feishu page is a native layer above the DOM, so an Agent panel beside it
// has to be a real column the page is measured against, not an overlay. Rather
// than build a second conversation, the one the app already has is moved into
// that column and moved back when the section is left -- it keeps its history,
// its permission control, its files and every handler already bound to it.
let dockedDocument = null, dockedWeb = null, dockPoll = 0;
function undockAgentPanel() {
  clearInterval(dockPoll); dockPoll = 0; dockedDocument = null; dockedChat = null; dockOptions = null; dockedWeb = null;
  const panel = document.getElementById("agent-panel");
  if (panel && panel.parentElement?.id !== "work-area") $("#work-area").append(panel);
}
function renderDockDocument() {
  const note = document.getElementById("feishu-dock-note");
  if (!note) return;
  // Naming what is selected is the difference between "改这篇文档" and "改这一段".
  const picked = dockedDocument?.selection;
  note.textContent = !dockedDocument
    ? "在左侧打开飞书文档、电子表格或多维表格，Agent 就能读它、改它。"
    : picked?.text ? `已选中：${picked.text.length > 40 ? `${picked.text.slice(0, 40)}…` : picked.text}`
    : picked?.label ? `已点选：${picked.label}`
    : `当前${dockedDocument.label}：${documentName(dockedDocument.title) || shortPath(dockedDocument.url)}`;
  note.classList.toggle("ready", Boolean(dockedDocument));
  // Only a mismatch is worth a line here: a document is named by its address,
  // so reading it is precise either way -- but it happens as the signed-in
  // account, not as whoever the page belongs to.
  renderDockWeb(dockedWeb?.state === "conflict" ? dockedWeb : null);
}
async function trackDockedDocument() {
  if (state.section !== "feishu-docs") return;
  const found = await api.feishuViewLocation("drive").catch(() => null);
  const web = await api.webIdentity().catch(() => dockedWeb);
  if (state.section !== "feishu-docs") return;
  if (web?.state !== dockedWeb?.state) { dockedWeb = web; renderDockDocument(); }
  // The selection changes far more often than the document does, so both are
  // compared before redrawing.
  const same = found?.url === dockedDocument?.url && found?.title === dockedDocument?.title
    && (found?.selection?.text ?? "") === (dockedDocument?.selection?.text ?? "")
    && (found?.selection?.label ?? "") === (dockedDocument?.selection?.label ?? "");
  if (same) return;
  dockedDocument = found; renderDockDocument();
}
// The messenger's half of the same idea. What is open there has no address of its
// own; the page reports the name in its header, and the main process decides
// which of this account's chats -- if any -- that name may be taken to mean
// (docked-chat.js). This side shows that decision and passes on the person's
// answer to it; it never decides a chat id itself.
//
// When Feishu renames that header there is simply no name, and the column still
// holds the Agent.
let dockedChat = null, dockOptions = null;
const dockSummary = (value) => JSON.stringify([value?.name, value?.binding, value?.key, value?.chat?.id, value?.reason, value?.by,
  value?.options?.length, value?.selection?.text ?? "", value?.web?.state, value?.web?.needsAttention, value?.web?.cause]);
// Whose Feishu the pages on the left are signed in to, as far as the control
// plane could tell. Silent once it is the signed-in person.
function webIdentityLine(web) {
  if (!web || web.state === "verified") return "";
  if (web.state === "checking") return web.needsAttention ? "左侧是飞书的授权页：确认后，侧边栏才会把网页里的会话对应到你的账号。" : "正在核对网页里登录的飞书账号…";
  if (web.state === "conflict") return "网页里登录的飞书账号不是你当前登录的账号。侧边栏不会把网页里的会话对应到你的账号；需要时请从你自己的会话里选择。";
  if (web.cause === "signed_out") return "左侧的飞书还没有登录：用手机飞书扫左侧的二维码，登录后会自动核对网页账号。";
  return `网页账号未核对${web.reason ? `（${web.reason}）` : ""}，会话需要你来对应。`;
}
function renderDockWeb(web) {
  const line = document.getElementById("feishu-dock-web");
  if (!line) return;
  const text = webIdentityLine(web);
  line.replaceChildren();
  line.hidden = !text;
  line.classList.toggle("warning", web?.state === "conflict");
  if (!text) return;
  line.append(element("span", text));
  if (web.state === "conflict" || (web.state === "unverified" && web.cause !== "unavailable" && web.cause !== "signed_out")) {
    const retry = element("button", "重新核对", "ghost"); retry.type = "button";
    retry.onclick = () => action(async () => { await api.verifyWebIdentity(); await refreshDock(); });
    line.append(retry);
  }
}
function renderDockChat() {
  const note = document.getElementById("feishu-dock-note");
  if (!note) return;
  const value = dockedChat, name = value?.name, picked = value?.selection;
  const selected = picked?.text ? ` · 已选中：${picked.text.length > 30 ? `${picked.text.slice(0, 30)}…` : picked.text}` : "";
  // Which conversation this column is holding, and why. An unbound one is the
  // shared conversation, and says so: two chats landing in one history is the
  // kind of thing nobody notices until it has happened a lot.
  note.textContent = !name ? "在左侧打开一个会话，Agent 就能对着它工作。"
    : value.binding === "bound" ? `当前会话：${name}${value.by === "picked" ? "（你选择的）" : "（已确认）"}${selected}`
    : value.binding === "candidate" ? `当前会话：${name}（还没确认对应你账号里的哪个会话，确认前 Agent 不会读写它）${selected}`
    : value.binding === "ambiguous" ? `当前会话：${name}（有 ${value.options?.length ?? 2} 个同名会话，请选一个；在那之前用的是公共对话）${selected}`
    : value.reason === "web_conflict" ? `当前会话：${name}（网页账号不一致，这里用的是公共对话）${selected}`
    : value.reason === "list_unavailable" ? `当前会话：${name}（暂时读不到会话列表，这里用的是公共对话）${selected}`
    : `当前会话：${name}（会话列表里没有同名的，这里用的是公共对话）${selected}`;
  note.classList.toggle("ready", value?.binding === "bound");
  renderDockWeb(value?.web);
  const actions = document.getElementById("feishu-dock-actions");
  if (!actions) return;
  actions.replaceChildren();
  actions.hidden = !name;
  if (!name) { dockOptions = null; renderDockPicker(); return; }
  const button = (text, className, onclick) => { const node = element("button", text, className); node.type = "button"; node.onclick = () => action(onclick); actions.append(node); };
  if (value.binding === "candidate") {
    // Remembered only while the pages are verified to be this person; otherwise
    // the answer holds for this page until anything about its sign-in changes.
    button(value.remembers ? "确认是这个会话" : "这次用这个会话", "primary", async () => {
      dockedChat = await api.confirmDockedChat(value.chat.id); dockOptions = null; renderDockChat(); await bindDockedConversation();
    });
  }
  if (value.binding === "bound") {
    button("不是这个", "ghost", async () => { dockedChat = await api.forgetDockedChat(); renderDockChat(); await bindDockedConversation(); });
  } else {
    button(value.binding === "ambiguous" ? "选择是哪一个" : "从我的会话里选", "ghost", async () => {
      dockOptions = value.binding === "ambiguous" ? { chats: value.options, complete: true } : await api.dockedChatOptions();
      renderDockPicker();
    });
  }
  renderDockPicker();
}
// The person's own chats, as the main process read them. Choosing one is the
// explicit binding the page's name alone never is.
function renderDockPicker() {
  const holder = document.getElementById("feishu-dock-picker");
  if (!holder) return;
  holder.replaceChildren();
  holder.hidden = !dockOptions?.chats?.length || !dockedChat?.name || dockedChat.binding === "bound";
  if (holder.hidden) return;
  const select = element("select"); select.id = "feishu-dock-select";
  for (const chat of dockOptions.chats) {
    const kind = chat.mode === "p2p" ? "单聊" : chat.mode === "group" ? "群" : chat.mode === "topic" ? "话题" : "";
    const option = element("option", `${chat.name}${kind ? `（${kind}）` : ""} · …${chat.id.slice(-6)}`);
    option.value = chat.id; select.append(option);
  }
  const use = element("button", "用这个会话", "primary"); use.type = "button";
  use.onclick = () => action(async () => { dockedChat = await api.confirmDockedChat(select.value); dockOptions = null; renderDockChat(); await bindDockedConversation(); });
  const cancel = element("button", "取消", "ghost"); cancel.type = "button";
  cancel.onclick = () => { dockOptions = null; renderDockPicker(); };
  holder.append(select, use, cancel);
  if (!dockOptions.complete) holder.append(element("small", "只列出了最近的会话。"));
}
async function refreshDock() {
  if (state.section === "feishu") {
    dockedChat = await api.dockedChat().catch(() => dockedChat);
    renderDockChat();
    await bindDockedConversation();
  } else if (state.section === "feishu-docs") {
    dockedWeb = await api.webIdentity().catch(() => dockedWeb);
    renderDockDocument();
  }
}
async function trackDockedChat() {
  if (state.section !== "feishu") return;
  const found = await api.dockedChat().catch(() => null);
  if (state.section !== "feishu") return;
  if (dockSummary(found) === dockSummary(dockedChat)) return;
  if (found?.name !== dockedChat?.name) dockOptions = null;
  dockedChat = found; renderDockChat();
  // At once. The decision above already waited for the chat list when it had
  // to, so the key it carries is the settled one; binding only after a second
  // round trip meant the panel went on showing the previous conversation --
  // measured against a real account, that reads as the conversations being
  // shared, which is the exact thing this is for.
  await bindDockedConversation();
}

// Which conversation the docked Agent is holding.
//
// The panel is one panel -- the application's single #agent-panel, moved into
// this column rather than rebuilt -- and until now the conversation inside it
// was one conversation too. Every Feishu chat shared it, and leaving the
// section dropped the pointer to it, so the history looked lost while the
// record sat on disk unreferenced.
//
// The key is the resolved chat id, never the name. A name is what Feishu draws
// in its header: two groups can carry the same one, and merging their histories
// silently is the one outcome nobody could detect. When no id can be had -- a
// duplicate name, a name past the thirty characters the header gives up, a chat
// list that will not open -- the panel falls back to one shared conversation
// and the column says so, rather than refusing to work.
async function bindDockedConversation() {
  if (state.section !== "feishu") return;
  const key = dockedChat?.key ?? UNBOUND_CHAT;
  // A conversation started while the page was unbound, and the person then
  // picked or confirmed the chat: it belongs to that chat. Re-bound now -- the
  // main process decides the key again -- and treated as current so the lookup
  // below does not walk away from the conversation being had.
  const waiting = state.pendingBind;
  if (waiting && key !== UNBOUND_CHAT && waiting.name === dockedChat?.name) {
    saveDraft(); await flushTaskUi().catch(() => {});
    state.pendingBind = null;
    await api.bindFeishuChat(waiting.id).catch(() => {});
    state.snapshot = await api.snapshot().catch(() => state.snapshot);
    state.dockedKey = key; state.taskId = waiting.id; await restoreTaskUi(waiting.id); render();
    return;
  }
  if (waiting && waiting.name !== dockedChat?.name) state.pendingBind = null;
  if (state.dockedKey === key) return;
  state.dockedKey = key;
  saveDraft(); await flushTaskUi().catch(() => {});
  // Read fresh rather than trusted: the binding is written by the main process
  // after the task exists, so whatever this renderer last held may predate it.
  // One call, on a chat switch that already makes one.
  state.snapshot = await api.snapshot().catch(() => state.snapshot);
  // The record already persists; what was missing was the way back to it.
  state.taskId = conversationFor(state.snapshot?.tasks, key);
  state.tab = "chat";
  if (state.taskId) await restoreTaskUi(state.taskId); else await restoreTaskUi("draft:cowork");
  render();
  // On the element rather than in a log: which chat this column is bound to, and
  // which conversation it chose, are the two facts every question about this
  // needs, and inferring them from what is drawn is how three wrong diagnoses
  // happened. Read by scripts/smoke-feishu-dock-live.js.
  const note = document.getElementById("feishu-dock-note");
  if (note) { note.dataset.chatKey = key; note.dataset.taskId = state.taskId ?? ""; }
}
// One embedded section, two uses: Feishu's messenger and Feishu's document home.
const FEISHU_SECTION_OF = { messenger: "feishu", drive: "feishu-docs" };
// Feishu's own app rail repeats the navigation this app already has down the
// left, so the messenger opens on the conversation. The choice is a per-machine
// preference and never leaves this profile.
function feishuRailHidden() {
  try { return remembered("feishu-rail") !== "shown"; } catch { return true; }
}
// The area moves and shrinks without any resize or scroll event when something
// above it grows -- the extras row, the error banner -- so it is watched itself.
const feishuAreaObserver = new ResizeObserver(() => { updateFeishuBounds()?.catch(() => {}); });
async function mountFeishuSection(library, kind, epoch) {
  // Feishu's own page fills the area: no card, no page margins, no heading and
  // no strip of its own. The one control this app adds lives in the toolbar
  // that is already on screen, so nothing here costs the page a row. It cannot
  // float over the page either — the page is a native layer above the DOM, so
  // anything drawn on top of it would be hidden underneath.
  library.classList.add("feishu-fill");
  library.querySelector("h1")?.remove();
  const area = element("div"); area.id = "feishu-chat-area";
  feishuAreaObserver.disconnect(); feishuAreaObserver.observe(area);
  // Two real columns: Feishu's own page on the left, this app's Agent on the
  // right. The native view is positioned from `area`, so shrinking the column is
  // what makes room -- nothing is drawn over the page. Both embedded sections get
  // one: a document to work on in 飞书文档, the open conversation in 飞书消息.
  library.classList.add("feishu-docs-split");
  const dock = element("div"); dock.id = "feishu-agent-dock";
  const head = element("div", undefined, "feishu-dock-head");
  head.append(element("strong", kind === "drive" ? "与 Agent 一起改这份内容" : "与 Agent 一起处理这个会话"));
  const note = element("small", "", "feishu-dock-note"); note.id = "feishu-dock-note";
  const web = element("small", "", "feishu-dock-web"); web.id = "feishu-dock-web"; web.hidden = true;
  const actions = element("div", undefined, "feishu-dock-actions"); actions.id = "feishu-dock-actions"; actions.hidden = true;
  const picker = element("div", undefined, "feishu-dock-picker"); picker.id = "feishu-dock-picker"; picker.hidden = true;
  head.append(note, web, actions, picker);
  dock.append(head, $("#agent-panel"));
  library.append(area, dock);
  const track = kind === "drive" ? trackDockedDocument : trackDockedChat;
  if (kind === "drive") renderDockDocument(); else renderDockChat();
  void track();
  clearInterval(dockPoll);
  // The person navigates inside Feishu's own page, so what is open there can only
  // be observed, not subscribed to.
  dockPoll = setInterval(() => { void track(); }, 1500);
  if (state.feishuView !== kind) {
    try {
      // Measured before the view is shown, so it appears already in place
      // instead of being revealed at its warm-up size and then jumping.
      const rect = area.getBoundingClientRect();
      const opened = await api.openFeishuView({ kind, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
      // A stale completion must not close a newer section's native view.
      if (opened?.cancelled || epoch !== viewEpoch || state.section !== FEISHU_SECTION_OF[kind]) return;
      state.feishuView = kind;
      await api.feishuViewRail(feishuRailHidden());
    } catch (cause) {
      // Why the page is not here belongs on the page, not only in the banner
      // across the top with an empty area underneath it.
      if (epoch !== viewEpoch) return;
      // Without the page there is no split to hold: give the Agent panel back
      // rather than leaving an empty column beside an error.
      library.classList.remove("feishu-fill", "feishu-docs-split");
      undockAgentPanel();
      document.getElementById("feishu-agent-dock")?.remove();
      area.className = "feishu-unavailable";
      if (!area.isConnected) library.append(area);
      area.append(element("h2", kind === "messenger" ? "还打不开飞书消息" : "还打不开飞书文档"), element("p", readableError(cause)));
      error("");
    }
  }
  if (state.feishuView === kind) {
    requestAnimationFrame(() => { area.scrollIntoView({ block: "nearest" }); requestAnimationFrame(() => { void updateFeishuBounds()?.catch(() => {}); }); });
  }
}
async function closeFeishuView() {
  state.feishuView = null;
  $("#feishu-native-area").hidden = true;
  $("#file-text-view").hidden = false; $("#file-content").hidden = false;
  $("#feishu-native-view").setAttribute("aria-pressed", "false");
  $("#feishu-native-view").textContent = "飞书原样";
  feishuViewControls(false);
  await api.hideFeishuView();
}
async function openFeishuDocumentView() {
  if (!state.document) throw new Error("请先打开一个飞书文档");
  const document = state.document, epoch = viewEpoch;
  const opened = await api.openFeishuView({ kind: "document", url: document.sourceUrl });
  if (opened?.cancelled || epoch !== viewEpoch || document !== state.document) return;
  state.feishuView = "document";
  $("#file-text-view").hidden = true;
  $("#feishu-native-area").hidden = false;
  $("#feishu-native-view").setAttribute("aria-pressed", "true");
  $("#feishu-native-view").textContent = "文本视图";
  feishuViewControls(true);
  await updateFeishuBounds();
}
for (const button of document.querySelectorAll("[data-section]")) button.onclick = () => action(() => switchSection(button.dataset.section));
for (const button of document.querySelectorAll("[data-tab]")) button.onclick = () => action(() => switchTab(button.dataset.tab));
$("#task-search").oninput = event => { state.taskSearch = event.target.value.slice(0, 200); renderSidebar(); };
$("#show-archived").onclick = () => { state.showArchived = !state.showArchived; renderSidebar(); };
$("#messages").addEventListener("scroll", captureConversationScroll, { passive: true });
$("#file-content").addEventListener("scroll", () => { $("#file-line-numbers").scrollTop = $("#file-content").scrollTop; }, { passive: true });
$("#jump-latest").onclick = () => { state.scrollState = { offset: 0, followLatest: true }; restoreConversationScroll(); queueTaskUiSave(); };
async function openNewTaskDraft() {
  const section = state.section === "coding" ? "coding" : "cowork";
  if (activeWorkbenchLayout.sidebarOverlay) state.sidebarPreference = "closed";
  if (state.section !== section) { await switchSection(section); $("#prompt").focus(); return; }
  const current = task();
  saveDraft(); await flushTaskUi().catch(() => {}); const closing = hidePreview(); clearArtifact();
  // /new and the top button inherit a coding task's project by task id. The
  // renderer shows the path, but only the main process resolves it when the new
  // record is created. With no current task, an already selected draft folder
  // remains selected.
  if (section === "coding" && current?.mode === "coding") state.draftWorkspace = { taskId: current.id, path: current.cwd };
  else if (section !== "coding") state.draftWorkspace = null;
  state.taskId = null; state.draftPermission = null; state.tab = "chat";
  await restoreTaskUi(`draft:${section}`); error(""); render(); await closing;
  if (section === "coding" && !state.draftWorkspace) await loadRecentProjects(viewEpoch);
  $("#prompt").focus();
}
$("#new-task").onclick = () => action(openNewTaskDraft);
$("#settings").onclick = () => action(() => switchSection("settings"));
// A clicked schedule notification lands on 定时任务 → 运行记录, where its run is.
api.onOpenScheduleRuns?.(() => { pendingScheduleTab = "runs"; void action(() => switchSection("schedules")); });
// A card's notification, clicked: open the task the card waits in, from
// wherever the person is (main.js announceConfirmation).
api.onOpenTask?.(({ taskId } = {}) => void action(async () => {
  if (typeof taskId !== "string") return;
  const target = state.snapshot.tasks.find((row) => row.id === taskId) ?? (await api.snapshot()).tasks.find((row) => row.id === taskId);
  if (target && !(state.section === target.mode && state.taskId === taskId)) await openTask(target);
}));
// A task an Agent drafted in a conversation (G5): shown in 定时任务, in the same
// dialog as any other, and created only by the person's 确定 there.
// Never over a dialog the person is in: the section redraws to show the draft,
// and whatever they were typing would go with it. They hear nothing; the Agent
// is told to wait.
api.onScheduleDraft?.((value) => {
  if (document.querySelector("dialog[open]")) { void api.settleScheduleDraft(value?.id, { busy: true }).catch(() => {}); return; }
  pendingScheduleDraft = value; void action(() => switchSection("schedules"));
});
$("#pick-workspace").onclick = () => action(async () => {
  const picked = await api.pickWorkspace();
  if (!picked) return;
  state.draftWorkspace = { ...picked, unavailable: false };
  state.recents = [picked, ...state.recents.filter((item) => item.path !== picked.path)];
  render();
});
$("#project-chip").onclick = () => { if (!task()) $("#pick-workspace").click(); };
// The panel is narrow, and six buttons across a narrow header wrap in the
// middle of words. Only the two that get used constantly stay on the header;
// the rest live behind one control that never changes width.
function closeFileMenu() { $("#file-menu").hidden = true; $("#file-menu-toggle").setAttribute("aria-expanded", "false"); }
$("#file-menu-toggle").onclick = () => {
  const open = $("#file-menu").hidden;
  $("#file-menu").hidden = !open; $("#file-menu-toggle").setAttribute("aria-expanded", open ? "true" : "false");
};
document.addEventListener("pointerdown", (event) => { if (!$(".file-menu-field").contains(event.target)) closeFileMenu(); }, true);
for (const id of ["#refresh-files", "#reveal-folder", "#show-document-url", "#show-local-files", "#upload-to-drive"]) $(id).addEventListener("click", closeFileMenu);
// Menus own navigation keys before the composer does. In particular, the first
// Escape closes the open menu and returns focus; only a later Escape in the
// plain input may stop a running task.
document.addEventListener("keydown", (event) => {
  const opened = mention.open ? { menu: $("#mention-menu"), close: closeMentions, focus: $("#prompt") }
    : !$("#permission-menu").hidden ? { menu: $("#permission-menu"), close: closePermissionMenu, focus: $("#permission-toggle") }
      : !$("#knowledge-scope-menu").hidden ? { menu: $("#knowledge-scope-menu"), close: closeKnowledgeMenu, focus: $("#knowledge-scope-toggle") }
        : !$("#file-menu").hidden ? { menu: $("#file-menu"), close: closeFileMenu, focus: $("#file-menu-toggle") } : null;
  if (!opened) return;
  if (event.key === "Escape") {
    event.preventDefault(); event.stopImmediatePropagation(); opened.close(); opened.focus.focus(); return;
  }
  if (!["ArrowDown", "ArrowUp"].includes(event.key) || mention.open) return;
  const choices = [...opened.menu.querySelectorAll('button:not([disabled]),input:not([disabled])')];
  if (!choices.length) return;
  event.preventDefault(); event.stopImmediatePropagation();
  const current = choices.indexOf(document.activeElement), step = event.key === "ArrowDown" ? 1 : -1;
  choices[(current + step + choices.length) % choices.length].focus();
}, true);
// 上传是一次真实的对外写入，所以它不是一个直接生效的菜单项：先露出目标文件夹，
// 确认要传到哪里，再选文件；每一次都要在应用内看过确认框才会真的发出去。
$("#upload-to-drive").onclick = () => {
  const form = $("#drive-upload-form");
  form.hidden = !form.hidden;
  if (!form.hidden) { $("#drive-upload-folder").focus(); $("#drive-upload-note").textContent = ""; }
};
$("#drive-upload-form").onsubmit = (event) => { event.preventDefault(); action(async () => {
  const button = $("#drive-upload-pick"), note = $("#drive-upload-note");
  button.disabled = true; note.textContent = "正在核验目标文件夹与配额…";
  try {
    const receipt = await api.uploadToDrive({ folderUrl: $("#drive-upload-folder").value.trim() });
    if (!receipt) { note.textContent = "已取消，没有上传任何东西。"; return; }
    note.replaceChildren(document.createTextNode(`已上传「${receipt.originalName}」· `));
    const link = element("button", "在飞书打开"); link.type = "button";
    link.onclick = () => action(() => api.openDriveFile(receipt.url));
    note.append(link);
  } finally { button.disabled = false; }
}); };
$("#compact-task").onclick = () => action(async () => {
  const button = $("#compact-task"); button.disabled = true; button.textContent = "压缩中…";
  try { if (await api.compactTask(state.taskId)) state.snapshot = await api.snapshot(); }
  finally { button.textContent = "压缩对话"; render(); }
});
// Taking turns back -- the last one (撤回上一轮, /undo) or back to an earlier
// one (回到这里) -- as Claude Code's rewind and Codex's backtrack do: the card
// says what goes and which files come back, and what was asked at that turn
// returns to the empty input box, to be changed and sent again.
async function rewindTo(turns, text) {
  const id = state.taskId;
  if (await api.rollbackTask(id, turns)) {
    state.snapshot = await api.snapshot();
    if (state.taskId === id && !$("#prompt").value.trim() && typeof text === "string") { $("#prompt").value = text; saveDraft(); $("#prompt").focus(); }
  }
  render();
}
$("#rollback-task").onclick = () => action(() => rewindTo(1, task()?.messages.findLast((message) => message.role === "user" && !message.steered)?.text));
async function requestStop() {
  if (!state.taskId || state.stopPending || task()?.status === "stopping" || !busy()) return;
  disarmStop();
  state.stopPending = true; renderComposerState();
  try { await api.stop(state.taskId); }
  catch (cause) { state.stopPending = false; renderComposerState(); throw cause; }
}
// Esc stops a running turn, as in Codex and Claude Code -- on the second press
// within three seconds, as WorkBuddy's stop shortcut does. Esc is also what
// closes a menu or a picker, and one pressed for that ended the turn.
function disarmStop() {
  stopArmedUntil = 0; clearTimeout(stopArmTimer);
  const hint = document.getElementById("stop-hint"); if (hint) hint.hidden = true;
}
function escapeToStop() {
  if (Date.now() < stopArmedUntil) return action(requestStop);
  stopArmedUntil = Date.now() + 3000; $("#stop-hint").hidden = false;
  clearTimeout(stopArmTimer); stopArmTimer = setTimeout(disarmStop, 3000);
}
// ---- @ in the composer ----
// Typing @ offers people and groups from the signed-in person's Feishu
// directory. A pick is sent with the message as data (src/application/
// mentions.js), so the Agent is told exactly who rather than left to guess
// between two colleagues with the same name. Picking only guides: a send still
// resolves its recipients through the application's own lookup.
function mentionTrigger() {
  const box = $("#prompt"), caret = box.selectionStart ?? 0;
  if (box.selectionEnd !== caret) return null;
  const before = box.value.slice(0, caret), coding = state.section === "coding";
  // In a coding task, / at the start of the message is a command.
  if (coding) { const slash = /^\/([A-Za-z0-9_/-]*)$/.exec(before); if (slash) return { kind: "command", start: 0, query: slash[1] }; }
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  const query = before.slice(at + 1);
  // In a coding task, @ names a file of the project: a path, after a space or
  // at the start, as Codex and Claude Code take it.
  if (coding) return query.length > 120 || /[\s@]/u.test(query) || (at > 0 && !/\s/u.test(before[at - 1])) ? null : { kind: "file", start: at, query };
  if (query.length > 20 || /[\s@]/u.test(query)) return null;
  // An @ inside an address (name@corp.com) is not someone being mentioned.
  if (at > 0 && /[A-Za-z0-9._%+-]/u.test(before[at - 1])) return null;
  return { kind: "people", start: at, query };
}
function closeMentions() {
  mention.open = false; mention.results = []; mention.note = ""; mention.query = ""; clearTimeout(mention.timer); mention.seq++;
  $("#mention-menu").hidden = true; $("#prompt").removeAttribute("aria-activedescendant");
}
function paintMentions() {
  const menu = $("#mention-menu");
  menu.replaceChildren();
  if (!mention.open) { menu.hidden = true; return; }
  menu.hidden = false;
  if (!mention.results.length) { menu.append(element("p", mention.note || (mention.kind === "file" ? "输入文件名或路径" : "输入姓名、邮箱或群名"), "mention-note")); return; }
  mention.results.forEach((entry, index) => {
    const option = element("button", undefined, "mention-option"); option.type = "button"; option.id = `mention-option-${index}`;
    option.setAttribute("role", "option"); option.setAttribute("aria-selected", String(index === mention.active));
    const text = element("span", undefined, "mention-text");
    if (entry.kind === "command") {
      text.append(element("strong", `/${entry.name} · ${entry.label}`), element("small", entry.detail));
      option.append(element("span", "/", "mention-face command"), text);
    } else if (entry.kind === "model") {
      text.append(element("strong", `${entry.label}${entry.current ? " · 当前" : ""}`), element("small", entry.detail));
      option.append(element("span", "◆", "mention-face command"), text);
    } else if (entry.kind === "review") {
      text.append(element("strong", entry.label), element("small", entry.detail));
      option.append(element("span", "◆", "mention-face command"), text);
    } else if (entry.kind === "file") {
      const slash = entry.path.lastIndexOf("/");
      text.append(element("strong", entry.path.slice(slash + 1)), element("small", slash > 0 ? entry.path.slice(0, slash) : "项目根目录"));
      option.append(element("span", "@", "mention-face file"), text);
    } else {
    text.append(element("strong", entry.name), element("small", entry.kind === "group"
      ? `群聊${entry.memberCount ? ` · ${entry.memberCount} 人` : ""}` : [entry.department, entry.email].filter(Boolean).join(" · ") || "同事"));
    option.append(element("span", entry.kind === "group" ? "群" : [...entry.name][0] ?? "?", `mention-face${entry.kind === "group" ? " group" : ""}`), text);
    }
    // mousedown, not click: a click would blur the textarea first and lose the caret.
    option.onmousedown = event => { event.preventDefault(); pickMention(index); };
    menu.append(option);
  });
  $("#prompt").setAttribute("aria-activedescendant", `mention-option-${mention.active}`);
  menu.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
}
function updateMentions() {
  const trigger = mentionTrigger();
  if (!trigger) { if (mention.open) closeMentions(); return; }
  mention.open = true; mention.start = trigger.start;
  if (trigger.kind === mention.kind && trigger.query === mention.query && (mention.results.length || mention.note)) { paintMentions(); return; }
  mention.kind = trigger.kind; mention.query = trigger.query; mention.active = 0; mention.results = [];
  clearTimeout(mention.timer);
  if (trigger.kind === "command") {
    const query = trigger.query.toLowerCase();
    mention.results = [...SLASH_COMMANDS.filter((command) => command.name.startsWith(query)).map((command) => ({ kind: "command", ...command })),
      ...projectCommandsHere().filter((command) => command.name.toLowerCase().startsWith(query) || command.aliases?.some((alias) => alias.toLowerCase().startsWith(query))).map((command) => ({ kind: "command", project: true, name: command.name,
        label: command.description || "项目命令", detail: `${command.source}${command.argumentHint ? ` · ${command.argumentHint}` : ""}`, takesArguments: command.takesArguments }))];
    mention.note = mention.results.length ? "" : `没有 /${trigger.query} 这个命令`;
    paintMentions();
    // Read again when it may have changed; the menu is redrawn if it did.
    void refreshProjectCommands().then((changed) => { if (changed && mention.open && mention.kind === "command") { mention.query = null; updateMentions(); } });
    return;
  }
  if (trigger.kind === "file") {
    mention.note = "正在查找文件…"; paintMentions();
    const seq = ++mention.seq, query = trigger.query;
    mention.timer = setTimeout(async () => {
      try {
        const found = await api.searchProjectFiles({ ...projectFolderRef(), query });
        if (seq !== mention.seq || !mention.open) return;
        mention.results = found.map((file) => ({ kind: "file", path: file }));
        mention.note = mention.results.length ? "" : `项目里没有匹配「${query}」的文件`;
      } catch (cause) {
        if (seq !== mention.seq) return;
        mention.results = []; mention.note = readableError(cause);
      }
      mention.active = 0; paintMentions();
    }, 120);
    return;
  }
  if (!trigger.query) { mention.note = "输入姓名、邮箱或群名"; paintMentions(); return; }
  mention.note = "正在搜索…"; paintMentions();
  const seq = ++mention.seq, query = trigger.query;
  mention.timer = setTimeout(async () => {
    try {
      const found = await api.searchPeople(query);
      if (seq !== mention.seq || !mention.open) return;
      mention.results = [...found.groups.map(group => ({ kind: "group", ...group })), ...found.users.map(user => ({ kind: "user", ...user }))];
      mention.note = mention.results.length ? "" : `没有找到「${query}」`;
    } catch (cause) {
      if (seq !== mention.seq) return;
      mention.results = []; mention.note = readableError(cause);
    }
    mention.active = 0; paintMentions();
  }, 250);
}
function pickMention(index) {
  const entry = mention.results[index]; if (!entry) return;
  if (entry.kind === "command" && entry.project && entry.takesArguments) {
    const box = $("#prompt"); box.value = `/${entry.name} `; box.setSelectionRange(box.value.length, box.value.length);
    closeMentions(); saveDraft(); box.focus(); return;
  }
  if (entry.kind === "command") { closeMentions(); $("#prompt").value = ""; saveDraft(); void action(() => runSlashCommand(entry.name)); return; }
  if (entry.kind === "model") {
    closeMentions(); $("#prompt").value = ""; saveDraft();
    void action(async () => { const chosen = await api.selectModel(entry.slug); modelNote(chosen); });
    return;
  }
  if (entry.kind === "review") { closeMentions(); sendReview(entry.target, entry.message); return; }
  if (entry.kind === "file") {
    const box = $("#prompt"), caret = box.selectionStart ?? box.value.length, inserted = `@${entry.path} `;
    box.value = box.value.slice(0, mention.start) + inserted + box.value.slice(caret);
    const at = mention.start + inserted.length; box.setSelectionRange(at, at);
    const slash = entry.path.lastIndexOf("/"), pick = { kind: "file", key: `workspace:${entry.path}`, path: entry.path, title: entry.path.slice(slash + 1), state: "current" };
    if (!mention.picks.some(item => draftReferenceKey(item) === draftReferenceKey(pick))) mention.picks = [...mention.picks, pick];
    closeMentions(); paintMentionRow(); saveDraft(); box.focus(); return;
  }
  const box = $("#prompt"), caret = box.selectionStart ?? box.value.length, inserted = `@${entry.name} `;
  box.value = box.value.slice(0, mention.start) + inserted + box.value.slice(caret);
  const at = mention.start + inserted.length; box.setSelectionRange(at, at);
  const pick = entry.kind === "group" ? { kind: "group", name: entry.name } : { kind: "user", name: entry.name, department: entry.department || "", email: entry.email || "" };
  if (!mention.picks.some(item => item.kind === pick.kind && (item.email || item.name) === (pick.email || pick.name))) mention.picks = [...mention.picks, pick];
  closeMentions(); paintMentionRow(); saveDraft(); box.focus();
}
// A coding task's commands (SLASH_COMMANDS). The two that are requests to the
// Agent go as a message, like anything typed; the rest act on the conversation
// or open something, the way the same command does in Codex or Claude Code.
// A review goes as a turn of its own through the composer, so a task is made
// first when there is none, like anything sent; what it looks at rides along.
function sendReview(target, message) {
  pendingReview = { target, message };
  $("#prompt").value = message;
  // After this event, for the reason given at /init below.
  setTimeout(() => $("#composer").requestSubmit(), 0);
}
// A project's own slash commands (.claude/commands, .codex/prompts), read
// through the main process. The last answer is shown at once and the files are
// read again whenever the / menu changes -- a handful of small files, and a
// command added a moment ago must be there (a few seconds' cache hid one).
const projectCommandCache = { key: null, list: [], seq: 0 };
const projectFolderKey = () => state.taskId ? `task:${state.taskId}` : state.draftWorkspace?.taskId ? `source-task:${state.draftWorkspace.taskId}` : state.draftWorkspace?.id ? `workspace:${state.draftWorkspace.id}` : null;
const projectFolderRef = () => state.taskId ? { taskId: state.taskId } : state.draftWorkspace?.taskId ? { taskId: state.draftWorkspace.taskId } : { workspaceId: state.draftWorkspace?.id };
const projectCommandsHere = () => projectCommandCache.key === projectFolderKey() ? projectCommandCache.list : [];
// Only the latest read counts, and a failed one leaves the last answer alone.
async function refreshProjectCommands() {
  const key = projectFolderKey(), seq = ++projectCommandCache.seq;
  if (!key) return false;
  const list = await api.projectCommands(projectFolderRef()).catch(() => null);
  if (!list || seq !== projectCommandCache.seq) return false;
  const changed = projectCommandCache.key !== key || JSON.stringify(list) !== JSON.stringify(projectCommandCache.list);
  Object.assign(projectCommandCache, { key, list });
  return changed;
}
// What was expanded from a project command, until the composer sends it.
let pendingCommand = null, pendingPlanningAction = null;
// A project command's text, filled in with what followed it, goes as a
// message like anything typed, marked with the command it came from.
async function runProjectCommand(name, args = "") {
  if (busy()) throw new Error("任务进行中，等这一轮结束再用这个命令");
  const expanded = await api.projectCommand({ ...projectFolderRef(), name, args });
  pendingCommand = expanded;
  $("#prompt").value = expanded.text;
  // After this event, for the reason given at /init below.
  setTimeout(() => $("#composer").requestSubmit(), 0);
}
async function runSlashCommand(name, args = "") {
  if (!SLASH_COMMANDS.some((command) => command.name === name)) return runProjectCommand(name, args);
  const need = (selector, why) => { const node = $(selector); if (!task() || node.hidden || node.disabled) throw new Error(why); node.click(); };
  if (name === "undo") return need("#rollback-task", busy() ? "任务进行中，停止后才能撤回" : "还没有可以撤回的一轮");
  if (name === "compact") return need("#compact-task", busy() ? "任务进行中，停止后才能压缩" : "还没有可以压缩的对话");
  if (name === "diff") return openDiffPanel();
  if (name === "new") return $("#new-task").click();
  if (name === "permissions") return $("#permission-toggle").click();
  // Codex's /model: the choices in the same menu, kept by the server.
  if (name === "model") {
    const options = await api.modelOptions();
    const kept = options.kept === "server", passedOver = new Set((options.unavailable ?? []).map((row) => row.slug));
    const rows = [...(kept ? [{ kind: "model", slug: null, label: `跟随服务端默认（${options.available.find((model) => model.slug === options.default)?.label ?? options.default}）`,
      detail: "管理员改默认时自动跟着改", current: options.choice === null }] : []),
      ...options.available.map((model) => ({ kind: "model", slug: model.slug, label: `${model.label}${passedOver.has(model.slug) ? "（暂不可用）" : ""}`,
        detail: model.vendor ? `${model.vendor}${model.slug === options.current ? " · 现在用的就是它" : ""}` : "", current: kept ? options.choice === model.slug : options.current === model.slug }))];
    if (rows.length < 2) throw new Error("服务端当前只提供一个模型");
    const box = $("#prompt"); box.focus();
    mention.open = true; mention.kind = "model"; mention.start = 0; mention.query = ""; mention.results = rows; mention.note = "";
    mention.active = Math.max(0, rows.findIndex((row) => row.current)); paintMentions();
    return;
  }
  if (name === "status") return openStatusDialog();
  // Codex's /review: its own review mode (review/start), pointed at the
  // uncommitted changes, another branch or one commit -- or, with words after
  // the command, at what they ask for.
  if (name === "review") {
    if (busy()) throw new Error("任务进行中，等这一轮结束再用这个命令");
    if (args) return sendReview({ type: "custom", instructions: args }, `审查：${args}`);
    const targets = await api.reviewTargets(projectFolderRef());
    if (!targets.repository) throw new Error("这个目录还不是 Git 仓库，没有可以对比的基准；可以在「查看改动」里初始化 Git 仓库，或者在 /review 后面写上要审查什么");
    const rows = [{ kind: "review", target: { type: "uncommittedChanges" }, label: "未提交的改动", detail: "工作目录里还没提交的改动，包括新文件", message: "审查：未提交的改动" },
      ...targets.branches.map((branch) => ({ kind: "review", target: { type: "baseBranch", branch }, label: `对比分支 ${branch}`,
        detail: `${targets.branch ? `当前分支 ${targets.branch}` : "当前"}相对 ${branch} 的改动`, message: `审查：对比分支 ${branch}` })),
      ...targets.commits.map((commit) => ({ kind: "review", target: { type: "commit", sha: commit.sha, title: commit.title }, label: `提交 ${commit.sha.slice(0, 7)}`,
        detail: commit.title || "（没有说明）", message: `审查：提交 ${commit.sha.slice(0, 7)}${commit.title ? ` ${commit.title}` : ""}` }))];
    const box = $("#prompt"); box.focus();
    mention.open = true; mention.kind = "review"; mention.start = 0; mention.query = ""; mention.results = rows; mention.note = "";
    mention.active = 0; paintMentions();
    return;
  }
  if (name === "init") {
    if (busy()) throw new Error("任务进行中，等这一轮结束再用这个命令");
    pendingPlanningAction = "init";
    $("#prompt").value = INIT_PROMPT;
    // After this event: a command typed and sent with Enter runs inside the
    // form's own submit, and a form ignores requestSubmit() while it is firing
    // one -- /review typed that way sent nothing (measured with the real app).
    setTimeout(() => $("#composer").requestSubmit(), 0);
    return;
  }
  throw new Error(`没有 /${name} 这个命令`);
}
// 文档网站: what this person has made for other people to open. Two kinds, one
// list -- a site whose numbers follow a Feishu table, and a site that is just
// files, which is what a small game is. The page itself is written in a coding
// task; this section owns what the site is, not how it is built.
// The words Feishu's own sharing panel uses, so somebody who has shared a
// document does not have to learn a second vocabulary for the same thing.
const SHARE_SCOPES = Object.freeze([
  { id: "invited", label: "仅邀请的人可访问", detail: "只有你，和你加进来的人。" },
  { id: "tenant", label: "组织内获得链接的人可阅读", detail: "同一个组织里，拿到链接的人都能打开。" },
  { id: "anyone", label: "互联网上获得链接的人可阅读", detail: "任何拿到链接的人都能打开，不用登录。", needsDeployment: true },
]);
const scopeWord = (id) => SHARE_SCOPES.find((scope) => scope.id === id)?.label ?? "未发布";

function sitePublishWarning(problems) {
  const named = problems.slice(0, 3).map((item) => item.path ? `${item.path}（${item.reason}）` : item.reason);
  return `发布前要处理：${named.join("、")}${problems.length > 3 ? ` 等 ${problems.length} 处` : ""}`;
}
function siteLine(site) {
  const when = site.lastReadAt ? new Date(site.lastReadAt).toLocaleString("zh-CN", { hour12: false }) : null;
  const where = !site.published ? "未发布"
    : site.offline ? "已下线（版本还在，可重新发布）"
    : `已发布 · ${site.publishedInherit ? "跟随表格权限" : scopeWord(site.publishedScope)}`;
  if (site.kind !== "table") return `只有文件，不接表格 · ${where}`;
  const every = site.refreshSeconds % 60 === 0 ? `${site.refreshSeconds / 60} 分钟` : `${site.refreshSeconds} 秒`;
  // The reading is done here, with this person's own Feishu identity, so it
  // happens while the application is open. Say that instead of letting "每 N
  // 分钟" imply a server is doing it -- somebody who closes the app and expects
  // the published page to keep following the table has been misled by a
  // sentence, which is worse than not having the sentence.
  const clock = !site.published || site.offline ? `每 ${every}（发布后开始自动读取）`
    : `每 ${every} 自动读取（应用开着时）`;
  return `接了表格 · ${site.fields} 个字段 · ${site.rowCount} 行${site.truncated ? "（已截断）" : ""} · ${clock}`
    + (when ? ` · 上次 ${when}` : " · 还没读过") + ` · ${where}`;
}

// The sharing panel. Who may open it, in Feishu's words -- and for a site built
// on a table, the option that means "whoever may read that table", which is the
// only one with no second list to keep in step.
function pickShare(site, { anonymousAllowed }) {
  return new Promise((resolve) => {
    const dialog = element("dialog", undefined, "diff-dialog share-dialog");
    const head = element("header");
    head.append(element("strong", site.published ? "谁可以打开" : "发布并设置谁可以打开"));
    const close = element("button", "取消"); close.type = "button"; close.onclick = () => dialog.close();
    head.append(close);
    const body = element("div", undefined, "diff-dialog-body");
    let chosen = site.publishedScope ?? "invited";
    let inherit = site.publishedInherit === true || (site.kind === "table" && !site.published);
    const options = element("div", undefined, "share-scopes");
    const paint = () => {
      options.replaceChildren();
      if (site.kind === "table") {
        const row = element("label", undefined, "share-scope");
        const box = element("input"); box.type = "radio"; box.name = "share"; box.checked = inherit; box.id = "share-inherit";
        box.onchange = () => { inherit = true; paint(); };
        row.append(box, element("strong", "跟随表格权限"), element("small", "在飞书里能读这张表的人就能打开；在飞书里移除，这里立刻打不开。", "share-detail"));
        options.append(row);
      }
      for (const scope of SHARE_SCOPES) {
        if (scope.needsDeployment && !anonymousAllowed) continue;
        const row = element("label", undefined, "share-scope");
        const box = element("input"); box.type = "radio"; box.name = "share"; box.checked = !inherit && chosen === scope.id;
        box.id = `share-${scope.id}`;
        box.onchange = () => { inherit = false; chosen = scope.id; paint(); };
        row.append(box, element("strong", scope.label), element("small", scope.detail, "share-detail"));
        options.append(row);
      }
    };
    paint();
    const note = element("p", site.kind === "table"
      ? "网页上显示的是你选定的那些字段。发布出去，就等于把这份数据交给能打开它的人。"
      : "发布的是这个目录里的静态文件。", "diff-dialog-note");
    const go = element("button", site.published ? "保存" : "发布", "primary"); go.type = "button"; go.id = "share-confirm";
    let answer = null;
    go.onclick = () => { answer = { scope: inherit ? "invited" : chosen, inherit, members: [] }; dialog.close(); };
    body.append(options, note, go);
    dialog.append(head, body);
    dialog.onclose = () => { dialog.remove(); resolve(answer); };
    document.body.append(dialog); dialog.showModal();
  });
}
async function renderSites(library) {
  const rows = await api.sites().catch(() => []);
  // Whether this deployment allows a link with no sign-in at all is the
  // server's answer, not a checkbox here.
  const anonymousAllowed = (await api.sitePublished().catch(() => null))?.anonymousAllowed === true;
  const head = element("div", undefined, "site-actions");
  const create = element("button", "新建网站", "primary"); create.type = "button"; create.id = "site-new";
  head.append(create);
  const hint = element("p", "放在这里的网站可以发布给别人打开：接了飞书表格的，数值会跟着表格走；只有文件的（比如自己写的小游戏），发布出去就能玩。页面本身在编程任务里写。", "sc-hint");
  const list = element("div", undefined, "site-list"); list.id = "site-list";
  if (!rows.length) list.append(element("p", "还没有网站。", "sc-hint"));
  // The templates themselves, each openable as a live page with sample data in
  // it -- you can sort it, filter it and play the game before choosing. 妙搭's
  // case centre does the same thing, and it is the most honest thing this
  // section can say about what it makes.
  //
  // Always here, not only while the list is empty: it is how somebody starts
  // the second site too, and it is the one place that shows what this can look
  // like.
  const gallery = element("section", undefined, "site-gallery"); gallery.id = "site-gallery";
  for (const site of rows) {
    const row = element("div", undefined, "site-row"); row.dataset.site = site.id;
    const text = element("div", undefined, "site-text");
    text.append(element("strong", site.name, "site-name"), element("small", siteLine(site), "site-meta"));
    // What 发布 would refuse, named here first rather than by the refusal.
    if (site.problems?.length) text.append(element("small", sitePublishWarning(site.problems), "site-problems"));
    const actions = element("div", undefined, "site-row-actions");
    // Looking comes before deciding who else may look, so it comes first here.
    const look = element("button", "预览"); look.type = "button"; look.className = "site-preview";
    look.onclick = () => action(() => api.sitePreview(site.id));
    actions.append(look);
    const edit = element("button", "用编程任务修改"); edit.type = "button"; edit.className = "site-edit";
    // The page is written in a coding task, on this site's own folder: the
    // section owns what the site is, the coding task owns how it is built.
    edit.onclick = () => action(async () => {
      await switchSection("coding");
      state.draftWorkspace = { id: site.workspaceId, path: site.path, name: site.name };
      state.recents = [state.draftWorkspace, ...state.recents.filter((item) => item.path !== site.path)];
      render();
      $("#prompt").focus();
    });
    actions.append(edit);
    if (site.kind === "table") {
      const refresh = element("button", "重新读取"); refresh.type = "button"; refresh.className = "site-refresh";
      refresh.onclick = () => action(async () => { await api.siteRefresh(site.id); await renderLibrary(); });
      actions.append(refresh);
    }
    // Changing the look afterwards. A style is one stylesheet, so this replaces
    // one file and leaves the page's structure and behaviour alone.
    if (site.kind === "table" || site.style) {
      const restyle = element("button", "换风格"); restyle.type = "button"; restyle.className = "site-restyle";
      restyle.onclick = () => action(async () => {
        const style = await pickStyle(site);
        if (!style) return;
        const done = await api.siteRestyle({ id: site.id, style });
        if (!done) return;
        await renderLibrary();
        await api.sitePreview(site.id).catch(() => {});
      });
      actions.append(restyle);
    }
    const publish = element("button", site.published && !site.offline ? "分享设置" : site.published ? "分享设置" : "发布");
    publish.type = "button"; publish.className = site.published ? "site-share" : "site-publish";
    publish.onclick = () => action(async () => {
      const share = await pickShare(site, { anonymousAllowed });
      if (!share) return;
      const done = site.published ? await api.siteShareSet({ id: site.id, share }) : await api.sitePublish({ id: site.id, share });
      if (done) await renderLibrary();
    });
    actions.append(publish);
    if (site.published && site.offline) {
      // Taken offline, not deleted: the version is still there, so putting it
      // back is one click and not another upload.
      const back = element("button", "重新发布", "primary"); back.type = "button"; back.className = "site-republish";
      back.onclick = () => action(async () => { await api.siteRepublish(site.id); await renderLibrary(); });
      actions.append(back);
    } else if (site.published) {
      // Publishing sends the bytes once; anything changed since then is only on
      // this machine until this is pressed. Without it, editing a published
      // site in a coding task -- or changing its style -- changed nothing
      // anybody else could see, and nothing said so.
      const update = element("button", "更新线上"); update.type = "button"; update.className = "site-update";
      update.onclick = () => action(async () => { if (await api.sitePublish({ id: site.id })) await renderLibrary(); });
      actions.append(update);
      const link = element("button", "复制链接"); link.type = "button"; link.className = "site-link";
      link.onclick = () => action(async () => {
        if (!await api.copyText(site.url)) throw new Error("没能复制链接");
        link.textContent = "已复制"; setTimeout(() => { link.textContent = "复制链接"; }, 1500);
      });
      const down = element("button", "取消发布"); down.type = "button"; down.className = "site-unpublish";
      down.onclick = () => action(async () => { if (await api.siteUnpublish(site.id)) await renderLibrary(); });
      actions.append(link, down);
    }
    const forget = element("button", "移出列表", "row-action"); forget.type = "button"; forget.className = "site-forget";
    forget.onclick = () => action(async () => { if (await api.siteForget(site.id)) await renderLibrary(); });
    actions.append(forget);
    row.append(text, actions);
    list.append(row);
  }
  create.onclick = () => action(async () => {
    const template = await pickTemplate();
    if (template) await createSite(template, template.style);
  });
  library.append(hint, head, list, gallery);
  {
    const offered = await api.siteTemplates(siteStyleChoice()).catch(() => null);
    if (offered) {
      const bar = element("div", undefined, "style-bar");
      const grid = element("div", undefined, "template-list");
      const paint = (style) => {
        bar.replaceChildren(element("span", "风格", "style-label"));
        for (const row of offered.styles) {
          const chip = element("button", row.name, "style-chip"); chip.type = "button";
          chip.dataset.style = row.id; chip.title = row.summary;
          chip.setAttribute("aria-pressed", row.id === style ? "true" : "false");
          chip.onclick = () => action(async () => {
            rememberSiteStyle(row.id);
            const next = await api.siteTemplates(row.id);
            offered.templates = next.templates;
            paint(next.style);
          });
          bar.append(chip);
        }
        grid.replaceChildren(...offered.templates.map((template) => templateCard(template, style, {
          onPick: (picked) => action(() => createSite(picked, style)),
          onDemo: (picked) => action(() => api.siteDemo({ template: picked.id, style })),
        })));
      };
      paint(offered.style);
      gallery.append(element("h2", "看看能做成什么样", "site-gallery-title"),
        element("p", "下面每一个都能直接打开来点：用的是示例数据，看完再决定用哪个。", "sc-hint"), bar, grid);
    }
  }
}
// Which ready-made site to start from. A template is the difference between
// "describe what you want and wait for the Agent" and "here is your dashboard,
// now change it"; the blank one is still here for people who want neither.
// A card for one combination. Used in the picker and on the section's front
// page, so a template looks the same wherever it is offered.
const BLANK = { id: "blank", name: "空网站", table: false, styled: false, preview: null,
  summary: "一个空目录。自己写，或者交给编程任务从头做。" };
function templateCard(template, style, { onPick, onDemo }) {
  const card = element("div", undefined, "template-card");
  card.dataset.template = template.id;
  if (template.styled && style) card.dataset.style = style;
  // The picture first, because it is the answer to "what will I get".
  const pick = element("button", undefined, "template-pick"); pick.type = "button";
  const shot = element("span", undefined, "template-shot");
  if (template.preview) {
    const image = document.createElement("img");
    image.src = template.preview; image.alt = `${template.name}的样子`;
    shot.append(image);
  } else shot.append(element("span", "从空白开始", "template-blank"));
  const tags = element("span", undefined, "template-tags");
  tags.append(element("span", template.table ? "接一张表格" : "不接表格", "template-tag"));
  pick.append(shot, element("strong", template.name, "template-name"),
    element("small", template.summary, "template-summary"), tags);
  pick.onclick = () => onPick(template);
  card.append(pick);
  // A picture cannot tell you whether the sorting works. This opens the real
  // page, with the sample table in it, and nothing is created by looking.
  if (onDemo && template.preview) {
    const demo = element("button", "打开样例 ›", "template-demo"); demo.type = "button";
    demo.onclick = () => onDemo(template);
    card.append(demo);
  }
  return card;
}

// Which look, for a site that already exists. The pictures are of the
// scenarios, not of this site, so this asks by name and shows what each style
// is for -- the site itself is one press away in the preview afterwards.
function pickStyle(site) {
  return new Promise((resolve, reject) => { action(async () => {
    const { styles } = await api.siteTemplates(site.style ?? undefined);
    const dialog = element("dialog", undefined, "diff-dialog share-dialog");
    const head = element("header");
    head.append(element("strong", `${site.name} · 换风格`));
    const close = element("button", "取消"); close.type = "button"; close.onclick = () => dialog.close();
    head.append(close);
    const body = element("div", undefined, "diff-dialog-body");
    const options = element("div", undefined, "share-scopes");
    let answer = null;
    for (const style of styles) {
      const row = element("label", undefined, "share-scope");
      const box = element("input"); box.type = "radio"; box.name = "site-style"; box.id = `restyle-${style.id}`;
      box.checked = style.id === site.style;
      box.onchange = () => { answer = style.id; };
      row.append(box, element("strong", style.name), element("small", style.summary, "share-detail"));
      options.append(row);
      if (box.checked) answer = style.id;
    }
    const note = element("p", site.style === null
      ? "这个网站的 site.css 已经不是内置的任何一个风格了——换过去会覆盖掉它，会先问你一次。"
      : "只换 site.css，页面的结构和行为不动。已经发布出去的版本不受影响，除非你再点「更新线上」。", "diff-dialog-note");
    const go = element("button", "换", "primary"); go.type = "button"; go.id = "restyle-confirm";
    let picked = null;
    go.onclick = () => { picked = answer; dialog.close(); };
    body.append(options, note, go);
    dialog.append(head, body);
    dialog.onclose = () => { dialog.remove(); resolve(picked); };
    document.body.append(dialog); dialog.showModal();
  }).catch(reject); });
}

// Making one, from either place it can be started: the picker, or a card on the
// section's front page.
async function createSite(template, style) {
  let made = null;
  if (template.table) {
    const url = await askForText(`${template.name} · 选一张表`, "贴一个多维表格或电子表格的链接");
    if (!url) return;
    const picked = await pickSlice(url);
    if (!picked) return;
    made = await api.siteCreate({ ...picked, template: template.id, style });
    if (!made) return;
  } else {
    const name = await askForText(`${template.name} · 起个名字`, template.id === "game" ? "比如「贪吃蛇」" : "网站名字");
    if (!name) return;
    made = await api.siteCreate({ name, template: template.id === "blank" ? null : template.id, style });
  }
  await renderLibrary();
  // Show what was just made. A template that starts from real data has
  // something to show immediately, and seeing it is what tells somebody whether
  // it is worth publishing -- a blank site has no page yet, so it opens nothing
  // rather than an error about a file that was never written.
  if (made?.id && template.id !== "blank") await api.sitePreview(made.id);
}

function pickTemplate() {
  return new Promise((resolve, reject) => { action(async () => {
    const dialog = element("dialog", undefined, "diff-dialog template-dialog");
    const head = element("header");
    head.append(element("strong", "新建网站"));
    const close = element("button", "取消"); close.type = "button"; close.onclick = () => dialog.close();
    head.append(close);
    const body = element("div", undefined, "diff-dialog-body");
    // Two axes, said out loud: 场景 is what the page is for, 风格 is what it
    // looks like. Keeping them apart is why five scenarios and three styles are
    // fifteen sites instead of fifteen templates to scroll through.
    const styleBar = element("div", undefined, "style-bar"); styleBar.id = "style-bar";
    const list = element("div", undefined, "template-list"); list.id = "template-list";
    let answer = null, style = siteStyleChoice();
    const paint = async () => {
      const offered = await api.siteTemplates(style);
      style = offered.style;
      styleBar.replaceChildren(element("span", "风格", "style-label"));
      for (const row of offered.styles) {
        const chip = element("button", row.name, "style-chip"); chip.type = "button";
        chip.dataset.style = row.id;
        chip.title = row.summary;
        chip.setAttribute("aria-pressed", row.id === style ? "true" : "false");
        chip.onclick = () => action(async () => { rememberSiteStyle(row.id); style = row.id; await paint(); });
        styleBar.append(chip);
      }
      list.replaceChildren(...[...offered.templates, BLANK].map((template) => templateCard(template, style, {
        onPick: (picked) => { answer = { ...picked, style: picked.styled ? style : null }; dialog.close(); },
        onDemo: (picked) => action(() => api.siteDemo({ template: picked.id, style })),
      })));
    };
    await paint();
    body.append(styleBar, list);
    dialog.append(head, body);
    dialog.onclose = () => { dialog.remove(); resolve(answer); };
    document.body.append(dialog); dialog.showModal();
  }).catch(reject); });
}
// Which style was last chosen. A convenience only -- it is never the reason a
// site looks one way, that is written into the site's own site.css.
function siteStyleChoice() {
  try { return remembered("site-style") || undefined; } catch { return undefined; }
}
function rememberSiteStyle(value) {
  try { remember("site-style", value); } catch { /* a convenience, never a failure */ }
}
// One line of text, asked for in the page rather than in a native prompt: the
// renderer has no `prompt()` and a native dialog cannot be driven in a smoke.
function askForText(title, placeholder) {
  return new Promise((resolve) => {
    const dialog = element("dialog", undefined, "diff-dialog ask-dialog");
    const head = element("header");
    head.append(element("strong", title));
    const close = element("button", "取消"); close.type = "button"; close.onclick = () => { dialog.close(); resolve(null); };
    head.append(close);
    const body = element("div", undefined, "diff-dialog-body");
    const input = element("input"); input.type = "text"; input.id = "ask-input"; input.placeholder = placeholder;
    const ok = element("button", "确定", "primary"); ok.type = "button"; ok.id = "ask-ok";
    const done = () => { const value = input.value.trim(); if (!value) return; dialog.close(); resolve(value); };
    ok.onclick = done;
    input.onkeydown = (event) => { if (event.key === "Enter") { event.preventDefault(); done(); } };
    body.append(input, ok);
    dialog.append(head, body);
    dialog.onclose = () => { dialog.remove(); resolve(null); };
    document.body.append(dialog); dialog.showModal(); input.focus();
  });
}
// Choosing what part of a Feishu table a site may show. The dialog reads
// structure only -- table and field names -- and nothing is read or written
// until the main process's confirmation card is answered: what is picked here
// is exactly what the card names and exactly what leaves this machine.
function pickSlice(url) {
  return new Promise((resolve, reject) => { action(async () => {
    let described = await api.tableDescribe({ url });
    const dialog = element("dialog", undefined, "diff-dialog table-dialog");
    const head = element("header");
    head.append(element("strong", "选择要展示的内容"), element("span", described.title ?? "", "diff-dialog-totals"));
    const close = element("button", "取消"); close.type = "button"; close.onclick = () => dialog.close();
    head.append(close);
    const body = element("div", undefined, "diff-dialog-body");
    const picked = new Set();
    const nameInput = element("input"); nameInput.type = "text"; nameInput.id = "site-name"; nameInput.placeholder = "网站名字";
    const rowsInput = element("input"); rowsInput.type = "number"; rowsInput.min = "1"; rowsInput.max = "5000"; rowsInput.value = "500"; rowsInput.id = "table-rows";
    const refresh = element("select"); refresh.id = "table-refresh";
    // 15 秒是切片本来就允许的下限：一张 5000 行的表分页读也只有 1.7 次/秒，远在
    // 飞书的速率之下，而一块盯着看的看板需要的就是这个。
    for (const [value, label] of [[15, "每 15 秒"], [60, "每分钟"], [300, "每 5 分钟"], [1800, "每 30 分钟"], [3600, "每小时"]]) {
      const option = element("option", label); option.value = String(value); refresh.append(option);
    }
    const build = element("button", "读取并建站", "primary"); build.type = "button"; build.id = "table-build";
    const note = element("p", "", "diff-dialog-note"); note.id = "table-note";
    const fields = element("div", undefined, "table-fields"); fields.id = "table-fields";
    const paint = () => {
      fields.replaceChildren(...described.fields.map((field) => {
        const row = element("label", undefined, "table-field");
        const box = element("input"); box.type = "checkbox"; box.checked = picked.has(field.id);
        box.onchange = () => { if (box.checked) picked.add(field.id); else picked.delete(field.id); note.textContent = `已选 ${picked.size} 个字段`; };
        row.append(box, element("span", field.name, "table-field-name"), element("small", field.type, "table-field-type"));
        row.dataset.field = field.id;
        return row;
      }));
      note.textContent = `已选 ${picked.size} 个字段`;
    };
    const adopt = (answer) => {
      described = answer; picked.clear();
      for (const field of described.fields) picked.add(field.id);
      if (!nameInput.value) nameInput.value = described.title ?? "";
      paint();
    };
    adopt(described);
    const choices = element("div", undefined, "table-choices");
    const list = described.kind === "base" ? described.tables : described.sheets;
    if (Array.isArray(list) && list.length > 1) {
      const select = element("select"); select.id = "table-which";
      for (const item of list) {
        const option = element("option", item.name); option.value = item.id;
        option.selected = item.id === (described.tableId ?? described.sheetId);
        select.append(option);
      }
      select.onchange = () => action(async () => {
        adopt(await api.tableDescribe({ url, ...(described.kind === "base" ? { tableId: select.value } : { sheetId: select.value }) }));
      });
      choices.append(element("label", described.kind === "base" ? "数据表" : "工作表"), select);
    }
    choices.append(element("label", "名字"), nameInput, element("label", "最多行数"), rowsInput, element("label", "刷新"), refresh);
    let answer = null;
    build.onclick = () => {
      const rows = Number(rowsInput.value);
      const chosen = described.fields.filter((field) => picked.has(field.id)).map((field) => field.id);
      const slice = described.kind === "base"
        ? { kind: "base", token: described.token, tableId: described.tableId, fields: chosen, rows, refreshSeconds: Number(refresh.value) }
        : { kind: "sheet", token: described.token, sheetId: described.sheetId, origin: described.origin ?? null, columns: chosen, headerRow: 1, rows, refreshSeconds: Number(refresh.value) };
      answer = { name: nameInput.value.trim() || described.title || "", slice, title: described.title ?? "",
        names: described.fields.map((field) => [field.id, field.name]) };
      dialog.close();
    };
    body.append(choices, fields, note, build);
    dialog.append(head, body);
    dialog.onclose = () => { dialog.remove(); resolve(answer); };
    document.body.append(dialog); dialog.showModal();
  }).catch(reject); });
}
// Everything changed in the working tree, file by file (Codex's /diff, the
// review pane of the desktop apps). Read when opened, never cached.
function diffContent(result, current, refresh) {
  const files = reviewFiles(result), totals = files.reduce((sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }), { added: 0, removed: 0 });
  const body = element("div", undefined, "diff-dialog-body");
  if (result.repository) {
    const scope = result.scope === "turn" ? "本轮改动" : "工作目录改动（包含你的手工修改）";
    body.append(element("p", `${scope} · 基准：${result.basis || "未知"}`, "diff-scope-basis"),
      element("p", `${files.length} 个文件 · +${totals.added} −${totals.removed}`, "diff-dialog-note"));
    if (result.unavailableReason) body.append(element("p", result.unavailableReason, "diff-unavailable"));
  }
  if (!result.repository) {
    // Where the absence is actually felt, and the one place it is mentioned.
    const note = element("p", "这个目录还不是 Git 仓库，没有可比较的基准。每一轮改了什么都在对话里。", "diff-dialog-note");
    const init = element("button", "初始化 Git 仓库", "init-git"); init.type = "button"; init.id = "init-git";
    init.onclick = () => action(async () => {
      const updated = await api.initGit({ taskId: current.id });
      if (state.draftWorkspace?.path === updated.path) state.draftWorkspace = { ...state.draftWorkspace, ...updated };
      state.recents = state.recents.map((item) => item.path === updated.path ? { ...item, ...updated } : item);
      await refresh();
    });
    note.append(" ", init); body.append(note);
  }
  else if (!files.length && !result.unavailableReason) body.append(element("p", result.scope === "turn" ? "这一轮没有留下可显示的文件差异。" : "没有未提交的改动。", "diff-dialog-note"));
  const verbs = { added: "新增", deleted: "删除", modified: "修改", renamed: "重命名" };
  const list = element("nav", undefined, "diff-file-list"), details = element("div", undefined, "diff-file-details");
  for (const file of files) {
    const jump = element("button", `${file.path} · +${file.added} −${file.removed}`); jump.type = "button";
    jump.onclick = () => { state.diffReview.path = file.path; details.querySelector(`[data-diff-file="${CSS.escape(file.path)}"]`)?.scrollIntoView({ block: "start" }); queueTaskUiSave(); };
    list.append(jump);
    const row = element("details", undefined, "coding-step change"); row.dataset.diffFile = file.path;
    row.open = state.diffReview.path === file.path || files.length <= 3 || file.lines.length <= 40;
    const summary = element("summary");
    summary.append(element("span", verbs[file.status] ?? "修改", "step-verb"), element("code", file.path, "step-target"), element("span", `+${file.added}`, "diff-count add"), element("span", `−${file.removed}`, "diff-count remove"),
      ...(file.untracked ? [element("span", "未跟踪", "step-state")] : []), ...(file.partial ? [element("span", "仅记录片段", "step-state bad")] : []));
    const diff = element("div", undefined, "activity-diff diff-review-lines");
    if (file.binary) diff.append(element("span", "二进制文件，不显示内容\n", "diff-hunk"));
    else if (file.tooLarge) diff.append(element("span", "文件太大，不显示内容\n", "diff-hunk"));
    else if (file.readError) diff.append(element("span", "无法读取这个文件的内容；请刷新，或到任务文件中核对原文件。\n", "diff-hunk"));
    for (const line of file.lines.slice(0, 600)) {
      const node = element(line.side && !result.unavailableReason ? "button" : "span", undefined,
        `diff-review-line ${line.kind === "hunk" ? "diff-hunk" : line.kind === "add" ? "diff-add" : line.kind === "remove" ? "diff-remove" : ""}`);
      if (node.tagName === "BUTTON") { node.type = "button"; node.onclick = () => { state.diffReview.selection = { file, line }; state.diffReview.path = file.path; $("#changes-content").replaceChildren(...diffContent(result, current, refresh).childNodes); }; }
      if (state.diffReview.selection?.file?.path === file.path && state.diffReview.selection?.line?.side === line.side && state.diffReview.selection?.line?.line === line.line) node.classList.add("selected");
      node.append(element("span", line.oldLine ?? "", "diff-old-line"), element("span", line.newLine ?? "", "diff-new-line"), element("code", line.text)); diff.append(node);
    }
    if (file.lines.length > 600) diff.append(element("span", `…还有 ${file.lines.length - 600} 行未显示\n`, "diff-hunk"));
    row.append(summary, diff); details.append(row);
  }
  if (files.length) body.append(element("div", undefined, "diff-review-layout"));
  if (files.length) body.lastChild.append(list, details);
  const selected = state.diffReview.selection;
  if (selected && selected.file.revision === result.revision && !result.unavailableReason) {
    const feedback = element("form", undefined, "diff-feedback"), label = element("label", `${selected.file.path} · ${selected.line.side === "old" ? "旧" : "新"}侧第 ${selected.line.line} 行`);
    const opinion = element("textarea"); opinion.maxLength = 4000; opinion.placeholder = "写下希望 Agent 如何处理这一行"; opinion.required = true;
    const add = element("button", "添加到对话"); add.type = "submit";
    feedback.onsubmit = (event) => { event.preventDefault(); const reference = diffReference(result, selected.file, selected.line, opinion.value);
      if (!mention.picks.some((item) => draftReferenceKey(item) === draftReferenceKey(reference))) mention.picks = [...mention.picks, reference];
      if (!$("#prompt").value.trim()) $("#prompt").value = reference.comment;
      paintMentionRow(); saveDraft(); renderComposerState(); $("#prompt").focus(); };
    label.append(opinion); feedback.append(label, add); body.append(feedback);
  }
  if (result.truncated) body.append(element("p", "改动太多，只显示了前 2MB。", "diff-dialog-note"));
  return body;
}
function markChangedDiffReferences(result) {
  let changed = false;
  mention.picks = mention.picks.map((reference) => {
    if (reference.kind !== "diff" || reference.scope !== result.scope || (reference.turnKey ?? null) !== (result.turnKey ?? null)) return reference;
    const file = result.files.find((row) => row.path === reference.path), missing = !file;
    const currentChanged = reference.scope === "turn" && reference.fileRevision !== (file?.currentRevision ?? "missing");
    if (reference.revision === result.revision && !missing && !currentChanged) return reference;
    changed = true; return { ...reference, state: "changed" };
  });
  if (changed) { paintMentionRow(); saveDraft(); }
}
async function openDiffPanel(options = {}) {
  const current = task();
  if (!current || current.mode !== "coding") throw new Error("先开始一个编程任务，再查看改动");
  const scope = options.scope === "turn" ? "turn" : "working", turnKey = scope === "turn" ? options.turnKey : null;
  if (scope === "turn" && !turnKey) throw new Error("找不到这一轮的改动记录");
  const closing = hidePreview(), epoch = viewEpoch, id = current.id;
  state.archivePreview = null; state.tab = "changes"; state.panelCollapsed = false; state.mobilePane = "panel";
  state.diffReview = { scope, turnKey, path: options.path ?? null, result: null, selection: null };
  $("#changes-content").replaceChildren(element("p", scope === "turn" ? "正在读取这一轮保存的改动…" : "正在读取工作目录里的改动…", "changes-loading"));
  render(); await closing;
  const result = await api.projectDiff({ taskId: id, scope, ...(turnKey ? { turnKey } : {}) });
  if (epoch !== viewEpoch || id !== state.taskId || state.tab !== "changes") return;
  state.diffReview.result = result; markChangedDiffReferences(result);
  const body = diffContent(result, current, openDiffPanel);
  $("#changes-content").replaceChildren(...body.childNodes);
  queueTaskUiSave();
}
async function openDiffDialog() {
  const current = task();
  if (!current || current.mode !== "coding") throw new Error("先开始一个编程任务，再查看改动");
  const result = await api.projectDiff({ taskId: current.id, scope: "working" });
  const dialog = element("dialog", undefined, "diff-dialog"), head = element("header");
  const totals = result.files.reduce((sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }), { added: 0, removed: 0 });
  head.append(element("strong", "工作目录里的改动"), element("span", result.repository ? `${result.files.length} 个文件 · +${totals.added} −${totals.removed}` : "", "diff-dialog-totals"));
  const close = element("button", "关闭"); close.type = "button"; close.onclick = () => dialog.close(); head.append(close);
  const body = diffContent(result, current, async () => { dialog.close(); await openDiffDialog(); });
  dialog.append(head, body);
  dialog.onclose = () => dialog.remove();
  document.body.append(dialog); dialog.showModal();
}
// What /model changed, said once where the person is typing.
function modelNote(options) {
  const current = options?.available?.find((model) => model.slug === options.current), label = current?.label ?? options?.current ?? "";
  imageModel = current ? { sees: current.images !== false, label: current.label } : null; paintImageRow();
  error(""); $("#prompt").placeholder = `已切换，下一轮用 ${label}${options?.choice === null ? "（跟随服务端默认）" : ""}`;
  setTimeout(renderContext, 4000);
}
// Codex's and Claude Code's /status: where this task works, under what, and
// how much conversation it carries.
async function openStatusDialog() {
  const current = task();
  if (!current) throw new Error("先开始一个编程任务");
  const options = await api.modelOptions().catch(() => null);
  const permission = permissionModes.find((mode) => mode.id === current.permission);
  const turns = current.messages.filter((message) => message.role === "user" && !message.steered).length;
  const label = options?.available?.find((model) => model.slug === options.current)?.label ?? options?.current ?? "未确认";
  // As Codex's /status: 58% left (116K used / 486K).
  const usage = current.contextUsage, left = contextLeft(usage);
  const context = !usage ? "还没有数据，Agent 回复一次后显示" : left === null ? `已用 ${tokenCount(usage.tokens)}（模型的窗口大小未知）`
    : `剩余 ${left}% · 已用 ${tokenCount(usage.tokens)} / ${tokenCount(usage.window)}`;
  const rows = [["项目目录", current.cwd], ["权限", permission ? `${permission.label} · ${permission.summary}` : current.permission],
    ["模型", `${label}${options?.choice === null ? "（跟随服务端默认）" : ""}`], ["对话", `${turns} 轮${current.compactedAt ? ` · ${new Date(current.compactedAt).toLocaleString("zh-CN")} 压缩过` : ""}`], ["上下文", context],
    ["状态", statuses[current.status] ?? current.status]];
  const dialog = element("dialog", undefined, "diff-dialog status-dialog");
  const head = element("header"); head.append(element("strong", "当前状态"), element("span", current.title, "diff-dialog-totals"));
  const close = element("button", "关闭"); close.type = "button"; close.onclick = () => dialog.close(); head.append(close);
  const list = element("dl", undefined, "status-rows");
  for (const [name, value] of rows) list.append(element("dt", name), element("dd", value));
  const body = element("div", undefined, "diff-dialog-body"); body.append(list);
  dialog.append(head, body); dialog.onclose = () => dialog.remove();
  document.body.append(dialog); dialog.showModal();
}
function paintMentionRow() {
  const row = $("#mention-row"), text = $("#prompt").value;
  // A pick whose @name has been deleted from the text is no longer in the message.
  mention.picks = mention.picks.filter(item => !["user", "group", "file"].includes(item.kind) || text.includes(`@${item.kind === "file" ? item.path : item.name}`));
  row.replaceChildren(...mention.picks.map(item => {
    const chip = element("span", undefined, "mention-chip");
    const label = item.kind === "group" ? `@${item.name}（群）` : item.kind === "user" ? `@${item.name}${item.department ? ` · ${item.department}` : ""}`
      : item.kind === "file" ? `文件 · ${item.path}` : item.kind === "diff" ? `${item.state === "current" ? "行级意见" : "意见需核对"} · ${item.path} · ${item.side === "old" ? "旧" : "新"}侧 ${item.startLine} 行`
        : item.kind === "page" ? `${item.state === "current" ? "页面" : "页面需核对"} · ${item.title} · ${item.address || `/${item.path}`}`
        : item.kind === "terminal" ? `${item.title} · ${item.excerpt.split("\n")[0].slice(0, 80)}`
        : selectionReferencePresentation(item).label;
    const open = element("button", label, "reference-open"); open.type = "button"; open.title = item.kind === "terminal" ? item.excerpt : ["selection", "diff", "page"].includes(item.kind)
      ? `${item.kind === "selection" ? selectionReferencePresentation(item).detail : `${item.path || item.url || item.resourceKey}${item.revision ? `\n版本 ${item.revision}` : ""}`}${item.comment ? `\n意见：${item.comment}` : ""}` : label;
    open.onclick = () => {
      if (item.kind === "file" && state.taskId) void action(async () => { await switchTab("files"); await loadFile(item.path); });
      else if (item.kind === "selection" && item.path && state.taskId) void action(async () => { await switchTab("files"); await loadFile(item.path); });
      else if (item.kind === "diff" && state.taskId) void action(() => openDiffPanel({ scope: item.scope, turnKey: item.turnKey, path: item.path }));
      else if (item.kind === "page" && state.taskId) void action(async () => { await switchTab("files"); await loadFile(item.path); await openPreview(); });
    };
    chip.append(open);
    const remove = element("button", "×"); remove.type = "button"; remove.setAttribute("aria-label", `移除引用 ${item.title || item.path || item.name || "内容"}`);
    remove.onclick = () => { mention.picks = mention.picks.filter(other => other !== item); paintMentionRow(); saveDraft(); };
    chip.append(remove); return chip;
  }));
  row.hidden = !mention.picks.length;
}
// The picks this message actually carries: only those still written in it.
function messageMentions(text) { return mention.picks.filter(item => ["user", "group"].includes(item.kind) && text.includes(`@${item.name}`)); }
function messageFiles(text) { return mention.picks.filter(item => item.kind === "file" && text.includes(`@${item.path}`)); }
function messageReferences(text) { return [...messageFiles(text), ...mention.picks.filter(item => ["diff", "page", "terminal"].includes(item.kind))]; }
function messageSelection() { return mention.picks.find(item => item.kind === "selection") ?? null; }
$("#prompt").addEventListener("input", event => { if (!event.isComposing) updateMentions(); paintMentionRow(); saveDraft(); renderComposerState(); });
// ---- images pasted into a coding task's box, as in Codex and Claude Code ----
// Kept per draft like the words, sent with the message, shown in it. Whether
// the model can see them is the server's model list's to say (from the Codex
// catalog); a model that cannot is only told an image was there.
function paintImageRow() {
  const row = $("#image-row"), images = pastedImages.get(draftKey()) ?? [];
  row.hidden = !images.length;
  row.replaceChildren(...images.map((image, index) => {
    const chip = element("span", undefined, "image-chip");
    if (image.unavailable) chip.append(element("span", `图片 ${index + 1} · 需重新粘贴`, "image-unavailable"));
    else { const picture = element("img"); picture.src = image.data; picture.alt = `图片 ${index + 1}`; chip.append(picture); }
    const remove = element("button", "×"); remove.type = "button"; remove.setAttribute("aria-label", `不发送图片 ${index + 1}`);
    remove.onclick = () => { images.splice(index, 1); paintImageRow(); saveDraft(); renderComposerState(); };
    chip.append(remove); return chip;
  }), ...(images.some(image => image.unavailable) ? [element("small", "应用重启后没有保留剪贴板图片内容；请移除后重新粘贴，文字不会丢失。", "image-note")] : []),
  ...(images.length && imageModel?.sees === false ? [element("small", `当前模型 ${imageModel.label} 不支持图片；请用 /model 更换模型或移除图片后发送`, "image-note")] : []));
  renderComposerState();
}
async function checkImageModel() {
  const options = await api.modelOptions().catch(() => null);
  const current = options?.available?.find((model) => model.slug === options.current);
  imageModel = current ? { sees: current.images !== false, label: current.label } : null;
  paintImageRow();
}
const readImage = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error("这张图片读不出来"));
  reader.readAsDataURL(file);
});
$("#prompt").addEventListener("paste", (event) => {
  if (state.section !== "coding") return;
  const files = [...(event.clipboardData?.items ?? [])].filter((item) => item.kind === "file" && IMAGE_TYPES.has(item.type)).map((item) => item.getAsFile()).filter(Boolean);
  if (!files.length) return;
  // Copied text that comes with the image still goes into the box.
  if (!event.clipboardData.types.includes("text/plain")) event.preventDefault();
  const key = draftKey();
  void action(async () => {
    const images = pastedImages.get(key) ?? [];
    for (const file of files) {
      if (images.length >= 5) throw new Error("一条消息最多带 5 张图片");
      if (file.size > 10 * 1024 * 1024) throw new Error("图片超过 10 MB");
      images.push({ id: crypto.randomUUID(), type: file.type, data: await readImage(file) });
    }
    pastedImages.set(key, images); paintImageRow(); saveDraft();
    await checkImageModel();
  });
});
// A Chinese input method commits its text on compositionend, not on input.
// Some WebKit input methods emit the accepting Enter immediately after
// compositionend with isComposing=false, so keep a very short guard as well as
// the standard flag/keyCode checks.
let promptComposing = false, compositionEndedAt = -Infinity;
$("#prompt").addEventListener("compositionstart", () => { promptComposing = true; });
$("#prompt").addEventListener("compositionend", () => { promptComposing = false; compositionEndedAt = performance.now(); updateMentions(); renderComposerState(); });
$("#prompt").addEventListener("click", () => updateMentions());
$("#prompt").addEventListener("keyup", event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) updateMentions(); });
$("#prompt").addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== $("#prompt")) closeMentions(); }, 150));
$("#queue-send").onclick = () => { submitActionOverride = "queue"; $("#composer").requestSubmit(); };
$("#composer").onsubmit = (event) => {
  event.preventDefault();
  const text = $("#prompt").value.trim(), ui = renderComposerState(), imagesHere = pastedImages.get(draftKey()) ?? [];
  const expectedAction = submitActionOverride ?? ui.action; submitActionOverride = null;
  // 停止 is the send button's job only when it is clicked: Enter in an empty
  // box must never be the thing that ends a turn.
  if (expectedAction === "stop") { if (event.submitter === $("#send") && !ui.disabled) void action(requestStop); return; }
  if (!text || state.submitting) return;
  const refused = dispatchError({ action: expectedAction, imageCount: imagesHere.length, imageModel });
  const disabled = expectedAction === "queue" ? ui.queueDisabled : ui.disabled;
  if (disabled || refused) { if (refused || ui.reason) error(refused || ui.reason); return; }
  // The lock is taken synchronously, before project-command lookup or task
  // creation can yield. Two Enter presses or clicks therefore share one
  // dispatch, rather than relying on the button repaint to prevent the second.
  state.submitting = true; state.submittingAction = expectedAction;
  // Keep the lock synchronous, but let the activating click finish before the
  // control changes to disabled. This avoids a pressed button disappearing
  // from the accessibility action halfway through its own event.
  queueMicrotask(renderComposerState);
  void action(async () => {
  let attemptedReference = null;
  try {
  // A command typed whole in a coding task is run, not sent to the Agent.
  const typed = state.section === "coding" ? /^\/([A-Za-z0-9][A-Za-z0-9_/-]*)(?:\s+([\s\S]+))?$/.exec(text) : null;
  if (typed && SLASH_COMMANDS.some((command) => command.name === typed[1].toLowerCase()) && (!typed[2] || COMMANDS_WITH_ARGUMENTS.has(typed[1].toLowerCase()))) {
    $("#prompt").value = ""; drafts.delete(draftKey());
    return runSlashCommand(typed[1].toLowerCase(), typed[2]?.trim());
  }
  if (typed && !SLASH_COMMANDS.some((command) => command.name === typed[1].toLowerCase())) {
    // Asked afresh: whether the project has this command decides what is sent.
    const own = (await api.projectCommands(projectFolderRef()).catch(() => [])).find((command) => command.name.toLowerCase() === typed[1].toLowerCase()
      || command.aliases?.some((alias) => alias.toLowerCase() === typed[1].toLowerCase()));
    if (own) { $("#prompt").value = ""; drafts.delete(draftKey()); return runProjectCommand(own.name, typed[2]?.trim()); }
  }
  // Sending while a turn is running adds to it instead of being refused. That
  // is the difference between correcting the Agent and having to stop it and
  // lose what it has already done.
  if (expectedAction === "steer") {
    if (!state.taskId) return;
    if (messageReferences(text).length || messageSelection()) throw new Error("正在执行时只能补充文字；文件和选区引用仍保留，请等本轮结束后发送");
    const picked = messageMentions(text);
    // Steering adds words to a running turn and has no room for data, so the
    // picks are said in words there.
    await api.steer(state.taskId, picked.length ? `${text}\n\n（@ 的对象：${picked.map(item => item.kind === "group" ? `${item.name}（群）` : `${item.name}${item.department ? ` · ${item.department}` : ""}${item.email ? ` · ${item.email}` : ""}`).join("；")}）` : text);
    $("#prompt").value = ""; drafts.delete(draftKey()); mention.picks = []; paintMentionRow(); saveDraft();
    return;
  }
  // The Feishu document section hosts the same panel, but it is not a task mode
  // of its own -- work started there is ordinary office work.
  // Both embedded sections send work to the same kind of task: they are places to
  // stand while working on Feishu's own pages, not task kinds of their own.
  const key = draftKey(), epoch = viewEpoch;
  let id = state.taskId;
  const source = state.tab === "browser" && state.archivePreview ? null : state.tab === "files" ? state.sheet || state.base || state.document || state.file : state.file;
  const selected = messageSelection();
  attemptedReference = selected || mention.picks.find(reference => ["diff", "page", "terminal"].includes(reference.kind)) || null;
  let context = selected ? referenceContext(selected) : source && state.tab !== "chat" && state.includeContext ? state.sheet && state.tab === "files" ? { kind: "feishu-sheet", handle: state.sheet.handle } : state.base && state.tab === "files" ? { kind: "feishu-base", handle: state.base.handle } : { ...(state.document && state.tab === "files" ? { kind: "feishu-document", handle: state.document.handle } : { path: state.file.path, revision: state.file.revision }), ...(state.selection ? { selection: state.selection } : {}) } : null;
  if (selected && !context) throw new Error("引用的内容已变化或不可用；请打开引用详情重新核对，文字仍保留在草稿中");
  if (context?.kind === "feishu-document" && $("#propose-document-edit").checked) context.intent = "propose-edit";
  if (context?.kind === "feishu-sheet" && $("#propose-sheet-edit").checked) context.intent = "propose-edit";
  if (context?.kind === "feishu-base" && $("#propose-base-edit").checked) context.intent = "propose-edit";
  if (!id) {
    const created = await createSectionTask(); id = created.id;
    if (!state.snapshot.tasks.some((item) => item.id === created.id)) state.snapshot.tasks.push(created);
    await loadTaskUi(id);
    if (pastedImages.has(key)) pastedImages.set(id, pastedImages.get(key));
    if (epoch === viewEpoch) { state.taskId = id; taskUiRecords.set(id, { ...taskUiRecords.get(id), value: currentTaskUi() }); taskUiDirty.add(id); render(); }
    await consumeNewDraft(key);
  }
  // Docked beside a document or a conversation, the Agent is told which one
  // without the person having to paste it every turn. Only which dock is said
  // here: what the page shows, and whether the Agent may have a chat's id, is
  // composed in the main process from what the page itself reported.
  const picks = messageMentions(text);
  const references = messageReferences(text);
  const dock = state.section === "feishu" ? "messenger" : state.section === "feishu-docs" ? "drive" : null;
  const review = pendingReview?.message === text ? pendingReview.target : null; pendingReview = null;
  const images = review ? [] : pastedImages.get(key) ?? [];
  if (images.some(image => image.unavailable)) throw new Error("有图片需要重新粘贴；图片和文字都已保留");
  const command = pendingCommand?.text === text ? { name: pendingCommand.name, source: pendingCommand.source } : null; pendingCommand = null;
  const planningAction = pendingPlanningAction === "init" && text === INIT_PROMPT ? "init" : null;
  const options = picks.length || references.length || dock || review || images.length || command || planningAction ? { ...(picks.length ? { mentions: picks } : {}), ...(references.length ? { references } : {}), ...(dock ? { dock } : {}), ...(review ? { review } : {}),
    ...(images.length ? { images: images.map((image) => ({ id: image.id, type: image.type, data: image.data })) } : {}), ...(command ? { command } : {}), ...(planningAction ? { planningAction } : {}) } : undefined;
  if (expectedAction === "queue") {
    const fingerprint = JSON.stringify({ id, text, context, options: { ...options, images: options?.images?.map(image => ({ id: image.id, type: image.type })) } });
    if (queueAttempt?.fingerprint !== fingerprint) queueAttempt = { fingerprint, clientRequestId: crypto.randomUUID() };
    await api.enqueueTaskMessage(id, { clientRequestId: queueAttempt.clientRequestId, text, context, options }); queueAttempt = null;
  } else await api.send(id, text, context, options);
  pendingPlanningAction = null;
  if (images.length) { pastedImages.delete(key); pastedImages.delete(id); paintImageRow(); }
  if (drafts.get(key)?.trim() === text) drafts.delete(key);
  if (state.taskId === id && $("#prompt").value.trim() === text) { $("#prompt").value = ""; mention.picks = []; mentionDrafts.delete(key); paintMentionRow(); saveDraft(); }
  } catch (cause) {
    if (attemptedReference && /已变化|已失效|不可用|重新选择|重新读取/.test(readableError(cause))) {
      mention.picks = mention.picks.map(reference => reference === attemptedReference || (attemptedReference.kind === "diff" && reference.kind === "diff") ? { ...reference, state: "changed", handle: undefined } : reference);
      paintMentionRow(); saveDraft();
    }
    if (expectedAction === "steer" && /turn.*(?:completed|not.*running)|没有正在执行|当前不能补充/i.test(readableError(cause))) {
      throw new Error("这句补充没有送达：本轮刚刚结束。文字和引用仍保留，未自动启动下一轮；请核对后再发送。");
    }
    throw cause;
  } finally { state.submitting = false; state.submittingAction = null; saveDraft(); render(); }
  });
};
// Where ↑ / ↓ are in what the person sent before (prompt-history.js).
const promptHistory = { entries: [], index: -1 };
// Enter sends, Shift+Enter starts a new line. A Chinese input method uses Enter
// to accept a candidate, and that keystroke belongs to the input method, so a
// composing Enter must never send a half-typed message.
$("#prompt").onkeydown = (event) => {
  if (event.isComposing || event.keyCode === 229 || promptComposing || (event.key === "Enter" && performance.now() - compositionEndedAt < 50)) return;
  // While the @ list is open, the keys that would move or send belong to it.
  if (mention.open) {
    if (mention.results.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      mention.active = (mention.active + (event.key === "ArrowDown" ? 1 : -1) + mention.results.length) % mention.results.length;
      paintMentions(); return;
    }
    if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
      event.preventDefault();
      if (mention.results.length) pickMention(mention.active); else closeMentions();
      return;
    }
    if (event.key === "Escape") { event.preventDefault(); closeMentions(); return; }
  }
  // Esc stops a running turn once it is pressed again (escapeToStop).
  if (event.key === "Escape" && busy() && state.taskId) { event.preventDefault(); void escapeToStop(); return; }
  // ↑ / ↓ bring back what this person sent before. Application-authored
  // planning messages are filtered by prompt-history.js.
  if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey && ["coding", "cowork"].includes(taskModeFor(state.section))) {
    const box = $("#prompt");
    const recalling = promptHistory.index >= 0 && box.value === promptHistory.entries[promptHistory.index];
    if (!recalling && box.value === "") promptHistory.entries = sentPrompts(state.snapshot.tasks, { taskId: state.taskId, cwd: task()?.cwd ?? state.draftWorkspace?.path ?? null, mode: taskModeFor(state.section) });
    const shown = recallPrompt({ value: box.value, selectionStart: box.selectionStart, selectionEnd: box.selectionEnd, entries: promptHistory.entries, index: recalling ? promptHistory.index : -1 }, event.key === "ArrowUp" ? 1 : -1);
    if (shown) { event.preventDefault(); promptHistory.index = shown.index; box.value = shown.value; box.setSelectionRange(box.value.length, box.value.length); saveDraft(); renderComposerState(); return; }
  }
  if (event.key !== "Enter" || event.shiftKey) return;
  event.preventDefault();
  $("#composer").requestSubmit();
};
$("#refresh-files").onclick = () => action(async () => { if (state.sheet) return loadSheet(state.sheet.sourceUrl, { sheetId: state.sheet.sheetId, range: state.sheet.range }); if (state.base) return loadBase(state.base.sourceUrl, { tableId: state.base.tableId, offset: state.base.offset }); if (state.document) return loadDocument(state.document.sourceUrl); const epoch = viewEpoch; await loadFiles(); if (epoch === viewEpoch && state.file) await loadFile(state.file.path); });
// Moving around an opened spreadsheet -- another worksheet, another range -- is
// this form and nothing else; the Agent has no read operation to fall back on.
// Without a handler the button submitted the form natively, which the page's
// CSP (form-action 'none') blocks, so 读取范围 and 工作表 did nothing at all.
$("#sheet-range-form").onsubmit = (event) => { event.preventDefault(); action(async () => {
  if (!state.sheet) throw new Error("请先打开一个飞书电子表格");
  const range = $("#sheet-range").value.trim();
  if (!range) throw new Error("请输入要读取的单元格范围");
  await loadSheet(state.sheet.sourceUrl, { sheetId: $("#sheet-selector").value, range });
}); };
// Another table, or another page of this one: a Base page is read by where it starts.
$("#base-page-form").onsubmit = (event) => { event.preventDefault(); action(async () => {
  if (!state.base) throw new Error("请先打开一个飞书多维表格");
  const start = Number($("#base-offset").value), tableId = $("#base-table-selector").value;
  if (!Number.isSafeInteger(start) || start < 1) throw new Error("请输入从第几条记录读起（从 1 开始）");
  await loadBase(state.base.sourceUrl, { tableId, offset: tableId === state.base.tableId ? start - 1 : 0 });
}); };
const fileSize = (bytes) => bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
// Attaching is copying into the task's folder — the same folder the Agent
// writes results into, which is why 在访达中打开 sits next to it.
$("#attach-files").onclick = () => action(async () => {
  const id = await ensureTask();
  $("#attach-files").disabled = true;
  try { await api.attachTaskFiles(id); await loadFiles(); } finally { $("#attach-files").disabled = false; }
});
$("#empty-attach-files").onclick = () => $("#attach-files").click();
$("#empty-open-document").onclick = () => $("#show-document-url").click();
$("#reveal-folder").onclick = () => action(async () => api.revealTaskFolder(await ensureTask()));
$("#show-document-url").onclick = () => { $("#document-url-form").hidden = !$("#document-url-form").hidden; if ($("#document-url-form").hidden) clearDocumentSearch(); else $("#document-url").focus(); };
// 「打开飞书内容」: a pasted link opens straight away, anything else is a title
// search. Without this the form fell through to a native submit, which
// navigated the whole window away from the application.
function clearDocumentSearch() {
  documentSearch = null;
  $("#document-search").hidden = true; $("#document-search-more").hidden = true;
  $("#document-search-status").textContent = ""; $("#document-search-results").replaceChildren();
}
let documentSearch = null;
function documentHit(hit) {
  const row = element("button", undefined, "document-hit");
  row.type = "button"; row.setAttribute("role", "option");
  row.append(element("strong", hit.title));
  const facts = [hit.type, hit.owner, hit.editedAt].filter(Boolean).join(" · ");
  if (facts) row.append(element("small", facts));
  if (hit.summary) row.append(element("span", hit.summary));
  row.onclick = () => action(async () => {
    $("#document-url-form").hidden = true; clearDocumentSearch();
    await (hit.kind === "sheet" ? loadSheet(hit.url) : loadDocument(hit.url));
  });
  return row;
}
async function runDocumentSearch(query, kind, pageToken) {
  const id = state.taskId, epoch = viewEpoch;
  $("#document-search").hidden = false; $("#document-search-more").hidden = true;
  $("#document-search-status").textContent = pageToken ? "继续搜索…" : "正在搜索飞书…";
  if (!pageToken) $("#document-search-results").replaceChildren();
  const result = await api.searchDocuments(id, query, kind, pageToken);
  if (id !== state.taskId || epoch !== viewEpoch) return;
  documentSearch = { query, kind, next: result.next };
  $("#document-search-results").append(...result.documents.map(documentHit));
  const found = $("#document-search-results").childElementCount;
  // An excluded row is one this application could not open -- a cross-tenant
  // result or a link shape the reader does not accept. Saying so is better than
  // a count that quietly disagrees with what Feishu showed the person.
  $("#document-search-status").textContent = found
    ? `找到 ${found} 项${result.excluded ? `（另有 ${result.excluded} 项无法在这里打开，已略过）` : ""}`
    : "没有能在这里打开的结果。可以直接粘贴文档链接。";
  $("#document-search-more").hidden = !result.next;
}
$("#document-search-more").onclick = () => action(() => documentSearch?.next
  ? runDocumentSearch(documentSearch.query, documentSearch.kind, documentSearch.next) : undefined);
// What the Feishu deployment this app talks to cannot do, with the reason it
// gives. Said where the person would reach for it, before they try: an option
// that cannot work is disabled and names why, and a search the deployment does
// not offer is never attempted.
let feishuDeployment = null;
const feishuLacks = (capability) => feishuDeployment?.unavailable?.[capability] ?? null;
function applyFeishuDeployment(value) {
  feishuDeployment = value;
  for (const [kind, capability] of [["sheet", "sheets"], ["base", "base"]]) {
    const option = $("#resource-kind").querySelector(`option[value="${kind}"]`), reason = feishuLacks(capability);
    if (!option || !reason) continue;
    option.disabled = true; option.title = reason;
    if (!option.textContent.includes("（")) option.textContent += "（当前飞书部署不提供）";
  }
  if (feishuLacks("documentSearch")) $("#document-url").placeholder = "粘贴文档链接（当前飞书部署不提供搜索）";
  const drive = feishuLacks("drive");
  if (drive) { $("#upload-to-drive").disabled = true; $("#upload-to-drive").title = drive; }
}
$("#document-url-form").onsubmit = (event) => { event.preventDefault(); action(async () => {
  const value = $("#document-url").value.trim(); if (!value) return;
  const kind = ["sheet", "base"].includes($("#resource-kind").value) ? $("#resource-kind").value : "document";
  if (!/^https?:/i.test(value)) {
    if (kind === "base") throw new Error("多维表格目前只能粘贴链接打开，请粘贴多维表格的链接");
    if (feishuLacks("documentSearch")) throw new Error(`${feishuLacks("documentSearch")}，请粘贴文档链接打开`);
    return runDocumentSearch(value, kind, null);
  }
  $("#document-url-form").hidden = true; clearDocumentSearch();
  await (kind === "sheet" ? loadSheet(value) : kind === "base" ? loadBase(value) : loadDocument(value));
}); };
$("#show-local-files").onclick = () => action(async () => { clearDocument(); renderContext(); await loadFiles(); });
// Reading a Feishu conversation is a way to bring material into a work task, so
// it lives with the task's other sources rather than in its own section.
$("#parent-folder").onclick = () => action(async () => { state.folder = state.folder.split("/").slice(0, -1).join("/"); await loadFiles(); });
$("#open-system-file").onclick = () => action(async () => {
  if (!state.taskId || !state.file?.path) throw new Error("请先选择要打开的文件");
  await api.openTaskFile({ taskId: state.taskId, path: state.file.path, action: "open" });
});
$("#reveal-task-file").onclick = () => action(async () => {
  if (!state.taskId || !state.file?.path) throw new Error("请先选择要显示的文件");
  await api.openTaskFile({ taskId: state.taskId, path: state.file.path, action: "reveal" });
});
$("#open-readable-copy").onclick = () => action(async () => {
  if (!state.file?.readableCopy) throw new Error("这个文件没有可用的文字版");
  await loadFile(state.file.readableCopy);
});
$("#open-preview").onclick = () => action(openPreview);
$("#refresh-preview").onclick = () => action(() => state.archivePreview ? openArchivedPreview(state.archivePreview.id, state.archivePreview.digest) : openPreview());
$("#preview-back").onclick = () => action(() => api.previewNavigate({ taskId: state.taskId, previewId: state.previewPage?.previewId, direction: "back" }));
$("#preview-forward").onclick = () => action(() => api.previewNavigate({ taskId: state.taskId, previewId: state.previewPage?.previewId, direction: "forward" }));
$("#reference-preview-page").onclick = () => action(() => {
  if (!state.previewPage?.local || state.previewPage.taskId !== state.taskId) throw new Error("当前页面还没有加载完成");
  const reference = previewPageReference(state.previewPage);
  mention.picks = [...mention.picks.filter(item => !(item.kind === "page" && item.path === reference.path)), reference];
  paintMentionRow(); saveDraft(); $("#prompt").focus();
});
// The coding task builds the page; 文档网站 owns what it is and who may open it.
// This is the door between them -- without it somebody could watch a website
// get built and previewed here and then find nothing anywhere to publish it.
//
// Two presses, not one. The first adds it and stays here, because the person is
// still working on the page and a jump would abandon the task they are in --
// a task with no name yet is not even in the sidebar to come back to. The
// second goes to the list, which is where sharing is decided.
$("#site-from-task").onclick = () => action(async () => {
  if (state.siteFromTask?.taskId === state.taskId) {
    const id = state.siteFromTask.id;
    await switchSection("sites");
    const row = document.querySelector(`.site-row[data-site="${id}"]`);
    row?.scrollIntoView({ block: "center" });
    row?.classList.add("site-row-new");
    return;
  }
  const made = await api.siteFromTask(state.taskId);
  if (!made) return;
  state.siteFromTask = { taskId: state.taskId, id: made.id };
  renderContext();
});
$("#include-context").onchange = (event) => { state.includeContext = event.target.checked; renderContext(); queueTaskUiSave(); };
$("#clear-selection").onclick = () => { state.selection = null; renderContext(); queueTaskUiSave(); };
function addCurrentContextReference() {
  const source = state.sheet || state.base || state.document || state.file;
  if (!source || state.tab !== "files") throw new Error("请先打开要引用的内容");
  if (mention.picks.some(reference => reference.kind === "selection")) throw new Error("一条消息目前只能带一个内容选区；请先移除原引用");
  const resourceKind = state.sheet ? "feishu-sheet" : state.base ? "feishu-base" : state.document ? "feishu-document" : "workspace-file";
  const resourceKey = source.sourceUrl || `workspace:${source.path}`;
  const revision = source.sourceRevision || source.revision;
  const reference = { kind: "selection", key: `${resourceKind}:${resourceKey}`, resourceKind, resourceKey, title: source.title || source.path,
    ...(source.path ? { path: source.path } : {}), ...(source.sourceUrl ? { url: source.sourceUrl } : {}), ...(revision ? { revision } : {}),
    ...(state.sheet ? { scope: `${state.sheet.sheetId} · ${state.sheet.range}` } : state.base ? { scope: `${state.base.tableId} · 第 ${state.base.offset + 1}–${state.base.offset + state.base.records.length} 条` } : {}),
    ...(source.handle ? { handle: source.handle } : {}), ...(state.selection ? { selection: structuredClone(state.selection) } : {}), state: "current" };
  mention.picks = [...mention.picks, reference]; paintMentionRow(); saveDraft(); $("#prompt").focus();
}
$("#add-context-reference").onclick = () => action(addCurrentContextReference);
$("#quote-selection").onclick = () => action(() => {
  const content = $("#file-content"), start = content.selectionStart, end = content.selectionEnd;
  if (end <= start) throw new Error("请先在文件中选中要引用的文字");
  if (end - start > 8000) throw new Error("选区最多包含 8000 字，请缩小引用范围");
  const before = content.value.slice(0, start), startLine = before.split("\n").length, endLine = startLine + content.value.slice(start, end).split("\n").length - 1;
  state.selection = { start, end, startLine, endLine, text: content.value.slice(start, end) }; state.includeContext = true; renderContext(); queueTaskUiSave(); addCurrentContextReference();
});
$("#close-preview").onclick = () => action(() => switchTab(state.archivePreview ? "apps" : "files"));
// Folding the panel keeps whatever is in it; reopening returns to the same
// file, document or preview rather than starting over.
$("#feishu-rail-toggle").onclick = () => action(async () => {
  const next = !feishuRailHidden();
  try { remember("feishu-rail", next ? "hidden" : "shown"); } catch { /* a convenience, never a failure */ }
  render();
  await api.feishuViewRail(next);
});
$("#publish-static-app").onclick = () => action(async () => {
  const id = state.taskId, entry = $("#app-entry").value.trim();
  if (!id) throw new Error("请先打开一个编程任务");
  if (!entry) throw new Error("请先填写静态应用入口，例如 dist/index.html");
  const button = $("#publish-static-app"), note = $("#publish-result");
  button.disabled = true; note.textContent = "正在收集静态文件并打包…";
  try {
    const result = await api.publishStaticApp(id, entry);
    if (!result) { note.textContent = "已取消，未生成文件。"; return; }
    // Say what is not self-contained, rather than letting someone discover it
    // when the page is already in front of other people.
    const caveats = [result.external.length ? `${result.external.length} 处仍指向外部地址` : "",
      result.missing.length ? `${result.missing.length} 处引用的文件不在包里` : ""].filter(Boolean);
    note.textContent = `已生成 ${result.path}（${(result.bytes / 1024).toFixed(0)} KiB，内联 ${result.inlined} 个文件）`
      + (caveats.length ? ` · 注意：${caveats.join("，")}` : " · 完全自包含");
  } finally { button.disabled = false; }
});
$("#open-files").onclick = () => action(async () => {
  if (state.tab === "files" && !state.panelCollapsed && activeWorkbenchLayout.singlePane && state.mobilePane === "chat") { state.mobilePane = "panel"; render(); syncNativeBounds(); queueTaskUiSave(); return; }
  if (state.tab === "files" && !state.panelCollapsed) { state.panelCollapsed = true; state.mobilePane = "chat"; render(); syncNativeBounds(); queueTaskUiSave(); return; }
  await ensureTask(); return switchTab("files");
});
$("#workbench-files").onclick = () => action(async () => {
  if (state.tab === "files" && !state.panelCollapsed && activeWorkbenchLayout.singlePane && state.mobilePane === "chat") { state.mobilePane = "panel"; render(); syncNativeBounds(); queueTaskUiSave(); return; }
  if (state.tab === "files" && !state.panelCollapsed) { state.panelCollapsed = true; state.mobilePane = "chat"; render(); syncNativeBounds(); queueTaskUiSave(); return; }
  return switchTab("files");
});
$("#workbench-diff").onclick = () => action(async () => {
  if (state.tab === "changes" && !state.panelCollapsed && state.diffReview.scope === "turn") return openDiffPanel({ scope: "working" });
  if (state.tab === "changes" && !state.panelCollapsed && activeWorkbenchLayout.singlePane && state.mobilePane === "chat") { state.mobilePane = "panel"; render(); syncNativeBounds(); queueTaskUiSave(); return; }
  if (state.tab === "changes" && !state.panelCollapsed) { state.panelCollapsed = true; state.mobilePane = "chat"; render(); syncNativeBounds(); queueTaskUiSave(); return; }
  return openDiffPanel();
});
$("#workbench-preview").onclick = () => action(async () => {
  if (state.tab === "browser" && !state.panelCollapsed && activeWorkbenchLayout.singlePane && state.mobilePane === "chat") { state.mobilePane = "panel"; render(); syncNativeBounds(); queueTaskUiSave(); return; }
  if (state.tab === "browser" && !state.panelCollapsed) { state.panelCollapsed = true; state.mobilePane = "chat"; render(); syncNativeBounds(); queueTaskUiSave(); return; }
  if (state.preview && state.tab === "browser") { state.panelCollapsed = false; state.mobilePane = "panel"; render(); syncNativeBounds(); queueTaskUiSave(); return; }
  return openPreview();
});
$("#workbench-terminal").onclick = () => {
  const current = task(); if (!current || current.mode !== "coding") return;
  if (state.terminalPanels.has(current.id)) state.terminalPanels.delete(current.id); else state.terminalPanels.add(current.id);
  render(); if (state.terminalPanels.has(current.id)) terminalUi.focus();
};
// The Agent asked the application to show a generated result. The panel has no
// controls of its own any more -- it is a viewer -- so opening it is the only
// thing the renderer does here.
api.onMediaPreview(({ taskId }) => { void action(async () => {
  // The main process has already replaced whatever preview was open with this
  // one, so the old one is forgotten, not closed: closing it now (retireMediaPreview,
  // on the render below) would take down the result that was just opened.
  state.mediaPreview = false;
  // The preview is a native view positioned over the panel, so the task it
  // belongs to has to be the one on screen. Nobody sees this without having
  // asked for it, so bringing that task forward is what they expect -- leaving
  // it invisible on another task would just look like nothing happened.
  if (taskId !== state.taskId) {
    if (!state.snapshot.tasks.some(item => item.id === taskId)) return;
    saveDraft(); await flushTaskUi().catch(() => {}); clearArtifact(); state.taskId = taskId; await restoreTaskUi(taskId); render();
  }
  state.mediaPreview = { taskId };
  await switchTab("media");
  $("#media-preview-frame").hidden = false;
  requestAnimationFrame(() => { void updateMediaBounds()?.catch(() => {}); });
}); });
// The Agent created, checked, stopped or saved a result: the panel on screen
// follows it without anyone pressing 刷新状态.
api.onMediaChanged?.(({ taskId }) => { if (taskId === state.taskId && state.tab === "media") void loadMediaResults({ quiet: true }).catch(() => {}); });
$("#close-media-preview").onclick = () => action(async () => { await api.closeMediaPreview(); state.mediaPreview = false; $("#media-preview-frame").hidden = true; });
$("#collapse-panel").onclick = () => action(async () => { state.panelCollapsed = true; state.mobilePane = "chat"; render(); syncNativeBounds(); queueTaskUiSave(); });
$("#reopen-panel").onclick = () => action(async () => { state.panelCollapsed = false; state.mobilePane = "panel"; render(); syncNativeBounds(); queueTaskUiSave(); });
$("#back-to-chat").onclick = () => action(async () => { state.mobilePane = "chat"; render(); syncNativeBounds(); $("#prompt").focus(); });
$("#sidebar-toggle").onclick = () => action(async () => {
  state.sidebarPreference = activeWorkbenchLayout.sidebarVisible ? "closed" : "open";
  render(); syncNativeBounds();
});
$("#sidebar-close").onclick = () => action(async () => { state.sidebarPreference = "closed"; render(); syncNativeBounds(); });
const divider = $("#workbench-divider");
let dividerPointer = null;
function resizeWorkbenchPanel(clientX) {
  if (!activeWorkbenchLayout.split) return;
  const rect = $("#work-area").getBoundingClientRect();
  const conversationMin = activeWorkbenchLayout.viewport === "wide" ? 440 : 420;
  const panelMin = activeWorkbenchLayout.viewport === "wide" ? 380 : 360;
  state.panelWidth = clampPanelWidth({ requested: rect.right - clientX, available: rect.width, conversationMin, panelMin });
  $("#work-area").style.setProperty("--workbench-panel-width", `${state.panelWidth}px`);
  divider.setAttribute("aria-valuenow", String(state.panelWidth));
  syncNativeBounds();
}
divider.addEventListener("pointerdown", event => {
  if (!activeWorkbenchLayout.split || event.button !== 0) return;
  dividerPointer = event.pointerId; divider.setPointerCapture(event.pointerId); divider.classList.add("dragging"); event.preventDefault();
});
divider.addEventListener("pointermove", event => { if (dividerPointer === event.pointerId) resizeWorkbenchPanel(event.clientX); });
const endDividerDrag = event => { if (dividerPointer !== event.pointerId) return; dividerPointer = null; divider.classList.remove("dragging"); queueTaskUiSave(); };
divider.addEventListener("pointerup", endDividerDrag); divider.addEventListener("pointercancel", endDividerDrag);
divider.addEventListener("keydown", event => {
  if (!["ArrowLeft", "ArrowRight"].includes(event.key) || !activeWorkbenchLayout.split) return;
  event.preventDefault();
  const edge = $("#work-area").getBoundingClientRect().right - (state.panelWidth + (event.key === "ArrowLeft" ? 24 : -24));
  resizeWorkbenchPanel(edge);
});
$("#close-detail").onclick = () => $("#detail").close();
new ResizeObserver(() => { updateBounds()?.catch(() => {}); }).observe($("#preview-area"));
new ResizeObserver(() => { updateFeishuBounds()?.catch(() => {}); }).observe($("#feishu-native-area"));
// The embedded view is a native layer placed over the page, so it does not move
// with the page by itself. Anything that shifts its box — scrolling a panel,
// resizing the window — has to reposition it, or it ends up floating over
// unrelated content.
const followFeishuBounds = () => { void updateFeishuBounds()?.catch(() => {}); void updateMediaBounds()?.catch(() => {}); void updateBounds()?.catch(() => {}); void loginViewPlacement?.()?.catch(() => {}); };
document.addEventListener("scroll", followFeishuBounds, true);
// Nor does it move when something above it appears without a resize or scroll:
// the error banner pushes the Feishu section's area down, and the page stayed
// put over the banner's text. The banner is watched here; the area, which each
// Feishu section builds anew, where it is built (mountFeishuSection).
new ResizeObserver(followFeishuBounds).observe($("#error-banner"));
window.addEventListener("resize", () => {
  const current = task(), working = ["coding", "cowork"].includes(state.section);
  const panelOpen = working && Boolean(current) && SIDE_PANEL_TABS.includes(state.tab) && !state.panelCollapsed;
  applyWorkbenchLayout(panelOpen, working ? current : null);
  // A confirmation can appear while the workbench still has two columns and
  // then be hidden when the window becomes single-pane. The decision belongs
  // to the conversation, so keep it reachable instead of leaving the person
  // looking at the task-file panel with no visible way to continue.
  if (confirmationVisibleForTask(state.appConfirmation, state.taskId)
    && activeWorkbenchLayout.singlePane && state.mobilePane === "panel") {
    state.mobilePane = "chat";
    render();
  }
  followFeishuBounds();
});
// WebContentsView is always above renderer DOM. When a modal, confirmation or
// overlay sidebar appears, move native surfaces to zero bounds first and put
// them back only after the same renderer state is visible again.
const overlayObserver = new MutationObserver(records => {
  if (!records.some(record => (record.type === "attributes" && record.target instanceof HTMLDialogElement)
    || record.target === $("#confirmations") || [...record.addedNodes, ...record.removedNodes].some(node => node instanceof HTMLDialogElement))) return;
  requestAnimationFrame(syncNativeBounds);
});
overlayObserver.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open"] });
// A page that never loads should say so and hand the panel back, not sit blank.
api.onFeishuViewFailed(({ description }) => {
  if (!state.feishuView) return;
  void closeFeishuView().catch(() => {});
  error(`飞书原样视图加载失败（${description || "未知原因"}），已切回文本视图。`);
});
// The messenger counts while the app is on any other section, so the tab has to
// hear about it without being visited. Asked for once as well: this window
// reloads, and the view behind the tab outlives the reload with its own count.
api.onFeishuUnread((value) => { state.feishuUnread = value; renderFeishuUnread(); });
// A link opened from a conversation lands in 飞书文档, where the main process
// has already put it; the conversation stays as it was in 飞书消息.
api.onFeishuOpenDocs(() => { if (state.section !== "feishu-docs") void action(() => switchSection("feishu-docs")); });
api.onWebIdentity(() => { void refreshDock().catch(() => {}); });
void api.feishuUnread().then((value) => { state.feishuUnread = value; renderFeishuUnread(); }).catch(() => {});
void api.feishuDeployment().then(applyFeishuDeployment).catch(() => {});
// Whatever the view is covering, Escape takes the interface back.
document.addEventListener("keydown", event => {
  if (event.key !== "Escape" || !state.feishuView) return;
  event.preventDefault();
  const wasSettings = state.feishuView === "settings";
  void action(async () => { await closeFeishuView(); if (wasSettings) await renderLibrary(); });
});
$("#feishu-native-view").onclick = () => action(() => state.feishuView === "document" ? closeFeishuView() : openFeishuDocumentView());
$("#feishu-view-reload").onclick = () => action(async () => {
  if (!state.document) throw new Error("请先打开一个飞书文档");
  await api.feishuViewNavigate({ kind: "document", url: state.document.sourceUrl });
  error("");
});
api.onChange((snapshot) => {
  const previousTasks = state.snapshot.tasks, previous = task(), wasBusy = busy();
  state.navigationOrder = reconcileNavigationOrder(state.navigationOrder, previousTasks, snapshot.tasks); state.snapshot = snapshot;
  if (!busy() || task()?.status === "stopping") state.stopPending = false;
  if (!previous && task()) render(); else { renderSidebar(); if (task()) renderConversation(); renderTaskQueue(); renderComposerState(); renderContext(); }
  if (wasBusy && task()?.status === "completed" && state.file) {
    if (state.tab === "browser" && !state.archivePreview) action(openPreview);
    else if (state.tab === "files") action(() => loadFile(state.file.path));
  }
});
// A table a site follows changed and the background read has landed. Redraw
// only when that list is what the person is looking at: the numbers in it went
// stale the moment the read finished, and a section they are not on can wait.
api.onSitesChange(() => { if (state.section === "sites") void action(renderLibrary); });
api.onPreviewNavigation?.((page) => {
  if (state.tab !== "browser" || !state.preview || page?.taskId !== state.taskId || page.previewId !== state.previewPage?.previewId) return;
  state.previewPage = page; $("#preview-title").textContent = page.title; $("#preview-address").textContent = page.address; renderContext();
});
api.onPreviewExpired((value) => {
  if (state.tab !== "browser" || state.archivePreview?.previewId !== value.previewId) return;
  viewEpoch += 1; state.preview = false; state.previewPage = null; $("#preview-area").dataset.previewState = "expired";
  $("#preview-title").textContent = "归档预览已到期 · 刷新会重新核验权限和归档内容"; renderContext();
});
api.onDocumentInvalidated(({ taskId, handle }) => {
  if (state.taskId !== taskId || state.document?.handle !== handle) return;
  clearDocument(); state.selection = null; $("#file-content").value = ""; $("#file-title").textContent = "文档引用已失效，请重新读取"; renderContext();
});
api.onSheetInvalidated(({ taskId, handle }) => {
  if (state.taskId !== taskId || state.sheet?.handle !== handle) return;
  clearDocument(); $("#file-title").textContent = "表格引用已失效，请重新读取"; renderContext();
});
api.onBaseInvalidated(({ taskId, handle }) => {
  if (state.taskId !== taskId || state.base?.handle !== handle) return;
  clearDocument(); $("#file-title").textContent = "多维表格引用已失效，请重新读取"; renderContext();
});
// Application confirmations and Codex approvals share a visual language but
// not an authorization resolver. This state only paints the main-process card;
// the main process owns its deadline and rejects stale/account-crossing replies.
let appConfirmationClearTimer;
function drawAppConfirmation({ focusCancel = false } = {}) {
  const request = state.appConfirmation, host = $("#confirmations");
  if (!request) { host.replaceChildren(); placeConfirmations(); renderSidebar(); return; }
  const card = element("div", undefined, `${request.danger ? "confirm-card danger" : "confirm-card"}${request.status === "pending" ? "" : " settled"}`);
  card.dataset.confirmId = request.id;
  card.append(element("strong", request.title || "请确认"), element("p", request.message));
  if (request.taskId) {
    const owner = state.snapshot.tasks.find((row) => row.id === request.taskId);
    card.append(element("small", `所属任务：${owner?.title ?? "当前任务"}`, "confirm-owner"));
  }
  if (request.detail) card.append(element("pre", request.detail));
  // Identifiers are for checking, folded away from what a person reads, shares
  // and records (see delivery-confirmation.js).
  if (request.technical) {
    const technical = element("details", undefined, "confirm-technical");
    technical.append(element("summary", "核对信息"), element("pre", request.technical));
    card.append(technical);
  }
  if (request.boundary) card.append(element("p", request.boundary, "confirm-boundary"));
  let cancelButton = null;
  if (request.status === "pending") {
    const row = element("div", undefined, "confirm-actions");
    request.buttons.forEach((label, index) => {
      const button = element("button", label);
      if (index === request.cancelId) cancelButton = button;
      if (request.danger && index !== request.cancelId) button.className = "danger";
      else if (index === request.defaultId && index !== request.cancelId) button.className = "primary";
      button.onclick = () => {
        if (state.appConfirmation?.id !== request.id || state.appConfirmation.status !== "pending") return;
        state.appConfirmation = { ...state.appConfirmation, status: "responding", statusText: "处理中…" };
        drawAppConfirmation();
        void api.confirmResponse({ id: request.id, response: index }).then((result) => {
          if (state.appConfirmation?.id !== request.id) return;
          if (result?.accepted === false) settleAppConfirmation(request.id, "invalid", "已失效 · 没有执行任何操作");
          else if (index === request.cancelId) settleAppConfirmation(request.id, "canceled", "已取消 · 没有执行这次操作");
          else settleAppConfirmation(request.id, "accepted", "已确认 · 已交回发起操作继续处理");
        }, () => settleAppConfirmation(request.id, "invalid", "响应失败 · 没有获得操作许可"));
      };
      row.append(button);
    });
    card.append(row);
  } else card.append(element("p", request.statusText || "处理中…", "confirm-state"));
  host.replaceChildren(card); placeConfirmations(); renderSidebar(); syncNativeBounds();
  if (focusCancel && request.danger && !host.hidden) cancelButton?.focus({ preventScroll: true });
}
function settleAppConfirmation(id, status, statusText) {
  if (state.appConfirmation?.id !== id) return;
  state.appConfirmation = { ...state.appConfirmation, status, statusText };
  clearTimeout(appConfirmationClearTimer); drawAppConfirmation();
  appConfirmationClearTimer = setTimeout(() => {
    if (state.appConfirmation?.id !== id || state.appConfirmation.status === "pending") return;
    state.appConfirmation = null; drawAppConfirmation();
  }, 6000);
}
api.onConfirm((request) => {
  // A duplicated event is a repaint of the same main-process request. Keep the
  // original deadline and response state; never manufacture a fresh card.
  const fresh = state.appConfirmation?.id !== request.id;
  if (!fresh) { placeConfirmations(); renderSidebar(); syncNativeBounds(); return; }
  clearTimeout(appConfirmationClearTimer);
  state.appConfirmation = { ...request, status: "pending" };
  const visible = confirmationVisibleForTask(state.appConfirmation, state.taskId);
  if (visible && activeWorkbenchLayout.singlePane && state.mobilePane === "panel") { state.mobilePane = "chat"; render(); }
  drawAppConfirmation({ focusCancel: fresh && visible });
});
// Timeout, account change, reload and a withdrawn Agent request all leave one
// short non-interactive record. They never retain buttons or imply permission.
api.onConfirmWithdrawn?.(({ id, reason } = {}) => {
  const text = reason === "timeout" ? "已超时 · 没有执行任何操作"
    : reason === "account-changed" ? "账号已切换 · 旧确认已作废"
      : reason === "reloaded" ? "页面已刷新 · 旧确认已作废"
        : "发起操作已经结束 · 确认已作废";
  settleAppConfirmation(id, reason || "withdrawn", text);
  error(text);
});
// A login can come back on its own after a restart, so the view has to follow
// the account rather than only what it was drawn with.
// The browser half is done the moment the callback lands; check immediately
// rather than leaving the person looking at a finished page.
api.onLoginCallback(() => action(async () => {
  loginViewPlacement = null;
  await api.closeLoginView().catch(() => {});
  await api.authPoll().catch(() => {});
  if (state.section === "settings") await renderLibrary();
}));
api.onAuthChanged(() => action(async () => {
  // Main-process account scopes are already switched when this arrives. Drop
  // every renderer-owned reference before asking the new scope for data, so
  // account Y never gets even a frame containing account X's draft or panel.
  for (const timer of taskUiTimers.values()) clearTimeout(timer);
  clearTimeout(appConfirmationClearTimer); state.appConfirmation = null; $("#confirmations").replaceChildren();
  taskUiTimers.clear(); taskUiRecords.clear(); taskUiDirty.clear(); taskUiSaving.clear(); drafts.clear(); mentionDrafts.clear(); pastedImages.clear(); queueEditDrafts.clear(); queueAttempt = null;
  state.taskId = null; state.taskUiMeta = []; state.taskSearch = ""; state.showArchived = false; state.navigationOrder = [];
  state.openSteps.clear(); state.terminalPanels.clear(); stepOpen.clear(); openChanges.clear(); state.snapshot = { tasks: [], approvals: [], warnings: [] }; state.tab = "chat";
  $("#prompt").value = ""; mention.picks = []; clearArtifact(); render();
  await updateConnection(); state.snapshot = await api.snapshot();
  const navigation = await api.taskUiNavigation(); state.taskUiMeta = navigation.items; state.navigationOrder = state.snapshot.tasks.map(item => item.id);
  if (["coding", "cowork", "feishu", "feishu-docs"].includes(state.section)) await restoreTaskUi();
  // 技能中心 holds per-account data -- the enterprise shelf, whether this person
  // may publish, their own imports -- so a different account means a fresh one.
  if (["settings", "knowledge", "schedules", "feishu", "feishu-docs", "skills"].includes(state.section)) await renderLibrary();
  render();
}));
state.section = lastSection();
api.onFlushTaskUi?.(async () => {
  saveDraft();
  await Promise.all([...new Set([...taskUiDirty, ...taskUiTimers.keys()])].map(key => flushTaskUi(key).catch(() => {})));
});
await action(async () => {
  state.snapshot = await api.snapshot();
  const navigation = await api.taskUiNavigation(); state.taskUiMeta = navigation.items; state.navigationOrder = state.snapshot.tasks.map(item => item.id);
  // Under draftKey(), as switchSection does: a start straight into a Feishu
  // section must know the cowork draft's revision before its composer saves.
  await restoreTaskUi(); await updateConnection(); await loadPermissionModes(); render();
  const warnings = [...state.snapshot.warnings, ...navigation.warnings]; if (warnings.length) error(warnings.join("\n"));
});
if (state.section === "coding") await action(() => loadRecentProjects(viewEpoch));
const logoutNotice = sessionStorage.getItem("logout-notice");
if (logoutNotice) { sessionStorage.removeItem("logout-notice"); error(logoutNotice); }
setInterval(() => updateConnection().catch(() => {}), 30_000);
// A running turn produces no snapshot change while the model is thinking, so
// the elapsed-time label needs its own tick to keep moving.
setInterval(() => { if (RUNNING_STATUSES.has(task()?.status) && !$("#conversation").hidden) renderConversation(); }, 1000);
