import { Resolver } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request } from "node:https";
import { mediaResultUrl } from "../control-plane/minimax-media.js";

const blocked = new BlockList();
for (const [address, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3]]) blocked.addSubnet(address, prefix, "ipv4");
export const publicMediaAddress = (value) => isIP(value) === 4 && !blocked.check(value, "ipv4");
export function validateMediaBytes(kind, contentType, bytes) {
  const mime = contentType?.split(";")[0].trim().toLowerCase();
  if (!Buffer.isBuffer(bytes) || bytes.length < 12 || bytes.length > (kind === "video" ? 104857600 : 12582912)) throw new Error("媒体文件为空或超过预览大小限制");
  if (kind === "image") {
    if (mime === "image/png" && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "png";
    if (mime === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "jpg";
    if (mime === "image/webp" && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "webp";
  }
  if (kind === "video" && mime === "video/mp4" && bytes.toString("ascii", 4, 8) === "ftyp") return "mp4";
  throw new Error("成果类型与文件签名不匹配，未打开预览");
}

export class MediaDownloader {
  constructor({ resolve = (hostname) => new Resolver({ timeout: 1500, tries: 2 }).resolve4(hostname), requestImpl = request, allow = [] } = {}) {
    this.resolve = resolve; this.request = requestImpl;
    // Ranges the deployment has explicitly written down as acceptable answers.
    this.allowed = new BlockList();
    for (const cidr of allow) { const [address, prefix] = cidr.split("/"); this.allowed.addSubnet(address, Number(prefix), "ipv4"); }
  }
  acceptable(address) { return publicMediaAddress(address) || (isIP(address) === 4 && this.allowed.check(address, "ipv4")); }
  async download(result) {
    const url = new URL(mediaResultUrl(result.url));
    if (url.port && url.port !== "443") throw new Error("媒体预览只允许 HTTPS 标准端口");
    // Pin a validated public IPv4 address for this request, retaining hostname TLS
    // verification. No redirects, cookies, user agent session or auth headers.
    let addresses; try { addresses = await this.resolve(url.hostname); } catch { throw new Error("无法解析媒体下载地址"); }
    // Naming the address matters: a local proxy in fake-IP mode maps real public
    // hosts into a reserved range, and the refusal is then correct but looks
    // like the app is broken. The address is this machine's own resolution.
    const refused = addresses.filter((address) => !this.acceptable(address));
    if (!addresses.length) throw new Error("无法解析媒体下载地址");
    if (refused.length) throw new Error(`媒体地址解析到非公开网段（${refused[0]}），已拒绝访问。私有化部署或 fake-IP 代理环境下，可在 .idou.json 的 media.allowedAddressRanges 中写明允许的网段（如 198.18.0.0/15）。`);
    if (result.expiresAt <= Date.now()) throw new Error("临时成果已过期");
    const limit = result.kind === "video" ? 104857600 : 12582912;
    const { bytes, mime } = await new Promise((resolve, reject) => {
      const req = this.request(url, { agent: false, signal: AbortSignal.timeout(60000), lookup: (_hostname, options, callback) => options.all ? callback(null, [{ address: addresses[0], family: 4 }]) : callback(null, addresses[0], 4) }, (res) => {
        if (res.statusCode !== 200 || (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity") || Number(res.headers["content-length"] || 0) > limit) { res.destroy(); reject(new Error("媒体下载被拒绝或超过大小限制")); return; }
        const chunks = []; let size = 0;
        res.on("data", (chunk) => { size += chunk.length; if (size > limit) { res.destroy(); reject(new Error("媒体文件超过预览限制")); } else chunks.push(chunk); });
        res.on("error", () => reject(new Error("媒体下载中断")));
        res.on("end", () => resolve({ bytes: Buffer.concat(chunks), mime: res.headers["content-type"] }));
      });
      req.on("error", () => reject(new Error("媒体下载失败或超时"))); req.end();
    });
    const extension = validateMediaBytes(result.kind, mime, bytes);
    if (result.expiresAt <= Date.now()) throw new Error("临时成果已过期");
    return { bytes, extension };
  }
}
