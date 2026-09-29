import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Where an installation keeps its things. The product was 我的豆包 (MyDouBao)
// before it was i豆 (idou), and an installation made before the rename keeps
// every place it already has: its data folder (~/.mydoubao), its task folder
// (~/我的豆包) and its desktop profile, whose name is also the name of the
// Keychain item its secrets are sealed with. Nothing is moved or copied, and an
// earlier version opened again finds everything where it left it. A new
// installation gets the new names.
//
// The old place wins whenever it is there, so a new-named folder made by
// accident can never hide someone's data.
export const kept = (current, legacy, exists = existsSync) => (exists(legacy) ? legacy : current);

// Settings, sessions, the local server's data: ~/.idou, or ~/.mydoubao.
export function dataHome({ home = os.homedir(), exists } = {}) {
  return kept(path.join(home, ".idou"), path.join(home, ".mydoubao"), exists);
}

// The deployment file a developer keeps there (README.md).
// Named for the product like its folder; one written under the new name in an
// old folder is the one meant.
export function localEnvFile({ home, exists = existsSync } = {}) {
  const folder = dataHome({ home, exists });
  const current = path.join(folder, "idou.env"), legacy = path.join(folder, "mydoubao.env");
  return exists(current) ? current : kept(current, legacy, exists);
}

// Where work tasks get their folders: ~/i豆, or ~/我的豆包.
export function taskFolderRoot({ home = os.homedir(), exists } = {}) {
  return kept(path.join(home, "i豆"), path.join(home, "我的豆包"), exists);
}

// The desktop's profile under the system's application data folder, and the
// name the application goes by, which Electron also gives its Keychain item
// ("<name> Safe Storage").
export function desktopProfileName({ appData, exists } = {}) {
  return path.basename(kept(path.join(appData, "i豆"), path.join(appData, "我的豆包"), exists));
}
export const desktopProfileDir = ({ home = os.homedir(), exists } = {}) => {
  const appData = path.join(home, "Library", "Application Support");
  return path.join(appData, desktopProfileName({ appData, exists }));
};

// A project's own settings, read from the folder a command starts in:
// .idou.json, or one written before the rename, .mydoubao.json.
export function projectConfigFile(cwd, exists = existsSync) {
  const current = path.join(cwd, ".idou.json");
  return exists(current) ? current : kept(current, path.join(cwd, ".mydoubao.json"), exists);
}

// The legacy macOS identity, kept by a build made on a machine that already
// runs the application under it (scripts/package-mac.js): changing it would
// cost that machine its privacy permissions and its Keychain access.
export const LEGACY_BUNDLE_ID = "com.mydoubao.desktop";
export const BUNDLE_ID = "io.github.scott987-cmd.idou";
