import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runProcess } from "../providers/process-runner.js";
import { appManifest, appHash, appDigest } from "./manifest.js";
import { MAX_APP_PACKAGE_BYTES } from "./archive.js";
import { readFrames, writeFrame } from "./runtime-frames.js";

export function runtimeConfig(value) {
  if (!value || Object.keys(value).some(key => !["dockerPath", "endpoint", "imageId"].includes(key)) || typeof value.dockerPath !== "string" || !path.isAbsolute(value.dockerPath) || /[\x00-\x1f]/.test(value.dockerPath) || typeof value.endpoint !== "string" || !/^unix:\/\/\/[^\x00-\x20?#]+$/.test(value.endpoint) || !/^sha256:[a-f0-9]{64}$/.test(value.imageId)) throw new Error("Runtime requires an absolute Docker CLI, local Unix endpoint and immutable image ID");
  return { dockerPath: value.dockerPath, endpoint: value.endpoint, imageId: value.imageId };
}
export function runtimeArgs(config, name, owner) {
  return ["run", "--rm", "--pull=never", "--interactive", "--init", "--name", name, "--label", `idou.runtime.owner=${owner}`,
    "--network=none", "--ipc=none", "--read-only", "--user=1000:1000", "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
    "--memory=256m", "--memory-swap=256m", "--cpus=0.5", "--pids-limit=32", "--ulimit=nofile=128:128", "--log-driver=none", "--stop-timeout=1",
    "--entrypoint=/usr/local/bin/node", config.imageId, "--max-old-space-size=128", "/opt/idou/src/apps/runtime-worker.js"];
}
export function verifyRuntimeInspection(row, { imageId, owner }) {
  const h = row?.HostConfig;
  if (!row || !/^[a-f0-9]{64}$/.test(row.Id) || row.Image !== imageId || row.Config?.Labels?.["idou.runtime.owner"] !== owner || row.Config?.User !== "1000:1000" || !row.State?.Running || !h || h.ReadonlyRootfs !== true || h.NetworkMode !== "none" || h.IpcMode !== "none" || h.Privileged !== false || h.PidMode || h.Memory !== 268435456 || h.MemorySwap !== 268435456 || h.NanoCpus !== 500000000 || h.PidsLimit !== 32 || h.AutoRemove !== true || h.Init !== true || h.LogConfig?.Type !== "none" || !h.CapDrop?.includes("ALL") || !h.SecurityOpt?.includes("no-new-privileges:true") || row.Mounts?.length !== 0 || h.Binds?.length || h.Devices?.length || h.DeviceRequests?.length || Object.keys(h.PortBindings || {}).length) throw new Error("Docker did not apply the required runtime isolation");
  return row.Id;
}

// Removal, then absence observed. Closing ends the worker's input, so Docker's
// own --rm is often already removing the container when this asks: Docker
// refuses a second removal as already in progress, and the container stays
// inspectable until its removal finishes. One look straight afterwards read that
// moment as a failure -- a third of the app-runtime smoke's runs, each ending in
// a close that threw -- so absence gets a bounded moment to arrive. Ownership is
// still checked before anything is removed.
export async function removeRuntimeContainer({ inspect, remove, owns, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 50, intervalMs = 100 }) {
  const row = await inspect();
  if (!row) return false;
  if (!owns(row)) throw new Error("Runtime cleanup ownership mismatch; no container removed");
  const removed = await remove(row.Id);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!(await inspect())) return true;
    await sleep(intervalMs);
  }
  throw new Error(removed.code !== 0 ? "Runtime container removal not confirmed" : "Runtime container still exists");
}

