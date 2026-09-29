// What the open document is called. Feishu names the page after it -- measured on
// the real client, the drive home reads "主页 - 飞书云文档" -- so the name is the
// page title without the product's own suffix. The address is still what the Agent
// opens; this is only what the person is shown, because a link is not a name.
//
// Nothing here reads the page: the title is what the view already reports to the
// application, the same place the unread count comes from.
const PRODUCTS = "飞书云文档|飞书文档|飞书|Feishu Docs|Feishu|Lark Docs|Lark";
const SUFFIX = new RegExp(`\\s*[-—–]\\s*(?:${PRODUCTS})\\s*$`);
// A page that is only the product's own name -- a view that carries no document,
// or one still loading -- names nothing, and saying "当前文档：飞书云文档" would
// be worse than showing the address.
const BARE = new RegExp(`^(?:${PRODUCTS})$`);
const MAX = 60;

// Feishu pads the title with invisible characters -- measured on a real document,
// several dozen zero-width and directional marks before the name itself -- so the
// name would arrive as a stretch of blanks with the words at the end. They carry
// no meaning here and are dropped before anything else is decided.
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁪-⁯﻿]/g;

export function documentName(title) {
  if (typeof title !== "string") return "";
  const text = title.replace(INVISIBLE, "").replace(/\s+/g, " ").trim().replace(SUFFIX, "").trim();
  return text.length > 0 && text.length <= MAX && !BARE.test(text) ? text : "";
}
