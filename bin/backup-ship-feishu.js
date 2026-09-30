#!/usr/bin/env node
// The program bin/backup.js hands each sealed copy to (--ship), taking it to a
// Feishu Drive folder with the application's bot (backup-feishu.js).
//
//   node bin/backup.js ... --seal <public key> --ship /opt/idou/app/bin/backup-ship-feishu.js
//
// From the deployment file: FEISHU_APP_ID and FEISHU_APP_SECRET (the
// application's own credential), IDOU_BACKUP_FEISHU_FOLDER (the folder's
// token: the last part of its link; the application must be a collaborator
// that can edit it), and IDOU_BACKUP_FEISHU_KEEP (how many it keeps, 14 unless
// set).
import "../src/adopt-legacy-env.js";
import path from "node:path";
import { loadFeishuProvider } from "../src/control-plane/server-config.js";
import { shipToFeishu } from "../src/control-plane/backup-feishu.js";

const [file] = process.argv.slice(2);
try {
  if (!file || !path.isAbsolute(file) || process.argv.length !== 3) throw new Error("用法：backup-ship-feishu.js </绝对路径/加密备份>");
  const appId = process.env.FEISHU_APP_ID, appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) throw new Error("缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET：备份由应用机器人上传，要载入部署配置");
  const keep = process.env.IDOU_BACKUP_FEISHU_KEEP === undefined ? 14 : Number(process.env.IDOU_BACKUP_FEISHU_KEEP);
  const result = await shipToFeishu({ file, folderToken: process.env.IDOU_BACKUP_FEISHU_FOLDER, feishu: loadFeishuProvider(), appId, appSecret, keep });
  const how = { added: "新加了一份", replaced: `覆盖了最旧的一份（${result.replaced}）`, "already-there": "文件夹里已经有这一份" }[result.action];
  process.stdout.write(`已送到飞书云盘：${result.name}，${how}${result.count ? `，文件夹里现在有 ${result.count} 份` : ""}。${result.tooLargeToRotate ? "它超过 20 MB，不能覆盖旧的，旧的要到飞书里手动清理。" : ""}\n`);
} catch (error) {
  process.stderr.write(`没有送到飞书云盘：${error.message}\n`);
  process.exitCode = 1;
}
