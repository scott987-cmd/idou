import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

// Said to the person: these reach the desktop's error banner (the UI rules found
// the first one there in English on 2026-09-25).
export function validateServerUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("缺少服务端地址"); }
  const loopback = ["127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("服务端地址必须是 HTTPS 的根地址（只有本机回环地址可以用 HTTP）");
  }
  return url.origin;
}

export async function readClientSession(filename, expectedServerUrl, now = Date.now()) {
  if (!filename || !path.isAbsolute(filename)) throw new Error("还没有连接服务端：请先在「设置」里用飞书登录。（开发连接要把 IDOU_SESSION_FILE 设为会话文件的绝对路径）");
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4096) throw new Error("会话文件无效");
    if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid())) throw new Error("会话文件必须属于当前用户，且权限为 0600");
    let session;
    try { session = JSON.parse(await handle.readFile("utf8")); }
    catch { throw new Error("会话文件格式无效"); }
    if (!session || typeof session !== "object" || Array.isArray(session)) throw new Error("会话文件格式无效");
    const serverUrl = validateServerUrl(session.serverUrl);
    if (expectedServerUrl && serverUrl !== validateServerUrl(expectedServerUrl)) throw new Error("这个会话文件属于另一个服务端");
    if (!Number.isFinite(session.expiresAt) || session.expiresAt <= now || session.expiresAt > now + 15 * 60_000) throw new Error("本机开发会话已过期：请重新启动本机服务端后再试");
    if (typeof session.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(session.token)) throw new Error("会话令牌无效");
    return { token: session.token, expiresAt: session.expiresAt, serverUrl };
  } finally { await handle.close(); }
}
