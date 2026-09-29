import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { bundledBinaryPath } from "../src/providers/feishu/bundled-runtime.js";
import { cliApiGet } from "../src/providers/feishu/openapi.js";
import { requireBundledCli } from "./helpers/stub-cli.js";

// lark-cli 1.0.96 refuses a query string in an `api` path and takes the same
// parameters as --params. Pinned on 2026-09-18, it broke every read that wrote
// its query into the path, and no test noticed: each faked the CLI and accepted
// whatever path it was handed. These run the pinned binary itself.
const run = promisify(execFile);

async function pinnedCli(t, argv) {
  // An empty home: nothing configured, nothing sent. A shape the CLI refuses
  // fails its argument check before it ever looks for a configuration.
  const home = await mkdtemp(path.join(os.tmpdir(), "idou-cli-shape-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  // A refusal is printed on stderr, with a non-zero exit.
  let output;
  try { const { stdout, stderr } = await run(bundledBinaryPath(), [...argv, "--dry-run"], { env: { HOME: home, PATH: "/usr/bin:/bin" }, timeout: 30_000 }); output = stdout || stderr; }
  catch (error) { output = error.stdout || error.stderr; }
  return JSON.parse(output);
}

test("a read with a query goes to the pinned CLI as a path and --params, and the CLI takes it", async (t) => {
  if (!(await requireBundledCli(t))) return;
  for (const endpoint of [
    "/open-apis/drive/v1/files?folder_token=fldcnFixture1&page_size=200&page_token=abc%2B%3D",
    "/open-apis/bitable/v1/apps/bascnFixture/tables/tblFixture/records?page_size=500",
    "/open-apis/im/v1/chats/oc_fixture?user_id_type=open_id",
  ]) {
    const argv = [...cliApiGet(endpoint), "--as", "user", "--format", "json"];
    assert.doesNotMatch(argv[2], /[?#]/, endpoint);
    const answer = await pinnedCli(t, argv);
    assert.notEqual(answer.error?.type, "validation", `${endpoint}: ${answer.error?.message}`);
    // What the old code sent, to prove this binary is the one that refuses it.
    const refused = await pinnedCli(t, ["api", "GET", endpoint, "--as", "user", "--format", "json"]);
    assert.equal(refused.error?.param, "path", endpoint);
  }
  assert.deepEqual(cliApiGet("/open-apis/drive/v1/files?folder_token=f&page_token=a%2Bb"),
    ["api", "GET", "/open-apis/drive/v1/files", "--params", JSON.stringify({ folder_token: "f", page_token: "a+b" })], "decoded once, encoded again by the CLI");
  assert.deepEqual(cliApiGet("/open-apis/bitable/v1/apps/bascnFixture"), ["api", "GET", "/open-apis/bitable/v1/apps/bascnFixture"]);
  for (const bad of ["https://open.feishu.cn/open-apis/x", "/open-apis/x#frag", "/elsewhere?x=1", "/open-apis/x y"]) assert.throws(() => cliApiGet(bad), bad);
});

test("no product code writes a query into a raw CLI read's path any more", async () => {
  const root = new URL("../src/", import.meta.url);
  const offenders = [];
  for (const entry of await readdir(root, { recursive: true })) {
    if (!entry.endsWith(".js")) continue;
    const source = await readFile(new URL(entry, root), "utf8");
    // `["api", "GET", `...?...`]`: the shape the pinned CLI refuses.
    for (const match of source.matchAll(/\[\s*"api"\s*,\s*"GET"\s*,\s*`[^`]*\?[^`]*`/g)) offenders.push(`${entry}: ${match[0]}`);
  }
  assert.deepEqual(offenders, []);
});
