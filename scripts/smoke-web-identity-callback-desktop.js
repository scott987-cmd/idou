// The web-account probe never shows the control plane's callback page over a
// Feishu section.
//
// 2026-09-24, after a restart: opening 飞书消息 showed a bare JSON page --
// {"status":"verified","message":"网页账号与应用登录一致，可以关闭这个页面。"} --
// instead of the messenger. The probe had been revealed over the section while
// Feishu's page waited for it to be on screen; once shown, Feishu sent it on to
// the control plane's callback, and the probe stayed in front on that page (one
// written for a tab in the person's own browser) until the next status poll
// closed it.
//
// Nothing here is clicked for the person: Feishu's page is the kind an account
// that already agreed sees. The status route answers slowly, the way a busy
// server does, so the time the probe spends on the callback page is long enough
// to see.
//
//   node scripts/smoke-web-identity-callback-desktop.js
import assert from "node:assert/strict";
import { startFeishuSection, sleep, until } from "./fixtures/feishu-section-harness.js";

// Feishu's page for an account that already agreed. Feishu's own page did nothing
// while it was hidden and went on by itself once it was shown; a hidden view
// here still runs its scripts, so the page waits and the loop below plays
// Feishu's part: it lets the page go on the moment the application shows it.
let origin;
const consentPage = (req, res) => {
  if (!req.url.startsWith("/fixture/consent?")) return false;
  const next = new URL(req.url, origin).searchParams.get("next") ?? "";
  if (!next.startsWith(`${origin}/auth/feishu/callback?`)) { res.writeHead(400); res.end(); return true; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta charset="utf-8"><title>授权 - 飞书（合成）</title><p>正在继续……</p>`);
  return true;
};

const section = await startFeishuSection({ route: consentPage, prefix: "idou-web-identity-callback-" });
origin = section.origin;
try {
  const { app, page, state, web, onScreen, errors } = section;
  // Feishu wants the person's page before it answers, from the very first check.
  await section.fixture({ consent: true });
  await section.signIn();

  // A slow status route from here on: 4 s per poll.
  state.slowStatusMs = 4000;
  await page.locator('[data-section="feishu"]').click();
  const callbackAt = `${origin}/auth/feishu/callback`;
  const shown = [], reveals = [];
  const deadline = Date.now() + 45_000;
  let verdict = null;
  while (Date.now() < deadline) {
    const [views, identity] = await Promise.all([onScreen(), web()]);
    if (identity.needsAttention && !reveals.length) {
      reveals.push(Date.now());
      // Shown to the person: Feishu's page goes on to the callback by itself.
      await app.evaluate(async ({ webContents }, prefix) => {
        for (const contents of webContents.getAllWebContents()) {
          if (contents.getURL().startsWith(prefix)) await contents.executeJavaScript("location.href = new URLSearchParams(location.search).get('next')");
        }
      }, `${origin}/fixture/consent`);
    }
    for (const { url } of views) if (url.startsWith(callbackAt)) shown.push(url);
    if (identity.state === "verified") { verdict = identity; break; }
    await sleep(100);
  }
  const trace = await app.evaluate(() => globalThis.webIdentityFixture.trace);
  const reachedCallback = trace.some((line) => line.startsWith("did-navigate") && line.includes("/auth/feishu/callback"));
  assert.ok(reveals.length > 0, "the probe was put in front of the person (otherwise this ran the wrong scenario)");
  assert.ok(reachedCallback, `the probe really went on to the callback: ${trace.filter((line) => /navigate|redirect/.test(line)).join(" | ")}`);
  assert.equal(verdict?.state, "verified", "and the check still reached its verdict");
  assert.deepEqual(shown, [], "the callback page was never on screen over the Feishu section");
  await until(onScreen, (views) => views.length === 1 && views[0].url.includes("/messenger"), "the messenger alone on screen", 10_000);
  assert.deepEqual(errors, []);
  console.log("web identity callback smoke passed");
} finally {
  await section.close();
}
