import test from "node:test";
import assert from "node:assert/strict";
import { egressNetworkName } from "../src/control-plane/scheduled-tasks.js";
import { loadSandboxNetwork } from "../src/control-plane/server-config.js";

// The sandbox's network is where the host firewall does its work (docs/
// server-deployment.md): a host set up before the product was renamed keeps
// the network it has, a new one gets the new name, and a setting names it
// outright.
test("the sandbox joins the host's own network: the earlier one where it exists, the new name otherwise", async () => {
  const docker = (present) => async (command, args) => ({ code: present.includes(args[2]) ? 0 : 1, stdout: present.includes(args[2]) ? `${args[2]}\n` : "", stderr: "" });
  assert.equal(await egressNetworkName({ run: docker(["mydoubao-egress"]) }), "mydoubao-egress");
  assert.equal(await egressNetworkName({ run: docker(["mydoubao-egress", "idou-egress"]) }), "mydoubao-egress", "the one its firewall was written for");
  assert.equal(await egressNetworkName({ run: docker([]) }), "idou-egress");
  assert.equal(await egressNetworkName({ run: async () => { throw new Error("no docker"); } }), "idou-egress");
  assert.equal(loadSandboxNetwork({}), null);
  assert.equal(loadSandboxNetwork({ IDOU_SANDBOX_NETWORK: "idou-egress" }), "idou-egress");
  assert.throws(() => loadSandboxNetwork({ IDOU_SANDBOX_NETWORK: "--rm" }), /不是合法的 Docker 网络名/);
});
