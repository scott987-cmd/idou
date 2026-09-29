import { createServer } from "node:http";
import { LOGIN_RETURN_PATHS } from "../control-plane/login-proof.js";

// Where this device receives the secret that completes a sign-in
// (FeishuLoginService.begin): a listener on the loopback address, for one
// sign-in, on a port the system picks. The control plane redirects the browser
// that authorized the sign-in here, so the secret reaches the machine that
// browser runs on; a browser on anyone else's machine reaches their loopback,
// not this one. It answers only the address it was opened for -- the right
// Host, this path, this sign-in's flow -- keeps the first secret it is given,
// and never keeps a process alive by itself.
const HEADERS = Object.freeze({ "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'", connection: "close" });
const PAGE = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>i豆</title></head><body><p>飞书授权完成，请返回应用确认账号。这个页面可以关闭。</p></body></html>';

export async function openLoginReturn({ onReturn = () => {} } = {}) {
  let expected = null, secret = null, closed = false, port = 0;
  const server = createServer((req, res) => {
    let url = null; try { url = new URL(req.url, "http://127.0.0.1"); } catch { /* answered below */ }
    const flow = url?.searchParams.getAll("flow") ?? [], given = url?.searchParams.getAll("secret") ?? [];
    // The Host check turns away a page that rebinds its own name to 127.0.0.1.
    if (req.method !== "GET" || req.headers.host !== `127.0.0.1:${port}` || !LOGIN_RETURN_PATHS.includes(url?.pathname) || !expected ||
        flow.length !== 1 || flow[0] !== expected || given.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(given[0])) {
      res.writeHead(404, HEADERS); res.end(); return;
    }
    if (!secret) { secret = given[0]; try { onReturn(); } catch { /* the secret is kept either way */ } }
    res.writeHead(200, { ...HEADERS, "content-type": "text/html; charset=utf-8" }); res.end(PAGE);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  server.unref(); port = server.address().port;
  return {
    port,
    // The sign-in this listener is for, once the control plane has named it.
    expect(flowId) { expected = flowId; },
    secret: () => secret,
    close() { if (closed) return; closed = true; server.close(); server.closeAllConnections(); },
  };
}
