import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isIPv4 } from "node:net";
import { addressAllowlist } from "./address-allowlist.js";
import { adminChat, adminUsers } from "./admin-directory.js";
import path from "node:path";
import { validateServerUrl } from "./client-session.js";
import { loopbackOrigin } from "./model-gateway.js";
import { resolveFeishuProvider } from "../providers/feishu/provider-registry.js";
import { FEISHU_CLI_WRITE_ACTIONS } from "../providers/feishu/cli-write-contract.js";
import { IMAGE } from "./sandbox/job.js";
import { pinnedImage } from "./sandbox/sandbox-image.js";

// Which Feishu deployment this control plane serves. Asked on every server, with
// or without a Feishu login, because scheduled tasks and the CLI bridge name its
// origins too. Only deployments this build ships can be named.
export function loadFeishuProvider(env = process.env) {
  try { return resolveFeishuProvider(env.FEISHU_PROVIDER || undefined); }
  catch (error) { throw new Error(`FEISHU_PROVIDER 无效：${error.message}`); }
}

export function loadFeishuLoginConfig(env = process.env) {
  const feishu = loadFeishuProvider(env);
  const origin = validateServerUrl(env.IDOU_PUBLIC_URL);
  const appId = env.FEISHU_APP_ID, appSecret = env.FEISHU_APP_SECRET;
  const allowedTenants = (env.FEISHU_ALLOWED_TENANTS || "").split(",").map((part) => part.trim()).filter(Boolean);
  // Name the setting that is wrong, never its value. An operator may have
  // pasted a secret into the wrong field, so no configured value is ever echoed
  // back into an error, a log or a report.
  if (typeof appId !== "string" || !appId.trim()) throw new Error("缺少 FEISHU_APP_ID");
  if (!feishu.ids.app(appId)) throw new Error(`FEISHU_APP_ID 格式不对：${feishu.ids.appHint}`);
  if (typeof appSecret !== "string" || !appSecret.trim()) throw new Error("缺少 FEISHU_APP_SECRET");
  if (!allowedTenants.length) throw new Error("缺少 FEISHU_ALLOWED_TENANTS：填入允许登录的租户 key，多个用逗号分隔");
  if (allowedTenants.some((id) => !/^[A-Za-z0-9_-]{1,256}$/.test(id))) throw new Error("FEISHU_ALLOWED_TENANTS 含无效的租户 key：只允许字母数字下划线和连字符，多个用逗号分隔");
  const port = Number(env.IDOU_PORT || 3041);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid server port");
  if (origin.startsWith("http:") && Number(new URL(origin).port || 80) !== port) throw new Error("Loopback public URL must match the listening port");
  if (env.FEISHU_SOURCE_ACCESS_ENABLED !== undefined && env.FEISHU_SOURCE_ACCESS_ENABLED !== "1") throw new Error("FEISHU_SOURCE_ACCESS_ENABLED must be omitted or 1");
  if (env.FEISHU_SESSION_RENEWAL_ENABLED !== undefined && env.FEISHU_SESSION_RENEWAL_ENABLED !== "1") throw new Error("FEISHU_SESSION_RENEWAL_ENABLED must be omitted or 1");
  if (env.FEISHU_CLI_IDENTITY_CHECKS_ENABLED !== undefined && (env.FEISHU_CLI_IDENTITY_CHECKS_ENABLED !== "1" || env.FEISHU_SOURCE_ACCESS_ENABLED !== "1")) throw new Error("FEISHU_CLI_IDENTITY_CHECKS_ENABLED requires value 1 and source access");
  if (env.FEISHU_CLI_BRIDGE_ENABLED !== undefined && (env.FEISHU_CLI_BRIDGE_ENABLED !== "1" || env.FEISHU_SOURCE_ACCESS_ENABLED !== "1")) throw new Error("FEISHU_CLI_BRIDGE_ENABLED requires value 1 and source access");
  const cliProxyScopes = (env.FEISHU_CLI_SCOPES || "").split(",").map(value => value.trim()).filter(Boolean);
  if ((env.FEISHU_CLI_BRIDGE_ENABLED === "1") !== (cliProxyScopes.length > 0) || cliProxyScopes.length > 64 || cliProxyScopes.some(scope => !/^[a-z][a-z0-9_.:-]{2,127}$/.test(scope)) || new Set(cliProxyScopes).size !== cliProxyScopes.length) throw new Error("FEISHU_CLI_BRIDGE_ENABLED requires an explicit, unique FEISHU_CLI_SCOPES allowlist");
  const cliWriteActions = (env.FEISHU_CLI_WRITE_ACTIONS || "").split(",").map(value => value.trim()).filter(Boolean);
  if (cliWriteActions.length > FEISHU_CLI_WRITE_ACTIONS.length || new Set(cliWriteActions).size !== cliWriteActions.length || cliWriteActions.some(action => !FEISHU_CLI_WRITE_ACTIONS.includes(action)) || cliWriteActions.length && env.FEISHU_CLI_BRIDGE_ENABLED !== "1") throw new Error(`FEISHU_CLI_WRITE_ACTIONS requires the CLI bridge and supports only: ${FEISHU_CLI_WRITE_ACTIONS.join(",")}`);
  let originalOrigins = {};
  if (env.FEISHU_WIKI_ORIGINAL_ORIGINS !== undefined) {
    try {
      if (env.FEISHU_SOURCE_ACCESS_ENABLED !== "1" || env.FEISHU_WIKI_ORIGINAL_ORIGINS.length > 65536) throw new Error();
      originalOrigins = feishu.references.tenantOrigins(JSON.parse(env.FEISHU_WIKI_ORIGINAL_ORIGINS));
      if (!Object.keys(originalOrigins).length || Object.keys(originalOrigins).some(tenant => !allowedTenants.includes(tenant))) throw new Error();
    } catch { throw new Error("Invalid FEISHU_WIKI_ORIGINAL_ORIGINS; explicit allowed tenants and source access are required"); }
  }
  if (env.FEISHU_WIKI_BUNDLE_READS_ENABLED !== undefined && (env.FEISHU_WIKI_BUNDLE_READS_ENABLED !== "1" || !Object.keys(originalOrigins).length)) throw new Error("FEISHU_WIKI_BUNDLE_READS_ENABLED requires value 1 and configured Wiki original origins");
  // 0 keeps the original behaviour: a login lasts as long as its Feishu access
  // token allows, and no refresh token is ever requested or stored.
  const longSessionDays = env.FEISHU_LONG_SESSION_DAYS === undefined ? 0 : Number(env.FEISHU_LONG_SESSION_DAYS);
  if (!Number.isSafeInteger(longSessionDays) || longSessionDays < 0 || longSessionDays > 30) throw new Error("FEISHU_LONG_SESSION_DAYS 只能是 0 到 30 之间的整数天");
  if (longSessionDays && env.FEISHU_SESSION_RENEWAL_ENABLED !== "1") throw new Error("FEISHU_LONG_SESSION_DAYS 需要同时启用 FEISHU_SESSION_RENEWAL_ENABLED=1");
  return { feishu, origin, appId, appSecret, allowedTenants, port, originalOrigins, longSessionDays, sessionRenewalEnabled: env.FEISHU_SESSION_RENEWAL_ENABLED === "1", sourceAccessEnabled: env.FEISHU_SOURCE_ACCESS_ENABLED === "1", bundleReadsEnabled: env.FEISHU_WIKI_BUNDLE_READS_ENABLED === "1", identityChecksEnabled: env.FEISHU_CLI_IDENTITY_CHECKS_ENABLED === "1", cliProxyScopes, cliWriteActions };
}

