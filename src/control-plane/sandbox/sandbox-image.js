import { readPinsSync } from "../../providers/runtime-artifacts.js";

// The image a scheduled run happens in, described from the same lock the desktop
// app reads. Nothing here repeats a version: the tag, the labels and the digests
// all come from `upstreams.lock.json`, so bumping Codex or the Feishu CLI is one
// edit, and an image built before that edit is recognisably stale after it.
//
// Two different questions, answered by two different things:
//
//   - Is this image built for this lock? The labels say so. They are the
//     image's own account of itself, written by the build from the lock after
//     the build verified the bytes -- useful for catching a stale image, and no
//     defence against someone who builds a lying one.
//   - Is this the image that was approved? Only a digest answers that. A tag is
//     a pointer anyone with access to the daemon or the registry can move.

export const IMAGE_LABELS = Object.freeze({
  codex: "com.mydoubao.codex",
  codexSha256: "com.mydoubao.codex.sha256",
  larkCli: "com.mydoubao.lark-cli",
  larkCliSha256: "com.mydoubao.lark-cli.sha256",
  releaseUpstreamsSha256: "com.mydoubao.release.upstreams.sha256",
  platform: "com.mydoubao.platform",
});

export function sandboxImageTag(pins = readPinsSync()) {
  return `${pins.sandbox.repository}:${pins.codex.version}-${pins.feishu.version}`;
}

// Docker spells architectures its own way; the lock is keyed the way Node does.
const FROM_DOCKER = Object.freeze({ amd64: "x64", arm64: "arm64" });
const TO_DOCKER = Object.freeze({ x64: "amd64", arm64: "arm64" });
export const imagePlatform = (os, architecture) => `${os}-${FROM_DOCKER[architecture] ?? architecture}`;
export const dockerPlatform = (platform) => {
  const [os, arch] = String(platform).split("-");
  return `${os}/${TO_DOCKER[arch] ?? arch}`;
};

// The labels a correct build for `platform` carries, or null when the lock has
// no reviewed artifacts for that platform at all -- in which case there is
// nothing a build could be checked against, and it must not be attempted.
export function expectedImageLabels(pins, platform, upstreamsSha256 = null) {
  // The lock also pins the desktop's macOS binaries; none of them runs in a
  // Linux container, whatever the architecture.
  if (!String(platform).startsWith("linux-")) return null;
  const cli = pins.feishu.bundledArtifacts?.[platform];
  const codex = pins.codex.vendorArtifacts?.[platform];
  if (!cli?.sha256 || !codex?.files?.["bin/codex"]) return null;
  return {
    [IMAGE_LABELS.codex]: pins.codex.version,
    [IMAGE_LABELS.codexSha256]: codex.files["bin/codex"],
    [IMAGE_LABELS.larkCli]: pins.feishu.version,
    [IMAGE_LABELS.larkCliSha256]: cli.sha256,
    ...(upstreamsSha256 ? { [IMAGE_LABELS.releaseUpstreamsSha256]: upstreamsSha256 } : {}),
    [IMAGE_LABELS.platform]: platform,
  };
}

// The two forms that name bytes rather than a pointer: `name@sha256:<64 hex>`, a
// repository digest, and a bare `sha256:<64 hex>`, an image ID. Docker's classic
// image store records no repository digest for an image it loaded rather than
// pulled, so there the ID -- the digest of the image's own config, which names
// every layer's content -- is the only immutable name the image has.
export const pinnedImage = (reference) => /@sha256:[a-f0-9]{64}$/.test(String(reference ?? "")) || /^sha256:[a-f0-9]{64}$/.test(String(reference ?? ""));

// Why an inspected image is not one this lock describes. Empty means it is.
export function imageFaults(inspected, pins) {
  const platform = imagePlatform(inspected.os, inspected.architecture);
  const expected = expectedImageLabels(pins, platform);
  if (!expected) return [`镜像平台 ${platform} 没有经过审核的 Codex 与飞书 CLI`];
  const labels = inspected.labels ?? {};
  if (!Object.values(IMAGE_LABELS).some((key) => Object.hasOwn(labels, key))) {
    return ["镜像没有版本标签，无法确认它与 upstreams.lock.json 一致（用 npm run build:sandbox 重新构建）"];
  }
  return Object.entries(expected)
    .filter(([key, value]) => labels[key] !== value)
    .map(([key, value]) => `镜像标签 ${key} 是 ${labels[key] ?? "(无)"}，发布清单要求 ${value}`);
}

// The component labels prove compatibility; the signed release decides which
// immutable image bytes were actually approved. Both are required in
// production because a correctly labelled image can still contain anything.
export function approvedImageFaults(reference, inspected, release) {
  const platform = imagePlatform(inspected.os, inspected.architecture);
  const approved = release?.sandboxImages?.[platform];
  if (!approved) return [`签名发布清单没有批准 ${platform} 沙箱镜像`];
  // The same approved bytes go by one of two names, depending on the store of
  // the Docker holding them: the repository digest the build machine's
  // containerd store records, or, once `docker load`ed into a classic store,
  // the image ID that store derives from the config. The release names both
  // when the build recorded both; whichever is used, the ID must be the one the
  // release pairs with it.
  const classic = typeof approved.classicId === "string" && reference === approved.classicId;
  const faults = [];
  if (reference !== approved.reference && !classic) faults.push(`沙箱镜像不是签名发布 ${release.releaseId} 批准的 digest`);
  if (inspected.id !== (classic ? approved.classicId : approved.id)) faults.push("沙箱镜像 ID 与签名发布清单不一致");
  if (inspected.labels?.[IMAGE_LABELS.releaseUpstreamsSha256] !== release.upstreamsSha256) faults.push("沙箱镜像没有绑定当前签名上游组合");
  return faults;
}
