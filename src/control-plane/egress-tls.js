import { mkdir, readFile, writeFile, chmod, stat } from "node:fs/promises";
import path from "node:path";
import { X509Certificate } from "node:crypto";
import { runProcess } from "../providers/process-runner.js";

// TLS for the sandbox egress proxy, and the reason it has to exist at all: the
// CLI sidecar that runs inside a sandbox forwards through `validateServerUrl`,
// which admits HTTPS anywhere but plain HTTP only on a literal loopback address
// (`client-session.js:5`). Inside a container loopback is the container, so the
// proxy has to be reachable by name over TLS or not at all.
//
// A private CA signs a server certificate rather than the server signing itself.
// The container then trusts one CA that outlives any particular certificate, so
// a re-issued certificate needs no change inside the image -- which matters
// because the alternative is every scheduled task failing at once, unattended,
// the day a certificate expires.
export const EGRESS_HOSTNAME = "egress.idou.internal";
const CA_DAYS = 3650;
const SERVER_DAYS = 90;
// Re-issued well before expiry: a certificate that runs out mid-run fails every
// scheduled task at the same moment, with nobody there to read the reason.
const RENEW_BEFORE_MS = 14 * 24 * 60 * 60_000;

const FILES = Object.freeze({ caKey: "egress-ca.key", caCert: "egress-ca.pem", key: "egress.key", cert: "egress.pem" });

async function readIfPresent(file) { try { return await readFile(file, "utf8"); } catch { return null; } }

// Whether this pair is sound: it parses, the CA signed it, and it carries the
// name the sandbox will dial. Deliberately says nothing about expiry.
function sound(caPem, certPem, hostname) {
  if (!caPem || !certPem) return false;
  try {
    const ca = new X509Certificate(caPem), cert = new X509Certificate(certPem);
    // Signed by this CA, not merely naming it as issuer: `checkIssued` compares
    // names (and key identifiers only where the certificate carries them), and
    // LibreSSL -- the openssl macOS ships -- writes none, so a certificate from
    // another CA of the same name passed as ours.
    return Boolean(cert.checkIssued(ca)) && cert.verify(ca.publicKey) && Boolean(cert.checkHost(hostname));
  } catch { return false; }
}

// Whether it is still worth keeping. Separate from `sound` because the two ask
// about different clocks, and merging them was a real defect: renewal passes a
// clock moved forward to just before expiry, and the freshly signed certificate
// is dated by openssl's own real clock -- so a single check judged the new
// certificate "about to expire" against the fast-forwarded time and refused it.
// Renewal would then have failed exactly when it was needed: two weeks before
// expiry, unattended, with the proxy raising errors instead of re-issuing.
function fresh(caPem, certPem, hostname, now) {
  if (!sound(caPem, certPem, hostname)) return false;
  try {
    const validTo = Date.parse(new X509Certificate(certPem).validTo);
    const caValidTo = Date.parse(new X509Certificate(caPem).validTo);
    return Number.isFinite(validTo) && Number.isFinite(caValidTo)
      && validTo - now > RENEW_BEFORE_MS && caValidTo > now;
  } catch { return false; }
}

// openssl prints key-generation progress to stderr and still exits 0. This
// product has read a progress line as a failure before, so the check here is the
// exit code and the file that was produced -- never the shape of the output.
async function openssl(args, { run, directory }) {
  const result = await run("openssl", args, { cwd: directory, timeoutMs: 30_000, maxOutputBytes: 1 << 20 });
  if (result.code !== 0) throw new Error(`生成出口证书失败：openssl ${args[0]} 退出码 ${result.code}\n${(result.stderr || "").slice(-500)}`);
  return result;
}

export async function ensureEgressCertificate({ directory, hostname = EGRESS_HOSTNAME, now = Date.now, run = runProcess } = {}) {
  if (!directory || !path.isAbsolute(directory)) throw new Error("出口证书目录必须是绝对路径");
  if (!/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i.test(hostname)) throw new Error("出口证书主机名不合法");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const at = now();
  const file = (name) => path.join(directory, name);

  const existingCa = await readIfPresent(file(FILES.caCert));
  const existingCert = await readIfPresent(file(FILES.cert));
  if (fresh(existingCa, existingCert, hostname, at)) {
    return { hostname, reissued: false, ca: existingCa, cert: existingCert, key: await readFile(file(FILES.key), "utf8"),
      caFile: file(FILES.caCert), certFile: file(FILES.cert), keyFile: file(FILES.key) };
  }

  // The CA is kept across re-issues so anything already trusting it stays
  // working; only a CA that is itself gone or expired is replaced.
  const caUsable = existingCa && (() => { try { return Date.parse(new X509Certificate(existingCa).validTo) > at; } catch { return false; } })();
  if (!caUsable) {
    await openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", String(CA_DAYS),
      "-keyout", FILES.caKey, "-out", FILES.caCert, "-subj", "/CN=idou Sandbox Egress CA",
      "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0", "-addext", "keyUsage=critical,keyCertSign,cRLSign"], { run, directory });
    await chmod(file(FILES.caKey), 0o600);
  }

  await openssl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-sha256",
    "-keyout", FILES.key, "-out", "egress.csr", "-subj", `/CN=${hostname}`], { run, directory });
  // The extensions are written to a file, always. This used to try `-extfile -`
  // first -- stdin, which openssl is never given -- and fall back to a file when
  // that failed; the openssl on GitHub's macOS runner did not fail, it signed a
  // certificate with no extensions at all.
  await writeFile(file("egress.ext"), `subjectAltName=DNS:${hostname}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`, { mode: 0o600 });
  await openssl(["x509", "-req", "-in", "egress.csr", "-CA", FILES.caCert, "-CAkey", FILES.caKey, "-CAcreateserial",
    "-days", String(SERVER_DAYS), "-sha256", "-out", FILES.cert, "-extfile", "egress.ext"], { run, directory });
  await chmod(file(FILES.key), 0o600);

  const ca = await readFile(file(FILES.caCert), "utf8"), cert = await readFile(file(FILES.cert), "utf8");
  // Verified after writing, not assumed from a zero exit: `x509 -req` drops
  // extensions unless told otherwise, so a zero exit can still produce a
  // certificate with no SAN, which would fail every sandbox at connect time
  // instead of here where the reason is still visible. Soundness only -- what it
  // must not be judged against is the caller's clock, which during a renewal is
  // deliberately set near the *old* certificate's expiry.
  if (!sound(ca, cert, hostname)) throw new Error("生成的出口证书未通过校验（主机名或签发关系不符）");
  return { hostname, reissued: true, ca, cert, key: await readFile(file(FILES.key), "utf8"),
    caFile: file(FILES.caCert), certFile: file(FILES.cert), keyFile: file(FILES.key) };
}

// What a sandbox needs to trust the proxy: one CA file, and the two variables
// that point the runtimes at it -- Node for Codex, and the Go CLI's own.
export function sandboxTrustEnvironment(caPathInSandbox) {
  return Object.freeze({ NODE_EXTRA_CA_CERTS: caPathInSandbox, SSL_CERT_FILE: caPathInSandbox });
}

export async function certificateAge(directory, name = FILES.cert) {
  try { return (await stat(path.join(directory, name))).mtimeMs; } catch { return null; }
}
