#!/usr/bin/env node
// Writes the key a worker of the execution pool is given: the run queue's own
// key, made one-way from the shared sealing key (database.js runQueueKey). A
// worker holding it opens the runs it is to run and nothing else the sealing
// key protects (docs/server-deployment.md §11).
//
//   node bin/run-queue-key.js <sealing key file> <queue key file>
//
// The queue key file is created 0600 and never overwritten; hand it to the
// worker's account (chown) and name it in IDOU_RUN_QUEUE_KEY_FILE.
import "../src/adopt-legacy-env.js";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { readStateKey, runQueueKey } from "../src/control-plane/database.js";

const [from, to] = process.argv.slice(2);
if (!from || !to || !path.isAbsolute(from) || !path.isAbsolute(to)) {
  process.stderr.write("用法：node bin/run-queue-key.js <共享库密钥文件（绝对路径）> <队列密钥文件（绝对路径）>\n");
  process.exit(2);
}
try {
  const key = runQueueKey(await readStateKey(from));
  await writeFile(to, `${key.toString("base64url")}\n`, { mode: 0o600, flag: "wx" });
  process.stdout.write(`队列密钥已写入 ${to}：执行节点只拿这一份，用它推不出共享库密钥。\n`);
} catch (error) {
  process.stderr.write(`没有写入队列密钥：${error.code === "EEXIST" ? `${to} 已存在，不覆盖` : error.message}\n`);
  process.exit(1);
}
