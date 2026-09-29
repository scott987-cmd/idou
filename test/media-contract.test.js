import assert from "node:assert/strict";
import test from "node:test";
import { validateMediaRequest } from "../src/media/contracts.js";

test("accepts both cowork media kinds", () => {
  assert.equal(validateMediaRequest({ kind: "image", prompt: " draw " }).prompt, "draw");
  assert.equal(validateMediaRequest({ kind: "video", prompt: "animate" }).kind, "video");
});

test("rejects unknown media kinds", () => {
  assert.throws(() => validateMediaRequest({ kind: "audio", prompt: "speak" }), /image or video/);
});

