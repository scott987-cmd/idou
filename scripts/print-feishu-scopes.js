#!/usr/bin/env node
// Emits the Feishu permission set to register in the console. Prints the
// batch-import JSON on stdout and the human breakdown on stderr, so
// `> scopes.json` gives a clean importable file.
//
// Two modes, because they answer different questions and only one of them can
// promise it will not drift:
//
//   npm run scopes                      every scope this application can ever
//                                       want. Five entries come from source
//                                       constants; the rest are literals in the
//                                       table below, each carrying how it was
//                                       established. Useful for setting up a
//                                       console from nothing.
//
//   npm run scopes -- <deployment.env>  exactly what THIS deployment's next
//                                       login will ask for, built by the same
//                                       feishuLoginScopes() the control plane
//                                       uses. This one genuinely cannot drift,
//                                       and it is the one to register against.
//
// The header used to claim the first form was derived from source and could not
// drift. It never was: nineteen of its entries are literals here, and the thing
// the control plane actually requests is FEISHU_CLI_SCOPES from the deployment
// file, which this script did not read at all.
import "../src/adopt-legacy-env.js";
import { SOURCE_ACCESS_SCOPE } from "../src/knowledge/source-access-contract.js";
import { ACCOUNT_IDENTITY_SCOPE } from "../src/providers/feishu/account-identity.js";
import { WIKI_SOURCE_SCOPE } from "../src/providers/feishu/wiki-source-format.js";
import { WIKI_BUNDLE_SCOPES } from "../src/providers/feishu/wiki-bundle-reader.js";
import { DOCUMENT_SEARCH_SCOPE } from "../src/providers/feishu/cli-read-contract.js";
import { DRIVE_DELIVERY_SCOPES } from "../src/providers/feishu/drive-files.js";
import { feishuLoginScopes, SCHEDULE_RESOURCE_SCOPE } from "../src/providers/feishu/login-scopes.js";

