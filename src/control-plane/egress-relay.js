// Scheduled runs on another machine (docs/scaling-plan.md step 3): a worker
// there runs the containers, but the egress proxy -- the one place a run may
// reach Feishu and the model through, checked against its run token -- stays
// with the coordinator. The containers are told to find it at the sandbox
// network's gateway on their own machine; this listens there and passes the
// bytes to the coordinator's remote egress listener, untouched.
//
// TCP, not HTTP: the container's TLS session ends at the coordinator's egress
// proxy, under the certificate the run was given, so what is relayed here is
// ciphertext. The relay holds no key and can read nothing it carries.
import { connect, createServer } from "node:net";

const endpoint = (value, name) => {
  if (!value || typeof value.host !== "string" || !value.host || !Number.isInteger(value.port) || value.port < 0 || value.port > 65535) throw new Error(`Invalid ${name}`);
  return value;
};

export async function startEgressRelay({ listen, upstream, log = () => {}, connectTimeoutMs = 5000 }) {
  endpoint(listen, "relay address"); endpoint(upstream, "egress upstream");
  const sockets = new Set();
  const server = createServer((inbound) => {
    sockets.add(inbound);
    const outbound = connect({ host: upstream.host, port: upstream.port });
    sockets.add(outbound);
    outbound.setTimeout(connectTimeoutMs, () => { if (outbound.connecting) outbound.destroy(new Error("upstream connect timed out")); });
    outbound.once("connect", () => outbound.setTimeout(0));
    const close = (error) => {
      if (error) log({ component: "egress-relay", event: "relay-failed", message: String(error?.message ?? error).slice(0, 200) });
      inbound.destroy(); outbound.destroy();
    };
    inbound.once("error", close); outbound.once("error", close);
    inbound.once("close", () => { sockets.delete(inbound); outbound.destroy(); });
    outbound.once("close", () => { sockets.delete(outbound); inbound.destroy(); });
    inbound.pipe(outbound); outbound.pipe(inbound);
  });
  await new Promise((resolve, reject) => {
    server.once("error", (error) => reject(error?.code === "EADDRNOTAVAIL"
      ? new Error(`出口转发无法监听 ${listen.host}:${listen.port}：这台机器上没有这个地址。IDOU_SANDBOX_GATEWAY 应是本机沙箱网络的网关 IP，网络要先建好。`)
      : error));
    server.listen(listen.port, listen.host, resolve);
  });
  return {
    server,
    address: server.address(),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

// The coordinator's side: which peers may reach its remote egress listener.
// Anybody else's connection is closed before a byte of TLS is exchanged.
export function admitPeers(server, peers, log = () => {}) {
  const allowed = new Set(peers.map((peer) => peer.replace(/^::ffff:/, "")));
  server.on("connection", (socket) => {
    const from = String(socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    if (!allowed.has(from)) {
      log({ component: "sandbox-egress", event: "remote-peer-refused", peer: from.slice(0, 64) });
      socket.destroy();
    }
  });
}
