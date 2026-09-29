// Real-tenant acceptance for how a scheduled task pins what a link names.
//
//   node scripts/acceptance-wiki-pinning.js <cases.json>
//
// Runs the control plane's own resolver -- the SaaS deployment definition, URL
// construction, node resolution, capability gates, link builders and their
// read-back, and the permission probe -- against the live Feishu tenant the
// bundled lark-cli is logged in to. Fixtures cannot stand in for this: the probe
// types, the node shapes and above all the way Feishu refuses were each assumed
// until they were measured, and the last one was assumed wrong.
//
// What is swapped is the bearer transport only. Each request is handed to the
// application's own bundled lark-cli with `--as user`, so the person's
// credential stays in the Keychain and never reaches this process. The CLI does
// not report Feishu's HTTP status; measured directly, every refusal these two
// endpoints give is HTTP 400, so that is what the resolver is handed. The
// session and grant plumbing is not exercised here -- unit tests cover it.
//
// Nothing is written to Feishu. The resources a case file names have to exist
// already; `docs/evidence/wiki-pinning-cases.json` names the ones this was
// accepted against.
import { createServer } from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FeishuSourceAccess } from "../src/control-plane/feishu-source-access.js";
import { FeishuOAuthProvider } from "../src/control-plane/feishu-oauth-provider.js";
import { FeishuLoginService } from "../src/control-plane/feishu-login.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { FeishuLoginClient } from "../src/application/feishu-login-client.js";
import { SOURCE_ACCESS_SCOPE } from "../src/knowledge/source-access-contract.js";
import { SCHEDULE_RESOURCE_SCOPE } from "../src/providers/feishu/login-scopes.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";

const run = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, "resources", "lark-cli", `${process.platform}-${process.arch}`, "lark-cli");

// One CLI call, as the logged-in person. An API refusal is printed to stderr and
// exits non-zero; it is an answer, not a transport failure, so both streams are read.
async function lark(args) {
  let out = "";
  try { const result = await run(cli, [...args, "--as", "user", "--format", "json"], { cwd: root, maxBuffer: 8 << 20 }); out = result.stdout || result.stderr; }
  catch (error) { out = error.stdout || error.stderr || ""; }
  if (!out.includes("{")) throw new Error(`lark-cli printed nothing usable for ${args.join(" ")}`);
  return JSON.parse(out.slice(out.indexOf("{")));
}

const casesFile = process.argv[2];
if (!casesFile) { console.error("usage: node scripts/acceptance-wiki-pinning.js <cases.json>"); process.exit(2); }
const cases = JSON.parse(await readFile(casesFile, "utf8"));

// Whose tenant this is comes from Feishu, not from the case file.
const me = await lark(["api", "GET", "/open-apis/authen/v1/user_info"]);
if (!me.ok) throw new Error(`lark-cli is not logged in as a person: ${me.error?.message ?? "unknown"}`);
const tenant = me.data.tenant_key, user = me.data.open_id;

const upstream = [];
async function viaCli(url) {
  const parsed = new URL(url), params = Object.fromEntries(parsed.searchParams);
  const body = await lark(["api", "GET", parsed.pathname, ...(Object.keys(params).length ? ["--params", JSON.stringify(params)] : [])]);
  if (!body.ok) return Response.json({ code: body.error?.code ?? 99999, msg: body.error?.message ?? "refused" }, { status: 400 });
  return Response.json({ code: 0, data: body.data });
}
const fetchImpl = async (url) => {
  // The login below is this harness's own and hands out no real credential.
  if (url.endsWith("/open-apis/authen/v2/oauth/token")) {
    return Response.json({ code: 0, token_type: "Bearer", access_token: "held-by-lark-cli", refresh_token: "held-by-lark-cli",
      expires_in: 3600, scope: [SOURCE_ACCESS_SCOPE, SCHEDULE_RESOURCE_SCOPE].join(" ") });
  }
  upstream.push(new URL(url).pathname + new URL(url).search);
  return viaCli(url);
};

const appId = "cli_acceptance";
const sessions = new SessionRegistry();
const authority = new FeishuSourceAccess({ feishu: SAAS_FEISHU, sessions, appId, fetchImpl, scheduleResourcesEnabled: true });
const provider = new FeishuOAuthProvider({ feishu: SAAS_FEISHU, appId, appSecret: "unused", fetchImpl, sourceAccess: authority });
let login;
const server = createServer(async (req, res) => { if (!await login.handle(req, res) && !await authority.handle(req, res)) { res.writeHead(404); res.end(); } });
server.listen(0, "127.0.0.1"); await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
login = new FeishuLoginService({ origin, sessions, provider, allowedTenants: [tenant] });
let failed = 0;
try {
  const client = new FeishuLoginClient(), begun = await client.begin(origin);
  const launched = await fetch(begun.launchUrl, { redirect: "manual" }), target = new URL(launched.headers.get("location"));
  await fetch(`${origin}/auth/feishu/callback?state=${target.searchParams.get("state")}&code=acceptance`,
    { headers: { cookie: launched.headers.get("set-cookie").split(";")[0] } });
  const session = await client.complete();
  console.log(`tenant ${tenant}, ${cases.length} cases, as ${me.data.name ?? user}\n`);
  for (const { label, kind, reference, expect } of cases) {
    upstream.length = 0;
    let got;
    try {
      const [resolved] = await authority.resolveScheduleResources(session.token, [{ kind, reference }]);
      got = `${resolved.kind} ${resolved.reference}`;
    } catch (error) { got = `REFUSED ${error.message}`; }
    const ok = got === expect;
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
    console.log(`      got      ${got}`);
    if (!ok) console.log(`      expected ${expect}`);
    console.log(`      upstream ${upstream.join("  ") || "(none)"}`);
  }
} finally { login.close(); server.closeAllConnections(); server.close(); }
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exitCode = failed ? 1 : 0;