// verified: exercised against a live Feishu tenant, or named by the pinned CLI's
// own bundled permission table. candidate: the capability is required but the
// identifier is not pinned anywhere we control, so confirm it in the console.
const GROUPS = [
  { need: "登录与身份（必需）", scopes: [[SOURCE_ACCESS_SCOPE, "verified"]] },
  { need: "定时任务解析知识库链接", scopes: [[SCHEDULE_RESOURCE_SCOPE, "verified"]] },
  { need: "读飞书文档", scopes: [[WIKI_SOURCE_SCOPE, "verified"]] },
  { need: "按关键词搜文档", scopes: [[DOCUMENT_SEARCH_SCOPE, "verified"]] },
  { need: "单段文档修改", scopes: [["docx:document", "verified"]] },
  // The pinned CLI refuses `im +messages-send` and `im +messages-reply` before
  // any network call with: missing required scope(s): im:message.send_as_user.
  // `im:message` alone is not enough to send as the signed-in user, so this was
  // never actually exercised end to end despite being marked verified.
  { need: "发消息与回复", scopes: [["im:message", "verified"], ["im:message.send_as_user", "pending"]] },
  // Live refusal 99991679 on chats list/search named these alternatives:
  // im:chat:readonly, im:chat, im:chat.group_info:readonly, im:chat:read.
  // im:chat:read is the one that also covers `chats.get`, which the pre-send
  // group check uses, so one scope serves both.
  { need: "选会话与群（发消息前置）", scopes: [["im:chat:read", "verified"], ["im:chat.members:read", "verified"]] },
  // im:message:readonly alone is NOT enough to list a chat's history with a user
  // token: the live tenant answers 230027. Reading as the signed-in user needs
  // the two dedicated per-container scopes; verified by comparing against a CLI
  // identity that holds them and reads the same chat successfully.
  { need: "读会话消息", scopes: [["im:message:readonly", "verified"], ["im:message.group_msg:get_as_user", "verified"], ["im:message.p2p_msg:get_as_user", "verified"]] },
  { need: "按姓名选私聊收件人", scopes: [["contact:user:search", "verified"]] },
  { need: "云盘上传与文件元数据", scopes: DRIVE_DELIVERY_SCOPES.map(scope => [scope, "narrowed"]) },
  // Stop guessing these one at a time. The signed-in person also holds a
  // separate CLI identity that reads and writes sheets and Base on this same
  // tenant, and `auth status` prints its full granted scope list. Diffing
  // against that list is what these two groups are: every name below is one
  // Feishu has actually issued to a working identity, so a console import
  // cannot fail on a name that does not exist.
  //
  // What the diff removed: a bare `sheets:spreadsheet` umbrella (the sheets
  // family has no such scope) and the `bitable:app*` pair. Feishu did name the
  // bitable pair in a 99991679 refusal, but that is the older passthrough
  // route; the working identity holds none of it and reads Base fine on the
  // `base:*` family alone, so asking for both routes only widens the grant.
  { need: "读写电子表格（Agent）", scopes: [["sheets:spreadsheet:read", "granted-elsewhere"],
    ["sheets:spreadsheet:write_only", "granted-elsewhere"], ["sheets:spreadsheet.meta:read", "granted-elsewhere"]] },
  // Feishu reveals one missing scope per call: base:table:read was granted and
  // the very next read named base:app:read. Listing the whole family a Base
  // read actually walks through is what ends that round trip.
  // Listing a table's fields is a scope of its own: the task panel's first live
  // Base read on 2026-09-13 was refused with base:field:read.
  { need: "读多维表格（Agent）", scopes: [["base:app:read", "named-by-feishu"], ["base:table:read", "named-by-feishu"],
    ["base:field:read", "named-by-feishu"], ["base:record:read", "granted-elsewhere"]] },
  // 日程与任务. Taken from the same working identity on this tenant (see the
  // sheets/Base note above), and limited to what the Agent is being given:
  // reading the agenda and free/busy, creating and updating events, replying to
  // an invitation; listing, creating, updating and completing tasks. Nothing
  // that deletes, transfers an event, or edits calendars themselves.
  { need: "读日程与空闲（Agent）", scopes: [["calendar:calendar:read", "granted-elsewhere"], ["calendar:calendar.event:read", "granted-elsewhere"],
    ["calendar:calendar.free_busy:read", "granted-elsewhere"]] },
  { need: "建改日程、回复邀请（Agent）", scopes: [["calendar:calendar.event:create", "granted-elsewhere"], ["calendar:calendar.event:update", "granted-elsewhere"],
    ["calendar:calendar.event:reply", "granted-elsewhere"]] },
  { need: "读任务（Agent）", scopes: [["task:task:read", "granted-elsewhere"], ["task:tasklist:read", "granted-elsewhere"]] },
  { need: "建改、完成任务（Agent）", scopes: [["task:task:write", "granted-elsewhere"]] },
  { need: "写多维表格记录（Agent）", scopes: [["base:record:create", "granted-elsewhere"], ["base:record:update", "granted-elsewhere"]] },
  // Deletion (the cli.delete action). Only the two that have their own scope:
  // deleting a task is task:task:write, clearing or deleting sheet content is
  // sheets:spreadsheet:write_only, and deleting document blocks is docx:document,
  // all already above. Every one of them still needs its own red deletion card.
  { need: "删除日程、删除多维表格记录（Agent，每次单独确认）", scopes: [["calendar:calendar.event:delete", "granted-elsewhere"], ["base:record:delete", "granted-elsewhere"]] },
  // Only spendable when the CLI bridge is OFF. Its one consumer is the
  // account-match endpoint, whose only caller the desktop builds for the
  // unbridged deployment -- with the bridge on it is asked for at consent and
  // can never be used. feishuLoginScopes() enforces that; this catalogue lists
  // it because an unbridged deployment does need it.
  { need: "独立 CLI 身份核验（仅未开桥接时）", scopes: [[ACCOUNT_IDENTITY_SCOPE, "unbridged-only"]] },
  { need: "知识库包读取（可选）", scopes: WIKI_BUNDLE_SCOPES.map(scope => [scope, "verified"]) },
];

// This application only ever acts with a user token, so nothing is requested at
// tenant level; that keeps the application's own standalone power at zero.
const emit = user => process.stdout.write(`${JSON.stringify({ scopes: { tenant: [], user } }, null, 2)}\n`);

