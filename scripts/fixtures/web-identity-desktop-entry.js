// Test-only synthetic Feishu for the embedded pages and the web-identity probe.
// Production never imports this entry.
//
// Every https request from a Feishu partition is answered here, so nothing
// reaches the real Feishu: the messenger is a page with one header in it, and
// Feishu's authorize page either sends the browser straight back with a code
// naming whoever the pages are "signed in" as, or shows a consent link the
// script clicks the way a person would.
import "../../src/adopt-legacy-env.js";
import { app, safeStorage } from "electron";
import { SaasFeishuCliProvider } from "../../src/providers/feishu/saas-cli-provider.js";
import { fixtureCipher } from "./wiki-cipher.js";

const cipher = fixtureCipher(Buffer.alloc(32, 41));
safeStorage.isEncryptionAvailable = cipher.available; safeStorage.encryptString = cipher.encrypt; safeStorage.decryptString = cipher.decrypt;

const fixture = globalThis.webIdentityFixture = {
  webUser: "alpha",
  consent: false,
  header: "项目组",
  authorizations: [],
  pageSessions: [],
  cliOpenId: "ou_cli_alpha", tenantUserId: "alpha", tenant: "tenant_fixture",
  chats: [
    { chat_id: "oc_projectgroup0001", name: "项目组", chat_mode: "group" },
    { chat_id: "oc_weeklymeeting001", name: "周会", chat_mode: "group" },
    { chat_id: "oc_weeklymeeting002", name: "周会", chat_mode: "group" },
    { chat_id: "oc_someonealone0001", name: "独立会话", chat_mode: "p2p" },
  ],
  chatLists: 0,
  // What every page tried to do, for a script that has to explain a failure.
  trace: [],
};
app.on("web-contents-created", (_event, contents) => {
  const note = (kind, detail) => { if (fixture.trace.length < 200) fixture.trace.push(`${kind} ${String(detail).slice(0, 160)}`); };
  contents.on("console-message", (details) => note("console", details?.message ?? details));
  contents.on("will-navigate", (_navigation, url) => note("will-navigate", url));
  contents.on("will-redirect", (_navigation, url) => note("will-redirect", url));
  contents.on("did-fail-load", (_failure, code, description, url) => note("did-fail-load", `${code} ${description} ${url}`));
  contents.on("did-navigate", (_navigation, url) => note("did-navigate", url));
});
// Keeps the login entry below from replacing the cipher set here.
globalThis.accountFixture = fixture;

const escape = (value) => String(value).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[character]);
const page = (body, title) => new Response(`<!doctype html><meta charset="utf-8"><title>${escape(title)}</title><body style="margin:0;font:14px sans-serif">${body}</body>`,
  { headers: { "content-type": "text/html; charset=utf-8" } });
// Feishu's messenger as measured on its own page (2026-09-24), for smokes about
// how it is laid out (`messengerLayout`): the app rail beside the content, and in
// the content the conversation list (288), a 6 px splitter and the conversation,
// sized in script from the width the content has -- only on a window resize. The
// list folds away when the conversation would be narrower than 350. Panes left
// over from a wider layout are clipped, never scrolled: showing the rail over a
// stale layout measured the full width on Feishu's page, not a scrollbar less.
const messengerLayout = (header) => `<section class="appLayout" style="display:flex;height:100vh;overflow:hidden">
<section class="appNavbar" style="flex:0 0 auto;width:156px;background:#46506a"></section>
<main class="appLayout-content" style="flex:1 1 0%;min-width:0;padding-right:6px;overflow:hidden">
<div id="app-page-container" style="display:flex;height:100%">
<div class="page-view-messenger" style="flex:none;height:100%;background:#eef0f3"></div>
<div class="sidebar-resizer" style="flex:none;width:6px"></div>
<div class="page-view-messenger-chat" style="flex:none;height:100%;background:#f8f9fa"><div id="header" class="header_title" style="display:inline-block;padding:12px;font-size:16px">${escape(header)}</div></div>
</div></main></section>
<script>
const LIST = 288, SPLITTER = 6, CONVERSATION_MIN = 350;
function layout() {
  const width = document.getElementById("app-page-container").getBoundingClientRect().width;
  const list = document.querySelector(".page-view-messenger"), splitter = document.querySelector(".sidebar-resizer");
  const folded = width - LIST - SPLITTER < CONVERSATION_MIN;
  list.style.display = splitter.style.display = folded ? "none" : "";
  list.style.width = LIST + "px";
  document.querySelector(".page-view-messenger-chat").style.width = (folded ? width : width - LIST - SPLITTER) + "px";
}
addEventListener("resize", layout);
layout();
</script>`;

