#!/usr/bin/env node
// Is the signed release manifest still the source that is on disk?
//
// Run before the tests, because the answer decides whether they mean anything.
// A mismatch used to fail quietly: the account-verifier test swallowed the error
// and hung for twenty-four minutes, which cost this project three separate
// afternoons. The refusal now reaches callers by name (FeishuRuntimeRefused),
// but still as failures scattered over unrelated tests and smokes -- a manual
// smoke read it as a chat list it could not read. Two seconds here, and the
// message says the one command that fixes it.
import "../src/adopt-legacy-env.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applicationSourceDigest, releaseVerification } from "../src/providers/release-manifest.js";

// A checkout under development is not held to the signature
// (release-manifest.js): the tests run as they are, and this says how far the
// source has moved from the last signed release. `npm run check:release`
// (IDOU_RELEASE_VERIFICATION=strict) holds it to the signature, as every
// release is before it is packaged or deployed.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestFile = path.join(root, "release", "manifest.json");
const strict = releaseVerification(root) === "strict";

let manifest;
try { manifest = JSON.parse(readFileSync(manifestFile, "utf8")); }
catch {
  if (!strict) { process.stdout.write(`没有签名的发布清单（${path.relative(root, manifestFile)}）：按开发模式测试；二进制仍按 upstreams.lock.json 的摘要核对。\n`); process.exit(0); }
  process.stderr.write(`读不到 ${path.relative(root, manifestFile)}：先签一次发布清单。\n`); process.exit(1);
}

const onDisk = applicationSourceDigest(root);
if (manifest.application?.sourceSha256 === onDisk) {
  process.stdout.write(`发布清单与源码一致（${manifest.releaseId}）\n`);
  process.exit(0);
}

if (!strict) {
  process.stdout.write(`开发模式：源码在 ${manifest.releaseId} 签名之后改过，测试照常运行，二进制仍按 upstreams.lock.json 的摘要核对。\n`
    + "发布之前重新签发，再用 npm run check:release 核对。\n");
  process.exit(0);
}

const bump = String(manifest.releaseId ?? "").replace(/\.(\d+)$/, (_, n) => `.${Number(n) + 1}`);
process.stderr.write(
  `发布清单与源码不一致：清单是 ${manifest.releaseId}，但 src/ 或 bin/ 之后又改过。\n`
  + "发布要先重新签发：\n\n"
  + `  IDOU_RELEASE_SIGNING_KEY_FILE="$HOME/.idou/release-signing-key.pem" \\\n`
  + `    node scripts/sign-release.js --release-id ${bump || "<新号>"} \\\n`
  + "    --sandbox-record <绝对路径>/dist/sandbox-releases/<本次镜像>.json\n\n"
  + "（release id 不能复用，--sandbox-record 只收绝对路径。）\n");
process.exit(1);
