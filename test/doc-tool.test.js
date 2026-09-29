import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { convert } from "officeparser";
import { runProcess } from "../src/providers/process-runner.js";

const tool = fileURLToPath(new URL("../bin/doc-tool.js", import.meta.url));
const run = (args, cwd) => runProcess(process.execPath, [tool, ...args], { cwd, timeoutMs: 120_000, maxOutputBytes: 1 << 20 });

const SOURCE = `# 第三季度复盘

## 各产品销售额

| 产品 | 销售额 |
| --- | --- |
| 豆浆机 | 128000 |
| 破壁机 | 241300 |

## 结论

- 破壁机是**第一大**单品
- 下季度补齐 [华北渠道](https://example.com)
`;

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "doc-tool-"));
  await writeFile(path.join(directory, "稿.md"), SOURCE);
  return directory;
}
const readBack = async (file) => String((await convert(file, "markdown"))?.value ?? "");

test("生成的 .docx 能被读回来，标题、表格、项目符号都在", async () => {
  const directory = await fixture(), output = path.join(directory, "复盘.docx");
  const result = await run(["docx", path.join(directory, "稿.md"), output]);
  assert.equal(result.code, 0, result.stderr);
  const text = await readBack(output);
  for (const expected of ["第三季度复盘", "各产品销售额", "豆浆机", "241300", "破壁机是第一大单品", "华北渠道"]) {
    assert.ok(text.includes(expected), `读回的内容里缺少「${expected}」\n${text.slice(0, 400)}`);
  }
  // 源文件里的强调和链接语法不该原样落进成品——注意读回来的 `**` 可能是
  // 读取器给真正的粗体加的标记，所以只检查源语法本身没有被当成文字带过去。
  assert.ok(!text.includes("第一大**") && !text.includes("**第一大"), "强调标记不该被当成文字写进文档");
  assert.ok(!text.includes("](https://"), "链接语法不该出现在生成的文档里");
});

test("生成的 .pptx 按二级标题分页", async () => {
  const directory = await fixture(), output = path.join(directory, "复盘.pptx");
  const result = await run(["pptx", path.join(directory, "稿.md"), output]);
  assert.equal(result.code, 0, result.stderr);
  const text = await readBack(output);
  for (const expected of ["第三季度复盘", "各产品销售额", "结论", "破壁机是第一大单品"]) {
    assert.ok(text.includes(expected), `读回的内容里缺少「${expected}」`);
  }
  assert.ok(!text.includes("第一大**") && !text.includes("**第一大"), "强调标记不该被当成文字写进演示文稿");
  assert.ok(!text.includes("](https://"), "链接语法不该出现在生成的演示文稿里");
  // 每个二级标题各成一页：读回来的分页符数量应当和标题数一致。
  assert.equal(text.split(/^---$/m).length - 1 >= 3, true, "应当至少分出封面加两页");
});

// pptxgenjs 声明依赖 image-size，而 image-size 的 ICNS/JXL/HEIF 解析器遇到构造过的图片
// 会死循环（GHSA-w3rx-r6r6-pgpr、GHSA-5p2g-fcmc-qvqq），至今没有修复版。它不构成
// 威胁，只因为没有代码加载它：这里让加载它直接报错，哪天情况变了，这个测试会先知道。
test("生成 .pptx 不会加载 image-size——它的死循环漏洞没有修复版", async () => {
  const directory = await fixture(), hook = path.join(directory, "refuse-image-size.mjs");
  await writeFile(hook, `import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, next) {
  if (/^image-size(?:\\/|$)/.test(specifier)) throw new Error("image-size 被加载了");
  return next(specifier, context);
} });
`);
  const guarded = (args) => runProcess(process.execPath, ["--import", pathToFileURL(hook).href, ...args], { cwd: directory, timeoutMs: 120_000, maxOutputBytes: 1 << 20 });
  // 先确认钩子真的拦得住：import 和 require 两条路都要拦。
  for (const probe of [["--input-type=module", "-e", 'await import("image-size")'], ["-e", 'require("image-size")']]) {
    assert.match((await guarded(probe)).stderr, /image-size 被加载了/, `钩子没拦住 ${probe.at(-1)}，这个测试就证明不了什么`);
  }
  const output = path.join(directory, "复盘.pptx");
  const result = await guarded([tool, "pptx", path.join(directory, "稿.md"), output]);
  assert.equal(result.code, 0, result.stderr);
  assert.ok((await readBack(output)).includes("各产品销售额"), "钩子下生成的演示文稿内容不完整");
});

test("参数不对时明确报错，不产出半成品", async () => {
  const directory = await fixture(), source = path.join(directory, "稿.md");
  for (const args of [[], ["odt", source, path.join(directory, "x.odt")], ["docx", source], ["docx", source, path.join(directory, "错.pptx")]]) {
    const result = await run(args);
    assert.equal(result.code, 1, `这些参数本该被拒绝：${JSON.stringify(args)}`);
    assert.ok(result.stderr.trim(), "拒绝时要说清原因");
  }
  const missing = await run(["docx", path.join(directory, "不存在.md"), path.join(directory, "x.docx")]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /读不到输入文件/);
});

test("空输入不会生成一个空文件让人以为成功了", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "doc-tool-empty-"));
  await writeFile(path.join(directory, "空.md"), "\n\n   \n");
  const result = await run(["pptx", path.join(directory, "空.md"), path.join(directory, "空.pptx")]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /没有可以转换的内容/);
});
