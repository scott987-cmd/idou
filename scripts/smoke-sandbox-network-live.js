// What a sandbox container can actually reach, asked of a real container.
//
// The plan this answers says it plainly: checking the docker argv is not network
// acceptance. The argv can be perfect while the network it names lets everything
// through -- which is exactly what was found here. `mydoubao-egress` was an
// ordinary bridge, and a container on it opened a TCP connection to the public
// internet in under a second. The egress proxy the whole design rests on was a
// convention, not a boundary.
//
//   node scripts/smoke-sandbox-network-live.js
//   node scripts/smoke-sandbox-network-live.js --expect-isolated   # fails if it is not
//
// Reports by default, because on a developer machine the honest answer is "this
// is not isolated and here is what that means". With --expect-isolated it is an
// acceptance gate and exits non-zero.
//
// Nothing is sent anywhere: each probe is a TCP connect that is closed as soon
// as it answers, and the DNS one asks only whether a name resolves.
import "../src/adopt-legacy-env.js";
import { runProcess } from "../src/providers/process-runner.js";
import { sandboxImageTag } from "../src/control-plane/sandbox/sandbox-image.js";
import { egressNetworkName } from "../src/control-plane/scheduled-tasks.js";

const NETWORK = process.env.IDOU_SANDBOX_NETWORK || await egressNetworkName();
const IMAGE = process.env.IDOU_SANDBOX_IMAGE || sandboxImageTag();
const strict = process.argv.includes("--expect-isolated");
const say = (line) => process.stdout.write(`  · ${line}\n`);

const docker = (args, timeoutMs = 60_000) => runProcess("docker", args, { timeoutMs, maxOutputBytes: 1 << 20 });

// One probe, run inside a throwaway container on the network under test. The
// script is passed as an argument rather than mounted, so this needs no
// workspace and leaves nothing behind.
const REACH = (host, port) => `
const net = require("node:net");
const done = (verdict) => { console.log(verdict); process.exit(0); };
const timer = setTimeout(() => done("timeout"), 6000);
const socket = net.connect({ host: ${JSON.stringify(host)}, port: ${port} }, () => { clearTimeout(timer); socket.destroy(); done("open"); });
socket.on("error", (error) => { clearTimeout(timer); done(error.code || "error"); });`;

const RESOLVE = `
require("node:dns").promises.resolve4("feishu.cn")
  .then((addresses) => console.log("resolved " + addresses[0]))
  .catch((error) => console.log(error.code || "failed"));`;

async function probe(script) {
  const result = await docker(["run", "--rm", "--pull", "never", "--network", NETWORK, "--entrypoint", "node", IMAGE, "-e", script]);
  return `${result.stdout ?? ""}`.trim().split("\n").at(-1) || `exit ${result.code}`;
}

const looked = await docker(["network", "inspect", NETWORK, "--format", "{{.Internal}} {{.Driver}} {{range .IPAM.Config}}{{.Gateway}}{{end}}"]);
if (looked.code !== 0) {
  process.stderr.write(`找不到出口网络 ${NETWORK}：${`${looked.stderr ?? ""}`.trim().slice(0, 200)}\n`);
  process.exit(strict ? 1 : 0);
}
const [internal, driver, gateway] = `${looked.stdout ?? ""}`.trim().split(/\s+/);
say(`网络 ${NETWORK}：internal=${internal} driver=${driver} 网关=${gateway || "(无)"}`);

// The one that matters. A sandbox that can open this has no egress boundary at
// all, whatever the proxy is configured to allow.
const publicIp = await probe(REACH("1.1.1.1", 443));
say(`直连公网 1.1.1.1:443 → ${publicIp}`);
const dns = await probe(RESOLVE);
say(`解析 feishu.cn → ${dns}`);
// Through the gateway address a container reaches whatever the host is
// listening on, which is more than the proxy.
const host = gateway ? await probe(REACH(gateway, 8444)) : "(没有网关地址)";
say(`经网关 ${gateway || "?"}:8444 → ${host}`);

const isolated = internal === "true" && publicIp !== "open";
say(isolated
  ? "结论：容器出不了网，出口只能经代理。"
  : "结论：容器可以绕过出口代理直接出网——出口代理目前是约定，不是边界。");

if (!isolated && strict) {
  process.stderr.write(`\n沙箱网络未达到隔离要求：internal=${internal}，直连公网=${publicIp}。\n`
    + `生产部署需要一个 --internal 网络，且出口代理作为该网络上的独立组件接入，\n`
    + `不能经 host-gateway 由宿主机提供——那样容器可触达宿主监听的任何端口。\n`);
  process.exit(1);
}
