// A document linked in a conversation opens in 飞书文档, and the conversation stays.
//
// Reported 2026-09-27: in 飞书消息, clicking a document link in a conversation
// made the conversation disappear, and the section was unusable after that.
// Feishu's messenger opens such a link as a new window; the views refuse new
// windows and loaded the link into the messenger itself, over the conversation,
// with no way back. Now the link goes to 飞书文档 (feishu-link-routing.js) --
// opened as a new window or followed in place -- and a messenger an older build
// left on a document goes back to its conversations the next time it is shown.
// A Drive file (a scheduled task's report) is diverted the same way, and a
// report link in the form this product wrote until 2026-09-29 opens the file.
//
//   IDOU_DESKTOP_BACKGROUND=1 node scripts/smoke-feishu-links-desktop.js
import "../src/adopt-legacy-env.js";
import assert from "node:assert/strict";
import { startFeishuSection, until } from "./fixtures/feishu-section-harness.js";

const HEADER = "合成会话：带文档链接";
const section = await startFeishuSection({ prefix: "idou-feishu-links-" });
try {
  const { page, app, onScreen, web, errors } = section;
  await section.fixture({ header: HEADER });
  await section.signIn();
  await page.locator('[data-section="feishu"]').click();
  await until(web, (value) => value.state === "verified", "the pages verified as the signed-in person");
  await until(onScreen, (views) => views.some((view) => view.url.includes("/messenger/")), "the messenger on screen");

  // The messenger's own page, by the id it had when it showed the conversation:
  // found by its address it could not be told apart from a view that left it.
  const messengerId = await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((item) => item.getURL().includes("/messenger/"))?.id);
  assert.ok(messengerId, "the messenger's page");
  const messenger = (script) => app.evaluate(({ webContents }, [id, code]) => {
    const contents = webContents.fromId(id);
    return code ? contents?.executeJavaScript(code, true) : contents?.getURL();
  }, [messengerId, script]);
  const docsShowing = (token) => until(async () => ({ active: await page.locator('[data-section="feishu-docs"]').getAttribute("aria-current"), views: await onScreen() }),
    (value) => value.active === "page" && value.views.some((view) => view.url.includes(token)), `${token} shown in 飞书文档`);
  const conversationBack = async () => {
    await page.locator('[data-section="feishu"]').click();
    await until(onScreen, (views) => views.some((view) => view.url.includes("/messenger/")), "the messenger on screen again");
    assert.equal(await messenger('document.querySelector("#header")?.textContent ?? ""'), HEADER, "the same conversation, not a blank page");
  };

  console.log("会话里的文档链接，以新窗口打开：");
  await messenger('window.open("https://fixture.feishu.cn/docx/SyntheticLinkedDoc12345", "_blank"); true');
  await docsShowing("SyntheticLinkedDoc12345");
  assert.match(await messenger(), /\/messenger\//, "the conversation was not navigated away");
  await conversationBack();
  console.log("  文档在「飞书文档」打开，会话还在");

  console.log("会话里的文档链接，在原页跟随：");
  await messenger('location.href = "https://fixture.feishu.cn/docx/SyntheticFollowedDoc123"; true');
  await docsShowing("SyntheticFollowedDoc123");
  assert.match(await messenger(), /\/messenger\//, "followed in place, still not over the conversation");
  await conversationBack();
  console.log("  同样在「飞书文档」打开，会话还在");

  // Reported 2026-09-29: a report link in a message went to 飞书文档 and showed
  // Feishu's 404 page. The link was /drive/file/<token>, a form this product
  // wrote and Feishu does not open; a file's page is /file/<token>
  // (test/fixtures/feishu-web-link-shapes.json). Old messages keep the old form.
  const fileShown = async (token) => {
    await docsShowing(token);
    const views = await onScreen();
    return new URL(views.find((view) => view.url.includes(token)).url).pathname;
  };
  console.log("会话里的旧报告链接（/drive/file/），以新窗口打开：");
  await messenger('window.open("https://fixture.feishu.cn/drive/file/SyntheticOldReport01", "_blank"); true');
  assert.equal(await fileShown("SyntheticOldReport01"), "/file/SyntheticOldReport01", "the file's own page, not Feishu's 404");
  assert.match(await messenger(), /\/messenger\//, "the conversation was not navigated away");
  await conversationBack();
  console.log("  在「飞书文档」打开的是文件本身，会话还在");

  console.log("会话里的云盘文件链接，在原页跟随（旧写法和正确写法各一次）：");
  for (const [link, token] of [["https://fixture.feishu.cn/drive/file/SyntheticOldReport02", "SyntheticOldReport02"], ["https://fixture.feishu.cn/file/SyntheticNewReport03", "SyntheticNewReport03"]]) {
    await messenger(`location.href = ${JSON.stringify(link)}; true`);
    assert.equal(await fileShown(token), `/file/${token}`);
    assert.match(await messenger(), /\/messenger\//, "a file followed in place does not replace the conversation either");
    await conversationBack();
  }
  console.log("  都在「飞书文档」打开文件本身，会话还在");

  console.log("旧版本留在文档上的消息页，再次打开时回到会话：");
  await app.evaluate(({ webContents }, id) => webContents.fromId(id)?.loadURL("https://fixture.feishu.cn/docx/SyntheticStuckDoc12345"), messengerId);
  await until(() => messenger(), (url) => url?.includes("SyntheticStuckDoc12345"), "the messenger left on a document, as before the fix");
  await page.locator('[data-section="cowork"]').click();
  await conversationBack();
  console.log("  回到了会话");

  assert.deepEqual(errors, [], "no renderer errors");
  console.log("OK");
} finally {
  await section.close();
}