// Whether this machine is a developer's or one that runs other people's tasks.
//
// In production the isolation the design claims has to actually hold: an
// internal egress network, a proxy not reached through the host, and a runtime
// that is not plain namespaces. A deployment short of any of those is refused
// rather than quietly downgraded -- measured on a developer machine, the egress
// network was an ordinary bridge and a sandbox container opened a TCP
// connection straight to the public internet, so the single address the whole
// egress design rests on was enforced by nothing at all.
export function loadSandboxMode(env = process.env) {
  const mode = env.IDOU_SANDBOX_MODE ?? "development";
  if (!["development", "production"].includes(mode)) throw new Error("IDOU_SANDBOX_MODE 只能是 development 或 production");
  return mode;
}

// Which image a scheduled run happens in. Unset, the tag derived from
// upstreams.lock.json is used -- fine on a developer's machine, where the image
// was built locally a minute ago. In production it has to be a digest: a tag is a
// pointer, and whoever can move it chooses what runs with the task's token. The
// check is made here, at start, so a production server with a tag does not come
// up at all rather than coming up and refusing every run.
export function loadSandboxImage(env = process.env) {
  const image = env.IDOU_SANDBOX_IMAGE;
  if (image === undefined || image === "") {
    if (loadSandboxMode(env) === "production") throw new Error("生产模式需要 IDOU_SANDBOX_IMAGE，并按摘要固定镜像（仓库@sha256:…，经典镜像存储上用镜像 ID sha256:…）");
    return null;
  }
  if (image.length > 255 || !IMAGE.test(image)) throw new Error("IDOU_SANDBOX_IMAGE 不是合法的镜像引用");
  if (loadSandboxMode(env) === "production" && !pinnedImage(image)) throw new Error("生产模式下 IDOU_SANDBOX_IMAGE 必须按摘要固定（仓库@sha256:… 或镜像 ID sha256:…），不能只写标签");
  return image;
}

// The OCI runtime a run's container gets. Production refuses plain namespaces
// (runc) before every run; saying so here as well means a production server
// without gVisor does not come up, rather than coming up and failing each task.
export function loadSandboxRuntime(env = process.env) {
  const runtime = env.IDOU_SANDBOX_RUNTIME || "runc";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(runtime)) throw new Error("IDOU_SANDBOX_RUNTIME 不是合法的 Docker 运行时名称");
  if (loadSandboxMode(env) === "production" && runtime === "runc") throw new Error("生产模式下 IDOU_SANDBOX_RUNTIME 不能是 runc，请用 runsc（gVisor）");
  return runtime;
}

// Where the sandbox reaches the egress proxy on its own network: on a Linux host
// that runs both Docker and the control plane, the internal network's gateway
// address. The proxy then listens on that address and nowhere else. Unset, the
// container reaches the host through host-gateway and the proxy listens on every
// address -- how a colima development machine works, and what production
// refuses, because through the host gateway a container reaches every port the
// host listens on. (The gateway address reaches them too: on the server it takes
// a host firewall to answer only the egress port; see docs/server-deployment.md.)
export function loadSandboxGateway(env = process.env) {
  const address = env.IDOU_SANDBOX_GATEWAY;
  if (address === undefined || address === "") {
    if (loadSandboxMode(env) === "production") throw new Error("生产模式需要 IDOU_SANDBOX_GATEWAY：沙箱网络上出口代理的地址，即 internal 网络的网关 IP");
    return null;
  }
  if (isIPv4(address) !== true || address === "0.0.0.0" || address.startsWith("127.")) throw new Error("IDOU_SANDBOX_GATEWAY 必须是沙箱网络上的一个 IPv4 地址（不能是 0.0.0.0 或回环地址）");
  return address;
}

