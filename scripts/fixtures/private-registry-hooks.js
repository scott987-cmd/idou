// Test-only module hook: the desktop started by private-desktop-entry.js gets a
// registry that also knows the private fixture. Production never registers it.
const REGISTRY = "/src/providers/feishu/provider-registry.js";
const STAND_IN = new URL("./private-registry.js", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  // The stand-in itself still reaches the real registry.
  if (resolved.url.endsWith(REGISTRY) && context.parentURL !== STAND_IN) return { ...resolved, url: STAND_IN };
  return resolved;
}
