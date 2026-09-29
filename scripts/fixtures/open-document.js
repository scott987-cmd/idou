// Opening a Feishu document or spreadsheet from an acceptance script.
//
// This used to be one button on the welcome screen. Work tasks no longer start
// from Feishu, so the entry moved into the task's own file panel: a task must
// exist, its file panel must be open, and the link box lives behind the panel's
// overflow menu. Scripts whose subject is document reading rather than button
// layout drive it through here, so the next time the entry moves there is one
// place to change instead of one per script.
export async function openFeishuResource(page, url, { kind = "document" } = {}) {
  await ensureTask(page);
  if (!(await page.locator("#document-url-form").isVisible())) await openFileMenuItem(page, "#show-document-url");
  await page.locator("#resource-kind").selectOption(kind);
  await page.locator("#document-url").fill(url);
  // Submitting from the field rather than clicking the button: the panel this
  // form now lives in scrolls, and Playwright's actionability check on the
  // button stalls there. Enter is also what a person actually does.
  await page.locator("#document-url").press("Enter");
}

// The panel's overflow menu closes as soon as one of its items is chosen, so a
// script that uses two of them has to open it twice.
export async function openFileMenuItem(page, id) {
  const toggle = page.locator("#file-menu-toggle");
  // Returning from a Feishu document moves this same menu back from the
  // document heading to the file toolbar. Give that render one beat before
  // treating a temporarily detached/hidden control as a closed panel; clicking
  // 任务文件 during the move can otherwise close the panel that is still open.
  await toggle.waitFor({ state: "visible", timeout: 1_000 }).catch(() => {});
  for (let attempt = 0; attempt < 3 && !(await toggle.isVisible()); attempt += 1) {
    if (await page.locator("#reopen-panel").isVisible()) await page.locator("#reopen-panel").click();
    else await page.locator("#open-files").click();
    await toggle.waitFor({ state: "visible", timeout: 1_000 }).catch(() => {});
  }
  await toggle.waitFor({ state: "visible" });
  await toggle.click();
  await page.locator(id).click();
}

// The file panel only exists once there is a task, and a task is otherwise only
// created by sending something -- which these scripts have no model for.
export async function ensureTask(page, mode = "cowork") {
  if (await page.locator("#open-files").isVisible().catch(() => false)) return;
  await page.evaluate(async (value) => {
    const snapshot = await window.idou.snapshot();
    if (!snapshot.tasks.some(task => task.mode === value)) await window.idou.createTask({ mode: value });
  }, mode);
  await page.locator("#recent-tasks button").first().click();
  await page.locator("#open-files").waitFor();
}
