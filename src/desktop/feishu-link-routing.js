// Where a link that an embedded Feishu page tries to open should go.
//
// Feishu's messenger opens a document linked in a conversation as a new
// window. The views here refuse new windows, and used to load such a link into
// the view that asked. That is right for 飞书文档, whose own page opens its
// documents in place, and wrong for 飞书消息: the document replaced the
// conversation, and with no way back the section stayed a document from then
// on (reported 2026-09-27). A link from the messenger goes to 飞书文档 instead,
// and the conversation stays where it was.
//
//   "here"      load it in the view that asked (飞书文档, a task's document)
//   "docs"      open it in 飞书文档 and show that section
//   "external"  the system browser: not a Feishu page
//   "ignore"    nothing: not https, or a messenger that is not on screen
//
// `feishuPage(url)` is the deployment's own test of a page the embedded views
// may show. `visible` is whether the asking view is the one on screen: a
// messenger warming behind another section has no business moving the app.
export function routeFeishuLink({ kind, target, visible, feishuPage }) {
  if (!feishuPage(target)) return typeof target === "string" && /^https:/i.test(target) ? "external" : "ignore";
  if (kind !== "messenger") return "here";
  return visible ? "docs" : "ignore";
}

// The messenger's own page navigating away to a document -- a link followed in
// place rather than as a new window -- is diverted the same way. Only to a
// document: the messenger navigates through Feishu's sign-in pages and its own
// addresses, and those must go on as they always have. `resource(url)` is the
// deployment's reading of a page address as a document, or null.
export function divertsFromMessenger({ kind, target, feishuPage, resource }) {
  return kind === "messenger" && feishuPage(target) && Boolean(resource(target));
}
