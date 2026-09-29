// Where the sign-in URL comes from, for acceptance scripts.
//
// Sign-in used to hand the URL to the system browser, which the fixtures
// recorded. It opens inside the application now, so the browser is no longer
// involved on the default path and the recorded list stays empty. Auth status
// carries the same URL in both cases, so scripts ask for it here instead of
// reaching into a fixture array that only the fallback button still fills.
import assert from "node:assert/strict";

export async function loginLaunchUrl(page, app, recorded = () => []) {
  const status = await page.evaluate(() => window.idou.authStatus());
  const url = status.launchUrl || (await app.evaluate(recorded)).at(-1);
  assert.ok(url, "sign-in must produce a launch URL");
  return url;
}
