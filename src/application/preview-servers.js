import { createArtifactServer } from "./workspace-files.js";

// The agent's half of preview: one artifact server per coding task, so the
// browser connector's browser_preview can open the page that task just wrote.
// The server's exact origin -- secret path prefix included -- goes to that
// task's browser on argv and is the only loopback address it may open, so the
// agent checks its own output without reaching the gateway, the control plane
// or LiteLLM on their ports.
//
// A server starts the first time a turn runs with the browser capability
// enabled, is reused by the task's later turns, and closes when the task is
// deleted or its scope goes away. The map holds the start itself rather than
// the finished server, so two turns that ask at once share one server instead
// of leaking the one that lost the race.
export class PreviewServers {
  constructor({ enabled = () => true, create = createArtifactServer } = {}) {
    this.enabled = enabled; this.create = create; this.servers = new Map();
  }

  async baseFor(task) {
    // A connection check passes a task with no id: it gets no preview server.
    if (!task?.id || !task.cwd || !this.enabled()) return undefined;
    let starting = this.servers.get(task.id);
    if (!starting) {
      starting = Promise.resolve().then(() => this.create(task.cwd));
      this.servers.set(task.id, starting);
      // A start that failed is forgotten, so the task's next turn tries again.
      starting.catch(() => { if (this.servers.get(task.id) === starting) this.servers.delete(task.id); });
    }
    return (await starting).url("");
  }

  close(taskId) {
    const starting = this.servers.get(taskId);
    if (!starting) return;
    this.servers.delete(taskId);
    // A server that is still starting closes as soon as it is up.
    starting.then((server) => server.close(), () => {});
  }

  closeAll() {
    for (const taskId of [...this.servers.keys()]) this.close(taskId);
  }
}
