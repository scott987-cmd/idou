import { getMode, getPermission } from "../modes.js";
import { knowledgeScopeInstruction } from "../knowledge/task-scope.js";
import { CodexAppServerClient } from "../providers/codex/app-server-client.js";
import { resolveCodexRuntime } from "../providers/codex/bundled-codex.js";
import { gatewayRuntimeConfig, MODEL_PROVIDER } from "../providers/codex/gateway-config.js";
import { DEFAULT_CHAT_MODEL } from "../providers/codex/chat-models.js";
import { resolveFeishuRuntime, feishuAgentEnvironment } from "../providers/feishu/bundled-runtime.js";
import { runProcess } from "../providers/process-runner.js";
import { mcpOverrides, inspectTaskMcp } from "./mcp-connections.js";
import { projectTrustOverrides, repositoryDirectories, sandboxOverrides } from "./sandbox-roots.js";
import { AGENT_SHELL_VARIABLES, withAgentShellTools } from "../providers/codex/agent-shell.js";
import { agentTool, agentToolsDirectory } from "./knowledge-commands.js";
import { installToolRules, ownedPaths, writableOwned } from "../providers/codex/tool-rules.js";
import { applicationRoot } from "../providers/release-manifest.js";
import path from "node:path";
import { tmpdir } from "node:os";
import { siteRulesInstruction } from "../apps/manifest.js";
import { secretValues } from "./redact-secrets.js";
import { fileURLToPath } from "node:url";

// Writing a .docx or .pptx by hand means installing packages and writing a
// throwaway script, which in practice does not finish inside one turn. The
// product ships the conversion instead, and the Agent is told the exact command
// so it never has to guess or install anything.
function documentToolInstruction() {
  const tool = fileURLToPath(new URL("../../bin/doc-tool.js", import.meta.url));
  return `To deliver a Word document or a slide deck, write the content as Markdown in the working directory and convert it with \`node ${JSON.stringify(tool)} docx <input.md> <output.docx>\` or \`… pptx <input.md> <output.pptx>\`. `
    + "In that Markdown, `#` is the title, `##` starts a heading (and a new slide), `-` is a bullet, and pipe tables become real tables. "
    + "Never install a package to produce these formats, and never write the binary yourself. Put the finished file in the working directory with a clear name and say where it is.";
}

// The Agent reads Feishu freely through the bundled CLI but holds no write
// credential. Every mutation is requested through this shim, confirmed by the
// user inside the application, and performed by the application itself.
// (Named in knowledge-commands.js, which recognises the Agent's knowledge reads
// by it.)
function agentToolInstruction(command) {
  return `Everything outside your sandbox goes through one tool: run \`${command} --help\` and use the operation it lists. That covers changing Feishu (a document, a spreadsheet, a Base table), generating images and videos, and the person's scheduled tasks (定时任务): drafting one for them to confirm, listing, pausing, resuming, deleting and running one now. `
    + "Documents have dedicated operations; spreadsheets, Base records and block-level document edits go through its `run` operation, where you write an ordinary Feishu CLI command and the application checks with the CLI what that command would send before asking the user. "
    + "A video is not finished when generation returns -- poll its status rather than assuming, and a temporary result expires, so save it to Drive when the person wants to keep it. "
    + "Read first with the bundled Feishu CLI, and consult its own `--help` and `skills read` for a command's flags rather than guessing them. "
    + "You have no Feishu write credential of your own, so this is the only way a write can happen; never try to write with the Feishu CLI directly. "
    + "Each call asks the user to confirm in the application, so state plainly what you are about to change before you run it, and pass content through files rather than inline arguments. "
    + "Such a call does not return until the user has answered, which can take minutes: the confirmation stays up for five. The user is there to answer it. "
    + "While the command is still running, keep waiting on that same command (poll it with empty input) until it exits, and do not end your turn before it does: "
    + "ending the turn withdraws the confirmation before the user can answer, and nothing is done. "
    + "A refusal means the user declined: report that and stop, do not retry or look for another route.";
}