// Which Docker network the sandbox joins: the internal one whose gateway is
// IDOU_SANDBOX_GATEWAY, and the one the host firewall is written for. Unset,
// the host's own is found (scheduled-tasks.js egressNetworkName).
export function loadSandboxNetwork(env = process.env) {
  const value = env.IDOU_SANDBOX_NETWORK;
  if (value === undefined || value === "") return null;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value)) throw new Error("IDOU_SANDBOX_NETWORK 不是合法的 Docker 网络名");
  return value;
}

// Who a run's container runs as. The default, nobody (65534), works where the
// workspace reaches the container through a file share that ignores ownership,
// as colima's does. On a Linux host the workspace keeps its owner and 0700, so
// the container has to run as that owner -- the control plane's own user -- to
// use it at all. Never root.
export function loadSandboxUser(env = process.env) {
  const value = env.IDOU_SANDBOX_USER;
  if (value === undefined || value === "") return null;
  const match = /^(\d{1,10}):(\d{1,10})$/.exec(value);
  const uid = match ? Number(match[1]) : 0, gid = match ? Number(match[2]) : 0;
  if (!match || !(uid > 0 && uid < 2 ** 31) || !(gid > 0 && gid < 2 ** 31)) throw new Error("IDOU_SANDBOX_USER 必须是 uid:gid，两者都是正整数，不能是 root（0）");
  return { uid, gid };
}

// How long a run's own words are kept on the control plane. The row outlives
// this -- when it ran and whether it worked is the history -- but the text is
// the container's output, which for a task that reads someone's documents every
// morning is their documents. The desktop mirrors finished runs into the
// person's own task records, so this store is a staging area; 30 days is long
// enough that somebody away for three weeks still collects their results, and
// short enough that it is not an archive nobody agreed to keep.
export function loadRunDetailRetention(env = process.env) {
  if (env.IDOU_SCHEDULE_RUN_DETAIL_DAYS === undefined) return 30;
  const days = Number(env.IDOU_SCHEDULE_RUN_DETAIL_DAYS);
  if (!Number.isSafeInteger(days) || days < 1 || days > 365) throw new Error("IDOU_SCHEDULE_RUN_DETAIL_DAYS 只能是 1 到 365 之间的整数天");
  return days;
}

// How much this one server takes on at once, and how much of that any one
// person may hold. The first group's defaults are what the server did before
// these were settings -- 8 model requests at once, 16 Feishu calls, 2 scheduled
// runs -- and a person's share defaults to the whole, so nothing changes until
// an operator sizes it: the model limit belongs to the model account's own
// quota, which this file cannot know. What did change: scheduled tasks are
// counted per person (50 each) rather than 50 for a whole tenant.
//
// The second group were numbers fixed in the code for the pilot, each the whole
// server's: a hundred signed-in sessions, four Feishu reads at once, thirty
// sign-ins a minute, four renewals at once, 32 MCP connections, four media jobs.
// Found 9-26 (docs/scaling-plan.md): the hundred-and-first person could not sign
// in. Each old number is now what one person gets (limits.js), and these are
// the server's, sized for a hundred thousand people.
const CAPACITY = Object.freeze({
  IDOU_MODEL_MAX_CONCURRENT: { fallback: 8, most: 4096, what: "同时进行的模型请求（整台服务器）" },
  IDOU_MODEL_MAX_CONCURRENT_PER_USER: { fallback: null, most: 4096, what: "一个人同时进行的模型请求" },
  IDOU_MODEL_REQUESTS_PER_MINUTE: { fallback: 90, most: 100_000, what: "一个会话每分钟的模型请求" },
  IDOU_FEISHU_CLI_MAX_CONCURRENT: { fallback: 16, most: 4096, what: "同时代办的飞书调用（整台服务器）" },
  IDOU_FEISHU_CLI_MAX_CONCURRENT_PER_USER: { fallback: null, most: 4096, what: "一个人同时代办的飞书调用" },
  IDOU_SCHEDULE_MAX_CONCURRENT: { fallback: 2, most: 256, what: "同时执行的定时任务（整台服务器）" },
  IDOU_SCHEDULES_PER_USER: { fallback: 50, most: 10_000, what: "一个人最多的定时任务个数" },
  IDOU_SCHEDULES_PER_TENANT: { fallback: 100_000, most: 10_000_000, what: "一个企业最多的定时任务个数" },
  IDOU_SIGNED_IN_MAX: { fallback: 200_000, most: 10_000_000, what: "同时登录的会话（整台服务器，每个会话一份飞书访问授权和续期凭据）" },
  IDOU_FEISHU_READS_MAX_CONCURRENT: { fallback: 128, most: 4096, what: "同时进行的飞书读取与核验（整台服务器）" },
  IDOU_FEISHU_READS_PER_MINUTE: { fallback: 30_000, most: 10_000_000, what: "每分钟的飞书读取与核验（整台服务器）" },
  IDOU_RENEWALS_MAX_CONCURRENT: { fallback: 128, most: 4096, what: "同时进行的登录续期（整台服务器）" },
  IDOU_LOGINS_PER_MINUTE: { fallback: 1200, most: 1_000_000, what: "每分钟新发起的登录（整台服务器）" },
  IDOU_MCP_SESSIONS_MAX: { fallback: 1024, most: 100_000, what: "同时连着的 MCP 会话（整台服务器）" },
  IDOU_MEDIA_JOBS_MAX_CONCURRENT: { fallback: 64, most: 4096, what: "同时进行的图片、视频生成（整台服务器）" },
  // Spend, not machine: the pilot's numbers stay until an operator raises them.
  IDOU_MEDIA_PER_HOUR: { fallback: 20, most: 1_000_000, what: "每小时最多生成的图片和视频（整台服务器，花钱的上限）" },
  IDOU_SPEECH_PER_HOUR: { fallback: 400, most: 10_000_000, what: "每小时最多生成的语音（整台服务器，花钱的上限）" },
});
export function loadCapacity(env = process.env) {
  const value = {};
  for (const [name, { fallback, most, what }] of Object.entries(CAPACITY)) {
    if (env[name] === undefined || env[name] === "") { value[name] = fallback; continue; }
    const number = Number(env[name]);
    if (!Number.isSafeInteger(number) || number < 1 || number > most) throw new Error(`${name}（${what}）只能是 1 到 ${most} 之间的整数`);
    value[name] = number;
  }
  const share = (whole, part, partName, wholeName) => {
    if (part === null) return whole;
    if (part > whole) throw new Error(`${partName} 不能大于 ${wholeName}（一个人的份额超过了整台服务器）`);
    return part;
  };
  const schedulesPerUser = value.IDOU_SCHEDULES_PER_USER, schedulesPerTenant = value.IDOU_SCHEDULES_PER_TENANT;
  if (schedulesPerUser > schedulesPerTenant) throw new Error("IDOU_SCHEDULES_PER_USER 不能大于 IDOU_SCHEDULES_PER_TENANT");
  return Object.freeze({
    model: Object.freeze({ maxConcurrent: value.IDOU_MODEL_MAX_CONCURRENT,
      maxConcurrentPerUser: share(value.IDOU_MODEL_MAX_CONCURRENT, value.IDOU_MODEL_MAX_CONCURRENT_PER_USER, "IDOU_MODEL_MAX_CONCURRENT_PER_USER", "IDOU_MODEL_MAX_CONCURRENT"),
      requestsPerMinute: value.IDOU_MODEL_REQUESTS_PER_MINUTE }),
    feishuCli: Object.freeze({ maxConcurrent: value.IDOU_FEISHU_CLI_MAX_CONCURRENT,
      maxConcurrentPerUser: share(value.IDOU_FEISHU_CLI_MAX_CONCURRENT, value.IDOU_FEISHU_CLI_MAX_CONCURRENT_PER_USER, "IDOU_FEISHU_CLI_MAX_CONCURRENT_PER_USER", "IDOU_FEISHU_CLI_MAX_CONCURRENT") }),
    schedules: Object.freeze({ maxConcurrentRuns: value.IDOU_SCHEDULE_MAX_CONCURRENT, perUser: schedulesPerUser, perTenant: schedulesPerTenant }),
    sourceAccess: Object.freeze({ signedIn: value.IDOU_SIGNED_IN_MAX, reads: value.IDOU_FEISHU_READS_MAX_CONCURRENT, readsPerMinute: value.IDOU_FEISHU_READS_PER_MINUTE }),
    renewal: Object.freeze({ signedIn: value.IDOU_SIGNED_IN_MAX, renewals: value.IDOU_RENEWALS_MAX_CONCURRENT }),
    login: Object.freeze({ perMinute: value.IDOU_LOGINS_PER_MINUTE }),
    mcp: Object.freeze({ sessions: value.IDOU_MCP_SESSIONS_MAX }),
    media: Object.freeze({ running: value.IDOU_MEDIA_JOBS_MAX_CONCURRENT, perHour: value.IDOU_MEDIA_PER_HOUR, speechPerHour: value.IDOU_SPEECH_PER_HOUR }),
  });
}
export const CAPACITY_KEYS = Object.freeze(Object.keys(CAPACITY));

