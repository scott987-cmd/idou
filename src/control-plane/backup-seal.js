// A backup snapshot, sealed so that it can leave the machine it was taken on
// (bin/backup.js --seal), and opened again only where its owner's private key is
// (--drill, or a restore).
//
// A snapshot holds everything the control plane keeps, secrets included: the
// unattended credentials and the key that seals them, the state key when asked
// for. The server holds only the operator's public key, so what it seals it can
// no longer read, and a copy stolen on the way or from wherever it is kept is
// bytes. The private key never comes near the server.
//
// The file:
//
//   IDOU-BACKUP 1\n
//   {"snapshot":…,"created":…,"recipient":<sha256 of the public key, hex>,
//    "key":<the data key, RSA-OAEP-SHA256 to that public key, base64>,
//    "iv":<12 bytes, base64>}\n
//   AES-256-GCM of a tar of the snapshot directory, the header line as AAD
//   the 16-byte GCM tag
//
// Standard pieces only, so it can be opened without this program: openssl
// pkeyutl unwraps the key, and any AES-GCM implementation reads the rest.
//
// Sealed, not signed: anybody with the public key can make such a file. The
// tag proves the bytes are the ones sealed with the key inside, not who sealed
// them. Opening therefore trusts nothing in the tar it has not checked -- every
// entry has to sit inside the snapshot's own directory, and be a plain file or
// directory -- and the drill checks every file against the snapshot's manifest.
import { spawn } from "node:child_process";
import { constants, createCipheriv, createDecipheriv, createHash, createPublicKey, createPrivateKey, privateDecrypt, publicEncrypt, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const MAGIC = "IDOU-BACKUP 1\n";
const TAG_BYTES = 16;
const MAX_HEADER = 16 * 1024;
const MIN_RSA_BITS = 3072;
export const SEALED_SUFFIX = ".idou-backup";

// The operator's public key, and the fingerprint the file names it by.
export function recipient(publicKeyPem) {
  let key;
  try { key = createPublicKey(publicKeyPem); } catch { throw new Error("备份公钥读不出来：需要 PEM 格式的 RSA 公钥"); }
  if (key.asymmetricKeyType !== "rsa") throw new Error("备份公钥必须是 RSA 公钥");
  if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < MIN_RSA_BITS) throw new Error(`备份公钥至少要 ${MIN_RSA_BITS} 位`);
  return { key, fingerprint: createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex") };
}

function tar(args, { cwd, stdin = "ignore", stdout = "pipe" } = {}) {
  const child = spawn("tar", args, { cwd, stdio: [stdin, stdout, "pipe"] });
  let said = "";
  child.stderr.on("data", (chunk) => { said = `${said}${chunk}`.slice(-2000); });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar ${args[0]} 失败（${code}）：${said.trim().slice(0, 300)}`))));
  });
  return { child, done };
}

// `root/name` into `file`, written beside it first and renamed once whole.
export async function sealDirectory({ root, name, publicKeyPem, file, now = new Date() }) {
  const { key, fingerprint } = recipient(publicKeyPem);
  const dataKey = randomBytes(32), iv = randomBytes(12);
  const header = `${JSON.stringify({ snapshot: name, created: now.toISOString(), recipient: fingerprint,
    key: publicEncrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, dataKey).toString("base64"),
    iv: iv.toString("base64") })}\n`;
  const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
  cipher.setAAD(Buffer.from(header));
  const partial = `${file}.partial`;
  const out = createWriteStream(partial, { mode: 0o600, flags: "wx" });
  try {
    out.write(MAGIC); out.write(header);
    const archive = tar(["-cf", "-", name], { cwd: root });
    await Promise.all([pipeline(archive.child.stdout, cipher, out, { end: false }), archive.done]);
    await new Promise((resolve, reject) => { out.end(cipher.getAuthTag(), (error) => (error ? reject(error) : resolve())); });
    await rename(partial, file);
  } catch (error) { out.destroy(); await rm(partial, { force: true }); throw error; }
  return { file, fingerprint, bytes: (await stat(file)).size };
}

// The header, read without trusting its size.
async function readHeader(file) {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(MAGIC.length + MAX_HEADER);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead);
    if (text.subarray(0, MAGIC.length).toString("latin1") !== MAGIC) throw new Error("不是 i豆 的加密备份");
    const end = text.indexOf(0x0a, MAGIC.length);
    if (end < 0) throw new Error("加密备份的文件头不完整");
    const line = text.subarray(MAGIC.length, end + 1);
    const header = JSON.parse(line.toString("utf8"));
    if (typeof header?.snapshot !== "string" || !/^[a-z]+-\d{8}T\d{9}Z$/.test(header.snapshot)) throw new Error("加密备份的文件头无效");
    return { header, line, start: MAGIC.length + line.length };
  } finally { await handle.close(); }
}

// The members a tar holds, each checked to sit inside `directory` and to be a
// plain file or directory; anything else stops the open before a byte is
// written where it names.
async function checkedMembers(archive, directory) {
  const listing = tar(["-tvf", archive]);
  let text = "";
  listing.child.stdout.on("data", (chunk) => { text += chunk; });
  await listing.done;
  const names = tar(["-tf", archive]);
  let plain = "";
  names.child.stdout.on("data", (chunk) => { plain += chunk; });
  await names.done;
  const lines = text.split("\n").filter(Boolean), members = plain.split("\n").filter(Boolean);
  if (lines.length !== members.length) throw new Error("加密备份里的条目数对不上");
  for (const [index, member] of members.entries()) {
    const type = lines[index][0];
    const parts = member.replace(/\/$/, "").split("/");
    if (!["-", "d"].includes(type) || path.isAbsolute(member) || parts[0] !== directory || parts.some((part) => part === ".." || part === "")) {
      throw new Error(`加密备份里有不该有的条目：${member.slice(0, 120)}`);
    }
  }
}

// Opened into `into` (an empty directory of the caller's): the snapshot's
// directory there, and the header. The tag is checked before anything is
// unpacked.
export async function openSealed({ file, privateKeyPem, into }) {
  const { header, line, start } = await readHeader(file);
  let key;
  try { key = createPrivateKey(privateKeyPem); } catch { throw new Error("备份私钥读不出来：需要 PEM 格式的 RSA 私钥"); }
  const fingerprint = createHash("sha256").update(createPublicKey(key).export({ type: "spki", format: "der" })).digest("hex");
  if (fingerprint !== header.recipient) throw new Error("这个私钥打不开这份备份：备份是给另一把公钥加密的");
  let dataKey;
  try { dataKey = privateDecrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(header.key, "base64")); }
  catch { throw new Error("解不开备份里的数据密钥"); }
  const size = (await stat(file)).size;
  if (size < start + TAG_BYTES) throw new Error("加密备份不完整");
  const handle = await open(file, "r");
  const tag = Buffer.alloc(TAG_BYTES);
  try { await handle.read(tag, 0, TAG_BYTES, size - TAG_BYTES); } finally { await handle.close(); }
  const decipher = createDecipheriv("aes-256-gcm", dataKey, Buffer.from(header.iv, "base64"));
  decipher.setAAD(line);
  decipher.setAuthTag(tag);
  await mkdir(into, { recursive: true, mode: 0o700 });
  const archive = path.join(into, ".archive.tar");
  try {
    await pipeline(createReadStream(file, { start, end: size - TAG_BYTES - 1 }), decipher, createWriteStream(archive, { mode: 0o600, flags: "wx" }));
  } catch (error) {
    await rm(archive, { force: true });
    throw /auth|tag/i.test(String(error?.message)) ? new Error("加密备份被改动过或不完整：校验没有通过") : error;
  }
  try {
    await checkedMembers(archive, header.snapshot);
    await tar(["-xf", archive], { cwd: into }).done;
  } finally { await rm(archive, { force: true }); }
  return { snapshot: path.join(into, header.snapshot), header };
}

export async function readPem(file, what) {
  try { return await readFile(file, "utf8"); } catch { throw new Error(`读不到${what}：${file}`); }
}