export async function createTaskRuntime(config, task) {
  // config.mcpConnections may hold more than the task's own bound connection —
  // the desktop prepends app-owned built-in connectors (web fetch, …) for coding
  // tasks. The task's own connection, when set, must be among them.
  if (task.mcpConnection && !config.mcpConnections?.some((row) => row.id === task.mcpConnection.id)) throw new Error("任务 MCP 连接未完成核验");
  // The desktop sets chatModel to the model the server enforces; a caller that
  // never learned it asks for the default, and a mismatch is the gateway's to refuse.
  const runtime = await gatewayRuntimeConfig(config, undefined, { model: config.chatModel ?? DEFAULT_CHAT_MODEL });
  if (task.enterpriseSkill || task.mcpConnection) {
    const version = await runProcess((await resolveCodexRuntime(config.codex.binary)).binary, ["--version"], { env: runtime.env, maxOutputBytes: 4096 });
    if (!config.codex.expectedVersion || version.code !== 0 || version.stdout.trim() !== `codex-cli ${config.codex.expectedVersion}`) throw new Error("Codex 版本与企业技能校验版本不一致，请先完成运行时兼容性检查");
  }
  const feishu = await resolveFeishuRuntime(config.feishu);
  const mode = getMode(task.mode);
  // Chosen per task and re-read on every turn, so changing it mid-conversation
  // takes effect on the next send rather than needing a new task.
  //
  // Except while a coding task is still planning. Codex and Claude Code both
  // look before they touch anything, and until now this one did not: a request
  // went straight to work, and the first thing the person saw was files
  // changing. The person's own choice is kept on the task and takes over the
  // moment they say 开始做 -- planning never silently widens it, and 只读计划 is
  // narrower than every other option, so this can only ever reduce what a turn
  // may do.
  const permission = task.stage === "planning" ? getPermission("plan") : getPermission(task.permission);
  // The connection check builds a runtime for something that is not a task: it
  // has a mode, a throwaway directory and a connection, but no identity. The
  // Agent bridge binds one task id per shell, so it has nothing to bind here --
  // and a check must not be handed a write channel it never uses anyway.
  const bridge = config.feishuBusinessLinked === false || !task.id ? null : config.agentFeishuEnvironment?.(task.id) ?? null;
  const env = withAgentShellTools({ ...feishuAgentEnvironment(feishu.binary, runtime.env, config.feishu.environment?.()), ...(bridge ?? {}) });
  let lease;
  // Only a bound enterprise connection needs a broker lease; built-in connectors
  // are always local stdio and never do.
  const enterpriseRow = config.mcpConnections?.find((row) => row.transport === "enterprise");
  if (enterpriseRow) {
    if (!config.acquireEnterpriseMcp) throw new Error("当前账号不能获取企业 MCP 授权");
    lease = await config.acquireEnterpriseMcp(enterpriseRow);
    env[lease.envName] = lease.token;
  }
  try {
  const repository = permission.sandbox !== "danger-full-access" ? await repositoryDirectories(task.cwd) : [];
  const overrides = { ...runtime.overrides, ...sandboxOverrides(permission, { cwd: task.cwd, repository: permission.sandbox === "workspace-write" ? repository : [] }),
    ...(permission.sandbox !== "danger-full-access" ? await projectTrustOverrides(task.cwd, repository) : {}),
    ...(config.mcpConnections?.length ? { mcp_servers: mcpOverrides(config.mcpConnections, task.cwd, lease ? { [lease.connectionId]: lease } : {}), "features.tool_call_mcp_elicitation": true } : {}),
    "shell_environment_policy.set": { ...runtime.overrides["shell_environment_policy.set"], ...Object.fromEntries(Object.entries(env).filter(([key]) => AGENT_SHELL_VARIABLES.includes(key) || key.startsWith("LARKSUITE_CLI_") || key.startsWith("IDOU_FEISHU_BRIDGE"))) } };
  // The application's own tools reach it from a sandbox without network by a
  // rule each (tool-rules.js), and nothing a sandboxed command can write may be
  // one of them. The temporary folder is writable in every sandbox; the
  // application keeps none of these there outside a test.
  const tools = { codexHome: runtime.env.CODEX_HOME, directory: config.codex.toolsDirectory ?? agentToolsDirectory(), larkCli: feishu.binary, agentScript: agentTool(), applicationRoot };
  if (permission.sandbox === "workspace-write") {
    const writable = [task.cwd, ...(overrides["sandbox_workspace_write.writable_roots"] ?? []).filter((root) => path.resolve(root) !== path.resolve(tmpdir()))];
    if (writableOwned(writable, ownedPaths(tools)).length) throw new Error("这个工作目录包含 i豆 自己的程序或数据，沙箱里运行的任务不能写到这些地方。请选择其中的一个项目目录，或把这个任务设为完全访问。");
  }
  const commands = await installToolRules(tools);
  const agentCommand = commands.agent ?? `node ${JSON.stringify(agentTool())}`;
  const alone = "Write that path exactly as it is, unquoted, at the start of a command of its own -- no pipe, redirection or variable assignment around it -- or it cannot reach the application.";
  const client = new CodexAppServerClient({ binary: config.codex.binary, cwd: task.cwd, env, configOverrides: overrides });
  if (lease) { const stop = client.stop.bind(client); client.stop = async () => { try { await stop(); } finally {
    try { await lease.close(); } catch { client.cleanupWarning = "任务已结束，但企业 MCP 短期授权撤销未确认；请联系管理员。该授权最迟在签发后 5 分钟到期。"; }
    finally { delete env[lease.envName]; }
  } }; }
  // A coding task is repository engineering: the Word/slide converter and the
  // Feishu write bridge are cowork tools, and the bridge's "everything outside
  // your sandbox goes through one tool" wording actively contradicts the
  // permission's own sandbox-escalation rules. So a coding task's developer
  // message is just its mode instructions and the permission; the document and
  // Feishu tooling is added only for cowork tasks.
  const developerParts = [mode.developerInstructions];
  if (mode.id !== "coding") {
    developerParts.push(documentToolInstruction());
    if (bridge) developerParts.push(agentToolInstruction(agentCommand) + (commands.agent ? ` ${alone}` : ""));
  }
  // A coding task on a site's own folder (config.site, found by the desktop) is
  // told what publishing will accept before it adds anything.
  if (mode.id === "coding" && config.site) developerParts.push(siteRulesInstruction(config.site.name));
  developerParts.push(permission.instruction);
  if (mode.id !== "coding") {
    if (task.knowledgeScope) developerParts.push(knowledgeScopeInstruction({ command: bridge ? agentCommand : null }));
    developerParts.push(config.feishuBusinessLinked === false
      ? "This Agent login is not linked to the local Feishu CLI identity. Do not invoke Feishu CLI, read its credentials, or perform Feishu document/chat/knowledge operations. Explain that business identity linking is required. Local coding and file tasks remain available. This instruction is not an OS security sandbox."
      : commands.larkCli
        ? `Use the bundled Feishu executable ${commands.larkCli} for every Feishu operation, including skills list/read. ${alone} Never install or update it.${config.feishu.profile ? ` Use --profile ${JSON.stringify(config.feishu.profile)}.` : ""}`
        : `Use the bundled Feishu executable ${JSON.stringify(feishu.binary)} for every Feishu operation, including skills list/read. Never install or update it.${config.feishu.profile ? ` Use --profile ${JSON.stringify(config.feishu.profile)}.` : ""}`);
  }
  return {
    ...(config.mcpConnections?.length ? { prepare: (client, threadId) => inspectTaskMcp(client, threadId, config.mcpConnections) } : {}),
    // The ids of every MCP connection active this turn (built-ins + the task's
    // own), so the approval layer accepts elicitation from any of them.
    mcpConnectionIds: (config.mcpConnections ?? []).map((row) => row.id),
    // Which of those are the app's own built-ins (技能中心 → 连接器), by id and
    // name: an answer to their card may cover more than one call.
    builtinConnections: (config.builtinConnections ?? []).map((row) => ({ id: row.id, title: row.title })),
    // Never kept in the task's record or shown (redact-secrets.js).
    secrets: secretValues(env),
    client,
    params: { cwd: task.cwd, model: runtime.model, modelProvider: MODEL_PROVIDER, sandbox: permission.sandbox,
      approvalPolicy: permission.approvalPolicy, serviceName: "idou-desktop", config: overrides,
      // On thread/resume as well: base instructions named there replace the
      // thread's own (measured), so a resumed task works from the current text.
      ...(mode.baseInstructions ? { baseInstructions: mode.baseInstructions } : {}),
      developerInstructions: developerParts.join("\n") },
  };
  } catch (error) { await lease?.close().catch(() => {}); throw error; }
}
