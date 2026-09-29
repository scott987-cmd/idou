// Reports what the person has selected inside Feishu's own page, so the Agent
// beside it knows which passage they are pointing at.
//
// This is the one thing the embedded view cannot tell the application from the
// outside: the page is Feishu's, rendered in its own process, and a document is
// opaque from the host side. A selection is also exactly the anchor a precise
// edit needs -- the selected text becomes the pattern a replacement matches.
//
// It only reads. Nothing is exposed to the page (no contextBridge), nothing is
// written back into it, and the only thing that leaves is the selected text and
// the short label of whatever was clicked. Page content is untrusted data: the
// application treats it as a quotation, never as an instruction.
const { ipcRenderer } = require("electron");

const MAX = 2000;
// Base cells and field headers are clicked rather than text-selected, so a plain
// selection is empty there. Climbing a few levels finds the short single-line
// label of the thing under the cursor, which is what "this cell" means.
const LABEL_LEVELS = 5;
const LABEL_MAX = 60;

function clickedLabel(target) {
  let node = target instanceof Element ? target : null;
  for (let level = 0; level < LABEL_LEVELS && node; level++) {
    const text = (node.textContent || "").replace(/\s+/g, " ").trim();
    if (text && text.length <= LABEL_MAX && !text.includes("\n")) return text;
    node = node.parentElement;
  }
  return "";
}

let last = null, timer = null;

function report(clicked) {
  const selected = String(window.getSelection ? window.getSelection().toString() : "").trim();
  const value = { text: selected.slice(0, MAX), truncated: selected.length > MAX, label: selected ? "" : clicked };
  const key = `${value.text}\0${value.label}`;
  if (key === last) return;
  last = key;
  try { ipcRenderer.send("idou:feishu-selection", value); } catch { /* the view is going away */ }
}

// Selection changes fire continuously while dragging; one report after the
// gesture settles is enough and keeps this off the page's critical path.
function schedule(clicked) {
  clearTimeout(timer);
  timer = setTimeout(() => report(clicked), 180);
}

document.addEventListener("selectionchange", () => schedule(""), true);
document.addEventListener("mouseup", (event) => schedule(clickedLabel(event.target)), true);
document.addEventListener("keyup", () => schedule(""), true);

// Which conversation is open, in the messenger only. Nothing else says: the
// address stays the same and the title stays "消息 - 飞书" whichever one is
// selected, so the page's own header is the only place the name appears. Only
// that one short title is read -- no message, no thread, no list -- and only the
// innermost element, because the ones around it carry the tabs and the 外部 badge.
//
// Where that header is belongs to the deployment's web client, so the main
// process hands it over (`--idou-page-reader`). Without it nothing is read
// and no conversation is ever named.
function pageReader() {
  const prefix = "--idou-page-reader=";
  const found = (process.argv || []).find((value) => typeof value === "string" && value.startsWith(prefix));
  try {
    const value = found && JSON.parse(decodeURIComponent(found.slice(prefix.length)));
    return value && typeof value.chatPage === "string" && typeof value.chatTitle === "string" ? value : null;
  } catch { return null; }
}
const READER = pageReader();
const CHAT_NAME_MAX = 30;
let lastChat = null, quiet = 0;

function openChatName() {
  if (!READER || !location.pathname.includes(READER.chatPage)) return "";
  const CHAT_TITLE = READER.chatTitle;
  for (const node of document.querySelectorAll(CHAT_TITLE)) {
    if (node.querySelector(CHAT_TITLE)) continue;
    const text = (node.textContent || "").replace(/\s+/g, " ").trim();
    const rect = node.getBoundingClientRect();
    if (text && text.length <= CHAT_NAME_MAX && rect.width > 8 && rect.height > 8) return text;
  }
  return "";
}

function reportChat() {
  const name = openChatName();
  // Said again every so often even when nothing changed: the host forgets what it
  // knows when the page leaves, and a page that only spoke on change would leave
  // the dock empty for as long as the person stayed in one conversation.
  if (name === lastChat && ++quiet < 5) return;
  lastChat = name; quiet = 0;
  try { ipcRenderer.send("idou:feishu-chat", { name }); } catch { /* the view is going away */ }
}

// Switching conversation is a click, which is already listened for; the interval
// is for every other way it can change, and costs one small read of one element.
document.addEventListener("mouseup", () => setTimeout(reportChat, 200), true);
setInterval(reportChat, 2000);
