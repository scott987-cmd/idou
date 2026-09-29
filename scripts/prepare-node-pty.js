import { chmod, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const packageRoot = path.join(root, "node_modules", "node-pty");
const metadata = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
if (metadata.version !== "1.1.0" || metadata.license !== "MIT") throw new Error("node-pty dependency is not the reviewed 1.1.0 MIT release");

// The prebuilt spawn helper is macOS's: node-pty 1.1.0 ships prebuilds for
// macOS and Windows only, builds from source on Linux, and uses the helper on
// macOS alone. Asking for it anywhere else made `npm ci` fail on every Linux
// machine, CI included.
if (process.platform === "darwin") {
  const helper = path.join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
  const before = await stat(helper);
  await chmod(helper, before.mode | 0o100);
  const after = await stat(helper);
  if (!(after.mode & 0o100)) throw new Error(`node-pty spawn helper is not executable: ${helper}`);
}
