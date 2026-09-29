#!/usr/bin/env node

import "../src/adopt-legacy-env.js";
import process from "node:process";
import { runChat } from "../src/application/chat.js";
import { runDoctor } from "../src/application/doctor.js";
import { readDeploymentFile, preflight } from "../src/application/deployment.js";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { listModes } from "../src/modes.js";

function usage() {
  return `i豆 (idou)

Usage:
  idou doctor [--json]
  idou preflight [/absolute/path/idou.env] [--json]
  idou modes
  idou chat --mode <coding|cowork> [--cwd <path>] [--permission <plan|manual|standard|auto|full>] <prompt>
`;
}

function parseChatArgs(args) {
  let mode = "cowork";
  let cwd = process.cwd();
  let permission;
  const promptParts = [];

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--mode") {
      mode = args[++index];
    } else if (value === "--cwd") {
      cwd = args[++index];
    } else if (value === "--permission") {
      permission = args[++index];
    } else {
      promptParts.push(value);
    }
  }

  if (!mode || !cwd || promptParts.length === 0) {
    throw new Error("chat requires --mode, --cwd when supplied, and a prompt");
  }

  return { mode, cwd, ...(permission ? { permission } : {}), prompt: promptParts.join(" ") };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const config = await loadConfig();

  if (command === "doctor") {
    const report = await runDoctor(config);
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      for (const check of report.checks) {
        process.stdout.write(`${check.ok ? "OK" : "FAIL"}  ${check.name}: ${check.detail}\n`);
      }
    }
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  if (command === "preflight") {
    const filename = args.find((value) => !value.startsWith("--")) || process.env.IDOU_DEPLOYMENT_FILE;
    if (!filename) throw new Error("preflight 需要部署配置路径，或设置 IDOU_DEPLOYMENT_FILE");
    const report = await preflight(await readDeploymentFile(path.resolve(filename)));
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify({ ok: report.ok, checks: report.checks, required: report.required }, null, 2)}\n`);
    else {
      for (const check of report.checks) process.stdout.write(`${check.ok ? "OK  " : "待处理"}  ${check.name}: ${check.detail}\n`);
      if (report.required.length) process.stdout.write(`\n还差这些：\n${report.required.map((item) => `  - ${item}`).join("\n")}\n`);
      else process.stdout.write("\n配置完整，可以运行 npm start 启动。\n");
    }
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  if (command === "modes") {
    for (const mode of listModes()) {
      process.stdout.write(`${mode.id}\t${mode.description}\n`);
    }
    return;
  }

  if (command === "chat") {
    await runChat(config, parseChatArgs(args));
    return;
  }

  process.stdout.write(usage());
  process.exitCode = command ? 1 : 0;
}

main().catch((error) => {
  process.stderr.write(`idou: ${error.message}\n`);
  process.exitCode = 1;
});

