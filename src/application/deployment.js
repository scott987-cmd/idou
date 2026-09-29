import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:net";
import { loadChatModelConfig, loadFeishuLoginConfig, loadServerModelKey, loadVideoKey } from "../control-plane/server-config.js";
import { FEISHU_CLI_WRITE_ACTIONS } from "../providers/feishu/cli-write-contract.js";
import { feishuLoginScopes, OFFLINE_SCOPE } from "../providers/feishu/login-scopes.js";
import { runDoctor } from "./doctor.js";
import { loadConfig } from "../config.js";
import { currentName } from "../env-names.js";

// Keys an operator may set. Anything else in the file is rejected rather than
// silently ignored, so a typo cannot leave a capability quietly disabled.
export const DEPLOYMENT_KEYS = Object.freeze([
  "IDOU_PUBLIC_URL", "IDOU_PORT",
  // Which Feishu deployment: one of those this build ships. Unset is SaaS.
  "FEISHU_PROVIDER",
  "FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_ALLOWED_TENANTS",
  "FEISHU_SOURCE_ACCESS_ENABLED", "FEISHU_CLI_BRIDGE_ENABLED", "FEISHU_CLI_SCOPES",
  "FEISHU_CLI_WRITE_ACTIONS", "FEISHU_CLI_IDENTITY_CHECKS_ENABLED", "FEISHU_SESSION_RENEWAL_ENABLED", "FEISHU_LONG_SESSION_DAYS",
  "FEISHU_WIKI_ORIGINAL_ORIGINS", "FEISHU_WIKI_BUNDLE_READS_ENABLED",
  "MINIMAX_API_KEY", "MINIMAX_CONFIG_FILE",
  // The chat model. Unset keeps MiniMax; "litellm" sends chat to GLM through a
  // LiteLLM proxy on the control plane's own machine. Images stay on MiniMax
  // either way, still with the MINIMAX_* key above (video: see below).
  "IDOU_MODEL_PROVIDER", "IDOU_MODEL_PROVIDERS", "IDOU_LITELLM_BASE_URL", "IDOU_LITELLM_MODEL",
  "IDOU_LITELLM_KEY_FILE", "IDOU_LITELLM_API_KEY",
  "IDOU_MEDIA_ENABLED", "IDOU_DRIVE_CONFIG_FILE", "IDOU_APPS_CONFIG_FILE",
  // Video on Qwen HappyHorse: the file holding a Token Plan key. Unset, video
  // stays on MiniMax with images.
  "QWEN_TOKEN_PLAN_KEY_FILE",
  "IDOU_WIKI_CONFIG_FILE", "IDOU_WIKI_KEY_CONFIG_FILE", "IDOU_SKILL_PUBLIC_KEY_FILE",
  "IDOU_SCHEDULED_TASKS", "IDOU_SCHEDULED_TASKS_DIR", "IDOU_SCHEDULED_TASKS_PORT",
  // 文档网站: the published-site listener. Off unless an operator names an
  // address for it; anonymous links are a separate decision again.
  "IDOU_SITES", "IDOU_SITES_URL", "IDOU_SITES_PORT", "IDOU_SITES_BIND", "IDOU_SITES_DIR", "IDOU_SITES_ANONYMOUS", "IDOU_SITES_ALLOW",
  // 服务端管理台: who may open it. A group whose members are administrators, and
  // a short list in this file as the way back in when that group cannot be read.
  "IDOU_ADMIN_CHAT", "IDOU_ADMIN_USERS", "IDOU_ADMIN_URL", "IDOU_ADMIN_PORT",
  // 模型可见性: which models each person is offered, and what somebody no rule
  // names gets. Unset means every model, which is what every deployment does today.
  "IDOU_MODEL_POLICY_FILE", "IDOU_MODEL_DEFAULT_VISIBLE",
  // 用量记账: where the counts live. Unset uses ~/.idou/model-usage.sqlite (~/.mydoubao/ on an installation from before the rename).
  // Counts only — the ledger has no column for a prompt or an answer.
  "IDOU_MODEL_USAGE_FILE",
  // Whether a schedule may run while nobody is signed in. It makes the control
  // plane hold a durable Feishu credential, so it is off unless asked for.
  "IDOU_SCHEDULE_UNATTENDED",
  // Whether a finished run is announced by the application bot rather than by
  // the person to themselves. A different authority, so a separate decision.
  "IDOU_SCHEDULE_BOT_NOTIFY",
  // How many days a finished run's own output is kept on the control plane.
  // The run record itself is not affected.
  "IDOU_SCHEDULE_RUN_DETAIL_DAYS",
  "IDOU_SCHEDULE_PROMPT_DAYS",
  // 容量: how much this server takes on at once and a person's share of it
  // (loadCapacity in control-plane/server-config.js). Unset keeps the pilot's.
  "IDOU_MODEL_MAX_CONCURRENT", "IDOU_MODEL_MAX_CONCURRENT_PER_USER", "IDOU_MODEL_REQUESTS_PER_MINUTE",
  "IDOU_FEISHU_CLI_MAX_CONCURRENT", "IDOU_FEISHU_CLI_MAX_CONCURRENT_PER_USER",
  "IDOU_SCHEDULE_MAX_CONCURRENT", "IDOU_SCHEDULES_PER_USER", "IDOU_SCHEDULES_PER_TENANT",
  // ...and what were the pilot's constants: signed-in sessions, Feishu reads,
  // renewals, sign-ins a minute, MCP connections, media jobs and media spend.
  "IDOU_SIGNED_IN_MAX", "IDOU_FEISHU_READS_MAX_CONCURRENT", "IDOU_FEISHU_READS_PER_MINUTE", "IDOU_RENEWALS_MAX_CONCURRENT",
  "IDOU_LOGINS_PER_MINUTE", "IDOU_MCP_SESSIONS_MAX", "IDOU_MEDIA_JOBS_MAX_CONCURRENT", "IDOU_MEDIA_PER_HOUR", "IDOU_SPEECH_PER_HOUR",
  // 监控指标: a Prometheus endpoint on 127.0.0.1 only. Unset, none.
  "IDOU_METRICS_PORT",
  // 多副本: the PostgreSQL the replicas share, and the key what they share is
  // sealed with (control-plane/database.js). Unset, one process as before.
  "IDOU_DATABASE_URL", "IDOU_STATE_KEY_FILE",
  // 执行池: whether scheduled runs go to the workers (`--role worker`), and a
  // worker's own name when several share one machine.
  "IDOU_SCHEDULE_EXECUTION", "IDOU_WORKER_NAME",
  // Where the durable data lives: files on this machine, or the shared database.
  "IDOU_DATA_STORE", "IDOU_COORDINATOR_LEASE_SECONDS",
  // Workers on other machines: the coordinator's egress for them, and the peers
  // allowed; on a worker, where that egress is.
  "IDOU_EGRESS_REMOTE_LISTEN", "IDOU_EGRESS_REMOTE_PEERS", "IDOU_EGRESS_UPSTREAM",
  // development | production. Production refuses to run scheduled tasks unless
  // the sandbox network is internal, the proxy is not reached through the host,
  // and the runtime is not plain namespaces.
  "IDOU_SANDBOX_MODE", "IDOU_SANDBOX_IMAGE",
  // What production needs from the host: gVisor, the proxy's address on the
  // internal network, and the user the container runs as.
  "IDOU_SANDBOX_RUNTIME", "IDOU_SANDBOX_GATEWAY", "IDOU_SANDBOX_USER", "IDOU_SANDBOX_NETWORK",
  // The server side of the enterprise skill shelf. The example file has always
  // documented these three with a full setup recipe, but they were never in this
  // list -- so following those instructions made readDeploymentFile throw on the
  // first one and the whole application refused to start. The shelf was
  // unreachable through its own documented path.
  "IDOU_SKILL_SIGNING_KEY_FILE", "IDOU_SKILL_REGISTRY_FILE", "IDOU_SKILL_ADMINS", "IDOU_SKILL_CATALOG_FILE",
  // Same story as the skill keys: documented as a server-only variable in
  // docs/enterprise-mcp-broker.md, read at src/control-plane/mcp-broker.js, and
  // stripped out again by serverEnvironment before the server ever saw it.
  "IDOU_MCP_CONFIG_FILE",
]);
const SECRET_KEYS = new Set(["FEISHU_APP_SECRET", "MINIMAX_API_KEY", "IDOU_LITELLM_API_KEY"]);

