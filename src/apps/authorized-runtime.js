import { randomUUID } from "node:crypto";
import { runtimeBinding, runtimeReceipt } from "./runtime-grant.js";
import { runtimeConfig } from "./docker-runtime.js";
import { createIsolatedStaticApp } from "./isolated-static-app.js";
import { validateServerUrl } from "../control-plane/client-session.js";
import { appHash } from "./manifest.js";
import { runtimeRequest } from "./runtime-http.js";
// The configured node/server are administrator inputs, never taken from a grant
// file, application package, browser or model-provided URL.
export async function createAuthorizedStaticApp({ config, grant, bytes, fetchImpl = fetch, createApp = createIsolatedStaticApp }) {
  if (!config || Object.keys(config).some(k => !["runtime", "nodeId", "serverUrl"].includes(k))) throw new Error("Invalid authorized runtime configuration");
  const runtime = runtimeConfig(config.runtime), serverUrl = validateServerUrl(config.serverUrl), binding = runtimeBinding(grant?.binding);
  if (typeof grant?.token !== "string") throw new Error("Runtime token must be a string");
  if (!grant || Object.keys(grant).some(k => !["token", "audience", "binding", "expiresAt", "deployed"].includes(k)) || grant.audience !== "app-runtime" || grant.deployed !== false || !/^[A-Za-z0-9_-]{43}$/.test(grant.token) || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= Date.now() || grant.expiresAt > Date.now() + 300000 || binding.nodeId !== config.nodeId || binding.imageId !== runtime.imageId || !Buffer.isBuffer(bytes) || bytes.length !== binding.bytes || appHash(bytes) !== binding.sha256) throw new Error("Runtime grant, node or package mismatch");
  bytes = Buffer.from(bytes);
  grant = { ...grant, binding };
  const body = { claimId: randomUUID(), nodeId: config.nodeId, imageId: runtime.imageId }, expected = JSON.stringify(binding);
  const request = route => runtimeRequest(serverUrl, grant.token, route, body, fetchImpl);
  let instance, timer, closing, stopped = false;
  const stopGrant = () => request("/v1/apps/runtime-stop").catch(() => {});
  const close = () => {
    if (closing) return closing;
    stopped = true; clearTimeout(timer);
    closing = (async () => { try { await instance?.close(); } finally { await stopGrant(); } })(); return closing;
  };
  const validate = result => {
    const value = runtimeReceipt(result);
    if (JSON.stringify(value.binding) !== expected || value.expiresAt !== grant.expiresAt || stopped) throw new Error("Runtime authorization changed or stopped");
    return value;
  };
  const authorize = async () => {
    if (stopped || Date.now() >= grant.expiresAt) throw new Error("Runtime authorization expired");
    return validate(await request("/v1/apps/runtime-check"));
  };
  try {
    // Claim is one shot. A lost response is not retried or treated as permission.
    validate(await request("/v1/apps/runtime-claim"));
    instance = await createApp({ config: runtime, bytes, digest: binding.digest, sha256: binding.sha256, expiresAt: grant.expiresAt, authorize });
    await authorize();
    const poll = async () => { try { await authorize(); if (!stopped) timer = setTimeout(poll, 2000); } catch { void close().catch(() => {}); } };
    timer = setTimeout(poll, 2000);
    instance.closed.then(() => { void close().catch(() => {}); }, () => { void close().catch(() => {}); });
    return { ...instance, close, binding, deployed: false };
  } catch (error) { await close(); throw error; }
}
