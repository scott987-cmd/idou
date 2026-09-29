import { defineFeishuProvider } from "./provider-definition.js";
import { OPENAPI_PROTOCOL } from "./openapi.js";
import {
  SAAS_ACCOUNTS_ORIGIN, SAAS_API_ORIGIN, SAAS_APP_ID, SAAS_APP_ID_HINT, SAAS_CHAT_ID, SAAS_COOKIE_HOSTS, SAAS_OPEN_ID,
  SAAS_PAGE_HOSTS, SAAS_PROVIDER_ID, SAAS_RESOURCE_HOSTS,
} from "./saas-deployment.js";
import { SaasFeishuCliProvider } from "./saas-cli-provider.js";
import { SaasWikiSourceReader } from "./wiki-source-reader.js";
import { SaasBaseReader, baseReference } from "./base-reader.js";
import { parseSaasDocumentReference } from "./document-format.js";
import { sheetReference } from "./sheet-reader.js";
import { driveReference, driveFileUrl, repairedDriveLink } from "./drive-files.js";
import { parseFeishuResourceReference, parseWikiNodeReference } from "./resource-reference.js";
import { wikiDocumentOrigin } from "./wiki-source-format.js";
import { FeishuCliSidecar } from "./cli-sidecar.js";
import { resolveFeishuRuntime } from "./bundled-runtime.js";

// Feishu SaaS, reached through the bundled lark-cli and Feishu's public OpenAPI.
// Everything it can do today, it declares.
export const SAAS_FEISHU = defineFeishuProvider({
  id: SAAS_PROVIDER_ID,
  label: "飞书",
  capabilities: {
    documents: true, documentSearch: true, documentWrites: true, sheets: true, base: true,
    chat: true, messages: true, drive: true, wiki: true, botMessages: true, webPages: true,
  },
  openApi: { protocol: OPENAPI_PROTOCOL, origin: SAAS_API_ORIGIN, accountsOrigin: SAAS_ACCOUNTS_ORIGIN },
  ids: { app: SAAS_APP_ID, user: SAAS_OPEN_ID, chat: SAAS_CHAT_ID, appHint: SAAS_APP_ID_HINT },
  web: {
    resourceHosts: SAAS_RESOURCE_HOSTS, pageHosts: SAAS_PAGE_HOSTS, cookieHosts: SAAS_COOKIE_HOSTS,
    sections: { home: "/", messenger: "/messenger/", drive: "/drive/home/" },
    // The messenger lives at /next/messenger/ and names the open conversation
    // only in its header.
    chat: { page: "/messenger", title: '[class*="header_title"],[class*="Header_title"],[class*="headerTitle"]' },
    // Feishu's own navigation: the messenger's app rail and the drive's
    // workspace sidebar, both repeating what this app already has down the left.
    chromeCss: {
      messenger: "section.appNavbar,.appNavbar{display:none !important}",
      drive: ".vmok-sidebar-container{display:none !important}",
    },
  },
  references: {
    document: parseSaasDocumentReference,
    sheet: sheetReference,
    base: baseReference,
    driveFolder: (value) => driveReference(value, "folder"),
    driveFile: (value) => driveReference(value, "file"),
    resource: parseFeishuResourceReference,
    tenantOrigin: wikiDocumentOrigin,
    wikiNode: parseWikiNodeReference,
  },
  links: {
    document: (origin, token) => `${origin}/docx/${token}`,
    sheet: (origin, token, sheetId) => `${origin}/sheets/${token}${sheetId ? `?sheet=${sheetId}` : ""}`,
    base: (origin, token, tableId) => `${origin}/base/${token}${tableId ? `?table=${tableId}` : ""}`,
    driveFolder: (origin, token) => `${origin}/drive/folder/${token}`,
    // What Feishu itself links a file as (drive-files.js); a folder is under /drive/.
    driveFile: driveFileUrl,
  },
  // Drive file links written before 2026-09-29 (drive-files.js), opened as the file.
  repairedLink: repairedDriveLink,
  runtime: { name: "lark-cli", lock: "feishu", resolve: resolveFeishuRuntime },
  client: {
    create: (config, runner, options) => new SaasFeishuCliProvider(config, runner, options),
    wikiSourceReader: (client, options) => new SaasWikiSourceReader(client, options),
    baseReader: (client) => new SaasBaseReader(client),
    sidecar: (options) => new FeishuCliSidecar(options),
  },
});