// Where the metrics listener answers (src/control-plane/metrics.js): a port on
// 127.0.0.1 only, never behind nginx. Unset, there is no listener.
// Where scheduled runs execute (docs/scaling-plan.md step 3): "local", this
// process's own Docker, as before; or "pool", queued in the shared database
// for the workers (`bin/server.js --role worker`). Pool needs the database.
export function loadScheduleExecution(env = process.env) {
  const value = env.IDOU_SCHEDULE_EXECUTION ?? "";
  if (value === "" || value === "local") return "local";
  if (value !== "pool") throw new Error("IDOU_SCHEDULE_EXECUTION 只能是 local 或 pool");
  if (!env.IDOU_DATABASE_URL) throw new Error("IDOU_SCHEDULE_EXECUTION=pool 需要 IDOU_DATABASE_URL：执行池的队列在共享数据库里");
  return "pool";
}
// Where the durable data lives (docs/scaling-plan.md §2.5): "files", this
// machine's SQLite databases and files, as before; or "postgres", the shared
// database, so that any machine's replica or coordinator reads the same data.
export function loadDataStore(env = process.env) {
  const value = env.IDOU_DATA_STORE ?? "";
  if (value === "" || value === "files") return "files";
  if (value !== "postgres") throw new Error("IDOU_DATA_STORE 只能是 files 或 postgres");
  if (!env.IDOU_DATABASE_URL) throw new Error("IDOU_DATA_STORE=postgres 需要 IDOU_DATABASE_URL");
  return "postgres";
}

// How long a coordinator's lease lasts unrenewed (coordinator-lease.js, §2.6):
// how soon a standby takes over from one that stopped without giving it up,
// and how long a database may be away before the holder stops itself (about
// half of it). Seconds.
export function loadCoordinatorLease(env = process.env) {
  const raw = env.IDOU_COORDINATOR_LEASE_SECONDS ?? "";
  if (raw === "") return 30_000;
  const seconds = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(seconds) || seconds < 6 || seconds > 300) throw new Error("IDOU_COORDINATOR_LEASE_SECONDS 要是 6 到 300 之间的整数秒");
  return seconds * 1000;
}

