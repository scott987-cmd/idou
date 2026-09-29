import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { assertAutomatedConfirmationChoice, MANUAL_CONFIRMATION_SMOKES } from "../scripts/fixtures/confirmation-policy.js";

test("the shared desktop helper permits only cancellation or refusal", () => {
  assert.doesNotThrow(() => assertAutomatedConfirmationChoice("取消"));
  assert.doesNotThrow(() => assertAutomatedConfirmationChoice("拒绝"));
  for (const label of ["允许", "确认", "确认删除", "确认发送", "撤回并恢复文件", "回答"]) {
    assert.throws(() => assertAutomatedConfirmationChoice(label), /自动化不能替用户/);
  }
});

test("every manual-confirmation smoke exists and the runner classifies it before execution", async () => {
  const scripts = new Set(await readdir(new URL("../scripts/", import.meta.url)));
  for (const [name, ids] of MANUAL_CONFIRMATION_SMOKES) {
    assert.ok(scripts.has(name), `人工清单里的脚本不存在：${name}`);
    assert.ok(ids.length > 0 && ids.every(id => /^M\d{2}$/u.test(id)), `${name} 没有人工验收编号`);
  }
  const runner = await readFile(new URL("../scripts/run-desktop-acceptance.js", import.meta.url), "utf8");
  const classifyAt = runner.indexOf("const manualIds = manualConfirmationIds(name)");
  const runAt = runner.indexOf("const { code, output } = await run(name");
  assert.ok(classifyAt >= 0 && runAt > classifyAt, "runner 必须在启动脚本前分类待人工路径");
  assert.match(runner, /待人工不是通过/u);
});

test("desktop smokes never automate an affirmative confirmation", async () => {
  const directory = new URL("../scripts/", import.meta.url);
  const names = (await readdir(directory)).filter(name => /^(?:smoke|acceptance)-.*\.js$/u.test(name));
  const unsafe = [];
  for (const name of names) {
    const source = await readFile(new URL(name, directory), "utf8");
    for (const match of source.matchAll(/answerConfirm\(\s*[^,]+,\s*["']([^"']+)["']/gu)) {
      try { assertAutomatedConfirmationChoice(match[1]); } catch { unsafe.push(`${name}: ${match[1]}`); }
    }
    if (/service\.approve\([^\n]+(?:accept|always)/u.test(source)) unsafe.push(`${name}: service.approve accept`);
    if (/service\.answer\(/u.test(source)) unsafe.push(`${name}: service.answer`);
    const positiveButton = /getByRole\(\s*["']button["']\s*,\s*\{[^\n]*name:\s*["'](确认[^"']*|允许[^"']*|回答|保存并提交清单|发布|更新|移出列表|读取并建站|撤回并恢复文件)["'][^\n]*\}\s*\)\.click\(/gu;
    for (const match of source.matchAll(positiveButton)) unsafe.push(`${name}: click ${match[1]}`);
    if (name.startsWith("smoke-") && /waitForHuman(?:Choice|Confirm)\(/u.test(source) && !MANUAL_CONFIRMATION_SMOKES.has(name)) {
      unsafe.push(`${name}: human wait is missing from the manual runner list`);
    }
  }
  assert.deepEqual(unsafe, [], `脚本仍会代答或漏分组：${unsafe.join("；")}`);
});

// Below the card: whatever drives Codex itself answers its approval requests on
// the wire, and may only refuse. test/codex-mcp-approval-wait.test.js holds one
// past the MCP tool timeout and then declines; an accept there would approve a
// call with no card and no person.
test("nothing that drives Codex answers its approval requests with accept", async () => {
  const accept = /\brespond\([^\n]*(?:action|decision):\s*["'](?:accept|acceptForSession|acceptAndRemember)["']/u;
  const unsafe = [];
  for (const [folder, pattern] of [["../scripts/", /^(?:smoke|acceptance)-.*\.js$/u], ["../test/", /\.test\.js$/u]]) {
    const directory = new URL(folder, import.meta.url);
    for (const name of (await readdir(directory)).filter(name => pattern.test(name))) {
      if (accept.test(await readFile(new URL(name, directory), "utf8"))) unsafe.push(`${folder.slice(3)}${name}`);
    }
  }
  assert.deepEqual(unsafe, [], `协议层代答了确认：${unsafe.join("；")}`);
});
