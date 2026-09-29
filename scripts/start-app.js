#!/usr/bin/env node
// One command for real use, in three shapes:
//   npm start                     own deployment: control plane + desktop
//   npm start -- --server-only    control plane only, for a shared deployment
//   npm start -- --connect <url>  join someone else's control plane
// The application secret is read from the operator's 0600 deployment file and
// handed only to the control-plane process. It never reaches the desktop, the
// packaged CLI, or any log, and a joining teammate never needs it at all.
import "../src/adopt-legacy-env.js";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import electronBinary from "electron";
import { readDeploymentFile, preflight, serverEnvironment } from "../src/application/deployment.js";
import { validateServerUrl } from "../src/control-plane/client-session.js";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = name => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1] ?? ""; };

function launchDesktop(env, onExit) {
  const desktop = spawn(electronBinary, [root], { env: { ...clientEnvironment(), ...env }, stdio: "inherit" });
  desktop.on("exit", code => onExit(code ?? 0));
  return desktop;
}

// Joining a shared deployment needs nothing local: no deployment file, no
// application secret, no model key. The teammate signs in with their own Feishu
// account against a control plane someone else runs.
async function join(target) {
  const origin = validateServerUrl(target);
  process.stdout.write(`连接到共享控制面：${origin}\n在「设置 → 飞书账号」用你自己的飞书账号登录即可。\n\n`);
  const desktop = launchDesktop({ IDOU_SERVER_URL: origin }, code => process.exit(code));
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => desktop.kill("SIGTERM"));
}

async function run(filename, serverOnly) {
  const env = await readDeploymentFile(path.resolve(filename));
  const report = await preflight(env);
  for (const check of report.checks) process.stdout.write(`${check.ok ? "OK  " : "待处理"}  ${check.name}: ${check.detail}\n`);
  if (!report.ok) {
    process.stderr.write(`\n还差这些才能启动：\n${report.required.map(item => `  - ${item}`).join("\n")}\n`);
    process.exit(1);
  }

  const local = report.local;
  let closing = false, server = null, desktop = null;
  const stop = code => {
    if (closing) return; closing = true;
    desktop?.kill("SIGTERM"); server?.kill("SIGTERM");
    setTimeout(() => { desktop?.kill("SIGKILL"); server?.kill("SIGKILL"); process.exit(code); }, 3000).unref();
  };
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => stop(0));

  server = spawn(process.execPath, [path.join(root, "bin/server.js"), local ? "--dev" : "--feishu"],
    { env: serverEnvironment(env), stdio: ["ignore", "pipe", "inherit"] });
  server.on("exit", code => { if (!closing) { process.stderr.write(`控制面已退出（code ${code}），应用无法继续。\n`); stop(code ?? 1); } });

  // Wait for the control plane to report readiness before launching the desktop,
  // so the first login attempt cannot race an unbound port.
  let banner = "";
  const ready = local ? "Client connection file:" : "Listening on loopback port";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("控制面启动超时")), 20_000);
    server.stdout.on("data", chunk => {
      banner += chunk; process.stdout.write(chunk);
      if (banner.includes(ready)) { clearTimeout(timer); resolve(); }
    });
  });

  const origin = local ? banner.match(/Development gateway: (\S+)/)?.[1] : report.config.origin;
  const sessionFile = local ? banner.match(/Client connection file: (\S+)/)?.[1] : null;
  if (!origin || (local && !sessionFile)) { process.stderr.write("控制面未报告可用的连接信息。\n"); stop(1); return; }

  if (serverOnly) {
    process.stdout.write(local
      ? `\n控制面已就绪：${origin}\n本机模式的连接文件在 ${sessionFile}\n\n`
      : `\n控制面已就绪：${origin}\n同租户的同事无需任何配置，直接运行：\n  npm start -- --connect ${origin}\n\n`);
    return;
  }
  process.stdout.write(local
    ? "\n应用已就绪（本机模式）。新建编程任务或工作任务即可开始；飞书业务功能需要配置自建应用后才开放，见 docs/setup-real-feishu.md。\n\n"
    : `\n应用已就绪。请在「设置 → 飞书账号」中点击「使用飞书登录」，浏览器会打开 ${origin} 的授权入口。\n\n`);
  // The desktop receives a short-lived session path or a server origin, never the
  // deployment file and never a secret. The skill-catalogue public key is the one
  // deployment setting that belongs on this side: src/config.js reads it, the
  // control plane never does. It used to go only to the server, so a configured
  // enterprise shelf arrived signed at a desktop with nothing to verify it with.
  desktop = launchDesktop({ ...(local ? { IDOU_SESSION_FILE: sessionFile } : { IDOU_SERVER_URL: origin }),
    ...(env.IDOU_SKILL_PUBLIC_KEY_FILE ? { IDOU_SKILL_PUBLIC_KEY_FILE: env.IDOU_SKILL_PUBLIC_KEY_FILE } : {}),
    // Both sides have to be talking about the same Feishu deployment.
    ...(env.FEISHU_PROVIDER ? { IDOU_FEISHU_PROVIDER: env.FEISHU_PROVIDER } : {}) },
    code => { process.stdout.write("桌面已关闭，正在停止控制面。\n"); stop(code); });
}

const target = flag("--connect");
if (target !== null) await join(target);
else {
  const filename = process.env.IDOU_DEPLOYMENT_FILE || args.find(value => !value.startsWith("--"));
  if (!filename) {
    process.stderr.write("用法：\n  IDOU_DEPLOYMENT_FILE=/绝对路径/idou.env npm start\n  npm start -- --server-only\n  npm start -- --connect https://你的控制面地址\n先运行 `npm run preflight` 检查配置。\n");
    process.exit(1);
  }
  await run(filename, args.includes("--server-only"));
}
