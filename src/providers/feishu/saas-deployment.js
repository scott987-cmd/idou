// Everything that makes the SaaS adapter SaaS, in one place.
//
// These values were written out wherever they were needed -- the same three
// link hosts in five parsers, `cli_` in four constructors, `ou_` in two senders,
// open.feishu.cn in eleven files -- which made the list of places a private
// deployment would have to edit the same as the list of places anyone had ever
// touched. They are the SaaS implementation's own facts. Code outside
// src/providers/feishu reaches them only through the SaaS definition
// (saas-definition.js), never by importing this file.
export const SAAS_PROVIDER_ID = "saas-cli";
export const SAAS_API_ORIGIN = "https://open.feishu.cn";
export const SAAS_ACCOUNTS_ORIGIN = "https://accounts.feishu.cn";

// Links that name a resource: Feishu, Lark and Doubao all serve the same paths.
export const SAAS_RESOURCE_HOSTS = Object.freeze(["feishu.cn", "larksuite.com", "doubao.com"]);
// Where the embedded Feishu pages may be. feishu.net carries the web client's
// own static assets and sign-in hops.
export const SAAS_PAGE_HOSTS = Object.freeze(["feishu.cn", "larksuite.com", "feishu.net"]);
// Where the pages' sign-in cookie lives.
export const SAAS_COOKIE_HOSTS = Object.freeze(["feishu.cn", "larksuite.com"]);
// A tenant's own document domain, as an administrator may name it for the
// Wiki's canonical links: one label under feishu.cn.
export const SAAS_TENANT_HOST = /^[a-z0-9-]+\.feishu\.cn$/;

export const SAAS_APP_ID = /^cli_[A-Za-z0-9_-]{1,128}$/;
export const SAAS_APP_ID_HINT = "应以 cli_ 开头，只含字母数字下划线和连字符";
export const SAAS_OPEN_ID = /^ou_[A-Za-z0-9_-]{1,120}$/;
export const SAAS_CHAT_ID = /^oc_[A-Za-z0-9_-]{8,64}$/;

// A host is on a list when it is one of the list's hosts or under one.
export const hostWithin = (hostname, hosts) => typeof hostname === "string" && hosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