// A deployment file holds the application secret, so it is read with the same
// ownership and permission rules as a session file and never echoed back.
export async function readDeploymentFile(filename) {
  if (!filename || !path.isAbsolute(filename)) throw new Error("部署配置需要一个绝对路径");
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 65536) throw new Error("部署配置必须是不超过 64KB 的普通文件");
    if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid())) {
      throw new Error(`部署配置含应用密钥，必须属于当前用户且权限为 0600：chmod 600 ${filename}`);
    }
    const env = {};
    for (const [index, raw] of (await handle.readFile("utf8")).split("\n").entries()) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const separator = line.indexOf("=");
      const written = separator > 0 ? line.slice(0, separator).trim() : "";
      // A file written before the rename says MYDOUBAO_*; it means IDOU_* (env-names.js).
      const key = currentName(written);
      if (!DEPLOYMENT_KEYS.includes(key)) throw new Error(`部署配置第 ${index + 1} 行不是可识别的设置项${written ? `：${written}` : ""}`);
      if (Object.hasOwn(env, key)) throw new Error(`部署配置重复设置了 ${key}${written !== key ? `（${written} 是它的旧名字）` : ""}`);
      // The same file is also read by `set -a; . file` (the LaunchAgent), so a
      // value means what it means to a shell. A JSON value has quotes of its own
      // and survives a shell only inside single quotes, which a shell takes
      // literally; reading them here as part of the value made such a setting
      // impossible to write for both readers at once.
      const rawValue = line.slice(separator + 1).trim();
      const value = /^'[^']*'$/.test(rawValue) ? rawValue.slice(1, -1) : rawValue.replace(/^"(.*)"$/, "$1");
      if (value) env[key] = value;
    }
    return env;
  } finally { await handle.close(); }
}

