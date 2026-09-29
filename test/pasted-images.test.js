import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { imageFolder, MAX_IMAGE_BYTES, MAX_IMAGES, readPastedImage, removePastedImages, savePastedImages } from "../src/desktop/pasted-images.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const png = { type: "image/png", data: `data:image/png;base64,${PNG}` };
async function root(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-pasted-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("a pasted image is kept in the account's own folder for its task, and read back as it was", async (t) => {
  const folder = imageFolder(await root(t), "task-1");
  const [saved] = await savePastedImages(folder, [png]);
  assert.equal(path.dirname(saved.path), folder);
  assert.match(path.basename(saved.path), /^[0-9a-f-]{36}\.png$/);
  assert.equal((await stat(saved.path)).mode & 0o777, 0o600, "only this user can read it");
  assert.equal((await stat(folder)).mode & 0o777, 0o700);
  assert.equal(await readPastedImage(folder, saved), png.data);
  await removePastedImages(folder);
  await assert.rejects(stat(folder), { code: "ENOENT" }, "and goes with the task");
});

test("retrying the same renderer image id reuses identical bytes without creating another attachment", async t => {
  const folder = imageFolder(await root(t), "task-retry"), id = randomUUID(), image = { ...png, id };
  const first = await savePastedImages(folder, [image]), second = await savePastedImages(folder, [image]);
  assert.deepEqual(second, first); assert.deepEqual(await readdir(folder), [`${id}.png`]);
  await assert.rejects(savePastedImages(folder, [{ ...image, data: `data:image/png;base64,${Buffer.from("different").toString("base64")}` }]), /对不上|EEXIST/);
});

test("what is not an image of a known type is refused, and then nothing at all is written", async (t) => {
  const folder = imageFolder(await root(t), "task-2");
  const refused = [
    [{ type: "image/svg+xml", data: "data:image/svg+xml;base64,PHN2Zz4=" }, /只能粘贴/],
    [{ type: "image/png", data: "file:///etc/passwd" }, /只能粘贴/],
    [{ type: "image/png", data: `data:image/jpeg;base64,${PNG}` }, /只能粘贴/],
    [{ type: "image/jpeg", data: `data:image/jpeg;base64,${PNG}` }, /对不上/],
    [{ type: "image/png", data: "data:image/png;base64," }, /超过 10 MB|对不上/],
    [{ type: "image/png", data: `data:image/png;base64,${"A".repeat(14_000_000)}` }, /超过 10 MB/],
  ];
  for (const [image, reason] of refused) await assert.rejects(savePastedImages(folder, [png, image]), reason, image.type);
  // One byte over the limit gets past the length estimate; the bytes themselves are what count.
  const over = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(MAX_IMAGE_BYTES + 1 - 8)]);
  await assert.rejects(savePastedImages(folder, [{ type: "image/png", data: `data:image/png;base64,${over.toString("base64")}` }]), /超过 10 MB/);
  await assert.rejects(savePastedImages(folder, Array(MAX_IMAGES + 1).fill(png)), /最多/);
  await assert.rejects(readdir(folder), { code: "ENOENT" }, "a refused batch writes nothing, not even the good one");
  assert.deepEqual(await savePastedImages(folder, []), []);
});

test("an image is read back only by an id this folder could have given it", async (t) => {
  const folder = imageFolder(await root(t), "task-3");
  await assert.rejects(readPastedImage(folder, { id: "../../secret", type: "image/png" }), /找不到/);
  await assert.rejects(readPastedImage(folder, { id: "00000000-0000-4000-8000-000000000000", type: "text/plain" }), /找不到/);
});