// Workers on other machines (docs/scaling-plan.md step 3, egress-relay.js).
// On the coordinator: an address those machines can reach, and which of them
// may. On a worker: where that address is.
const hostPort = (value, name) => {
  const match = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(value ?? "");
  const port = match ? Number(match[2]) : NaN;
  if (!match || port < 1 || port > 65535) throw new Error(`${name} 应写成 主机:端口，例如 10.0.0.5:8445`);
  return { host: match[1].replace(/^\[|\]$/g, ""), port };
};
export function loadEgressRemote(env = process.env) {
  if (!env.IDOU_EGRESS_REMOTE_LISTEN) {
    if (env.IDOU_EGRESS_REMOTE_PEERS) throw new Error("IDOU_EGRESS_REMOTE_PEERS 需要同时设置 IDOU_EGRESS_REMOTE_LISTEN");
    return null;
  }
  const listen = hostPort(env.IDOU_EGRESS_REMOTE_LISTEN, "IDOU_EGRESS_REMOTE_LISTEN");
  if (["0.0.0.0", "::"].includes(listen.host)) throw new Error("IDOU_EGRESS_REMOTE_LISTEN 要写内网地址，不能监听所有地址");
  const peers = String(env.IDOU_EGRESS_REMOTE_PEERS ?? "").split(",").map((peer) => peer.trim()).filter(Boolean);
  if (!peers.length || peers.some((peer) => !/^[0-9a-fA-F:.]{2,45}$/.test(peer))) throw new Error("IDOU_EGRESS_REMOTE_PEERS 要列出执行节点的 IP（逗号分隔），只有它们能连");
  return { ...listen, peers };
}
export function loadEgressUpstream(env = process.env) {
  return env.IDOU_EGRESS_UPSTREAM ? hostPort(env.IDOU_EGRESS_UPSTREAM, "IDOU_EGRESS_UPSTREAM") : null;
}

// Which worker this is, when several run on one machine: it names the worker's
// own directory under the scheduled-task data directory.
export function loadWorkerName(env = process.env) {
  const value = env.IDOU_WORKER_NAME ?? "worker";
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(value)) throw new Error("IDOU_WORKER_NAME 只能是小写字母开头、由小写字母数字和连字符组成的名字（最长 32 个字符）");
  return value;
}

// What a worker of the execution pool is never given (docs/server-deployment.md
// §11): the sealing key, every key -- or file of keys -- that the coordinator
// and the model replicas use, and the coordinator's own configuration files. A
// worker runs containers; it has no login, model, Feishu or signing authority
// to use them for, and on another machine it would only carry them there. A
// production worker holding any of them refuses to start (bin/server.js).
export const WORKER_WITHHELD = Object.freeze(["IDOU_STATE_KEY_FILE", "FEISHU_APP_SECRET", "MINIMAX_API_KEY", "MINIMAX_CONFIG_FILE",
  "IDOU_LITELLM_API_KEY", "IDOU_LITELLM_KEY_FILE", "QWEN_TOKEN_PLAN_KEY_FILE", "IDOU_SKILL_SIGNING_KEY_FILE",
  "IDOU_FEISHU_BRIDGE_KEY", "IDOU_WIKI_KEY_CONFIG_FILE", "IDOU_MCP_CONFIG_FILE", "IDOU_DRIVE_CONFIG_FILE", "IDOU_APPS_CONFIG_FILE",
  "IDOU_WIKI_CONFIG_FILE"]);
export const withheldFromWorker = (env = process.env) => WORKER_WITHHELD.filter((name) => env[name]);