async function defaultRuntimeChecks() {
  try { return (await runDoctor(await loadConfig())).checks; }
  catch (error) { return [{ name: "runtime", ok: false, detail: error.message }]; }
}

// LiteLLM's unauthenticated liveness route. No key goes with it: this only says
// whether something answers on the configured loopback port.
async function liteLlmAlive(origin) {
  try {
    const response = await fetch(`${origin}/health/liveliness`, { redirect: "error", signal: AbortSignal.timeout(2000) });
    await response.body?.cancel();
    return response.ok;
  } catch { return false; }
}

async function portFree(port) {
  return new Promise(resolve => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

// Reports what an operator still has to do, and the two values they must register
// with Feishu. Never returns or prints a secret, only whether one loads.
export async function preflight(env, { checkPort = portFree, runtime = defaultRuntimeChecks, liteLlm = liteLlmAlive } = {}) {
  const checks = [], required = [];
  const add = (name, ok, detail, action) => { checks.push({ name, ok, detail, ...(action ? { action } : {}) }); if (!ok && action) required.push(action); };

  // Two supported shapes. A file with no Feishu application is local mode: the
  // product runs immediately with coding and cowork tasks, and every Feishu
  // business entry point stays refused until an application is configured.
  const local = !env.FEISHU_APP_ID && !env.FEISHU_APP_SECRET;
  let config = null;
  if (local) {
    add("mode", true, "本机模式：编程与工作任务可用；飞书文档、消息、云盘等业务功能需要配置自建应用后才开放");
  } else {
    try {
      config = loadFeishuLoginConfig(env);
      const pending = config.allowedTenants.includes("PENDING-FIRST-LOGIN");
      add("feishu-application", true, pending
        ? `App ID ${config.appId}，租户 key 待确认：先启动并点一次登录，控制面会在 stderr 打出真实值，填回 FEISHU_ALLOWED_TENANTS 后再登录`
        : `App ID ${config.appId}，允许租户 ${config.allowedTenants.join("、")}`);
    } catch (error) {
      // The loader already names the exact setting, so repeat that rather than a
      // catch-all list the operator then has to search through.
      add("feishu-application", false, error.message, `${error.message}。也可以把飞书相关设置全部留空，先用本机模式`);
    }
  }

  if (config) {
    const schedules = env.IDOU_SCHEDULED_TASKS === "1";
    // Exactly what FeishuSourceAccess will put in the authorization URL. An
    // operator registers what this prints, so a list assembled separately here
    // would send them to the console with the wrong set.
    const scopes = feishuLoginScopes({ ...config, scheduleResourcesEnabled: schedules });
    add("oauth-registration", true, `回调地址 ${config.origin}/auth/feishu/callback；申请授权范围 ${scopes.join(" ")}${config.longSessionDays > 0 ? `，另加 ${OFFLINE_SCOPE}（长会话）` : ""}`);
    add("bridge-writes", true, config.cliWriteActions.length
      ? `已启用写入动作：${config.cliWriteActions.join("、")}`
      : `当前只读。可选动作：${FEISHU_CLI_WRITE_ACTIONS.join("、")}`);
    // Off by default because every generation is a real paid call, but silence
    // at startup turned into an unexplained 404 at the moment someone used it.
    add("media-service", true, env.IDOU_MEDIA_ENABLED === "1"
      ? "图片与视频已启用；每次生成都是一次真实付费调用"
      : "图片与视频未启用。桌面端的「创作图片或视频」会被服务端拒绝；需要时设置 IDOU_MEDIA_ENABLED=1");
    // Every upload to Feishu Drive -- a finished file, or a generated image or
    // video being kept -- is charged against a server-held quota bound to one
    // managed folder, and is refused when none is configured. Nothing else
    // said so: the upload action and media could both be enabled and still
    // never work, with the reason only visible at the moment someone tried.
    const reportWrite = config.cliWriteActions.includes("drive.upload");
    add("schedule-report-write", !schedules || reportWrite,
      !schedules ? "未启用定时任务，不需要报告归档写入"
        : reportWrite ? "定时任务报告使用受限 drive.upload 后处理器写入任务所有人自己的云空间（我的空间），计入租户的云盘配额"
          : "已启用定时任务，但未启用 drive.upload：任务会执行，但报告归档会失败，控制面不会保存正文。",
      schedules && !reportWrite ? "在 FEISHU_CLI_WRITE_ACTIONS 中加入 drive.upload，并在飞书开放平台发布对应权限" : null);
    // Archiving a report builds its links on the tenant's own Feishu domain,
    // and refuses without one -- so with schedules on, a tenant
    // with no domain configured fails every run at the very end, as 「报告未保存」,
    // after the model has already been paid for. This used to pass here.
    const originless = schedules ? config.allowedTenants.filter((tenant) => tenant !== "PENDING-FIRST-LOGIN" && !config.originalOrigins?.[tenant]) : [];
    add("schedule-report-origin", originless.length === 0,
      !schedules ? "未启用定时任务，不需要租户内容域名"
        : originless.length ? `已启用定时任务，但租户 ${originless.join("、")} 没有配置飞书内容域名：每次运行都会在最后以「报告未保存」失败`
          : "每个租户都配置了飞书内容域名，报告归档能构造云盘链接",
      originless.length ? `在 FEISHU_WIKI_ORIGINAL_ORIGINS 里为每个租户写上内容域名，整段 JSON 用单引号括起来，例如 FEISHU_WIKI_ORIGINAL_ORIGINS='{"${originless[0]}":"https://你的租户.feishu.cn"}'` : null);
    const uploads = reportWrite || env.IDOU_MEDIA_ENABLED === "1" || schedules;
    add("drive-budget", Boolean(env.IDOU_DRIVE_CONFIG_FILE) || !uploads, env.IDOU_DRIVE_CONFIG_FILE
      ? `云盘上传配额已配置：${env.IDOU_DRIVE_CONFIG_FILE}`
      : uploads ? "已启用云盘上传、图片视频或定时任务，但没有配置 IDOU_DRIVE_CONFIG_FILE：所有上传到云盘（包括定时报告）都会被拒绝。配置方法见 docs/drive-budget.md"
        : "未配置云盘上传配额；不上传文件到云盘就不需要",
      uploads && !env.IDOU_DRIVE_CONFIG_FILE ? "配置 IDOU_DRIVE_CONFIG_FILE，为每个租户指定受管文件夹和字节上限" : null);
    const free = await checkPort(config.port);
    add("listen-port", free, free ? `127.0.0.1:${config.port} 可用` : `127.0.0.1:${config.port} 已被占用`,
      free ? null : `释放端口 ${config.port}，或在部署配置中改用其他 IDOU_PORT 并同步 IDOU_PUBLIC_URL`);
  }

  // The key files belong to other projects (the digital-human config, the
  // LiteLLM proxy's .env), so their permissions are the operator's call; say so
  // rather than refusing to start.
  const loose = async filename => {
    if (!filename || process.platform === "win32") return "";
    try { return (await stat(filename)).mode & 0o077 ? "；注意该文件对其他用户可读，建议 chmod 600" : ""; } catch { return ""; }
  };
  // Where the MiniMax key came from, in the words this report used before the
  // chat model became a choice. Only a file actually read is checked: with an
  // inline key the file is neither named nor used, and a warning about "该文件"
  // pointed at nothing (review, 2026-09-11).
  const minimaxSource = async () => env.MINIMAX_API_KEY?.trim() ? "已从环境读取（不显示内容）"
    : `已从 ${env.MINIMAX_CONFIG_FILE} 读取（不复制、不显示）${await loose(env.MINIMAX_CONFIG_FILE)}`;
  // Loaded exactly as the server will load it, so a setting that would stop the
  // server stops here first, named. A key is only ever reported as loaded.
  const provider = env.IDOU_MODEL_PROVIDER || "minimax";
  let chat = null;
  try { chat = await loadChatModelConfig(env); }
  catch (error) {
    add("model-key", false, error.message, provider === "minimax" ? `${error.message}。填入现有数字人项目那个 region 为 "cn" 的配置文件绝对路径`
      : provider === "litellm" ? `${error.message}。LiteLLM 的密钥只交给控制面：IDOU_LITELLM_KEY_FILE 指向 LiteLLM 那份 .env（读其中的 LITELLM_MASTER_KEY），或直接写 IDOU_LITELLM_API_KEY`
        : error.message);
  }
  if (chat?.provider === "minimax") {
    const ignored = Object.keys(env).some(key => key.startsWith("IDOU_LITELLM_")) ? "；IDOU_LITELLM_* 已填写，但 IDOU_MODEL_PROVIDER 不是 litellm，这些设置不生效" : "";
    add("model-key", true, await minimaxSource() + ignored);
  }
  if (chat?.provider === "litellm") {
    const inline = Boolean(env.IDOU_LITELLM_API_KEY?.trim());
    add("model-key", true, `对话模型 ${chat.model}，经本机 LiteLLM 的模型组 ${chat.upstreamModel}；密钥${inline
      ? `已从环境读取（不显示内容）${env.IDOU_LITELLM_KEY_FILE ? "，IDOU_LITELLM_KEY_FILE 未使用" : ""}`
      : `已从 ${env.IDOU_LITELLM_KEY_FILE} 读取（不复制、不显示）${await loose(env.IDOU_LITELLM_KEY_FILE)}`}`);
    // Informational: the control plane starts either way, and chat works once
    // the proxy is up.
    add("litellm", true, await liteLlm(chat.upstreamOrigin) ? `${chat.upstreamOrigin} 有响应`
      : `${chat.upstreamOrigin} 暂时没有响应：控制面照常启动，但对话要等 LiteLLM 起来才能用`);
    // Media never followed the chat model. Without a MiniMax key the server
    // still starts and answers media requests with "not configured"; with one,
    // it has to load, because the server will load it.
    if (env.IDOU_MEDIA_ENABLED === "1") {
      // With a Qwen key video is not MiniMax's to make, so only images are said to be.
      const onMiniMax = env.QWEN_TOKEN_PLAN_KEY_FILE ? "图片" : "图片与视频";
      if (!env.MINIMAX_API_KEY?.trim() && !env.MINIMAX_CONFIG_FILE) {
        add("media-key", true, `${onMiniMax}已启用，但没有配置 MiniMax 密钥：控制面照常启动，生成${onMiniMax === "图片" ? "图片" : "图片或视频"}会提示不可用。需要时填 MINIMAX_CONFIG_FILE 或 MINIMAX_API_KEY`);
      } else {
        try {
          await loadServerModelKey(env);
          add("media-key", true, `${onMiniMax}仍走 MiniMax，密钥${await minimaxSource()}`);
        } catch (error) {
          add("media-key", false, error.message, `${error.message}。${onMiniMax}仍走 MiniMax；不需要就删掉 MINIMAX_* 或 IDOU_MEDIA_ENABLED`);
        }
      }
    }
  }

  // Video's own key, loaded exactly as the server will load it: a broken file
  // stops the server, so it is named here first. Without media on it is unused.
  if (env.QWEN_TOKEN_PLAN_KEY_FILE) {
    if (env.IDOU_MEDIA_ENABLED !== "1") add("video-key", true, "QWEN_TOKEN_PLAN_KEY_FILE 已填写，但没有开 IDOU_MEDIA_ENABLED，这项设置不生效");
    else {
      try {
        await loadVideoKey(env);
        add("video-key", true, `视频走阿里云百炼 HappyHorse（Qwen Token Plan），密钥已从 ${env.QWEN_TOKEN_PLAN_KEY_FILE} 读取（不复制、不显示）`);
      } catch (error) {
        add("video-key", false, error.message, `${error.message}。不需要就删掉 QWEN_TOKEN_PLAN_KEY_FILE，视频会回到 MiniMax`);
      }
    }
  }

  // The packaged runtimes matter as much as the credentials: a task cannot run
  // without Codex, and no Feishu call can be made without the pinned CLI.
  for (const check of await runtime()) {
    add(check.name, check.ok, check.detail, check.ok ? null : (check.name === "codex-runtime"
      ? "安装并确保 codex 可执行，或用 IDOU_CODEX_BIN 指向它"
      : "运行 npm run bundle:feishu 重新打包内置飞书 CLI"));
  }
  return { ok: checks.every(check => check.ok), checks, required, config, local };
}

// Only the keys the server understands, so an unrelated shell variable cannot
// reach the control plane or the packaged CLI.
export function serverEnvironment(env, base = process.env) {
  const result = { PATH: base.PATH, HOME: base.HOME, TMPDIR: base.TMPDIR, LANG: base.LANG };
  for (const key of DEPLOYMENT_KEYS) if (env[key] !== undefined) result[key] = env[key];
  return result;
}

export const redactDeployment = env => Object.fromEntries(Object.entries(env).map(([key, value]) => [key, SECRET_KEYS.has(key) ? "<redacted>" : value]));
