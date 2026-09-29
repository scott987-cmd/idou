import path from "node:path";

// What a scheduled task is allowed to be, said in terms no container runtime
// owns. A job has to mean the same thing whether it is handed to Docker today,
// to gVisor by changing one runtime name, or to a microVM provider that does not
// exist here yet -- so nothing Docker-specific is allowed through this contract.
//
// Three rules come from what every production sandbox actually does, rather than
// from what is convenient here:
//
//   * The sandbox is per run and is destroyed with it. Nothing is reused, so
//     nothing carries over from one tenant's task to the next.
//   * Compute and network are two separate boundaries. The network half is only
//     worth anything if it is enforced outside the sandbox, so this contract
//     describes the policy and refuses to pretend it enforces one it cannot.
//   * Credentials stay outside. The point of running the agent in a container is
//     that stealing what it holds gains nothing, which stops being true the
//     moment a live token is passed in as an environment variable.
export const SANDBOX_LIMITS = Object.freeze({
  memoryMb: Object.freeze({ min: 128, max: 4096, fallback: 512 }),
  cpus: Object.freeze({ min: 0.25, max: 4, fallback: 1 }),
  pids: Object.freeze({ min: 16, max: 512, fallback: 128 }),
  timeoutMs: Object.freeze({ min: 10_000, max: 30 * 60_000, fallback: 10 * 60_000 }),
  envEntries: 24, envValueBytes: 4096, commandLength: 64,
});

// The one path a job may write. Fixed, so a job never names a host path and a
// provider on a different host can honour the same job.
export const WORKSPACE = "/workspace";

// `none` is the only mode a container runtime enforces by itself. `gateway` is
// the one a scheduled task actually uses: the sandbox reaches exactly one
// address and nothing else, and that address holds the credentials, so what
// leaks if the sandbox is compromised is the ability to ask -- not the identity
// to ask with. `open` is full egress and says so in its name: a deliberate
// choice, never a default and never where an unrecognised value lands.
//
// A general hostname allowlist is still not offered. Every vendor that
// documents one also documents how to get around it -- domain fronting, DNS
// tunnelling, plain HTTP, raw IPs -- so naming a mode we cannot actually
// enforce would be worse than not having it.
const NETWORK_MODES = new Set(["none", "gateway", "open"]);
// Where the gateway is reachable from inside the sandbox. Loopback is refused
// outright: inside a container it means the container itself.
const GATEWAY = /^https?:\/\/[a-z0-9][a-z0-9.-]{0,253}(?::\d{1,5})?$/i;
const LOOPBACK = /^https?:\/\/(localhost|127\.|\[?::1)/i;

// A name this product carries a secret in, or one that simply reads like a
// secret. Refused rather than documented, because an instruction not to pass
// credentials is not a control.
const SECRET_NAME = /(^|_)(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|COOKIE)S?(_|$)/i;
// The desktop's Feishu bridge under either name the product has had (env-names.js).
const SECRET_PREFIX = [/^LARKSUITE_CLI_/i, /^IDOU_FEISHU_BRIDGE/i, /^MYDOUBAO_FEISHU_BRIDGE/i, /^AWS_/i, /^OPENAI_/i];
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
// [registry[:port]/]repository[:tag][@digest] -- no whitespace, no shell
// metacharacter, and never a leading dash, so a provider that builds a command
// line cannot read an image name as another argument. The registry's own port is
// what the first attempt here got wrong: it read `:5000` as the tag and then
// refused the path that followed, which would have rejected every private
// registry this is likely to be deployed against.
export const IMAGE = /^(?:[a-zA-Z0-9][a-zA-Z0-9.-]*(?::\d{1,5})?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;

const bounded = (value, bound, name) => {
  const number = value === undefined || value === null ? bound.fallback : Number(value);
  if (!Number.isFinite(number) || number < bound.min || number > bound.max) throw new Error(`${name} 超出允许范围（${bound.min}-${bound.max}）`);
  return number;
};

function sandboxEnvironment(env) {
  const entries = Object.entries(env ?? {});
  if (entries.length > SANDBOX_LIMITS.envEntries) throw new Error(`沙箱环境变量最多 ${SANDBOX_LIMITS.envEntries} 个`);
  for (const [name, value] of entries) {
    if (!ENV_NAME.test(name)) throw new Error(`沙箱环境变量名不合法：${name}`);
    if (SECRET_NAME.test(name) || SECRET_PREFIX.some((pattern) => pattern.test(name))) throw new Error(`凭据不能进入沙箱：${name}`);
    if (typeof value !== "string" || value.length > SANDBOX_LIMITS.envValueBytes) throw new Error(`沙箱环境变量 ${name} 的值不合法`);
    if (/[\0\n\r]/.test(value)) throw new Error(`沙箱环境变量 ${name} 的值含有控制字符`);
  }
  return Object.freeze(Object.fromEntries(entries));
}

export function sandboxJob(input) {
  const image = String(input?.image ?? "");
  if (image.length > 255 || !IMAGE.test(image)) throw new Error("沙箱镜像名称不合法");
  const command = Array.isArray(input?.command) ? input.command.map((part) => String(part)) : [];
  if (command.length === 0 || command.length > SANDBOX_LIMITS.commandLength) throw new Error("沙箱需要一条要执行的命令");
  if (command.some((part) => part.length === 0 || /[\0]/.test(part))) throw new Error("沙箱命令参数不合法");
  const workspace = String(input?.workspace ?? "");
  // resolve(), not normalize(): normalize keeps a trailing slash, so two jobs
  // naming the same directory would compare as two different ones. The root
  // itself is refused outright -- a job's workspace is the one thing it may
  // write, and that must never be the whole filesystem.
  if (!path.isAbsolute(workspace) || workspace !== path.resolve(workspace) || workspace === path.parse(workspace).root) throw new Error("沙箱工作目录必须是规范的绝对路径，且不能是根目录");

  const mode = input?.network?.mode ?? "none";
  if (!NETWORK_MODES.has(mode)) throw new Error("沙箱网络策略只能是 none、gateway 或 open");
  const gateway = mode === "gateway" ? String(input?.network?.gateway ?? "") : null;
  if (mode === "gateway" && (!GATEWAY.test(gateway) || LOOPBACK.test(gateway))) throw new Error("gateway 模式需要一个沙箱可达的网关地址（不能是回环地址）");

  return Object.freeze({
    image, command: Object.freeze(command), workspace,
    env: sandboxEnvironment(input?.env),
    network: Object.freeze(gateway === null ? { mode } : { mode, gateway }),
    limits: Object.freeze({
      memoryMb: bounded(input?.limits?.memoryMb, SANDBOX_LIMITS.memoryMb, "内存上限"),
      cpus: bounded(input?.limits?.cpus, SANDBOX_LIMITS.cpus, "CPU 上限"),
      pids: Math.trunc(bounded(input?.limits?.pids, SANDBOX_LIMITS.pids, "进程数上限")),
      timeoutMs: Math.trunc(bounded(input?.limits?.timeoutMs, SANDBOX_LIMITS.timeoutMs, "超时时间")),
    }),
  });
}
