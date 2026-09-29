// A node:test reporter that records which top-level tests actually ran, by
// file and line, for scripts/check-test-inventory.js. It prints nothing else;
// the usual TAP output comes from the tap reporter beside it.
//
// On 2026-09-24 --test-force-exit made twelve tests after a top-level await
// never run, and the suite still reported every test passing: 2112 had become
// 2100 and nothing said so. A count cannot catch that (tests declared in loops
// make the run larger than the files look); a list of what ran can.
export default async function* inventory(source) {
  const ran = [];
  for await (const event of source) {
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    const { nesting, file, line } = event.data ?? {};
    if (nesting === 0 && file) ran.push({ file, line: line ?? null });
  }
  yield `${JSON.stringify({ ran })}\n`;
}
