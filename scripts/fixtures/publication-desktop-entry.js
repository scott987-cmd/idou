// Synthetic process boundary only; retain the production CLI guard, adapters,
// desktop IPC, publication composition, journal and HTTP services.
import "../../src/adopt-legacy-env.js";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { DesktopWikiPublication } from "../../src/knowledge/desktop-publication.js";
import { DesktopWikiReception } from "../../src/knowledge/desktop-reception.js";
const origin = new URL(process.env.IDOU_SERVER_URL);
assert.equal(origin.hostname, "127.0.0.1");
const ok = data => ({ code: 0, stderr: "", stdout: JSON.stringify({ ok: true, identity: "user", data }) });
const start = DesktopWikiPublication.prototype.start;
DesktopWikiPublication.prototype.start = function(...args) { globalThis.publicationFixture.desktop = this; return start.apply(this, args); };
const receiveStart = DesktopWikiReception.prototype.start;
DesktopWikiReception.prototype.start = function(...args) { globalThis.publicationFixture.reception = this; return receiveStart.apply(this, args); };
globalThis.publicationFixture = { async run(argv, opts) {
  assert.equal(argv[argv.indexOf("--as") + 1], "user");
  if (argv[0] === "api" && argv[2].startsWith("/open-apis/docx/v1/documents/")) {
    const response = await fetch(new URL(`/fixture${argv[2]}`, origin)); return ok(await response.json());
  }
  // An upload is verified by reading the destination folder through the
  // read-only API passthrough, its query as --params (lark-cli 1.0.96 refuses
  // one in the path).
  if (argv[0] === "api" && argv[2] === "/open-apis/drive/v1/files") {
    assert.equal(argv[3], "--params"); assert.equal(JSON.parse(argv[4]).folder_token, "SyntheticFolder123");
    return ok(await (await fetch(new URL("/fixture/files", origin))).json());
  }
  if (argv[0] !== "drive") throw new Error("Unexpected synthetic command");
  if (argv[1] === "+inspect") return ok({ input_url: "https://test.feishu.cn/drive/folder/SyntheticFolder123", token: "SyntheticFolder123", type: "folder", title: "企业知识包", url: "https://test.feishu.cn/drive/folder/SyntheticFolder123" });
  if (argv[1] === "+upload") {
    const name = argv[argv.indexOf("--name") + 1]; assert.equal(argv.includes("--file-token"), false);
    assert.match(name, /^(?:idou|mydoubao)-[a-f0-9-]+\.wiki\.bundle$/);
    const row = (await globalThis.publicationFixture.desktop.publisher.journal.load()).find(row => name.endsWith(`-${row.id}.wiki.bundle`));
    assert.equal(row.state, "dispatching");
    const bytes = await readFile(path.join(opts.cwd, name));
    const response = await fetch(new URL(`/fixture/upload?name=${encodeURIComponent(name)}`, origin), { method: "POST", body: bytes }); assert.equal(response.status, 200);
    return ok(await response.json());
  }
  if (argv[1] === "+download") {
    const token = argv[argv.indexOf("--file-token") + 1];
    const response = await fetch(new URL(`/fixture/download?token=${token}`, origin)); assert.equal(response.status, 200);
    await writeFile(path.join(opts.cwd, "payload.bin"), Buffer.from(await response.arrayBuffer())); return ok({});
  }
  throw new Error("Unexpected synthetic drive command");
} };
await import("./account-desktop-entry.js");
