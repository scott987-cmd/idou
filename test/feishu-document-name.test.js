import test from "node:test";
import assert from "node:assert/strict";
import { documentName } from "../src/desktop/feishu-document-name.js";

// "主页 - 飞书云文档" is what the real client reported for the drive's own home,
// which is where the suffix was measured.
test("the document's name is its page title without Feishu's own suffix", () => {
  assert.equal(documentName("主页 - 飞书云文档"), "主页");
  assert.equal(documentName("新机快速恢复流程 - 飞书云文档"), "新机快速恢复流程");
  assert.equal(documentName("Q3 计划 - 预算 - 飞书云文档"), "Q3 计划 - 预算", "only the suffix goes, not a dash in the name");
  assert.equal(documentName("Roadmap - Feishu Docs"), "Roadmap");
  assert.equal(documentName("Roadmap — Lark"), "Roadmap", "an em dash separates it just as well");
});

// Measured on a real document: Feishu pads the title with dozens of zero-width
// and directional marks, so the name arrived as a stretch of blanks with the
// words at the end of it.
test("the invisible characters Feishu pads the title with are not part of the name", () => {
  assert.equal(documentName("​‍​⁣⁢​﻿我的豆包 · 产品介绍 - 飞书云文档"), "我的豆包 · 产品介绍");
  assert.equal(documentName("‪周报‬ - 飞书云文档"), "周报");
  assert.equal(documentName("​​​ - 飞书云文档"), "", "invisible characters alone name nothing");
});

test("a title that is not a name leaves the address to speak for itself", () => {
  assert.equal(documentName("飞书云文档"), "", "the suffix alone names nothing");
  assert.equal(documentName("x".repeat(80)), "", "a whole sentence is not a title");
  for (const value of [undefined, null, "", "   ", 42]) assert.equal(documentName(value), "");
});
