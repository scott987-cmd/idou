import readline from "node:readline/promises";
import process from "node:process";
import { getMode, getPermission, DEFAULT_PERMISSION } from "../modes.js";
import { projectTrustOverrides, repositoryDirectories, sandboxOverrides } from "./sandbox-roots.js";
import { AGENT_SHELL_VARIABLES, withAgentShellTools } from "../providers/codex/agent-shell.js";
import { CodexAppServerClient } from "../providers/codex/app-server-client.js";
import { resolveFeishuRuntime, feishuAgentEnvironment } from "../providers/feishu/bundled-runtime.js";
import { gatewayRuntimeConfig, MODEL_PROVIDER } from "../providers/codex/gateway-config.js";
import { DEFAULT_CHAT_MODEL } from "../providers/codex/chat-models.js";
import { fetchServerModel } from "../providers/codex/server-model.js";
import { readClientSession } from "../control-plane/client-session.js";
import { runTurn } from "./turn.js";
import { agentTool, agentToolsDirectory } from "./knowledge-commands.js";
import { installToolRules, ownedPaths, writableOwned } from "../providers/codex/tool-rules.js";
import { applicationRoot } from "../providers/release-manifest.js";
import path from "node:path";
import { tmpdir } from "node:os";

// The Agent's questions (Codex's request_user_input), asked on the terminal. A
// question marked secret is never asked, and with no terminal to ask on every
// question goes back unanswered -- the desktop's 不回答 -- so the Agent carries
// on without it instead of waiting for input that cannot come.
export async function answerInTerminal(questions, ask) {
  const answers = {};
  for (const question of Array.isArray(questions) ? questions : []) {
    if (typeof question?.id !== "string") continue;
    const options = Array.isArray(question.options) ? question.options.filter((option) => typeof option?.label === "string") : [];
    const ownWords = question.isOther === true || !options.length;
    if (question.isSecret === true || !ask) { answers[question.id] = { answers: [] }; continue; }
    const menu = options.map((option, index) => `  ${index + 1}. ${option.label}${option.description ? ` - ${option.description}` : ""}\n`).join("");
    const hint = options.length ? `Choose a number${ownWords ? " or type your own answer" : ""}` : "Type your answer";
    const reply = String(await ask(`\n${question.header ? `${question.header}: ` : ""}${question.question ?? ""}\n${menu}${hint} (Enter to skip): `) ?? "").trim();
    const picked = /^\d+$/.test(reply) ? options[Number(reply) - 1]?.label : undefined;
    answers[question.id] = { answers: picked ? [picked] : reply && ownWords ? [reply] : [] };
  }
  return { answers };
}

function terminalApprovalHandler(client) {
  const terminal = readline.createInterface({ input: process.stdin, output: process.stderr });

  const handler = async (request) => {
    if (request.method === "item/tool/requestUserInput") {
      client.respond(request.id, await answerInTerminal(request.params?.questions, process.stdin.isTTY ? (prompt) => terminal.question(prompt) : null));
      return;
    }
    const approvalMethods = new Set([
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "execCommandApproval",
      "applyPatchApproval",
    ]);

    if (!approvalMethods.has(request.method)) {
      client.respondError(request.id, -32601, `i豆 does not yet handle ${request.method}`);
      return;
    }

    const subject = request.params?.command || request.params?.reason || request.method;
    if (!process.stdin.isTTY) {
      client.respond(request.id, { decision: "decline" });
      return;
    }
    const answer = await terminal.question(`\nApprove ${subject}? [y/N] `);
    client.respond(request.id, { decision: /^y(?:es)?$/i.test(answer.trim()) ? "accept" : "decline" });
  };

  return { handler, close: () => terminal.close() };
}

// The terminal has no desktop main process to learn the server's model for it,
// so it asks the server the same way; an explicit chatModel still wins, and
// anything unlearnable keeps the default for the gateway to accept or refuse.
async function chatModel(config) {
  if (config.chatModel) return config.chatModel;
  try { return await fetchServerModel((await readClientSession(config.controlPlane.sessionFile, config.controlPlane.baseUrl)).serverUrl) ?? DEFAULT_CHAT_MODEL; }
  catch { return DEFAULT_CHAT_MODEL; }
}

