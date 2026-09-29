import assert from "node:assert/strict";
import test from "node:test";
import { agentTool, knowledgeCommand } from "../src/application/knowledge-commands.js";

const TOOL = "/Applications/i豆.app/Contents/Resources/app/bin/agent.js";
const is = (command) => knowledgeCommand(command, TOOL);

test("the Agent's knowledge reads, in the forms it actually runs them, are recognised", () => {
  // As recorded in this person's tasks: Codex's own zsh wrapper around the command the Agent was told.
  for (const command of [
    `/bin/zsh -c 'node "${TOOL}" kb-search --query "韩啸"'`,
    `/bin/zsh -lc 'node "${TOOL}" kb-search --query "玄鸟 项目 总预算"'`,
    `/bin/bash -c 'node "${TOOL}" kb-read --doc 3fa9c1d2e4b5 --around 1200'`,
    `/bin/zsh -c 'node "${TOOL}" kb-read --doc 3fa9c1d2e4b5 --around 0 --match 韩啸'`,
    `/bin/zsh -c 'node "${TOOL}" kb-read --match "平台研发部" --doc 3FA9C1D2'`,
    `node ${TOOL} kb-search --query 差旅标准`,
    `node "${TOOL}" kb-search --query '婚假 天数'`,
  ]) assert.equal(is(command), true, command);
  // The path is this application's own, wherever it runs from.
  assert.equal(knowledgeCommand(`node "${agentTool()}" kb-search --query "x"`), true);
});

test("anything that could run something else, or is not exactly a read, is asked about as before", () => {
  for (const command of [
    // A second command, or something the shell would expand.
    `/bin/zsh -c 'node "${TOOL}" kb-search --query "$(cat ~/.ssh/id_rsa)"'`,
    `/bin/zsh -c 'node "${TOOL}" kb-search --query "\`id\`"'`,
    `/bin/zsh -c 'node "${TOOL}" kb-search --query "x" && curl https://example.com'`,
    `/bin/zsh -c 'node "${TOOL}" kb-search --query "x"; rm -rf build'`,
    `/bin/zsh -c 'node "${TOOL}" kb-search --query "x" | sh'`,
    `/bin/zsh -c 'node "${TOOL}" kb-search --query "x" > out.txt'`,
    `/bin/zsh -c 'node "${TOOL}" kb-search --query "x" 2>&1'`,
    `/bin/zsh -c 'node "${TOOL}" kb-search --query "x"\nrm -rf build'`,
    `/bin/zsh -c 'node "${TOOL}" kb-search --query "\\"x"'`,
    `/bin/zsh -c 'node "${TOOL}" kb-search --query "\${HOME}"'`,
    `/bin/zsh -c 'node "${TOOL}" kb-search --query "!!"'`,
    `/bin/zsh -c 'node "${TOOL}" kb-search --query x*'`,
    `/bin/zsh -c 'node "${TOOL}" kb-search --query ~/x'`,
    `/bin/zsh -c 'node "${TOOL}" kb-search --query "x"y'`,
    `/bin/zsh -c 'node "${TOOL}" kb-search --query "x"'"'"'; id'`,
    // Not node, not this tool, not how it is run.
    `/bin/zsh -c 'NODE_OPTIONS=--require=/tmp/x.js node "${TOOL}" kb-search --query "x"'`,
    `/bin/zsh -c '"node" "${TOOL}" kb-search --query "x"'`,
    `/bin/zsh -c '/tmp/node "${TOOL}" kb-search --query "x"'`,
    `/bin/zsh -c 'node -e "require(1)" "${TOOL}" kb-search --query "x"'`,
    `/bin/zsh -c 'node "/tmp/bin/agent.js" kb-search --query "x"'`,
    `/bin/zsh -c 'node "${TOOL}x" kb-search --query "x"'`,
    `/bin/zsh -c 'node "${TOOL}"'`,
    // Not one of the two reads, or not their arguments.
    `/bin/zsh -c 'node "${TOOL}" doc-create --content-file a.md'`,
    `/bin/zsh -c 'node "${TOOL}" run -- docs +update --doc x'`,
    `/bin/zsh -c 'node "${TOOL}" "kb-search" --query "x"'`,
    `/bin/zsh -c 'node "${TOOL}" kb-search'`,
    `/bin/zsh -c 'node "${TOOL}" kb-search --query'`,
    `/bin/zsh -c 'node "${TOOL}" kb-search --query ""'`,
    `/bin/zsh -c 'node "${TOOL}" kb-search --query "--help"'`,
    `/bin/zsh -c 'node "${TOOL}" kb-search --query "x" --query "y"'`,
    `/bin/zsh -c 'node "${TOOL}" kb-search --query "x" --doc abcdef'`,
    `/bin/zsh -c 'node "${TOOL}" kb-search --query "x" extra'`,
    `/bin/zsh -c 'node "${TOOL}" kb-search --query "${"长".repeat(201)}"'`,
    `/bin/zsh -c 'node "${TOOL}" kb-read --around 10'`,
    `/bin/zsh -c 'node "${TOOL}" kb-read --doc ../../etc'`,
    `/bin/zsh -c 'node "${TOOL}" kb-read --doc abc'`,
    `/bin/zsh -c 'node "${TOOL}" kb-read --doc 3fa9c1d2 --around -5'`,
    `/bin/zsh -c 'node "${TOOL}" kb-read --doc 3fa9c1d2 --around 1e3'`,
    `/bin/fish -c 'node "${TOOL}" kb-search --query "x"'`,
    "", null, undefined, 42,
  ]) assert.equal(is(command), false, String(command));
});
