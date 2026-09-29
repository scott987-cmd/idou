import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";
import { driveReference } from "../src/providers/feishu/drive-files.js";

// Every link this product builds to a Feishu page has the shape Feishu itself
// gives for that kind of resource. Until 2026-09-29 a Drive file was linked as
// /drive/file/<token> -- a page Feishu answers with its 404 -- and every test
// used the same invented shape, so nothing failed: the person found it by
// clicking a report link in a Feishu message. The shapes below were recorded
// from Feishu's own answers, not written from memory.
const shapes = JSON.parse(await readFile(new URL("./fixtures/feishu-web-link-shapes.json", import.meta.url), "utf8"));
const ORIGIN = "https://tenant.feishu.cn";
const tokenOf = (url) => new URL(url).pathname.split("/").filter(Boolean).at(-1);
const shape = (url) => new URL(url).pathname.replace(tokenOf(url), "<token>");

// Which recorded kind each link builder is for.
const BUILDERS = Object.freeze({ document: "docx", sheet: "sheet", base: "bitable", driveFile: "file", driveFolder: "folder" });

test("every link the SaaS deployment builds is the shape Feishu itself gives for that resource", () => {
  assert.deepEqual(Object.keys(SAAS_FEISHU.links).sort(), Object.keys(BUILDERS).sort(), "a new link builder needs a recorded shape here");
  for (const [builder, kind] of Object.entries(BUILDERS)) {
    const recorded = shapes.metas[kind];
    const built = SAAS_FEISHU.links[builder](ORIGIN, tokenOf(recorded));
    assert.equal(built, recorded, `${builder} builds what Feishu gives for a ${kind}`);
  }
});

test("a Drive file is read in every form Feishu gives it, and given back as its page", () => {
  for (const url of [shapes.metas.file, shapes.inspect.file]) {
    const read = driveReference(url, "file");
    assert.equal(read.token, tokenOf(shapes.metas.file));
    assert.equal(shape(read.url), shape(shapes.metas.file), "the file's own page");
  }
  assert.equal(driveReference(shapes.metas.folder, "folder").url, shapes.metas.folder);
  assert.throws(() => driveReference(shapes.metas.folder, "file"), /云盘文件夹或文件链接/, "a folder is not a file");
  assert.throws(() => driveReference(shapes.metas.file, "folder"), /云盘文件夹或文件链接/, "nor a file a folder");
});

test("a report link written before the fix is opened as the file it names, and nothing else is touched", () => {
  const old = shapes.notOpened.file;
  // Still read, so an old record's button and an old message's link work.
  assert.equal(driveReference(old, "file").url, shapes.metas.file);
  assert.equal(SAAS_FEISHU.repairedLink(old), shapes.metas.file);
  assert.equal(SAAS_FEISHU.repairedLink(`${old}?from=bot#top`), shapes.metas.file);
  for (const url of [...Object.values(shapes.metas), `${shapes.metas.file}?from=x`, "https://example.com/drive/file/FileTokenFixture001",
    "https://tenant.feishu.cn/drive/file/../../admin", "not a url", ""]) {
    const repaired = SAAS_FEISHU.repairedLink(url);
    if (url.startsWith("https://tenant.feishu.cn/drive/file/")) assert.equal(new URL(repaired).origin, ORIGIN);
    else assert.equal(repaired, url, `left as it was: ${url}`);
  }
  assert.equal(SAAS_FEISHU.repairedLink(undefined), undefined);
});
