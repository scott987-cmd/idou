// The coordinator's side of the execution pool (docs/scaling-plan.md step 3):
// the same `execute(job)` a DockerSandbox answers, answered by putting the job
// in the run queue (run-queue.js) and waiting for a worker (run-worker.js) to
// run it. Everything around the container stays with the coordinator -- the
// run's egress token, the previous report, the model, reading the result,
// archiving and telling the owner -- so a worker needs no Feishu authority and
// no schedule of its own.
import { randomUUID } from "node:crypto";
import { readFile as readFileAsync } from "node:fs/promises";
import path from "node:path";
import { RunInterrupted } from "../run-queue.js";

// What the runner writes into a run's directory for the container. They travel
// with the job: a worker need not share this disk.
export const RUN_FILES = Object.freeze(["task.json", "egress-ca.pem"]);

export class PoolSandbox {
  // `owner`: this coordinator, so a restart gives up its own runs and nobody
  // else's. `claimTimeoutMs`: how long a run may wait for a worker to take it.
  // Its egress token was issued with 30 seconds to spare beyond the run's own
  // limit, so a run left waiting longer would start with too little time.
  constructor({ queue, owner, claimTimeoutMs = 30_000, pollMs = 2000, readFile = readFileAsync, log = () => {} }) {
    if (!queue || typeof owner !== "string" || !owner) throw new Error("The execution pool needs a queue and an owner");
    Object.assign(this, { queue, owner, claimTimeoutMs, pollMs, readFile, log });
  }

  // Workers come and go; a run waits in the queue for one, briefly.
  async available() { return { ok: true, faults: [] }; }

  // A coordinator that restarted cannot finish what it had queued or running:
  // their egress tokens went with it. Given up here, and the workers stop them.
  async sweep() { return this.queue.cancelOwned(this.owner); }

  async execute(job, { signal, runId = randomUUID(), schedule = runId } = {}) {
    const files = {};
    for (const name of RUN_FILES) {
      try { files[name] = (await this.readFile(path.join(job.workspace, name))).toString("base64"); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
    signal?.throwIfAborted();
    const { workspace: _workspace, ...portable } = job;
    await this.queue.enqueue({ id: runId, schedule, owner: this.owner, payload: { job: portable, files } });
    const cancel = () => { void this.queue.cancel(runId).catch(() => {}); };
    signal?.addEventListener("abort", cancel, { once: true });
    // Nobody took it in time: given up, and said plainly.
    let unclaimed = false;
    const waited = setTimeout(async () => {
      try {
        if (await this.queue.stateOf(runId) === "queued") { unclaimed = true; await this.queue.cancel(runId); }
      } catch { /* the wait below still ends the run */ }
    }, this.claimTimeoutMs);
    waited.unref?.();
    try {
      // Not given the signal: once a run is cancelled, what counts is its
      // worker confirming the container is gone.
      const result = await this.queue.wait(runId, { pollMs: this.pollMs });
      if (signal?.aborted) throw signal.reason ?? new DOMException("The run was cancelled", "AbortError");
      if (result?.error) throw new Error(result.error.message);
      if (result?.aborted) throw new RunInterrupted("执行节点停止了这次运行");
      return result;
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("The run was cancelled", "AbortError");
      if (unclaimed) throw new Error(`没有执行节点接手这次运行（${Math.round(this.claimTimeoutMs / 1000)} 秒内）：执行节点可能都在忙或不在线`);
      throw error;
    } finally {
      clearTimeout(waited);
      signal?.removeEventListener("abort", cancel);
    }
  }
}
