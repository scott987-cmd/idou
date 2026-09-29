import { DOMParser } from "@xmldom/xmldom";
import { hostWithin, SAAS_RESOURCE_HOSTS } from "./saas-deployment.js";

export function parseSaasDocumentReference(value) {
  if (typeof value !== "string" || value.length > 2048 || /[\\\x00-\x20]/.test(value)) throw new Error("请输入有效的飞书文档链接");
  let url;
  try { url = new URL(value); } catch { throw new Error("请输入完整的 HTTPS 飞书文档链接"); }
  const match = url.pathname.match(/^\/(docx|wiki)\/([A-Za-z0-9_-]{8,128})\/?$/);
  if (url.protocol !== "https:" || url.port || url.username || url.password || !match ||
      !hostWithin(url.hostname, SAAS_RESOURCE_HOSTS) ||
      (url.hash && !/^#[A-Za-z0-9_-]{1,200}$/.test(url.hash))) throw new Error("当前 SaaS 适配器仅支持飞书、Lark 或豆包的 HTTPS docx/wiki 文档链接；表格能力尚未接入");
  url.search = "";
  return { kind: match[1], token: match[2], url: url.href, partial: Boolean(url.hash) };
}

// Projection for reading, never an XML/HTML execution surface or round-trip editor.
export function projectDocumentXml(xml) {
  if (typeof xml !== "string" || Buffer.byteLength(xml) > 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("文档结构过大或包含不支持的声明");
  let document;
  try { document = new DOMParser({ onError: () => { throw new Error("Invalid XML"); } }).parseFromString(`<document>${xml}</document>`, "application/xml"); }
  catch { throw new Error("无法解析文档结构，未展示可能残缺的内容"); }
  const chunks = [], resources = [], warnings = new Set();
  const blocks = new Set(["title", "p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "tr", "blockquote", "pre", "callout"]);
  let count = 0, title = "飞书文档", partial = false;
  const stack = [{ node: document.documentElement, depth: 0 }];
  while (stack.length) {
    const { node, depth, closing } = stack.pop();
    if (closing) { chunks.push("\n"); continue; }
    if (++count > 20_000 || depth > 64) throw new Error("文档结构超出当前阅读器限制");
    if (node.nodeType === 3 || node.nodeType === 4) { if (/\S/.test(node.data) || !/[\r\n]/.test(node.data)) chunks.push(node.data); continue; }
    if (node.nodeType !== 1) continue;
    const tag = node.tagName.toLowerCase();
    if (tag === "title" && title === "飞书文档") title = node.textContent.trim().slice(0, 200) || title;
    if (["fragment", "excerpt"].includes(tag)) partial = true;
    const resourceType = ["sheet", "bitable", "img", "source", "whiteboard", "synced_reference"].includes(tag) ? tag : tag === "cite" && ["sheets", "bitable"].includes(node.getAttribute("file-type")) ? node.getAttribute("file-type") : null;
    if (resourceType) {
      const names = { sheet: "电子表格", sheets: "电子表格", bitable: "多维表格", img: "图片", source: "附件", whiteboard: "画板", synced_reference: "同步引用" };
      const label = `${names[resourceType]}：${node.getAttribute("name") || "内部内容未加载"}`;
      resources.push({ kind: resourceType, label, token: node.getAttribute("token") || node.getAttribute("src-token") || null, sheetId: node.getAttribute("sheet-id") || null, tableId: node.getAttribute("table-id") || null });
      chunks.push(`\n[${label}]\n`); warnings.add("图片、附件和嵌入表格等资源未展开，不能将当前文本视为这些资源的完整内容。"); continue;
    }
    if (["script", "style", "iframe", "object"].includes(tag)) { warnings.add("不支持的活动内容已忽略。"); continue; }
    if (tag === "br") { chunks.push("\n"); continue; }
    if (["td", "th"].includes(tag)) chunks.push("\t");
    if (blocks.has(tag)) { chunks.push("\n"); stack.push({ closing: true }); }
    for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push({ node: node.childNodes.item(i), depth: depth + 1 });
  }
  return { title, text: chunks.join("").replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim(), resources, warnings: [...warnings], partial };
}
