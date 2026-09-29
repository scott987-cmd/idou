// Every built-in Feishu skill the bundled CLI carries is shown with a Chinese
// name and a Chinese line, whatever the upstream description says. Read from
// the real binary, so a CLI upgrade that brings a skill without a Chinese name
// fails here rather than on the shelf: on 2026-09-25 the shelf showed
// lark-event, lark-shared and lark-skill-maker by id, 邮箱 as "Use when user
// mentions 起草邮件…", and four cards that only said to use 视频会议 instead.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { bundledBinaryPath } from "../src/providers/feishu/bundled-runtime.js";
import { productSkillCatalog } from "../src/application/skill-policy.js";
import { builtinAlias, splitBuiltin } from "../src/desktop/renderer/skill-center.js";
import { requireBundledCli } from "./helpers/stub-cli.js";

const run = promisify(execFile);
const chinese = (text) => (String(text).match(/[一-鿿]/gu) ?? []).length;

test("every built-in skill on the shelf has a Chinese name and a Chinese line", async (t) => {
  if (!(await requireBundledCli(t))) return;
  const { stdout } = await run(bundledBinaryPath(), ["skills", "list"], { timeout: 30_000, env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME } });
  const skills = productSkillCatalog(JSON.parse(stdout).skills);
  assert.ok(skills.length >= 20, "the bundled CLI must list its skills");
  const shown = skills.filter((skill) => !builtinAlias(skill)).map(splitBuiltin);
  const wrong = [];
  for (const card of shown) {
    if (/^lark-/u.test(card.title) || card.title === card.name) wrong.push(`${card.name}: 卡片名是 id「${card.title}」`);
    if (chinese(card.description.slice(0, 60)) < 6) wrong.push(`${card.name}: 说明不是中文「${card.description.slice(0, 40)}」`);
    // The same test the UI rules apply on screen: a run of English words is English.
    const english = /(?:^|[^A-Za-z0-9_./\\-])((?:[A-Za-z][A-Za-z'’]*[\s,:;.!?]+){3,}[A-Za-z][A-Za-z'’]*)/u.exec(card.description);
    if (english) wrong.push(`${card.name}: 说明里有英文「${english[1].slice(0, 40)}」`);
  }
  assert.deepEqual(wrong, []);
  // The aliases point at a skill that is itself on the shelf.
  for (const skill of skills.filter((row) => builtinAlias(row))) assert.ok(shown.some((card) => card.name === builtinAlias(skill)), `${skill.name} points at ${builtinAlias(skill)}, which is not shown`);
});

test("a skill that only hands its work to another is recognised as an alias", () => {
  assert.equal(builtinAlias({ name: "lark-vc", description: "仅当用户或上游配置显式指定 lark-vc 时使用，相关请求统一交由 lark-meeting 技能处理。" }), "lark-meeting");
  assert.equal(builtinAlias({ name: "lark-im", description: "飞书即时通讯：收发消息和管理群聊。" }), null);
  assert.deepEqual(splitBuiltin({ name: "lark-attendance", description: "飞书考勤打卡：查询自己的考勤打卡记录" }).title, "考勤打卡");
});