export function loadMetricsPort(env = process.env) {
  if (env.IDOU_METRICS_PORT === undefined || env.IDOU_METRICS_PORT === "") return null;
  const port = Number(env.IDOU_METRICS_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("IDOU_METRICS_PORT 只能是 1 到 65535 之间的端口号");
  if (env.IDOU_PORT !== undefined && Number(env.IDOU_PORT) === port) throw new Error("IDOU_METRICS_PORT 不能和 IDOU_PORT 相同");
  return port;
}

export function loadSchedulePromptRetention(env = process.env) {
  if (env.IDOU_SCHEDULE_PROMPT_DAYS === undefined) return 30;
  const days = Number(env.IDOU_SCHEDULE_PROMPT_DAYS);
  if (!Number.isSafeInteger(days) || days < 1 || days > 365) throw new Error("IDOU_SCHEDULE_PROMPT_DAYS 只能是 1 到 365 之间的整数天");
  return days;
}

// Whether a finished scheduled task may be announced by the application's own
// bot. Off unless asked for, and separate from every other setting here, because
// it is a different authority: the bot holds the application's credential and
// reaches Feishu directly, past the grant and contract checks every other write
// goes through. Without it the result is still delivered -- as the owner, to the
// owner -- which arrives in the chat nobody looks at. That is the trade, and it
// belongs to the operator rather than to a default.
export function loadScheduleNotifyConfig(env = process.env) {
  if (env.IDOU_SCHEDULE_BOT_NOTIFY === undefined) return { bot: false };
  if (env.IDOU_SCHEDULE_BOT_NOTIFY !== "1") throw new Error("IDOU_SCHEDULE_BOT_NOTIFY must be omitted or 1");
  if (env.IDOU_SCHEDULED_TASKS !== "1") throw new Error("IDOU_SCHEDULE_BOT_NOTIFY 需要同时启用 IDOU_SCHEDULED_TASKS=1");
  return { bot: true };
}

// Whether scheduled tasks may run while nobody is signed in. Off unless asked
// for, and every prerequisite is named rather than silently required: without
// one of them the feature is not merely degraded, it cannot obtain a credential
// at all, and it would fail at the moment a person tried to grant it.
export function loadUnattendedScheduleConfig(env = process.env) {
  if (env.IDOU_SCHEDULE_UNATTENDED === undefined) return { enabled: false, windowDays: 0 };
  if (env.IDOU_SCHEDULE_UNATTENDED !== "1") throw new Error("IDOU_SCHEDULE_UNATTENDED must be omitted or 1");
  if (env.IDOU_SCHEDULED_TASKS !== "1") throw new Error("IDOU_SCHEDULE_UNATTENDED 需要同时启用 IDOU_SCHEDULED_TASKS=1");
  if (env.FEISHU_SESSION_RENEWAL_ENABLED !== "1") throw new Error("IDOU_SCHEDULE_UNATTENDED 需要同时启用 FEISHU_SESSION_RENEWAL_ENABLED=1");
  // Without source access the authorization page requests no content scopes, so
  // an unattended run would hold an identity that can reach nothing -- and the
  // feature exists to do work in Feishu.
  if (env.FEISHU_SOURCE_ACCESS_ENABLED !== "1") throw new Error("IDOU_SCHEDULE_UNATTENDED 需要同时启用 FEISHU_SOURCE_ACCESS_ENABLED=1");
  const windowDays = Number(env.FEISHU_LONG_SESSION_DAYS);
  if (!Number.isSafeInteger(windowDays) || windowDays < 1 || windowDays > 30) throw new Error("IDOU_SCHEDULE_UNATTENDED 需要 FEISHU_LONG_SESSION_DAYS 设为 1 到 30 之间的天数");
  return { enabled: true, windowDays };
}

// Published sites, and the listener other people reach to open them.
//
// Off unless an operator turns it on, because turning it on opens a port that
// is not loopback -- the rest of this control plane is reachable only from this
// machine, and widening that is a decision, not a default. The address it binds
// and the address people are given are named separately: a deployment usually
// binds a private interface and is reached through the company's own proxy, and
// the link written into a confirmation card has to be the one that works.
export function loadSitesConfig(env = process.env) {
  if (env.IDOU_SITES === undefined) return null;
  if (env.IDOU_SITES !== "1") throw new Error("IDOU_SITES must be omitted or 1");
  const origin = String(env.IDOU_SITES_URL ?? "").trim();
  let parsed;
  try { parsed = new URL(origin); } catch { throw new Error("IDOU_SITES 需要 IDOU_SITES_URL：别人打开网站时用的完整地址"); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("IDOU_SITES_URL 只能是协议加主机名，例如 https://sites.example.com");
  }
  const port = Number(env.IDOU_SITES_PORT ?? 3042);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("IDOU_SITES_PORT 无效");
  const bind = String(env.IDOU_SITES_BIND ?? "127.0.0.1").trim();
  if (!/^[A-Za-z0-9.:_-]{1,64}$/.test(bind)) throw new Error("IDOU_SITES_BIND 无效");
  const directory = String(env.IDOU_SITES_DIR ?? "").trim();
  if (directory && !directory.startsWith("/")) throw new Error("IDOU_SITES_DIR 需要绝对路径");
  // Anonymous links are a tenant policy, not a per-site choice: in a private
  // deployment somebody has to decide that a link with no sign-in may exist.
  if (env.IDOU_SITES_ANONYMOUS !== undefined && env.IDOU_SITES_ANONYMOUS !== "1") throw new Error("IDOU_SITES_ANONYMOUS must be omitted or 1");
  const anonymousAllowed = env.IDOU_SITES_ANONYMOUS === "1";
  // Which addresses may connect at all. Parsed here, at startup, so one typo
  // stops the server rather than quietly turning into "everyone" -- a list that
  // fails open is worse than no list, because somebody believes it.
  let allow = null;
  try { allow = addressAllowlist(env.IDOU_SITES_ALLOW); }
  catch (error) { throw new Error(`IDOU_SITES_ALLOW ${error.message}`); }
  if (anonymousAllowed && parsed.protocol !== "https:") throw new Error("允许未登录访问时，IDOU_SITES_URL 必须是 https");
  // Who administers this deployment. Both sources are optional: with neither,
  // there is no console, which is said at startup rather than discovered as a
  // 404. See admin-directory.js for why a group and not a department.
  let admins;
  try { admins = { users: adminUsers(env.IDOU_ADMIN_USERS), chatId: adminChat(env.IDOU_ADMIN_CHAT) }; }
  catch (error) { throw new Error(`管理员配置无效：${error.message}`); }
  // Where the console is: an origin of its own, never the sites' -- a published
  // page is script, and from the console's origin it could read the console
  // (site-server.js). Unset, there is no console, which is said at startup.
  let console = null;
  if (env.IDOU_ADMIN_URL !== undefined && env.IDOU_ADMIN_URL !== "") {
    let at;
    try { at = new URL(String(env.IDOU_ADMIN_URL).trim()); } catch { throw new Error("IDOU_ADMIN_URL 不是合法的地址"); }
    if (!["http:", "https:"].includes(at.protocol) || at.pathname !== "/" || at.search || at.hash) throw new Error("IDOU_ADMIN_URL 只能是协议加主机名（可带端口），例如 https://admin.example.com");
    if (at.origin === parsed.origin) throw new Error("IDOU_ADMIN_URL 不能和 IDOU_SITES_URL 同源：发布的网页会读到管理台。换一个主机名或端口");
    const adminPort = Number(env.IDOU_ADMIN_PORT ?? 3045);
    if (!Number.isSafeInteger(adminPort) || adminPort < 1 || adminPort > 65535 || adminPort === port) throw new Error("IDOU_ADMIN_PORT 无效，或和 IDOU_SITES_PORT 相同");
    console = { origin: at.origin, port: adminPort };
  }
  return { origin: parsed.origin, port, bind, directory, anonymousAllowed, allow, admins, console };
}

// Called only by server entry points. The source file is never copied, logged,
// placed in a session record, or passed into the Codex/client environment.
export async function loadServerModelKey(env = process.env) {
  if (typeof env.MINIMAX_API_KEY === "string" && env.MINIMAX_API_KEY.trim()) return env.MINIMAX_API_KEY.trim();
  if (!env.MINIMAX_CONFIG_FILE) throw new Error("缺少 MINIMAX_CONFIG_FILE：填入现有 MiniMax 配置文件的绝对路径");
  if (!path.isAbsolute(env.MINIMAX_CONFIG_FILE)) throw new Error("MINIMAX_CONFIG_FILE 必须是绝对路径");
  let handle;
  // Each failure names its own cause. The key itself is never read into a
  // message, only checked for presence.
  try { handle = await open(env.MINIMAX_CONFIG_FILE, "r"); }
  catch (error) { throw new Error(`打不开 MINIMAX_CONFIG_FILE：${error.code === "ENOENT" ? "文件不存在" : error.code === "EACCES" ? "没有读取权限" : error.code}`); }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("MINIMAX_CONFIG_FILE 指向的不是普通文件");
    if (stat.size > 65536) throw new Error("MINIMAX_CONFIG_FILE 超过 64KB，看起来不是配置文件");
    const raw = await handle.readFile("utf8");
    // Two accepted shapes, so an existing project's configuration can be pointed
    // at directly instead of copying its key into a second file: this
    // application's JSON form, or a KEY=VALUE environment file that already
    // holds MINIMAX_API_KEY. Nothing is copied, rewritten or printed either way.
    let config = null;
    try { config = JSON.parse(raw); } catch { /* fall through to the env-file shape */ }
    if (config && typeof config === "object" && !Array.isArray(config)) {
      if (config.region !== "cn") throw new Error("MINIMAX_CONFIG_FILE 的 region 必须是 \"cn\"（domestic 国内区）");
      if (typeof config.api_key !== "string" || !config.api_key.trim()) throw new Error("MINIMAX_CONFIG_FILE 里没有非空的 api_key");
      return config.api_key.trim();
    }
    const values = new Map();
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator > 0) values.set(trimmed.slice(0, separator).trim(), trimmed.slice(separator + 1).trim().replace(/^["'](.*)["']$/, "$1"));
    }
    const key = values.get("MINIMAX_API_KEY");
    if (typeof key !== "string" || !key.trim()) throw new Error("MINIMAX_CONFIG_FILE 既不是含 api_key 的 JSON，也不是含 MINIMAX_API_KEY 的环境文件");
    // If that project pins a base URL, it must still be a domestic endpoint.
    const base = values.get("MINIMAX_BASE_URL");
    if (base && !["https://api.minimaxi.com", "https://api.minimax.cn"].includes(base.replace(/\/$/, ""))) {
      throw new Error("MINIMAX_CONFIG_FILE 里的 MINIMAX_BASE_URL 不是国内区端点");
    }
    return key.trim();
  } finally { await handle.close(); }
}

// The chat model the gateway enforces, and everything it needs to reach it.
// Unset keeps MiniMax exactly as it always ran. "litellm" sends chat to GLM
// through a LiteLLM proxy on this machine; the proxy key is read here, on the
// server, and like the MiniMax key never reaches a client, a log or a report.
// Images stay on MiniMax and keep loadServerModelKey; video goes to Qwen when a
// Token Plan key file is configured (loadVideoKey).
async function chatModelFor(provider, env) {
  if (provider === "minimax") {
    return { provider, model: "MiniMax-M3", upstreamOrigin: "https://api.minimaxi.com", upstreamModel: "MiniMax-M3",
      apiKey: await loadServerModelKey(env), maxOutputTokens: 16384, timeoutMs: 180_000 };
  }
  if (provider !== "litellm") throw new Error("IDOU_MODEL_PROVIDER(S) 只能是 minimax（默认）或 litellm");
  const upstreamOrigin = loopbackOrigin(env.IDOU_LITELLM_BASE_URL || "http://127.0.0.1:4000");
  if (!upstreamOrigin) throw new Error("IDOU_LITELLM_BASE_URL 必须是本机回环地址，形如 http://127.0.0.1:4000：只能用 http、主机只能是 127.0.0.1 或 [::1]（不接受 localhost 等名字）、必须写明端口、不带路径、查询或账号");
  const upstreamModel = env.IDOU_LITELLM_MODEL || "volc-coding";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(upstreamModel)) throw new Error("IDOU_LITELLM_MODEL 格式不对：应是 LiteLLM 里的模型组名，字母或数字开头，只含字母数字和 . _ : -，最长 64 个字符");
  return { provider, model: "GLM-5.3", upstreamOrigin, upstreamModel, apiKey: await loadLiteLlmKey(env), maxOutputTokens: 32768, timeoutMs: 600_000 };
}