app.on("session-created", (session) => {
  const where = session.storagePath ?? "";
  fixture.trace.push(`session-created ${where}`);
  if (!/Partitions[/\\]feishu-/.test(where)) return;
  const pages = /Partitions[/\\]feishu-web-/.test(where);
  if (pages) fixture.pageSessions.push(session);
  intercept(session, pages);
});
function intercept(session, pages) {
  // Feishu's authorize page is reached by a redirect from the control plane, and
  // a redirect is followed without consulting protocol handlers -- measured: the
  // probe loaded the real passport page. So it is caught here, before any
  // request leaves, and answered with the redirect Feishu itself would send.
  session.webRequest.onBeforeRequest({ urls: ["https://accounts.feishu.cn/*"] }, (details, callback) => {
    const url = new URL(details.url);
    // The sign-in view: the script completes sign-in over HTTP itself, and
    // nothing goes to the real Feishu.
    if (!pages || url.pathname !== "/open-apis/authen/v1/authorize") { callback({ cancel: true }); return; }
    fixture.authorizations.push({ scope: url.searchParams.get("scope"), user: fixture.webUser });
    const back = new URL(url.searchParams.get("redirect_uri"));
    back.searchParams.set("code", `web-${fixture.webUser}`);
    back.searchParams.set("state", url.searchParams.get("state"));
    if (!fixture.consent) { callback({ redirectURL: back.href }); return; }
    // A page that needs a person, served by the script's own control plane.
    const consent = new URL("/fixture/consent", back.origin);
    consent.searchParams.set("next", back.href);
    callback({ redirectURL: consent.href });
  });
  // The tenant's own pages are loaded directly, so a protocol handler serves them.
  session.protocol.handle("https", async (request) => {
    const url = new URL(request.url);
    if (!/(^|\.)feishu\.cn$/.test(url.hostname)) return new Response("not part of this fixture", { status: 404 });
    if (url.pathname.includes("SyntheticSlowDoc12345")) {
      fixture.slowDocumentStarted = true;
      await new Promise(resolve => { fixture.releaseSlowDocument = resolve; });
    }
    // A Feishu address that answers with a redirect somewhere else, as a link
    // redirector does.
    if (url.pathname === "/fixture/leave") return new Response(null, { status: 302, headers: { location: url.searchParams.get("to") ?? "https://outside.example/" } });
    if (url.pathname.startsWith("/messenger")) {
      if (fixture.messengerLayout) return page(messengerLayout(fixture.header), "消息 - 飞书");
      return page(`<div id="header" class="header_title" style="display:inline-block;padding:12px;font-size:16px">${escape(fixture.header)}</div>`, "消息 - 飞书");
    }
    return page(`<p>${escape(url.pathname)}</p>`, "合成文档 - 飞书");
  });
  fixture.trace.push(`intercepting ${pages ? "pages" : "sign-in"} ${session.storagePath}`);
}

const invoke = SaasFeishuCliProvider.prototype.invoke;
SaasFeishuCliProvider.prototype.invoke = async function(args, options) {
  if (!this.fixtureRunner) {
    const originalRunner = this.runner;
    this.runner = async (binary, argv, opts) => {
      const ok = (data) => ({ code: 0, stderr: "", stdout: JSON.stringify({ ok: true, identity: "user", data }) });
      if (argv[0] === "skills" || argv[0] === "--version") return originalRunner(binary, argv, opts);
      if (argv[0] === "api" && argv[2] === "/open-apis/authen/v1/user_info") return ok({ open_id: fixture.cliOpenId, user_id: fixture.tenantUserId, tenant_key: fixture.tenant });
      if (argv[0] === "im" && argv[1] === "+chat-list") { fixture.chatLists += 1; return ok({ chats: fixture.chats, has_more: false }); }
      // The readers turn any failure into their own generic one, so the command
      // that was refused is only ever seen here.
      fixture.trace.push(`unexpected-cli ${argv.slice(0, 4).join(" ")}`);
      throw new Error(`Unexpected fixture command ${argv.slice(0, 2).join(" ")}; no live Feishu call is permitted`);
    };
    this.fixtureRunner = true;
  }
  return invoke.call(this, args, options);
};
await import("./login-desktop-entry.js");