export async function createDockerRuntime({ config: input, bytes, digest, sha256, expiresAt }) {
  const config = runtimeConfig(input);
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_APP_PACKAGE_BYTES || !appDigest(digest) || !appDigest(sha256) || appHash(bytes) !== sha256 || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 300000) throw new Error("Invalid runtime package or lifetime");
  const packageText = bytes.toString("base64"); // Capture before the first await.
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-runtime-client-")), owner = randomUUID(), name = `idou-static-${owner}`;
  const prefix = ["--config", directory, "--host", config.endpoint], env = { PATH: "/usr/bin:/bin", LANG: "C" };
  const command = args => runProcess(config.dockerPath, [...prefix, ...args], { env, timeoutMs: 10000, maxOutputBytes: 65536 });
  let child, childDone, closing, stopped = false, manifest, containerId, stderrBytes = 0;
  const ready = Promise.withResolvers(), terminated = Promise.withResolvers(), pending = new Map();
  ready.promise.catch(() => {}); terminated.promise.catch(() => {});
  const inspect = async () => {
    const result = await command(["container", "inspect", name]);
    if (result.code !== 0) {
      if (result.stderr.includes(`No such object: ${name}`) || result.stderr.includes(`No such container: ${name}`)) return null;
      throw new Error("Unable to verify runtime container state");
    }
    const rows = JSON.parse(result.stdout); if (!Array.isArray(rows) || rows.length !== 1) throw new Error("Invalid Docker inspection");
    return rows[0];
  };
  const rejectPending = () => {
    ready.reject(new Error("Isolated application runtime stopped or rejected its package"));
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("Isolated application runtime unavailable")); }
    pending.clear();
  };
  const close = () => {
    if (closing) return closing;
    stopped = true; clearTimeout(expiryTimer); clearTimeout(startTimer); rejectPending();
    closing = (async () => {
      child?.stdin.end();
      try {
        await removeRuntimeContainer({ inspect, remove: id => command(["container", "rm", "--force", id]),
          owns: row => row.Config?.Labels?.["idou.runtime.owner"] === owner && row.Image === config.imageId && /^[a-f0-9]{64}$/.test(row.Id) });
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await childDone;
        await rm(directory, { recursive: true, force: true });
      }
    })();
    closing.then(() => terminated.resolve(), error => terminated.reject(error)); return closing;
  };
  let expiryTimer, startTimer;
  const fail = () => { void close().catch(() => {}); };
  try {
    const available = await command(["image", "inspect", config.imageId, "--format", "{{.Id}}"]);
    if (available.code !== 0 || available.stdout.trim() !== config.imageId) throw new Error("Pinned runtime image is not installed; runtime will not pull or fall back");
    child = spawn(config.dockerPath, [...prefix, ...runtimeArgs(config, name, owner)], { env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    childDone = new Promise(resolve => child.once("close", resolve));
    child.on("error", fail); child.stdin.on("error", fail);
    child.stderr.on("data", chunk => { stderrBytes += chunk.length; if (stderrBytes > 16384) fail(); });
    child.on("close", fail);
    startTimer = setTimeout(fail, 30000);
    expiryTimer = setTimeout(fail, Math.max(0, expiresAt - Date.now()));
    void (async () => {
      try {
        for await (const value of readFrames(child.stdout, () => 3 * 1024 * 1024)) {
          if (stopped) break;
          if (!manifest) {
            if (value?.kind !== "ready" || value.protocol !== 1 || value.digest !== digest || value.sha256 !== sha256) throw new Error();
            const checked = appManifest(value.manifest); if (checked.digest !== digest) throw new Error();
            manifest = checked.manifest; ready.resolve();
          } else {
            const request = pending.get(value?.id); if (!request || value.kind !== "file" || value.path !== request.file.path || typeof value.base64 !== "string" || value.base64.length !== 4 * Math.ceil(request.file.bytes / 3)) throw new Error();
            const data = Buffer.from(value.base64, "base64");
            if (data.toString("base64") !== value.base64 || data.length !== request.file.bytes || appHash(data) !== request.file.sha256) throw new Error();
            pending.delete(value.id); clearTimeout(request.timer); request.resolve(data);
          }
        }
        if (!stopped) fail();
      } catch { fail(); }
    })();
    await writeFrame(child.stdin, { kind: "load", protocol: 1, digest, sha256, expiresAt, package: packageText });
    await ready.promise;
    containerId = verifyRuntimeInspection(await inspect(), { imageId: config.imageId, owner });
    if (stopped || expiresAt <= Date.now()) throw new Error("Runtime expired during startup");
    clearTimeout(startTimer);
    const readFile = async filePath => {
      if (stopped || Date.now() >= expiresAt) throw new Error("Runtime expired");
      const file = manifest.files.find(file => file.path === filePath); if (!file || pending.size >= 16) throw new Error("Runtime file unavailable or request limit reached");
      const id = randomUUID(), result = Promise.withResolvers(); result.promise.catch(() => {});
      const timer = setTimeout(fail, 5000); pending.set(id, { ...result, timer, file });
      try { await writeFrame(child.stdin, { kind: "read", id, path: filePath }); } catch { fail(); }
      return result.promise;
    };
    return { manifest: structuredClone(manifest), digest, sha256, expiresAt, containerId, name, readFile, close, closed: terminated.promise };
  } catch (error) { await close(); throw error; }
}