// The set of chat models this server offers. `IDOU_MODEL_PROVIDERS` is a
// comma-separated list (e.g. "minimax,litellm") when a deployment wants the
// client to be able to pick; unset, it falls back to the single
// `IDOU_MODEL_PROVIDER` (default "minimax"), so a one-model deployment is
// unchanged. The first entry is the default until the client chooses another;
// each entry keeps its own upstream and key, none of which reaches a client.
export async function loadChatModelConfigs(env = process.env) {
  const raw = (env.IDOU_MODEL_PROVIDERS || env.IDOU_MODEL_PROVIDER || "minimax").split(",").map((value) => value.trim()).filter(Boolean);
  const providers = [...new Set(raw)];
  if (!providers.length) throw new Error("至少要配置一个模型 provider");
  const models = [];
  for (const provider of providers) models.push(await chatModelFor(provider, env));
  return { models, default: models[0] };
}

// Back-compat single-model view: the default model of the configured set.
export async function loadChatModelConfig(env = process.env) {
  return (await loadChatModelConfigs(env)).default;
}

// Images stay on MiniMax whichever chat model runs, and so does video unless a
// Token Plan key sends it to Qwen (loadVideoKey). On the MiniMax
// route the chat key is the media key, as it always was. On LiteLLM a
// configured MiniMax key is still loaded, so a broken one stops startup naming
// its setting; an absent one leaves media on but unconfigured, which the server
// answers with 503 rather than a 404 that reads as "media is off". Never the
// LiteLLM key: it is not a MiniMax key and must not leave for MiniMax.
export async function loadMediaKey(chat, env = process.env) {
  if (env.IDOU_MEDIA_ENABLED && env.IDOU_MEDIA_ENABLED !== "1") throw new Error("IDOU_MEDIA_ENABLED must be omitted or 1");
  if (env.IDOU_MEDIA_ENABLED !== "1") return { enabled: false, mediaKey: null };
  if (chat.provider === "minimax") return { enabled: true, mediaKey: chat.apiKey };
  return { enabled: true, mediaKey: env.MINIMAX_API_KEY?.trim() || env.MINIMAX_CONFIG_FILE ? await loadServerModelKey(env) : null };
}

