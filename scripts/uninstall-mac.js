// Everything the desktop application leaves on this Mac, listed; and, when asked,
// moved to the Trash with its Keychain item deleted and its privacy permissions
// reset (docs/uninstall.md).
//
//   node scripts/uninstall-mac.js                          what would go
//   node scripts/uninstall-mac.js --apply                  do it
//   node scripts/uninstall-mac.js --apply --task-folders   and ~/i豆 too: your own files
//
// Nothing is deleted outright: folders go to the Trash, where they can be put
// back until it is emptied. The Keychain item cannot be put back, and without
// it what the application sealed in its profile can no longer be read -- which
// is what uninstalling means. Both the names from before the rename (我的豆包,
// com.mydoubao.desktop) and the current ones are looked for; an installation
// has one set or the other.
//
// What is on the server -- scheduled tasks, an unattended authorization,
// published sites -- is not on this Mac; take it away in the application first.
import { execFile } from "node:child_process";
import { lstat, mkdir, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BUNDLE_ID, LEGACY_BUNDLE_ID } from "../src/install-names.js";

const NAMES = ["i豆", "我的豆包"];
const IDS = [BUNDLE_ID, LEGACY_BUNDLE_ID];

// Each place, what it holds, and whether it goes by default. Every one is under
// `home` or one of `applications` -- both always given, never defaulted: a
// test of this once reached the real /Applications through a default and took
// the installed application with it (2026-09-30).
export function places({ home, applications }) {
  if (typeof home !== "string" || !path.isAbsolute(home)) throw new Error("places 需要明确给出家目录");
  if (!Array.isArray(applications) || !applications.length || !applications.every((dir) => typeof dir === "string" && path.isAbsolute(dir))) {
    throw new Error("places 需要明确给出「应用程序」目录");
  }
  const library = path.join(home, "Library");
  return [
    ...NAMES.flatMap((name) => applications.map((dir) => path.join(dir, `${name}.app`))).map((at) => ({ at, what: "应用本身" })),
    ...NAMES.map((name) => ({ at: path.join(library, "Application Support", name), what: "账号、对话记录、Codex 记录、知识库副本、内嵌飞书的登录、设备身份" })),
    ...[".idou", ".mydoubao"].map((name) => ({ at: path.join(home, name), what: "本机设置、会话租约、命令行工具的数据" })),
    ...NAMES.flatMap((name) => [path.join(library, "Caches", name), path.join(library, "Logs", name)]).map((at) => ({ at, what: "缓存和日志" })),
    ...IDS.flatMap((id) => [path.join(library, "Caches", id), path.join(library, "HTTPStorages", id), path.join(library, "Preferences", `${id}.plist`),
      path.join(library, "Saved Application State", `${id}.savedState`)]).map((at) => ({ at, what: "系统为应用保存的缓存、偏好和窗口状态" })),
    { at: path.join(library, "LaunchAgents", "com.mydoubao.control-plane.plist"), what: "开发时本机的控制面自启动项" },
    ...NAMES.map((name) => ({ at: path.join(home, name), what: "任务文件夹：你放进去的文件和产出的结果", own: true })),
  ];
}

async function run(command, args) {
  try { await promisify(execFile)(command, args, { timeout: 30_000 }); return true; } catch { return false; }
}

// The Trash takes the name as it is, or with the moment added when that is taken.
async function toTrash(at, trash, now) {
  const base = path.basename(at);
  let target = path.join(trash, base);
  if (await lstat(target).catch(() => null)) {
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    const extension = path.extname(base);
    target = path.join(trash, `${path.basename(base, extension)} ${stamp}${extension}`);
  }
  await rename(at, target);
  return target;
}

// `home`, `applications` and `exec` are always given (the command below gives
// this Mac's); nothing here reaches a real place, or runs a real command, by
// default.
export async function uninstall({ home, applications, exec, apply = false, taskFolders = false, trash = home && path.join(home, ".Trash"), now = new Date() } = {}) {
  if (typeof exec !== "function") throw new Error("uninstall 需要明确给出运行命令的方式");
  const found = [];
  for (const place of places({ home, applications })) if (await lstat(place.at).catch(() => null)) found.push(place);
  const keychain = [];
  for (const name of NAMES) if (await exec("security", ["find-generic-password", "-s", `${name} Safe Storage`])) keychain.push(`${name} Safe Storage`);
  const report = { moved: [], kept: [], keychain: [], permissions: [], failed: [] };
  for (const place of found) {
    if (place.own && !taskFolders) { report.kept.push(place); continue; }
    if (!apply) { report.moved.push({ ...place, to: null }); continue; }
    await mkdir(trash, { recursive: true });
    try { report.moved.push({ ...place, to: await toTrash(place.at, trash, now) }); }
    catch (error) { report.failed.push({ ...place, why: error.code === "EXDEV" ? "不在同一块盘上，请手动拖到废纸篓" : String(error?.message ?? error) }); }
  }
  for (const item of keychain) {
    if (!apply) { report.keychain.push({ item, done: false }); continue; }
    report.keychain.push({ item, done: await exec("security", ["delete-generic-password", "-s", item]) });
  }
  // What macOS granted it -- accessibility, screen recording, automation -- by
  // bundle id; tccutil answers the same for an id it never saw.
  for (const id of IDS) report.permissions.push({ id, done: apply ? await exec("tccutil", ["reset", "All", id]) : false });
  return report;
}

const invoked = (() => { try { return fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? ""); } catch { return false; } })();
if (invoked) {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply"), taskFolders = argv.includes("--task-folders");
  const home = os.homedir();
  const report = await uninstall({ home, applications: ["/Applications", path.join(home, "Applications")], exec: run, apply, taskFolders });
  const lines = [apply ? "已卸载：" : "会移到废纸篓的（加 --apply 才动手）："];
  for (const place of report.moved) lines.push(`  ${place.at}　${place.what}${place.to ? ` → ${place.to}` : ""}`);
  for (const place of report.failed) lines.push(`  没有移动 ${place.at}：${place.why}`);
  for (const { item, done } of report.keychain) lines.push(`  钥匙串项「${item}」${apply ? (done ? "已删除" : "没有删掉，请在「钥匙串访问」里手动删除") : "会被删除（删除后应用加密保存的内容无法再读取）"}`);
  lines.push(`  隐私权限（辅助功能、屏幕录制、自动化）${apply ? "已重置" : "会被重置"}：${report.permissions.map((row) => row.id).join("、")}`);
  for (const place of report.kept) lines.push(`  保留 ${place.at}（${place.what}；要一起移走请加 --task-folders）`);
  lines.push("服务端上的定时任务、无人值守授权、发布的网站不在这台电脑上：请先在应用里删除或撤销。");
  process.stdout.write(`${lines.join("\n")}\n`);
}
