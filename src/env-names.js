// The product was 我的豆包 (MyDouBao) before it was i豆 (idou), and its settings
// were named MYDOUBAO_*. They are IDOU_* now. A deployment, a LaunchAgent or a
// habit from before the rename still means the same thing, setting for setting.
export const PREFIX = "IDOU_";
export const LEGACY_PREFIX = "MYDOUBAO_";

export const currentName = (key) => (typeof key === "string" && key.startsWith(LEGACY_PREFIX) ? `${PREFIX}${key.slice(LEGACY_PREFIX.length)}` : key);

// Every legacy setting copied to its current name where that is not set
// already: a current name, set, always wins. Returns the legacy names found.
export function adoptLegacyNames(env = process.env) {
  const found = [];
  for (const key of Object.keys(env)) {
    if (!key.startsWith(LEGACY_PREFIX)) continue;
    found.push(key);
    const now = currentName(key);
    if (env[now] === undefined) env[now] = env[key];
  }
  return found;
}

// What goes into a sandbox container, under both names: an image built before
// the rename reads MYDOUBAO_*, and the images are pinned by digest, so each
// IDOU_* setting travels under its old name as well until they are rebuilt.
export function withLegacyNames(env) {
  const out = { ...env };
  for (const [key, value] of Object.entries(env)) if (key.startsWith(PREFIX)) out[`${LEGACY_PREFIX}${key.slice(PREFIX.length)}`] = value;
  return out;
}
