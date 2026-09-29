import { workspaceOpenTarget } from "../application/workspace-files.js";

export async function openWorkspaceItem(cwd, relative, action, systemShell) {
  if (!systemShell || typeof systemShell.openPath !== "function" || typeof systemShell.showItemInFolder !== "function") throw new Error("系统文件处理能力不可用");
  if (action === "reveal") {
    const target = await workspaceOpenTarget(cwd, relative);
    systemShell.showItemInFolder(target.full);
    return { opened: true, action, path: target.file.path };
  }
  if (action !== "open") throw new Error("未知的文件操作");
  const target = await workspaceOpenTarget(cwd, relative, { system: true });
  const failure = await systemShell.openPath(target.full);
  if (failure) throw new Error(`系统应用未能打开这个文件：${String(failure).slice(0, 200)}`);
  return { opened: true, action, path: target.file.path };
}
