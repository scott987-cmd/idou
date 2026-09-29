import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { REDACTED, redactAssignments, redactor, secretValues } from "../src/application/redact-secrets.js";
import { TaskStore } from "../src/application/task-store.js";

// The step's output as it was kept on 2026-09-23, when a work task's Agent ran
// `env` looking for a media setting (the key itself replaced here).
const ENV_DUMP = "=== env ===\nLARKSUITE_CLI_CONFIG_DIR=/var/folders/tk/T/mydoubao-lark-cli-OVUXzt\nMYDOUBAO_FEISHU_BRIDGE=http://127.0.0.1:52746\n"
  + "MYDOUBAO_FEISHU_BRIDGE_KEY=Zk3v9Qm2Lr8Tn5Wx1Yb7Cd4Fg6Hj0KsPqRuVaEiOo\nMYDOUBAO_FEISHU_BRIDGE_TASK=ce0ed37b-8a4e-441a-bf42-95407bffa02a\nMYDOUBAO_NODE_RUNTIME=/Applications/i豆.app/Contents/MacOS/MyDouBao\n";

test("a credential printed as NAME=value is hidden whatever its value, and nothing else is", () => {
  const hidden = redactAssignments(ENV_DUMP);
  assert.match(hidden, new RegExp(`MYDOUBAO_FEISHU_BRIDGE_KEY=${REDACTED}`));
  assert.doesNotMatch(hidden, /Zk3v9Qm2/);
  for (const kept of ["LARKSUITE_CLI_CONFIG_DIR=/var/folders", "MYDOUBAO_FEISHU_BRIDGE=http://127.0.0.1:52746", "MYDOUBAO_FEISHU_BRIDGE_TASK=ce0ed37b", "MYDOUBAO_NODE_RUNTIME=/Applications"]) {
    assert.ok(hidden.includes(kept), `${kept} is not a credential and stays readable`);
  }
  // A dotenv file the Agent read, holding a key this application never handed out.
  assert.equal(redactAssignments("OPENAI_API_KEY=sk-proj-abcdefghijklmnop\nDEBUG=true"), `OPENAI_API_KEY=${REDACTED}\nDEBUG=true`);
  assert.equal(redactAssignments(redactAssignments(ENV_DUMP)), redactAssignments(ENV_DUMP), "hiding twice changes nothing");
});

test("the values the Agent's environment holds are hidden wherever they appear, not only after a name", () => {
  const env = { MYDOUBAO_FEISHU_BRIDGE_KEY: "Zk3v9Qm2Lr8Tn5Wx1Yb7Cd4Fg6Hj0KsPqRuVaEiOo", MYDOUBAO_FEISHU_BRIDGE: "http://127.0.0.1:52746", SHORT_TOKEN: "abc" };
  assert.deepEqual(secretValues(env), ["Zk3v9Qm2Lr8Tn5Wx1Yb7Cd4Fg6Hj0KsPqRuVaEiOo"], "a secret-looking name with a real value; too short a value is not a credential");
  const hide = redactor(secretValues(env));
  assert.equal(hide(`curl -H "x-key: Zk3v9Qm2Lr8Tn5Wx1Yb7Cd4Fg6Hj0KsPqRuVaEiOo" http://127.0.0.1:52746`), `curl -H "x-key: ${REDACTED}" http://127.0.0.1:52746`);
  assert.equal(hide(null), null);
});

test("a task record written before records hid credentials is cleaned when it is read, and kept that way", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-old-record-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "tasks"));
  const id = "ce0ed37b-8a4e-441a-bf42-95407bffa02a";
  await writeFile(path.join(directory, "tasks", `${id}.json`), JSON.stringify({ schemaVersion: 1, id, mode: "cowork", cwd: "/Users/someone/我的豆包/2026-09-23-232",
    messages: [{ id: "a", role: "assistant", text: "环境里有 MYDOUBAO_FEISHU_BRIDGE_KEY=Zk3v9Qm2Lr8Tn5Wx1Yb7Cd4Fg6Hj0KsPqRuVaEiOo" }],
    activity: [{ id: "call_eol1", type: "commandExecution", status: "completed", command: "/bin/zsh -c 'env | grep MYDOUBAO'", output: ENV_DUMP, seq: 137 }] }));
  const { tasks } = await new TaskStore(path.join(directory, "tasks")).load();
  const disk = await readFile(path.join(directory, "tasks", `${id}.json`), "utf8");
  for (const text of [JSON.stringify(tasks[0]), disk]) assert.equal(text.includes("Zk3v9Qm2"), false);
  assert.match(tasks[0].activity[0].output, /MYDOUBAO_FEISHU_BRIDGE=http:\/\/127\.0\.0\.1:52746/);
  assert.equal(tasks[0].activity[0].seq, 137, "nothing else about the record changes");
});
