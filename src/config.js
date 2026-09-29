import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { bundledBinaryPath } from "./providers/feishu/bundled-runtime.js";
import { bundledCodexBinary } from "./providers/codex/bundled-codex.js";
import { projectConfigFile } from "./install-names.js";

const defaults = Object.freeze({
  codex: { binary: "codex" },
  feishu: { provider: "saas-cli", profile: null },
  controlPlane: { baseUrl: null, authProvider: "feishu", sessionFile: null },
  knowledge: {
    driveFolderToken: null,
    maxBytes: 10 * 1024 * 1024 * 1024,
    reserveBytes: 1024 * 1024 * 1024,
  },
  media: { driveFolderToken: null, allowedAddressRanges: [] },
  browser: { allowedLocalPorts: [3000, 4173, 5173, 8000, 8080] },
});


// Media results are fetched from wherever the provider says, so reserved ranges
// are refused by default. A private deployment may legitimately answer from one
// — a proxy in fake-IP mode, an internal mirror — and says so here, one IPv4
// CIDR at a time. Nothing is opened that was not written down.
const CIDR = /^(\d{1,3})(\.\d{1,3}){3}\/(\d{1,2})$/;
function mediaAddressRanges(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 32) throw new Error("media.allowedAddressRanges must be an array of at most 32 IPv4 CIDR strings");
  for (const entry of value) {
    const match = typeof entry === "string" && entry.match(CIDR);
    if (!match || Number(match[3]) > 32 || entry.split("/")[0].split(".").some((part) => Number(part) > 255)) throw new Error(`media.allowedAddressRanges entry is not an IPv4 CIDR: ${String(entry).slice(0, 40)}`);
  }
  return [...new Set(value)];
}
// Which program runs is not something a file in the working directory gets to
// decide. `.idou.json` is read from wherever the command was started, which
// can be a repository someone else wrote -- and the executables named here run
// holding the person's Feishu and model credentials. The environment is the
// developer's own; a checked-out file is not.
function refuseExecutablePaths(fileConfig, file) {
  for (const section of ["codex", "feishu"]) {
    if (fileConfig[section] && Object.hasOwn(fileConfig[section], "binary")) {
      throw new Error(`${path.basename(file)} 不能指定可执行文件（${section}.binary）；开发时请用环境变量 ${section === "codex" ? "IDOU_CODEX_BIN" : "IDOU_FEISHU_BIN"}`);
    }
  }
}

export async function loadConfig(cwd = process.cwd()) {
  let fileConfig = {};
  // .idou.json, or one written before the product was renamed (install-names.js).
  const file = projectConfigFile(cwd);
  try {
    fileConfig = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  refuseExecutablePaths(fileConfig, file);

  return {
    codex: {
      ...defaults.codex,
      ...fileConfig.codex,
      binary: process.env.IDOU_CODEX_BIN || bundledCodexBinary() || defaults.codex.binary,
    },
    feishu: {
      ...defaults.feishu,
      ...fileConfig.feishu,
      // Which deployment, by name, from the ones this build ships; the registry
      // refuses any other. Nothing here can say where a deployment lives.
      provider: process.env.IDOU_FEISHU_PROVIDER || fileConfig.feishu?.provider || defaults.feishu.provider,
      binary: process.env.IDOU_FEISHU_BIN || bundledBinaryPath(),
      profile: process.env.IDOU_FEISHU_PROFILE || fileConfig.feishu?.profile || null,
    },
    controlPlane: {
      ...defaults.controlPlane,
      ...fileConfig.controlPlane,
      baseUrl: process.env.IDOU_SERVER_URL || fileConfig.controlPlane?.baseUrl || null,
      sessionFile: process.env.IDOU_SESSION_FILE || fileConfig.controlPlane?.sessionFile || null,
    },
    knowledge: { ...defaults.knowledge, ...fileConfig.knowledge },
    media: { ...defaults.media, ...fileConfig.media, allowedAddressRanges: mediaAddressRanges(fileConfig.media?.allowedAddressRanges) },
    skillCenter: { publicKeyFile: process.env.IDOU_SKILL_PUBLIC_KEY_FILE || fileConfig.skillCenter?.publicKeyFile || null },
    browser: { ...defaults.browser, ...fileConfig.browser },
  };
}