const deploymentFile = process.argv[2];
if (deploymentFile) {
  const { readDeploymentFile } = await import("../src/application/deployment.js");
  const { loadFeishuLoginConfig } = await import("../src/control-plane/server-config.js");
  // Reads the deployment file the same way the application does, so a file it
  // would refuse to start on is refused here too rather than half-reported.
  const env = await readDeploymentFile(deploymentFile);
  const config = loadFeishuLoginConfig(env);
  const user = [...feishuLoginScopes({ ...config, scheduleResourcesEnabled: env.IDOU_SCHEDULED_TASKS === "1" })];
  emit(user);
  process.stderr.write(`\n这是 ${deploymentFile} 下次登录会申请的 ${user.length} 项，和控制面构造授权链接用的是同一个函数。\n`
    + `控制台按这份开通即可；多开的不会用到，少开的会让对应动作不可用。\n`
    + (config.longSessionDays > 0 ? "另外会带上 offline_access（长会话），它不是控制台里的权限项，不用勾。\n" : ""));
  process.exit(0);
}

const all = GROUPS.flatMap(group => group.scopes);
emit([...new Set(all.map(([scope]) => scope))]);

const width = Math.max(...GROUPS.map(group => group.need.length));
process.stderr.write("\n用途与权限对应关系（stdout 是可直接导入的 JSON）：\n\n");
for (const group of GROUPS) {
  for (const [scope, status] of group.scopes) {
    process.stderr.write(`  ${group.need.padEnd(width, "　")}  ${scope.padEnd(34)}${status === "verified" ? "已确认" : status === "named-by-feishu" ? "飞书已点名" : status === "granted-elsewhere" ? "同租户已发过" : status === "narrowed" ? "已收窄" : status === "unbridged-only" ? "只在未开桥接时用" : "待控制台确认"}\n`);
  }
}
process.stderr.write(`
标「已确认」的在真实租户上跑通过对应动作，或被飞书授权页/内置 CLI 权限表点名；
标「飞书已点名」的是实测时飞书在错误里直接报出来的，照着开通即可；
标「同租户已发过」的是本租户另一个可用身份上真实存在的权限名，照抄不会因为名字不存在而导入失败；
标「已收窄」的是从一个伞形权限换成的精确权限，比原来要得少，换完需要重新授权一次才生效；
标「只在未开桥接时用」的在开了 FEISHU_CLI_BRIDGE_ENABLED=1 的部署上永远用不到，开了也是白开；
标「待控制台确认」的是按同租户可用身份推断的，开通并跑通一次后再改成已确认。
这几项对应控制台里的中文名：
  search:docs:read            搜索云文档
  wiki:wiki:readonly          查看知识库节点（定时任务创建时解析到底层文档）
  contact:user:search         搜索用户
  im:chat.members:read        查看群成员
  im:chat:read                查看群信息
  im:message:readonly         获取单聊、群组消息
  im:message.group_msg:get_as_user  以用户身份获取群组消息
  im:message.p2p_msg:get_as_user    以用户身份获取单聊消息
  im:message.send_as_user     以用户身份发送消息
  sheets:spreadsheet:read     查看电子表格
  sheets:spreadsheet:write_only  编辑电子表格
  sheets:spreadsheet.meta:read   查看电子表格元数据
  base:app:read               查看多维表格
  base:table:read             查看多维表格数据表
  base:field:read             查看多维表格字段
  base:record:read            查看多维表格记录
  calendar:calendar:read      获取日历、日程及忙闲信息
  calendar:calendar.event:read     查看日程
  calendar:calendar.free_busy:read 查询忙闲信息
  calendar:calendar.event:create   创建日程
  calendar:calendar.event:update   更新日程
  calendar:calendar.event:reply    回复日程邀请
  task:task:read              查看任务
  task:tasklist:read          查看任务清单
  task:task:write             创建、更新任务
  base:record:create          新增多维表格记录
  base:record:update          更新多维表格记录
导入后必须同步更新部署配置里的 FEISHU_CLI_SCOPES，两边少一个都会在登录时失败：
控制台少开会让授权页直接报「当前应用权限不足」，配置少写则对应动作不可用。
不需要的功能可以整行删掉，少开的权限只会让对应动作不可用，不影响其余部分。
`);
