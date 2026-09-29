// Synthetic transport/key authority only. Never loaded by the production app.
import "../../src/adopt-legacy-env.js";
import { randomBytes, randomUUID } from "node:crypto";
import { LocalWiki, evidencePage } from "../../src/knowledge/local-wiki.js";
import { sealWikiBundle, portablePage } from "../../src/knowledge/bundle.js";
import { WikiBundleReceiver } from "../../src/knowledge/bundle-receiver.js";
import { wikiHash, wikiManifest } from "../../src/knowledge/manifest.js";
import { SYNTHESIS_RECIPE } from "../../src/knowledge/synthesis.js";
import { chatDocumentUrl } from "./chat-data.js";

const status = LocalWiki.prototype.status;
globalThis.bundleFixture = { downloads: 0, releases: 0 };
LocalWiki.prototype.status = function() { globalThis.bundleFixture.wiki = this; return status.call(this); };
globalThis.bundleFixture.receive = async () => {
  const state = globalThis.bundleFixture, wiki = state.wiki;
  const source = await wiki.provider.readDocument(chatDocumentUrl), identity = source.identity;
  const page = evidencePage({ ...source, identity: { ...identity, principal: "synthetic-publisher" } }, Date.now());
  // Made by GLM and received by a desktop on the default MiniMax connection: the
  // record must arrive, survive a restart and still say which model made it.
  page.synthesis = { state: "complete", recipe: SYNTHESIS_RECIPE, model: "GLM-5.3",
    facts: [{ text: '先核对阅读与消息来源，再生成行动项。<script>window.__bundlePwned=true</script>',
      evidence: [{ chunkId: page.chunks[0].id, quote: "核对文档阅读与消息来源" }] }] };
  const key = randomBytes(32), shardKey = wikiHash("synthetic-shard"), nodeId = wikiHash("synthetic-publisher-node");
  const sealed = sealWikiBundle([portablePage(page)], { shardKey, nodeId, generation: 1, fence: 1, keyId: wikiHash("synthetic-key"),
    providerId: source.providerId, driveTenantKey: identity.tenantKey, folderToken: "SyntheticFolder123" }, key);
  const manifest = wikiManifest({ format: sealed.metadata.format, providerId: source.providerId, driveTenantKey: identity.tenantKey,
    folderToken: "SyntheticFolder123", fileToken: "SyntheticBundle123", reservationId: randomUUID(), keyId: sealed.metadata.keyId,
    ciphertextSha256: sealed.metadata.ciphertextSha256, bytes: sealed.bytes.length, sourceSetHash: sealed.metadata.sourceSetHash, sourceCount: 1 });
  const publication = { state: "published", clientReported: true, generation: 1, fence: 1, nodeId, manifest, manifestHash: wikiHash(manifest) };
  const folder = { providerId: source.providerId, token: manifest.folderToken, identity };
  const receiver = new WikiBundleReceiver({ wiki,
    coordinator: { head: async () => ({ publication }) },
    drive: { resolveFolder: async () => folder, unchanged: async expected => {
      const current = await wiki.provider.documentIdentity();
      if (current.principal !== expected.principal || current.tenantKey !== expected.tenantKey) throw new Error("changed identity");
    }, download: async () => { state.downloads++; return sealed.bytes; } },
    keyAuthority: { acquire: async () => ({ key, assertCurrent: async () => {}, release: async () => { state.releases++; } }) },
  });
  try { return await receiver.receive(shardKey, "synthetic-folder"); }
  finally { key.fill(0); }
};
await import("./chat-desktop-entry.js");
