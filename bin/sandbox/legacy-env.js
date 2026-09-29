// Settings were MYDOUBAO_* before the product was renamed i豆 (idou); they are
// IDOU_* now (src/env-names.js). A control plane from before the rename passes
// only the old names into this container, so each is also read under its new
// one. Self-contained: this directory is all the image copies of bin/.
for (const [key, value] of Object.entries(process.env)) {
  if (!key.startsWith("MYDOUBAO_")) continue;
  const current = `IDOU_${key.slice("MYDOUBAO_".length)}`;
  if (process.env[current] === undefined) process.env[current] = value;
}
