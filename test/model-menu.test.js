import test from "node:test";
import assert from "node:assert/strict";
import { modelMenuNote } from "../src/desktop/renderer/model-menu.js";

const model = (slug) => ({ slug, label: slug });

test("the model menu says what its list is, and never 'this one model' over an empty one", () => {
  assert.equal(modelMenuNote({ available: [], kept: "server" }), "服务端尚未确认可用模型。");
  assert.equal(modelMenuNote({}), "服务端尚未确认可用模型。");
  assert.equal(modelMenuNote({ available: [model("MiniMax-M3")], kept: "server" }), "服务端当前只提供这一个模型。");
  assert.match(modelMenuNote({ available: [model("MiniMax-M3"), model("GLM-5.3")], kept: "server" }), /保存在服务端/);
  assert.match(modelMenuNote({ available: [model("MiniMax-M3"), model("GLM-5.3")], kept: "local" }), /本连接使用/);
});