// Video's own key: a Qwen Token Plan key (sk-sp-…) for Alibaba Cloud Model
// Studio. Set, videos are made there with HappyHorse; unset, video stays on
// MiniMax with images. Only ever a file: it is a subscription key, so it stays
// out of the deployment file, the process environment and every log, and a
// file anyone on the machine can read is refused rather than warned about.
export async function loadVideoKey(env = process.env) {
  const filename = env.QWEN_TOKEN_PLAN_KEY_FILE;
  if (filename === undefined || filename === "") return null;
  if (!path.isAbsolute(filename)) throw new Error("QWEN_TOKEN_PLAN_KEY_FILE 必须是绝对路径");
  let handle;
  try { handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
  catch (error) { throw new Error(`打不开 QWEN_TOKEN_PLAN_KEY_FILE：${error.code === "ENOENT" ? "文件不存在" : error.code === "EACCES" ? "没有读取权限" : error.code === "ELOOP" ? "它是符号链接，请直接指向真实文件" : error.code ?? "原因未知"}`); }
  let raw;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("QWEN_TOKEN_PLAN_KEY_FILE 指向的不是普通文件");
    if (process.platform !== "win32" && (stat.mode & 0o007)) throw new Error("QWEN_TOKEN_PLAN_KEY_FILE 对其他用户可读写，请改成 600（或 640，属组是运行控制面的用户组）");
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096) throw new Error("QWEN_TOKEN_PLAN_KEY_FILE 超过 4KB，看起来不是密钥文件");
    raw = buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
  const key = raw.trim();
  if (!/^sk-sp-[\x21-\x7e]{8,4000}$/.test(key)) throw new Error("QWEN_TOKEN_PLAN_KEY_FILE 里不是一行 Token Plan 密钥（应以 sk-sp- 开头，不含空白）");
  return key;
}

// It becomes an HTTP header value, and a stray newline or space in it would
// otherwise surface as a header error that quotes the value back.
const headerSafe = key => /^[\x21-\x7e]{1,4096}$/.test(key);

async function loadLiteLlmKey(env) {
  if (typeof env.IDOU_LITELLM_API_KEY === "string" && env.IDOU_LITELLM_API_KEY.trim()) {
    if (!headerSafe(env.IDOU_LITELLM_API_KEY.trim())) throw new Error("IDOU_LITELLM_API_KEY 含空白或不可见字符，不像一个密钥");
    return env.IDOU_LITELLM_API_KEY.trim();
  }
  const filename = env.IDOU_LITELLM_KEY_FILE;
  if (!filename) throw new Error("缺少 IDOU_LITELLM_KEY_FILE：填入存放 LiteLLM 密钥的文件的绝对路径（或直接用 IDOU_LITELLM_API_KEY）");
  if (!path.isAbsolute(filename)) throw new Error("IDOU_LITELLM_KEY_FILE 必须是绝对路径");
  let handle;
  // No symlink, so the file checked is the file read; non-blocking, so a FIFO
  // put in its place is refused instead of stalling startup.
  try { handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
  catch (error) { throw new Error(`打不开 IDOU_LITELLM_KEY_FILE：${error.code === "ENOENT" ? "文件不存在" : error.code === "EACCES" ? "没有读取权限" : error.code === "ELOOP" ? "它是符号链接，请直接指向真实文件" : error.code ?? "原因未知"}`); }
  let raw;
  try {
    if (!(await handle.stat()).isFile()) throw new Error("IDOU_LITELLM_KEY_FILE 指向的不是普通文件");
    // Read at most one byte past the limit, so a file that grows after the
    // check is still refused rather than read whole.
    const buffer = Buffer.alloc(65537);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 65536) throw new Error("IDOU_LITELLM_KEY_FILE 超过 64KB，看起来不是密钥文件");
    raw = buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
  // Two accepted shapes: a file holding just the key, or the proxy's own
  // environment file pointed at directly, so the key is never copied into a
  // second place. A line that starts NAME= is an assignment, never a key.
  const assignment = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
  const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
  let key;
  if (lines.length === 1 && !assignment.test(lines[0])) key = lines[0];
  else {
    const values = new Map();
    for (const line of lines) {
      const match = assignment.exec(line);
      if (match) values.set(match[1], match[2].trim().replace(/^(["'])(.*)\1$/, "$2").trim());
    }
    // A key made for this application wins over the proxy's master key.
    key = values.get("IDOU_LITELLM_API_KEY") || values.get("LITELLM_MASTER_KEY");
    if (!key) throw new Error("IDOU_LITELLM_KEY_FILE 既不是只有一行密钥的文件，也不是含 LITELLM_MASTER_KEY 或 IDOU_LITELLM_API_KEY 的环境文件");
  }
  if (!headerSafe(key)) throw new Error("IDOU_LITELLM_KEY_FILE 里的密钥含空白或不可见字符，不像一个密钥");
  return key;
}
