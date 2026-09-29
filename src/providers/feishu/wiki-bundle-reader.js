import { createHash } from "node:crypto";
import { SAAS_API_ORIGIN } from "./saas-deployment.js";
import { ownFileName, sameFileName } from "../../product-names.js";

export const WIKI_BUNDLE_SCOPES = Object.freeze(["space:document:retrieve", "drive:file:download"]);

// Server transport only. The caller supplies a validated, coordinator-resolved
// manifest and a credential-bound request function, never a client URL. `url`
// turns an OpenAPI path into an address on the deployment's own origin.
const saasUrl = (path) => `${SAAS_API_ORIGIN}${path}`;
export async function readWikiDriveBundle({ manifest, json, request, assertCurrent, signal, reserveList, reserveDownload, url = saasUrl }) {
  const member = async () => {
    const seen = new Set(); let pageToken;
    for (let page = 0; page < 10; page++) {
      assertCurrent(); reserveList();
      const query = new URLSearchParams({ folder_token: manifest.folderToken, page_size: "200" });
      if (pageToken) query.set("page_token", pageToken);
      const result = await json(url(`/open-apis/drive/v1/files?${query}`)); assertCurrent();
      const data = result?.data;
      if (result?.code !== 0 || !Array.isArray(data?.files) || data.files.length > 200 || typeof data.has_more !== "boolean") throw new Error();
      const matches = data.files.filter(file => file?.token === manifest.fileToken);
      if (matches.length) {
        const file = matches[0];
        if (matches.length !== 1 || file.type !== "file" || file.shortcut_info || file.parent_token !== manifest.folderToken || !sameFileName(file.name, ownFileName(`${manifest.reservationId}.wiki.bundle`))) throw new Error();
        return;
      }
      if (!data.has_more || typeof data.next_page_token !== "string" || !data.next_page_token || data.next_page_token.length > 2048 || seen.has(data.next_page_token)) throw new Error();
      pageToken = data.next_page_token; seen.add(pageToken);
    }
    throw new Error(); // Bounded lookup is not a complete directory inventory.
  };
  let bytes, reader, response, complete = false;
  try {
    await member(); assertCurrent(); reserveDownload();
    response = await request(url(`/open-apis/drive/v1/files/${manifest.fileToken}/download`)); assertCurrent();
    const length = response.headers.get("content-length"), encoding = response.headers.get("content-encoding");
    if (response.status !== 200 || response.redirected || !response.body || response.headers.has("content-range") ||
      encoding && encoding !== "identity" || length !== null && (!/^[0-9]+$/.test(length) || Number(length) !== manifest.bytes)) throw new Error();
    bytes = Buffer.alloc(manifest.bytes); reader = response.body.getReader(); let offset = 0;
    // Actively cancel a stalled stream on logout/deadline, including when a
    // transport supplies a body which does not itself observe fetch's signal.
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      while (true) {
        assertCurrent(); const part = await reader.read(); assertCurrent();
        if (part.done) break;
        if (!(part.value instanceof Uint8Array) || offset + part.value.byteLength > bytes.length) throw new Error();
        bytes.set(part.value, offset); offset += part.value.byteLength;
      }
      if (offset !== bytes.length || createHash("sha256").update(bytes).digest("hex") !== manifest.ciphertextSha256) throw new Error();
    } finally { signal.removeEventListener("abort", cancel); }
    await member(); assertCurrent(); complete = true; return bytes;
  } finally {
    if (!complete) bytes?.fill(0);
    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    else await response?.body?.cancel().catch(() => {});
  }
}
