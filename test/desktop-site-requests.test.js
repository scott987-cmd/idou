// How the desktop asks the server about published sites (src/desktop/main.js),
// read from its source: the main process cannot be started in a unit test, and
// these are the lines a later edit could quietly undo. Found in review before
// .270: every site request waited 60 seconds while the server's content check
// could take longer and still publish; a quit then waited on it; and a publish
// given up on, published again, put up a second site.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const main = await readFile(new URL("../src/desktop/main.js", import.meta.url), "utf8");
const block = (start) => {
  const at = main.indexOf(start);
  assert.ok(at >= 0, `${start} is in main.js`);
  return main.slice(at, main.indexOf("\n  };\n", at) + 5);
};

test("site requests wait as long as their route needs, and stop when the app quits", () => {
  assert.match(main, /import \{ siteRequestTimeout, siteRequestFailure, siteRequestBody, tooMuchData \} from "\.\.\/application\/site-requests\.js";/);
  const request = block("const siteRequest = async (route, body, { updating = false } = {}) =>");
  assert.match(request, /signal: AbortSignal\.any\(\[AbortSignal\.timeout\(siteRequestTimeout\(route\)\), leaving\.signal\]\)/);
  assert.doesNotMatch(request, /AbortSignal\.timeout\(\d/, "no fixed wait of its own");
  assert.match(block("const beginShutdown = () =>"), /leaving\.abort\(\);/, "quitting stops what waits on the network");
});

test("a first publish goes out under the id kept for it, and the list adopts it once it is up", () => {
  const publish = main.slice(main.indexOf("const publishLocalSite = async"), main.indexOf('bind("site-republish"'));
  // Read after the card, not from the copy taken before it (third review before .270).
  assert.match(publish, /const current = await scope\.siteStore\.recordPublishing\(site\.id\);\s*const siteId = current\.publishedId \?\? current\.publishingId;/);
  assert.ok(publish.indexOf("recordPublishing(site.id)") > publish.indexOf("await approve("), "after the card");
  assert.match(publish, /siteRequest\("\/v1\/sites\/publish", \{\s*siteId,/);
  const list = main.slice(main.indexOf('bind("sites"'), main.indexOf('bind("sites"') + 2500);
  // Asked at every drawing since the list is the server's too (docs/sites-phase0.md
  // §0.5) -- which covers a first publish that may be up; no answer draws this
  // computer's list as it last knew it.
  assert.match(list, /const listed = await siteRequest\("\/v1\/sites\/list", \{\}\)\.catch\(\(\) => null\);/, "the server is asked when a first publish may be up");
  assert.match(list, /await followServer\([^;]*\)\.catch\(\(\) => \{\}\);/, "the list is drawn even when following fails");
  const follow = main.slice(main.indexOf("const followServer = async (remote, { askedAt = null } = {}) =>"), main.indexOf('bind("sites", async () =>'));
  assert.match(follow, /remote\.get\(site\.publishingId\)/);
});

test("a request that came back with no answer is said in words a person can act on", async () => {
  const { siteRequestFailure, CHECKED_SITE_ROUTES } = await import("../src/application/site-requests.js");
  const late = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  const cutOff = Object.assign(new TypeError("terminated"), { cause: { code: "UND_ERR_SOCKET" } });
  const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  assert.equal(siteRequestFailure(late, "/v1/sites/publish"), "服务端还在检查，等了 4 分钟仍没有答复。它可能稍后就会生效：过一会儿刷新网站列表看看；再点发布会更新同一个网站，不会多出一个。");
  assert.match(siteRequestFailure(cutOff, "/v1/sites/data"), /^和服务端的连接在答复前断开了。这次的数据可能稍后更新到线上/, "broken off after it was sent: it may still happen");
  assert.match(siteRequestFailure(late, "/v1/sites/share"), /新的分享范围可能稍后生效/);
  assert.match(siteRequestFailure(late, "/v1/sites/republish"), /网站可能稍后重新上线/);
  assert.equal(siteRequestFailure(refused, "/v1/sites/publish"), "连不上服务端，请检查网络后再试。", "never got there: nothing will happen");
  assert.equal(siteRequestFailure(late, "/v1/sites/list"), "服务端没有及时答复，请稍后再试。");
  assert.match(siteRequestFailure(late, "/v1/sites/publish", { quitting: true }), /正在退出/);
  // Fifth review before .270: each kind said for what may have happened.
  const certificate = Object.assign(new TypeError("fetch failed"), { cause: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" } });
  const redirected = Object.assign(new TypeError("fetch failed"), { cause: { message: "unexpected redirect" } });
  const garbled = new SyntaxError("Unexpected token < in JSON");
  assert.match(siteRequestFailure(certificate, "/v1/sites/publish"), /^服务端的证书没有通过校验，这次请求没有发出去/);
  assert.match(siteRequestFailure(redirected, "/v1/sites/publish"), /^答复被转到了别的地址，这次请求没有执行/);
  assert.match(siteRequestFailure(garbled, "/v1/sites/publish"), /^收到的答复看不懂（可能被网络或代理改动了）。它可能稍后就会生效/);
  assert.match(siteRequestFailure(cutOff, "/v1/sites/withdraw"), /可能已经取消发布：过一会儿刷新网站列表看看/);
  assert.match(siteRequestFailure(late, "/v1/sites/publish", { updating: true }), /新版本可能稍后就会上线：打开链接看看；再点「更新线上」/);
  for (const route of [...CHECKED_SITE_ROUTES, "/v1/sites/list", "/v1/sites/withdraw", "/v1/sites/erase"]) for (const error of [late, cutOff, refused, certificate, redirected, garbled, new TypeError("fetch failed")]) {
    assert.doesNotMatch(siteRequestFailure(error, route), /[A-Za-z]{3,}|undefined/, `${route}: no English, nothing missing`);
  }
  const request = block("const siteRequest = async (route, body, { updating = false } = {}) =>");
  assert.match(request, /catch \(error\) \{ throw new Error\(siteRequestFailure\(error, route, \{ quitting: leaving\.signal\.aborted, updating \}\)\); \}/);
});

test("the site list redrawn in the background leaves what the person was told in place", async () => {
  const renderer = await readFile(new URL("../src/desktop/renderer/app.js", import.meta.url), "utf8");
  const listener = renderer.split("\n").find((line) => line.startsWith("api.onSitesChange("));
  assert.ok(listener, "the listener is there");
  assert.doesNotMatch(listener, /action\(/, "action() clears the message before it runs");
  assert.match(listener, /void redrawSites\(\)/);
  const redraw = renderer.slice(renderer.indexOf("function redrawSites()"), renderer.indexOf("function redrawSites()") + 400);
  assert.doesNotMatch(redraw, /action\(/);
  assert.match(redraw, /renderLibrary\(\)\.catch\(\(cause\) => error\(readableError\(cause\)\)\)/);
});

test("the desktop follows the server's word on its published sites, and asks again for a table site it thinks is down", () => {
  const follow = main.slice(main.indexOf("const followServer = async (remote, { askedAt = null } = {}) =>"), main.indexOf('bind("sites", async () =>'));
  assert.match(follow, /store\.recordServer\(site\.id, \{ offline: row\.offline === true/);
  assert.ok(main.indexOf("const followServer = async (remote, { askedAt = null } = {}) =>") < main.indexOf('bind("sites", async () =>'), "defined before the first handler that uses it");
  const refresh = main.slice(main.indexOf("const refreshDueSites = async () =>"), main.indexOf("setInterval(() => { void refreshDueSites(); }"));
  assert.match(refresh, /Date\.now\(\) - followedAt > 5 \* 60_000 && scope\.siteStore\.list\(\)\.some\(\(site\) => site\.slice && site\.publishedId && site\.publishedOffline === true\)/);
  assert.match(refresh, /await followServer\(/);
});

test("one change of a site's at a time, said before any card; 取消发布 is never held back", () => {
  const defined = main.indexOf("const oneAtATime = async (id, run) =>");
  assert.ok(defined > 0);
  for (const handler of ['bind("site-publish", async ({ id, share } = {}) => oneAtATime(id, async () => {', 'bind("site-republish", async (id) => oneAtATime(id, async () => {', 'bind("site-share-set", async ({ id, share } = {}) => oneAtATime(id, async () => {']) {
    assert.ok(main.includes(handler), handler);
    assert.ok(main.indexOf(handler) > defined, "defined before the handlers that use it");
  }
  // Every handler that changes what is up, not only the ones named above: going
  // back to a version (docs/sites-phase0.md §0.6) is a publish too.
  // A handler's body runs to the next handler, or to the next helper defined
  // between them (publishLocalSite, shared with the Agent's site-publish).
  const handlers = [...main.matchAll(/\n  bind\("(site-[a-z-]+)", ([^\n]*)/g)];
  const ends = [...main.matchAll(/\n  (?:bind\(|const |let )/g)].map((match) => match.index);
  const bodyAt = (match) => main.slice(match.index, ends.find((at) => at > match.index) ?? main.length);
  const changing = handlers.filter((match) => /siteRequest\("\/v1\/sites\/(?:publish|republish|share|rollback)"|publishLocalSite\(/.test(bodyAt(match)));
  assert.deepEqual(changing.map((match) => match[1]).sort(), ["site-publish", "site-republish", "site-rollback", "site-share-set"]);
  for (const match of changing) assert.match(match[2], /oneAtATime\(id, async \(\) => \{$/, match[1]);
  // And each says on its row what it is doing while it waits (§0.7), as do
  // deleting a site and bringing one onto this computer.
  const bodyOf = (name) => bodyAt(handlers.find((match) => match[1] === name));
  for (const name of [...changing.map((match) => match[1]), "site-erase", "site-download"]) {
    // Publishing's steps are publishLocalSite's, shared with the Agent's site-publish.
    const body = name === "site-publish" ? main.slice(main.indexOf("const publishLocalSite = async"), main.indexOf('bind("site-publish"')) : bodyOf(name);
    assert.match(body, /await whileWorking\(id, [^\n]*siteRequest\("\/v1\/sites\//, `${name} says on its row what it is doing`);
  }
  const unpublish = main.slice(main.indexOf('bind("site-unpublish"'), main.indexOf('bind("site-unpublish"') + 200);
  assert.doesNotMatch(unpublish, /oneAtATime/);
  const publish = main.slice(main.indexOf("const publishLocalSite = async"), main.indexOf('bind("site-republish"'));
  assert.match(publish, /\}, \{ updating: Boolean\(current\.publishedId\) \}\)\);/, "an update says so when it gets no answer");
});

test("following the server is one site at a time, and never stops a refresh (sixth review before .270)", () => {
  const follow = main.slice(main.indexOf("const followServer = async (remote, { askedAt = null } = {}) =>"), main.indexOf('bind("sites", async () =>'));
  assert.match(follow, /for \(const site of store\.list\(\)\) \{\s*try \{/);
  const refresh = main.slice(main.indexOf("const refreshDueSites = async () =>"), main.indexOf("setInterval(() => { void refreshDueSites(); }"));
  assert.match(refresh, /await followServer\([^;]*\)\.catch\(\(\) => \{\}\);/);
});

// Off the server for good (docs/sites-phase0.md §0.5): a deletion, drawn as
// one, and approved in code only by the person's answer to that card -- the
// rule every deletion here follows (AGENTS.md).
test("deleting a site off the server is approved only by the person's answer to a deletion card", () => {
  const erase = main.slice(main.indexOf('bind("site-erase"'), main.indexOf('bind("site-hide"'));
  assert.match(erase, /buttons: \["取消", "删除"\], defaultId: 0, cancelId: 0, destructive: true \}\);/);
  assert.match(erase, /if \(choice\.response !== 1 \|\| choice\.destructive !== true\) return null;/);
  assert.ok(erase.indexOf("choice.destructive !== true") < erase.indexOf('siteRequest("/v1/sites/erase"'), "answered before anything is sent");
});

// A site downloaded onto this computer reads no table here; updating its page
// from here must not take it off the table it follows on the server.
test("updating a site this computer reads no table for keeps the table it follows", () => {
  const publish = main.slice(main.indexOf("const publishLocalSite = async"), main.indexOf('bind("site-republish"'));
  assert.match(publish, /serverSource = current\.source \?\? null;/);
  assert.match(publish, /source: site\.slice \? \{[^}]*\} : serverSource,/);
});
