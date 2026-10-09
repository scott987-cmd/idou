import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import { declined } from "./agent-confirmation.js";
import { permitsUnattendedActions } from "../permissions.js";

// A website the Agent built in its task, published from the conversation
// (docs/sites-phase1.md §1.1): "把这个表格做成看板发给销售部" ends with a link,
// not with instructions to go and click 发布 somewhere else. The same publish
// as 文档网站's (main.js publishFolder), on the same card (site-publishing.js)
// -- or, from a task on 完全访问, on the person's standing authorization
// (permissions.js, 2026-09-28). Who may open a site already online is not the
// Agent's to change here: that stays the person's, in 分享设置.
const SCOPES = Object.freeze(["invited", "tenant", "anyone"]);
// Answered beside a write waiting on its card (agent-reads.js).
export const SITE_READS = Object.freeze(["site-list"]);

// The site's folder: the task's own, or a folder inside it -- a page anywhere
// else on the machine is the person's to publish.
async function siteFolder(root, relative = ".") {
  if (typeof relative !== "string" || !relative.trim() || relative.length > 1024) throw new Error("--dir 要给任务文件夹里网站目录的路径（就是任务文件夹本身时写 .）");
  const base = await realpath(root);
  const target = await realpath(path.resolve(base, relative)).catch(() => { throw new Error("找不到这个网站目录"); });
  const within = path.relative(base, target);
  if (within.startsWith("..") || path.isAbsolute(within)) throw new Error("网站目录必须在当前任务的文件夹里");
  if (!await stat(path.join(target, "index.html")).then((entry) => entry.isFile(), () => false)) throw new Error("这个目录里没有 index.html：网站要有一个入口页面。");
  return target;
}

export function agentSiteActions({ getScope, confirm, sites }) {
  if (typeof getScope !== "function" || typeof confirm !== "function" || typeof sites?.publishFolder !== "function" || typeof sites?.list !== "function") {
    throw new Error("Invalid agent site action wiring");
  }
  return {
    "site-publish": async (params, taskId) => {
      const scope = getScope();
      if (!scope) throw new Error("应用尚未就绪");
      const task = scope.service.get(taskId);
      if (params.scope !== undefined && !SCOPES.includes(params.scope)) throw new Error("--scope 只能是 invited（仅邀请的人）、tenant（组织内）或 anyone（互联网上）");
      if (params.name !== undefined && (typeof params.name !== "string" || !params.name.trim() || params.name.length > 80)) throw new Error("--name 要是 1 到 80 个字的网站名字");
      const folder = await siteFolder(task.cwd, params.dir ?? ".");
      // What the card says is decided where the publish is: whether it is new or
      // an update, how many files, who will be able to open it.
      const approve = async (card) => {
        if (permitsUnattendedActions(task)) return true;
        const choice = await confirm({ ...card, taskId: task.id });
        if (choice.response !== 1) throw declined(choice, "用户没有发布这个网站：什么都没有发出去。");
        return true;
      };
      return sites.publishFolder({ task, folder, name: params.name ?? null, scope: params.scope ?? null, approve });
    },
    // The person's sites, to name one by its link: reads, so no card.
    "site-list": async () => sites.list(),
  };
}
