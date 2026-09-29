import test from "node:test";
import assert from "node:assert/strict";
import { MediaDownloader, publicMediaAddress } from "../src/application/media-download.js";

// The default answer to a reserved range is still no. Only what a deployment
// has written down as acceptable gets through, and only that.
test("保留网段默认拒绝，写进白名单的网段才放行，且只放行写进去的", () => {
  assert.equal(publicMediaAddress("198.18.0.106"), false);
  const strict = new MediaDownloader({ allow: [] });
  assert.equal(strict.acceptable("198.18.0.106"), false);
  assert.equal(strict.acceptable("8.8.8.8"), true);
  const relaxed = new MediaDownloader({ allow: ["198.18.0.0/15"] });
  assert.equal(relaxed.acceptable("198.18.0.106"), true);
  assert.equal(relaxed.acceptable("198.19.255.1"), true);
  // Adjacent reserved space stays refused: the allowlist is not "reserved is fine".
  assert.equal(relaxed.acceptable("10.0.0.5"), false);
  assert.equal(relaxed.acceptable("127.0.0.1"), false);
  assert.equal(relaxed.acceptable("::1"), false);
});

test("下载前的地址核验按实例白名单判断，错误信息指向配置项", async () => {
  const downloader = new MediaDownloader({ resolve: async () => ["198.18.0.106"], requestImpl: () => { throw new Error("must not request"); } });
  await assert.rejects(downloader.download({ url: "https://cdn.example.test/result.png", kind: "image", expiresAt: Date.now() + 60000 }), /198\.18\.0\.106.*allowedAddressRanges/s);
});

// 配置里写明的网段必须两条路径都认：预览能看、保存到云盘也能过。
// 这两处各自 new 了一个下载器，只给其中一个传白名单，人就会看到
// 「已经配过了却还是被拒」——正是这样漏过一次。
test("预览和保存到云盘用的是同一份白名单", async () => {
  const { MediaDownloader } = await import("../src/application/media-download.js");
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../src/desktop/main.js", import.meta.url), "utf8"));
  const constructions = [...source.matchAll(/new MediaDownloader\(([^)]*)\)/g)].map((match) => match[1]);
  const mediaPreview = /new MediaPreview\(\{[^}]*allowedAddressRanges:\s*([^,}]+)/.exec(source)?.[1] ?? "";
  assert.ok(mediaPreview.includes("media"), "预览没有拿到配置里的网段");
  assert.ok(constructions.length >= 1, "保存路径应当显式构造下载器并传入网段");
  for (const args of constructions) assert.match(args, /allow:\s*config\.media/, `这个下载器没有拿到配置里的网段：${args}`);
  // 没传白名单时默认必须仍然是拒绝，而不是放行。
  assert.equal(new MediaDownloader().acceptable("198.18.0.33"), false);
  assert.equal(new MediaDownloader({ allow: ["198.18.0.0/15"] }).acceptable("198.18.0.33"), true);
  // 放开这一段不等于顺带放开别的保留网段。
  for (const address of ["127.0.0.1", "10.0.0.5", "192.168.1.9", "169.254.169.254", "172.16.0.1"]) {
    assert.equal(new MediaDownloader({ allow: ["198.18.0.0/15"] }).acceptable(address), false, `${address} 不该被放行`);
  }
});
