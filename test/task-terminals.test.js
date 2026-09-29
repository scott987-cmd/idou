import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TaskTerminals, terminalEnvironment, terminalSize } from "../src/desktop/task-terminals.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

function fakePty() {
  const emitter = new EventEmitter();
  return {
    writes: [], sizes: [], killed: false,
    write(value) { this.writes.push(value); }, resize(cols, rows) { this.sizes.push([cols, rows]); }, kill() { this.killed = true; },
    onData(handler) { emitter.on("data", handler); return { dispose: () => emitter.off("data", handler) }; },
    onExit(handler) { emitter.on("exit", handler); return { dispose: () => emitter.off("exit", handler) }; },
    data(value) { emitter.emit("data", value); }, exit(value = { exitCode: 0, signal: 0 }) { emitter.emit("exit", value); },
  };
}

test("terminal environment keeps a narrow allowlist and clamps sizes", () => {
  const env = terminalEnvironment({ HOME: "/tmp/home", PATH: "/bin", LANG: "zh_CN.UTF-8", LC_ALL: "C", MINIMAX_API_KEY: "canary", LARK_TOKEN: "secret", SSH_AUTH_SOCK: "/secret", BAD: "no" });
  assert.deepEqual(env, { HOME: "/tmp/home", PATH: "/bin", LANG: "zh_CN.UTF-8", LC_ALL: "C", TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "idou" });
  assert.deepEqual(terminalSize({ cols: 1, rows: 999 }), { cols: 2, rows: 300 });
});

test("terminal handles are task-owned, bounded and never accept renderer environment or pid", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-terminal-")); t.after(() => rm(root, { recursive: true, force: true }));
  const tasks = new Map([[A, { id: A, mode: "coding", cwd: root }], [B, { id: B, mode: "coding", cwd: root }]]), children = [];
  const terminals = new TaskTerminals({ getTask: id => tasks.get(id), spawn: (_file, _args, options) => { const child = fakePty(); child.options = options; children.push(child); return child; }, environment: { HOME: root, PATH: "/bin", MODEL_API_KEY: "canary" }, maxBytes: 1024 });
  t.after(() => terminals.closeAll());
  const opened = await terminals.open(A, { cols: 100, rows: 30, env: { MODEL_API_KEY: "leak" }, pid: 1 });
  assert.equal(opened.cwd, root); assert.equal(children[0].options.cols, 100); assert.equal(children[0].options.rows, 30); assert.equal(children[0].options.env.MODEL_API_KEY, undefined);
  assert.throws(() => terminals.write(B, opened.terminalId, "echo forged\r"), /不属于当前任务/);
  assert.throws(() => terminals.resize(B, opened.terminalId, { cols: 80, rows: 24 }), /不属于当前任务/);
  terminals.write(A, opened.terminalId, "echo ok\r"); terminals.resize(A, opened.terminalId, { cols: 120, rows: 40 });
  assert.deepEqual(children[0].writes, ["echo ok\r"]); assert.deepEqual(children[0].sizes, [[120, 40]]);
  children[0].data("x".repeat(2_000));
  const snapshot = await terminals.open(A);
  assert.equal(Buffer.byteLength(snapshot.output), 1024); assert.equal(snapshot.truncated, true);
  children[0].exit({ exitCode: 7, signal: 0 });
  assert.equal((await terminals.open(A)).state, "exited");
  const reopened = await terminals.reopen(A, opened.terminalId);
  assert.notEqual(reopened.terminalId, opened.terminalId); assert.equal(children.length, 2);
});

test("real PTYs use the task cwd, resize, accept input and isolate Ctrl+C", async t => {
  if (process.platform === "win32") return t.skip("POSIX shell assertions");
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-terminal-real-")); t.after(() => rm(root, { recursive: true, force: true }));
  const other = await mkdtemp(path.join(os.tmpdir(), "idou-terminal-other-")); t.after(() => rm(other, { recursive: true, force: true }));
  const tasks = new Map([[A, { id: A, mode: "coding", cwd: root }], [B, { id: B, mode: "coding", cwd: other }]]);
  const terminals = new TaskTerminals({ getTask: id => tasks.get(id), environment: { HOME: os.homedir(), USER: os.userInfo().username, SHELL: existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/bash", PATH: process.env.PATH, IDOU_SECRET_CANARY: "must-not-appear" } });
  t.after(() => terminals.closeAll());
  const a = await terminals.open(A, { cols: 91, rows: 33 }), b = await terminals.open(B);
  let aText = "", bText = ""; terminals.on("data", value => { if (value.terminalId === a.terminalId) aText += value.data; if (value.terminalId === b.terminalId) bText += value.data; });
  const waitFor = async predicate => { const end = Date.now() + 8_000; while (!predicate()) { if (Date.now() > end) throw new Error(`terminal output timeout: ${aText} / ${bText}`); await new Promise(resolve => setTimeout(resolve, 20)); } };
  terminals.write(A, a.terminalId, "printf 'CWD=%s\\nSIZE=' \"$PWD\"; stty size; printf 'CANARY=%s\\n' \"${IDOU_SECRET_CANARY-unset}\"\r");
  await waitFor(() => /CANARY=unset/.test(aText)); assert.match(aText, new RegExp(`CWD=${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)); assert.match(aText, /SIZE=33 91/);
  terminals.write(A, a.terminalId, "stty -echo\r"); await new Promise(resolve => setTimeout(resolve, 50));
  terminals.write(A, a.terminalId, "sleep 30; echo A_SHOULD_NOT_FINISH\r"); terminals.write(B, b.terminalId, "sleep 1; echo B_STILL_RUNNING\r");
  await new Promise(resolve => setTimeout(resolve, 100)); terminals.write(A, a.terminalId, "\x03");
  // Printed as output: a line of its own once escape sequences are gone. What a
  // shell echoes of the typed command is not -- zsh echoes it despite `stty
  // -echo`, bash does not, and the test used to count on zsh's habit.
  const printed = (text, marker) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][A-Z0-9]|\x1b[=>]/g, "").split(/\r\n|\r|\n/).some((line) => line.trim() === marker);
  await waitFor(() => printed(bText, "B_STILL_RUNNING"));
  // Ctrl+C ended A's sleep: its shell runs the next command at once.
  terminals.write(A, a.terminalId, "echo A_AFTER_INTERRUPT\r");
  await waitFor(() => printed(aText, "A_AFTER_INTERRUPT"));
  assert.equal(printed(aText, "A_SHOULD_NOT_FINISH"), false, "Ctrl+C must prevent the command's marker from being printed");
  terminals.resize(A, a.terminalId, { cols: 77, rows: 22 }); terminals.write(A, a.terminalId, "printf 'RESIZED='; stty size\r");
  await waitFor(() => /RESIZED=22 77/.test(aText));
  const exit = once(terminals, "exit"); terminals.write(A, a.terminalId, "exit 4\r");
  const [ended] = await exit; assert.equal(ended.taskId, A); assert.equal(ended.exitCode, 4);
});
