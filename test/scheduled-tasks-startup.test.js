import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { connect as connectTls } from "node:tls";
import os from "node:os";
import path from "node:path";
import { startScheduledTasks } from "../src/control-plane/scheduled-tasks.js";
import { EGRESS_HOSTNAME } from "../src/control-plane/egress-tls.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";

// Where the egress proxy listens, and where the container is told to find it,
// are one setting (IDOU_SANDBOX_GATEWAY): on a Linux server the internal
// network's gateway address, and nowhere else. Unset, a development machine
// keeps listening everywhere and sends the container through host-gateway.
const sessions = { prune() {}, verify: () => null, issueForSandboxRun: () => null };

async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function start(t, extra = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "idou-scheduled-start-"));
  let tasks = null;
  // close before rm: a throwing rm must not skip closing the listener.
  t.after(async () => { await tasks?.close(); await rm(dataDir, { recursive: true, force: true }); });
  // `docker` that always fails: this is about the assembly, not about Docker.
  tasks = await startScheduledTasks({ feishu: SAAS_FEISHU, sessions, sourceAccess: null, dataDir, controlPlaneOrigin: "http://127.0.0.1:1",
    docker: "false", log: () => {}, ...extra });
  return tasks;
}

test("given an address, the proxy listens there alone and the container is sent there", async (t) => {
  const port = await freePort();
  const tasks = await start(t, { egressPort: port, gatewayAddress: "127.0.0.1", sandboxUser: { uid: 999, gid: 988 } });
  assert.equal(tasks.egressAddress, "127.0.0.1");
  assert.equal(tasks.runner.sandbox.gatewayHost, `${EGRESS_HOSTNAME}:127.0.0.1`, "not host-gateway");
  assert.deepEqual([tasks.runner.sandbox.uid, tasks.runner.sandbox.gid], [999, 988]);
  await new Promise((resolve, reject) => { const socket = connect(port, "127.0.0.1", () => { socket.destroy(); resolve(); }); socket.once("error", reject); });
});

test("unset, a development machine listens everywhere and reaches the host through its gateway", async (t) => {
  const tasks = await start(t, { egressPort: await freePort() });
  assert.equal(tasks.egressAddress, "0.0.0.0");
  assert.equal(tasks.runner.sandbox.gatewayHost, `${EGRESS_HOSTNAME}:host-gateway`);
  assert.deepEqual([tasks.runner.sandbox.uid, tasks.runner.sandbox.gid], [65534, 65534]);
});

// A gateway address this machine does not have means the sandbox network was
// not created (or the setting names another one). Said in those words, with the
// setting, instead of a bare EADDRNOTAVAIL.
test("an address this machine does not have stops the start, naming the setting", async (t) => {
  await assert.rejects(start(t, { egressPort: await freePort(), gatewayAddress: "192.0.2.1" }),
    /无法监听 192\.0\.2\.1:\d+：这台机器上没有这个地址。IDOU_SANDBOX_GATEWAY/);
});

// What a handshake with the egress proxy is shown: the certificate it serves now.
async function served(port) {
  return new Promise((resolve, reject) => {
    const socket = connectTls({ host: "127.0.0.1", port, servername: EGRESS_HOSTNAME, rejectUnauthorized: false }, () => {
      const peer = socket.getPeerCertificate(); socket.destroy();
      resolve({ serial: peer.serialNumber, validTo: Date.parse(peer.valid_to) });
    });
    socket.once("error", reject);
  });
}

// The egress certificate lasts 90 days and was looked at only when the server
// started: one not restarted in the last 14 days of it would have gone on
// serving it until every run failed at once. Now it is renewed while the server
// runs, and the listener serves the new one without a restart.
test("the egress certificate is renewed while the server runs, and served without a restart", async (t) => {
  let clock = Date.now();
  const port = await freePort();
  const tasks = await start(t, { egressPort: port, gatewayAddress: "127.0.0.1", now: () => clock });
  const first = await served(port);
  assert.equal(first.validTo, tasks.egressCertificate().validTo);
  const ca = tasks.egressCertificate().ca;

  assert.equal(await tasks.renewEgressCertificate(), false, "a fresh certificate is left as it is");
  clock += 80 * 86400_000; // inside its last 14 days
  assert.equal(await tasks.renewEgressCertificate(), true);
  const second = await served(port);
  assert.notEqual(second.serial, first.serial, "the listener serves the new certificate, with no restart");
  assert.equal(second.validTo, tasks.egressCertificate().validTo);
  assert.equal(tasks.egressCertificate().ca, ca, "under the same CA, which the containers already trust");
  assert.equal(tasks.runner.ca, ca);
});
