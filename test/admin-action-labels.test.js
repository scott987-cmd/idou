// Every action the audit trail can hold has words for it in the console
// (admin-ui/pages-data.js). Without them the page shows "admin.policy.update"
// to the person reading it -- which it did, for every policy change, until
// this was checked. The actions are read from where rows are written: an
// `action: "…"` field, an administrator's `record(admin, "…")`, and the
// audit-trail module that turns other components' events into rows.
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const here = path.resolve("src/control-plane");
const ACTION = /^(admin|auth|feishu|schedule|site|media|policy|system|skill)\.[a-z][a-z.-]*$/;

test("every audit action written anywhere has a label in the console", async () => {
  const written = new Set();
  for (const name of (await readdir(here)).filter((file) => file.endsWith(".js"))) {
    const text = await readFile(path.join(here, name), "utf8");
    for (const [, action] of text.matchAll(/\baction: "([a-z][a-z.-]*)"/g)) if (ACTION.test(action)) written.add(action);
    for (const [, action] of text.matchAll(/\brecord\(admin, "([a-z][a-z.-]*)"/g)) written.add(action);
    if (name === "audit-trail.js") for (const [, action] of text.matchAll(/"((?:feishu|site|media|schedule|auth|skill)\.[a-z][a-z.-]*)"/g)) written.add(action);
    // Built from a word: admin.person.${action} for the bulk route's actions.
    if (text.includes("`admin.person.${action}`")) for (const action of ["disable", "enable", "sign-out"]) written.add(`admin.person.${action}`);
  }
  const labels = await readFile(path.join(here, "admin-ui", "pages-data.js"), "utf8");
  const labelled = new Set([...labels.matchAll(/^\s+"([a-z][a-z.-]*)": "/gm)].map(([, action]) => action));
  assert.ok(written.size > 30, `found only ${written.size} actions: the patterns no longer match how rows are written`);
  assert.deepEqual([...written].filter((action) => !labelled.has(action)).sort(), [], "actions without words in admin-ui/pages-data.js");
});
