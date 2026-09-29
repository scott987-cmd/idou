// Scheduled runs on another machine reach the coordinator's egress proxy
// through a relay on that machine (src/control-plane/egress-relay.js), and the
// coordinator lets only the listed machines in.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer as createHttps, request } from "node:https";
import { X509Certificate } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createNet } from "node:net";
import os from "node:os";
import path from "node:path";
import { admitPeers, startEgressRelay } from "../src/control-plane/egress-relay.js";
import { EGRESS_HOSTNAME, ensureEgressCertificate } from "../src/control-plane/egress-tls.js";
import { loadEgressRemote, loadEgressUpstream } from "../src/control-plane/server-config.js";
import { startScheduledTasks } from "../src/control-plane/scheduled-tasks.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";

async function certificate(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-egress-cert-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return ensureEgressCertificate({ directory: path.join(directory, "tls") });
}
const freePort = async () => {
  const probe = createNet(); await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address(); await new Promise((resolve) => probe.close(resolve)); return port;
};
// A request as a container makes it: to the egress by name, trusting the CA it was given.
function ask(port, ca, route = "/probe") {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, servername: EGRESS_HOSTNAME, path: route, ca, method: "GET", agent: false }, (res) => {
      const peer = res.socket.getPeerCertificate().fingerprint256, chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString(), peer }));
    });
    req.on("error", reject); req.end();
  });
}

test("the relay carries the container's TLS to the coordinator unopened", { timeout: 60_000 }, async (t) => {
  const tls = await certificate(t);
  const upstream = createHttps({ key: tls.key, cert: tls.cert }, (req, res) => { res.end(`egress saw ${req.url}`); });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  t.after(() => { upstream.close(); upstream.closeAllConnections(); });
  const relay = await startEgressRelay({ listen: { host: "127.0.0.1", port: 0 }, upstream: { host: "127.0.0.1", port: upstream.address().port } });
  t.after(() => relay.close());
  const answer = await ask(relay.address.port, tls.ca);
  assert.equal(answer.body, "egress saw /probe");
  assert.equal(answer.peer, new X509Certificate(tls.cert).fingerprint256, "the certificate is the coordinator's: the relay holds no key");
});

test("a relay whose coordinator is away fails that request and carries on", { timeout: 60_000 }, async (t) => {
  const tls = await certificate(t), port = await freePort();
  const relay = await startEgressRelay({ listen: { host: "127.0.0.1", port: 0 }, upstream: { host: "127.0.0.1", port } });
  t.after(() => relay.close());
  await assert.rejects(ask(relay.address.port, tls.ca));
  const upstream = createHttps({ key: tls.key, cert: tls.cert }, (req, res) => { res.end("back"); });
  upstream.listen(port, "127.0.0.1"); await once(upstream, "listening");
  t.after(() => { upstream.close(); upstream.closeAllConnections(); });
  assert.equal((await ask(relay.address.port, tls.ca)).body, "back");
});

test("the coordinator's listener for other machines lets in the listed peers and closes on everybody else", { timeout: 60_000 }, async (t) => {
  const tls = await certificate(t);
  const open = async (peers) => {
    const server = createHttps({ key: tls.key, cert: tls.cert }, (req, res) => { res.end("egress"); });
    admitPeers(server, peers);
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    t.after(() => { server.close(); server.closeAllConnections(); });
    return server.address().port;
  };
  assert.equal((await ask(await open(["127.0.0.1"]), tls.ca)).body, "egress");
  await assert.rejects(ask(await open(["10.9.9.9"]), tls.ca), "no handshake for a stranger");
});

test("scheduled tasks open that listener with the egress proxy itself behind it", { timeout: 60_000 }, async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "idou-remote-egress-"));
  const sessions = { prune() {}, verify: () => null, issueForSandboxRun: () => null };
  const tasks = await startScheduledTasks({ feishu: SAAS_FEISHU, sessions, sourceAccess: null, dataDir, controlPlaneOrigin: "http://127.0.0.1:1",
    docker: "false", log: () => {}, egressPort: await freePort(), remoteEgress: { host: "127.0.0.1", port: 0, peers: ["127.0.0.1"] } });
  t.after(async () => { await tasks.close(); await rm(dataDir, { recursive: true, force: true }); });
  const answer = await ask(tasks.remoteEgressAddress.port, tasks.certificate.ca, "/nowhere");
  assert.equal(answer.status, 404);
  assert.equal(answer.body, '{"error":"not_found"}', "the egress proxy's own answer");
});

test("the settings for other machines are said in full or refused by name", () => {
  assert.equal(loadEgressRemote({}), null);
  assert.deepEqual(loadEgressRemote({ IDOU_EGRESS_REMOTE_LISTEN: "10.0.0.5:8445", IDOU_EGRESS_REMOTE_PEERS: "10.0.0.6, 10.0.0.7" }),
    { host: "10.0.0.5", port: 8445, peers: ["10.0.0.6", "10.0.0.7"] });
  for (const [env, reason] of [
    [{ IDOU_EGRESS_REMOTE_PEERS: "10.0.0.6" }, /需要同时设置 IDOU_EGRESS_REMOTE_LISTEN/],
    [{ IDOU_EGRESS_REMOTE_LISTEN: "10.0.0.5:8445" }, /要列出执行节点的 IP/],
    [{ IDOU_EGRESS_REMOTE_LISTEN: "0.0.0.0:8445", IDOU_EGRESS_REMOTE_PEERS: "10.0.0.6" }, /不能监听所有地址/],
    [{ IDOU_EGRESS_REMOTE_LISTEN: "10.0.0.5", IDOU_EGRESS_REMOTE_PEERS: "10.0.0.6" }, /主机:端口/],
    [{ IDOU_EGRESS_REMOTE_LISTEN: "10.0.0.5:8445", IDOU_EGRESS_REMOTE_PEERS: "10.0.0.6;rm" }, /要列出执行节点的 IP/],
  ]) assert.throws(() => loadEgressRemote(env), reason, JSON.stringify(env));
  assert.equal(loadEgressUpstream({}), null);
  assert.deepEqual(loadEgressUpstream({ IDOU_EGRESS_UPSTREAM: "10.0.0.5:8445" }), { host: "10.0.0.5", port: 8445 });
  assert.throws(() => loadEgressUpstream({ IDOU_EGRESS_UPSTREAM: "10.0.0.5:99999" }), /主机:端口/);
});
