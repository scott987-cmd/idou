import path from "node:path";
import { realpath } from "node:fs/promises";
import { declined } from "./agent-confirmation.js";
import { permitsUnattendedActions } from "../permissions.js";

// A skill the Agent wrote in its task folder, put to use for new tasks -- what
// the person does from 技能中心 with 导入 and 启用 (main.js). By default it asks
// on the same card; from a task on 完全访问 it is enabled without one: the
// task's permission is the person's authorization (permissions.js, 2026-09-28).
//
// Only from inside the task's own folder: a skill anywhere else on the machine
// is the person's to import. One skill is in use at a time (LocalSkillStore),
// so enabling this one switches off the one before it, and both the card and
// the answer say which.
const KINDS = Object.freeze({ cowork: "工作任务", coding: "编程任务" });

async function inside(root, relative) {
  if (typeof relative !== "string" || !relative.trim() || relative.length > 1024) throw new Error("--dir 要给任务文件夹里技能目录的路径");
  const base = await realpath(root);
  const target = await realpath(path.resolve(base, relative)).catch(() => { throw new Error("找不到这个技能目录"); });
  const within = path.relative(base, target);
  if (within.startsWith("..") || path.isAbsolute(within)) throw new Error("技能目录必须在当前任务的文件夹里");
  return target;
}

export function agentSkillActions({ getScope, confirm }) {
  if (typeof getScope !== "function" || typeof confirm !== "function") throw new Error("Invalid agent skill action wiring");
  return {
    "skill-enable": async (params, taskId) => {
      const scope = getScope();
      if (!scope) throw new Error("应用尚未就绪");
      const task = scope.service.get(taskId);
      const kinds = String(params.for ?? "cowork").split(",").map((value) => value.trim()).filter(Boolean);
      if (!kinds.length || kinds.some((kind) => !KINDS[kind])) throw new Error("--for 只能是 cowork、coding，或者 cowork,coding");
      const directory = await inside(task.cwd, params.dir);
      const before = (await scope.localSkills.list()).find((skill) => skill.enabled) ?? null;
      const skill = await scope.localSkills.importDirectory(directory);
      const replacing = before && before.id !== skill.id ? before : null;
      if (!permitsUnattendedActions(task)) {
        const named = kinds.map((kind) => KINDS[kind]).join("和");
        const choice = await confirm({ type: "warning", title: "确认启用本机技能",
          message: `新建的${named}会使用「${skill.title}」`,
          detail: `任务：${task.title}\n来源：这个任务的文件夹（${path.relative(await realpath(task.cwd), directory) || "."}），未经服务端签名审核\n`
            + `标识：${skill.id} · 版本 ${skill.version}\n摘要：${skill.digest.slice(0, 16)}…\n\n${skill.description}\n\n`
            + `${replacing ? `同一时间只用一个技能：启用后，「${replacing.title}」会停用。\n` : ""}`
            + "Agent 会在可用技能里看到它的名称和描述，遇到符合描述的请求时照它的说明做。停用后新任务不再使用它。",
          buttons: ["取消", "启用"], defaultId: 0, cancelId: 0 });
        if (choice.response !== 1) throw declined(choice, "用户没有启用这个技能：它已导入技能中心，但没有启用。");
      }
      await scope.localSkills.setEnabled(skill.id, true, kinds);
      return { enabled: true, id: skill.id, title: skill.title, version: skill.version, for: kinds,
        ...(replacing ? { switchedOff: { id: replacing.id, title: replacing.title } } : {}) };
    },
  };
}
