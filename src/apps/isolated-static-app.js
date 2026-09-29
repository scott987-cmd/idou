import { createDockerRuntime } from "./docker-runtime.js";
import { createStaticGateway } from "./package-preview.js";

// Runtime-node composition only. Never imported by the model/control-plane server.
export async function createIsolatedStaticApp(options) {
  const authorize = options.authorize ?? (() => {});
  const runtime = await createDockerRuntime(options); let gateway;
  const close = async () => { gateway?.close(); await runtime.close(); };
  try {
    await authorize();
    const readFile = async file => {
      try { await authorize(); const bytes = await runtime.readFile(file); await authorize(); return bytes; }
      catch (error) { await close(); throw error; }
    };
    gateway = await createStaticGateway({ manifest: runtime.manifest, expiresAt: runtime.expiresAt, readFile,
      onExpired: () => { void close().catch(() => {}); } });
    runtime.closed.then(() => gateway.close(), () => gateway.close());
    // Read the entry through the container before advertising readiness.
    await readFile(runtime.manifest.entry);
    return { ...gateway, manifest: runtime.manifest, digest: runtime.digest, sha256: runtime.sha256, containerId: runtime.containerId, name: runtime.name,
      entryUrl: gateway.url(gateway.entry), close, closed: runtime.closed };
  } catch (error) { await close(); throw error; }
}
