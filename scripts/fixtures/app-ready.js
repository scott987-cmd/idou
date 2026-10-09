// When the application's own window can be driven.
//
// index.html draws the sidebar, 新工作任务 and the composer before app.js has
// run; app.js wires them, and restores the person's draft into them, only
// after that. A control being on screen therefore says nothing: #new-task was
// visible 30–150 ms before any button worked, and smoke-preview-desktop.js,
// clicking 技能中心 in that gap, waited 60 s for a section that never opened
// (2 of 7 runs, 2026-10-03). The page says itself when it is ready -- the last
// line of app.js -- and every script that drives it waits for that first
// (test/smoke-app-ready.test.js reads them all with drivenBeforeReady).
//
// Again after anything that reloads the page: the new document starts over.
export const APP_READY = 'body[data-app-state="ready"]';

// A locator's wait polls from this side, so a window in the background, whose
// animation frames never come, does not hold it up.
export async function appReady(page, { timeout } = {}) {
  await page.locator(APP_READY).waitFor({ state: "attached", ...(timeout === undefined ? {} : { timeout }) });
}

// A window some script opens on a page of its own -- a generated site, a game
// -- says so on the line that takes it, and is not held to this.
export const OTHER_PAGE = "不是 i豆 的窗口";

// Where a script acts on the application's window before the page said it was
// ready: a wait for #new-task to appear, or the window taken (firstWindow) or
// reloaded and then used -- by itself or handed to a helper -- before
// appReady. Setting its timeouts and listening to it are not acting on it.
export function drivenBeforeReady(source) {
  const code = withoutComments(source), found = [];
  const lineOf = (index) => source.slice(0, index).split("\n").length;
  for (const match of code.matchAll(/\.locator\(\s*["']#new-task["']\s*\)\.waitFor\(\s*\)/g)) {
    found.push({ line: lineOf(match.index), why: "等 #new-task 出现不等于应用就绪：它是 index.html 里的静态标记" });
  }
  const failureReadouts = catchBlocks(code);
  const taken = [...code.matchAll(/(\w+)\s*=\s*await\s+\w+\.firstWindow\([^)]*\)/g)]
    .filter((match) => !failureReadouts.some(([from, to]) => match.index > from && match.index < to))
    .filter((match) => !source.slice(match.index, source.indexOf("\n", match.index)).includes(OTHER_PAGE));
  const names = new Set(taken.map((match) => match[1]));
  const starts = [
    ...taken.map((match) => ({ name: match[1], at: match.index + match[0].length, what: "firstWindow()" })),
    ...[...code.matchAll(/\b(\w+)\.reload\(\)/g)].filter((match) => names.has(match[1])).map((match) => ({ name: match[1], at: match.index + match[0].length, what: "reload()" })),
  ];
  for (const { name, at, what } of starts) {
    const reference = new RegExp(`\\b${name}\\b`, "g");
    reference.lastIndex = at;
    let next;
    while ((next = reference.exec(code)) && /^\??\.(?:setDefaultTimeout|setDefaultNavigationTimeout|on|once|off)\(/.test(code.slice(next.index + name.length)));
    if (!next || !/appReady\(\s*$/.test(code.slice(Math.max(0, next.index - 12), next.index))) {
      found.push({ line: lineOf(at), why: `${what} 之后没先等 appReady(${name})` });
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

// Comments blanked out in place, so positions still line up with the source.
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, (text) => text.replace(/[^\n]/g, " "))
    .replace(/(^|[\s;{}])\/\/[^\n]*/g, (text, lead) => lead + " ".repeat(text.length - lead.length));
}

// The spans of `catch (...) { ... }` blocks: a window taken there is read for
// the failure report, not driven.
function catchBlocks(code) {
  const spans = [];
  for (const match of code.matchAll(/\bcatch\s*(?:\([^)]*\))?\s*\{/g)) {
    let depth = 0, index = match.index + match[0].length - 1;
    for (; index < code.length; index += 1) {
      if (code[index] === "{") depth += 1;
      else if (code[index] === "}" && --depth === 0) break;
    }
    spans.push([match.index, index]);
  }
  return spans;
}
