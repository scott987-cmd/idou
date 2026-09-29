import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { X509Certificate } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { ensureEgressCertificate, sandboxTrustEnvironment, EGRESS_HOSTNAME } from "../src/control-plane/egress-tls.js";

async function directory(t) {
  const made = await mkdtemp(path.join(os.tmpdir(), "idou-egress-tls-"));
  t.after(() => rm(made, { recursive: true, force: true }));
  return made;
}

test("a private CA signs a certificate that actually carries the egress hostname", async (t) => {
  const where = await directory(t);
  const issued = await ensureEgressCertificate({ directory: where });
  assert.equal(issued.reissued, true);
  assert.equal(issued.hostname, EGRESS_HOSTNAME);

  const cert = new X509Certificate(issued.cert), ca = new X509Certificate(issued.ca);
  assert.ok(cert.checkIssued(ca), "the CA signed it");
  assert.ok(cert.checkHost(EGRESS_HOSTNAME), "and it is valid for the name the sandbox will dial");
  assert.equal(cert.checkHost("evil.example.com"), undefined, "and for nothing else");
  assert.match(ca.subject, /idou Sandbox Egress CA/);
  // The container trusts the CA, not the server certificate, so a re-issue
  // needs no change inside the image.
  assert.notEqual(issued.cert, issued.ca);
});

test("a second call reuses what is already there rather than churning certificates", async (t) => {
  const where = await directory(t);
  const first = await ensureEgressCertificate({ directory: where });
  const second = await ensureEgressCertificate({ directory: where });
  assert.equal(second.reissued, false, "nothing was regenerated");
  assert.equal(second.cert, first.cert);
  assert.equal(second.ca, first.ca);
});

test("a certificate close to expiry is replaced before it can strand a run", async (t) => {
  const where = await directory(t);
  const first = await ensureEgressCertificate({ directory: where });
  const validTo = Date.parse(new X509Certificate(first.cert).validTo);
  // An expiry that arrives mid-run fails every scheduled task at once, with
  // nobody there to read why -- so the renewal happens well ahead of it.
  const soon = validTo - 7 * 24 * 60 * 60_000;
  const second = await ensureEgressCertificate({ directory: where, now: () => soon });
  assert.equal(second.reissued, true, "re-issued while the old one still had a week left");
  assert.notEqual(second.cert, first.cert);
  assert.equal(second.ca, first.ca, "and the CA is kept, so anything already trusting it still does");
});

test("a certificate for the wrong name is not accepted just because it exists", async (t) => {
  const where = await directory(t);
  const first = await ensureEgressCertificate({ directory: where, hostname: "old.mydoubao.internal" });
  const second = await ensureEgressCertificate({ directory: where, hostname: EGRESS_HOSTNAME });
  assert.equal(second.reissued, true);
  assert.ok(new X509Certificate(second.cert).checkHost(EGRESS_HOSTNAME));
  assert.notEqual(second.cert, first.cert);
});

test("a corrupted or truncated certificate is replaced rather than served", async (t) => {
  const where = await directory(t);
  await ensureEgressCertificate({ directory: where });
  await writeFile(path.join(where, "egress.pem"), "-----BEGIN CERTIFICATE-----\nnot a certificate\n-----END CERTIFICATE-----\n");
  const again = await ensureEgressCertificate({ directory: where });
  assert.equal(again.reissued, true);
  assert.ok(new X509Certificate(again.cert).checkHost(EGRESS_HOSTNAME));
});

test("a mismatched pair is refused: a certificate this CA did not sign", async (t) => {
  const mine = await directory(t), theirs = await directory(t);
  await ensureEgressCertificate({ directory: mine });
  const other = await ensureEgressCertificate({ directory: theirs });
  // Someone else's certificate, dropped in beside our CA. Checking only that a
  // certificate parses and matches the hostname would accept it.
  await writeFile(path.join(mine, "egress.pem"), other.cert);
  const repaired = await ensureEgressCertificate({ directory: mine });
  assert.equal(repaired.reissued, true, "the pair has to agree, not merely parse");
  assert.ok(new X509Certificate(repaired.cert).checkIssued(new X509Certificate(repaired.ca)));
});

test("openssl failing is reported as a failure, never as a certificate", async (t) => {
  const where = await directory(t);
  // A non-zero exit is the verdict -- openssl writes key-generation progress to
  // stderr and still succeeds, and this product has read a progress line as an
  // error before.
  await assert.rejects(() => ensureEgressCertificate({ directory: where,
    run: async () => ({ code: 1, stdout: "", stderr: "unknown option" }) }), /生成出口证书失败[\s\S]*退出码 1/);
  const noisy = await ensureEgressCertificate({ directory: where,
    run: async (command, args, options) => {
      const { runProcess } = await import("../src/providers/process-runner.js");
      const result = await runProcess(command, args, options);
      return { ...result, stderr: `${".".repeat(500)}+++++\n${result.stderr}` };
    } });
  assert.equal(noisy.reissued, true, "noise on stderr with a zero exit is still a success");
});

test("the paths and the trust variables a sandbox needs are named, not guessed", async (t) => {
  const where = await directory(t);
  const issued = await ensureEgressCertificate({ directory: where });
  assert.equal(issued.caFile, path.join(where, "egress-ca.pem"));
  assert.equal((await readFile(issued.certFile, "utf8")), issued.cert);
  assert.equal((await readFile(issued.keyFile, "utf8")), issued.key);
  // Node for Codex, and the Go CLI's own variable: one CA file covers both.
  assert.deepEqual(sandboxTrustEnvironment("/workspace/.mydoubao/ca.pem"),
    { NODE_EXTRA_CA_CERTS: "/workspace/.mydoubao/ca.pem", SSL_CERT_FILE: "/workspace/.mydoubao/ca.pem" });
});

test("a relative directory or an unusable hostname is refused up front", async () => {
  await assert.rejects(() => ensureEgressCertificate({ directory: "relative/path" }), /绝对路径/);
  await assert.rejects(() => ensureEgressCertificate({ directory: "/tmp/x", hostname: "not a hostname" }), /主机名不合法/);
  await assert.rejects(() => ensureEgressCertificate({ directory: "/tmp/x", hostname: "" }), /主机名不合法/);
});