export async function runChat(config, { mode: modeId, cwd, permission: permissionId, prompt }) {
  const mode = getMode(modeId);
  // sandbox and approval policy live on the permission, not the mode (a mode says
  // what kind of work it is; a permission says how much runs unattended). The
  // terminal has no picker, so it uses the same default the desktop starts with.
  const permission = getPermission(permissionId ?? DEFAULT_PERMISSION);
  const runtime = await gatewayRuntimeConfig(config, undefined, { model: await chatModel(config) });
  const feishu = await resolveFeishuRuntime(config.feishu);
  const env = withAgentShellTools(feishuAgentEnvironment(feishu.binary, runtime.env, config.feishu.environment?.()));
  const repository = permission.sandbox !== "danger-full-access" ? await repositoryDirectories(cwd) : [];
  const overrides = { ...runtime.overrides, ...sandboxOverrides(permission, { cwd, repository: permission.sandbox === "workspace-write" ? repository : [] }),
    ...(permission.sandbox !== "danger-full-access" ? await projectTrustOverrides(cwd, repository) : {}),
    "shell_environment_policy.set": { ...runtime.overrides["shell_environment_policy.set"], ...Object.fromEntries(Object.entries(env).filter(([key]) => AGENT_SHELL_VARIABLES.includes(key) || key.startsWith("LARKSUITE_CLI_"))) } };
  // The bundled Feishu CLI reaches its sidecar from a sandbox without network by
  // a rule (tool-rules.js), as a desktop task's does.
  const tools = { codexHome: runtime.env.CODEX_HOME, directory: config.codex.toolsDirectory ?? agentToolsDirectory(), larkCli: feishu.binary, agentScript: agentTool(), applicationRoot };
  if (permission.sandbox === "workspace-write") {
    const writable = [cwd, ...(overrides["sandbox_workspace_write.writable_roots"] ?? []).filter((root) => path.resolve(root) !== path.resolve(tmpdir()))];
    if (writableOwned(writable, ownedPaths(tools)).length) throw new Error("这个工作目录包含 i豆 自己的程序或数据，沙箱里运行的任务不能写到这些地方。请换一个项目目录，或用 --permission full。");
  }
  const commands = await installToolRules(tools);
  const client = new CodexAppServerClient({ binary: config.codex.binary, cwd, env, configOverrides: overrides });
  const approval = terminalApprovalHandler(client);
  let streamed = false;

  client.on("serverRequest", (request) => {
    approval.handler(request).catch((error) => client.respondError(request.id, -32000, error.message));
  });
  client.on("notification", (message) => {
    if (message.method === "item/agentMessage/delta") {
      streamed = true;
      process.stdout.write(message.params.delta);
    }
  });
  client.on("stderr", (text) => process.stderr.write(text));

  try {
    await client.start();
    const started = await client.request("thread/start", {
      cwd,
      model: runtime.model,
      modelProvider: MODEL_PROVIDER,
      sandbox: permission.sandbox,
      approvalPolicy: permission.approvalPolicy,
      serviceName: "idou",
      ...(mode.baseInstructions ? { baseInstructions: mode.baseInstructions } : {}),
      config: overrides,
      developerInstructions: `${mode.developerInstructions}\n${permission.instruction}\nThe application-bundled Feishu executable is ${commands.larkCli ?? JSON.stringify(feishu.binary)}. Use this exact executable for every Feishu command, including skills list/read.${commands.larkCli ? " Write that path exactly as it is, unquoted, at the start of a command of its own -- no pipe, redirection or variable assignment around it -- or it cannot reach the application." : ""} Do not install or self-update lark-cli; the application manages its version.${config.feishu.profile ? ` Append --profile ${JSON.stringify(config.feishu.profile)} to Feishu commands.` : ""}`,
    });

    const turn = await runTurn(client, {
      threadId: started.thread.id,
      input: [{ type: "text", text: prompt, text_elements: [] }],
    });
    if (turn.status !== "completed") throw new Error(turn.error?.message || `Codex turn ${turn.status}`);

    if (!streamed) {
      const messages = turn.items.filter((item) => item.type === "agentMessage");
      if (messages.length > 0) process.stdout.write(messages.at(-1).text);
    }
    process.stdout.write("\n");
  } finally {
    approval.close();
    await client.stop();
  }
}
