// A Feishu page loaded while its view is hidden can finish loading and still
// never start. Measured 2026-09-22: once the embedded web session had been
// signed out, the warm-up's load of 消息 and 文档 was redirected to Feishu's own
// login page, which stayed on its loading illustration for good -- shown,
// focused, with animation frames running, 19 of its 50 resources fetched and
// its first API call never made -- and started at once when reloaded in view.
// So there was no QR code to scan, and no way back in.
//
// Whether a view that is now on screen is in that state: it was sent to one
// page, finished loading on a page of another host (a sign-in redirect), and has
// no title, which every Feishu page that has started sets. The host test keeps
// this to redirects, and to no particular deployment's sign-in address.
export function stalledRedirect({ requested, landed, title, settled }) {
  if (settled !== true || typeof title !== "string" || title.trim() !== "") return false;
  let from, to;
  try { from = new URL(requested); to = new URL(landed); } catch { return false; }
  return from.protocol === "https:" && to.protocol === "https:" && from.host !== to.host;
}
