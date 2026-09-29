// The real Feishu resources a live acceptance script reads, named by whoever
// runs it: `--resources <file.json>`, or IDOU_LIVE_RESOURCES=<file.json>.
// Nothing about a real tenant is written into the repository; each operator
// keeps a file for their own. Only the keys a script asks for are required:
//
//   {
//     "origin": "https://<tenant>.feishu.cn",
//     "wikiDocument": "<Wiki node holding a docx>",      "documentMarker": "<text in it>",
//     "wikiSheet": "<Wiki node holding a spreadsheet>",  "sheetId": "<one worksheet of it>", "sheetMarker": "<text in it>",
//     "wikiBase": "<Wiki node holding a Base>",          "baseTable": "<tbl… of it>",       "baseMarker": "<text in it>",
//     "siteBase": "https://<tenant>.feishu.cn/base/<token>",
//     "siteSheet": "https://<tenant>.feishu.cn/sheets/<token>"
//   }
//
// Every resource named has to exist already and be readable by the account the
// application is signed in with; the scripts only read them.
import { readFileSync } from "node:fs";

export function liveResources(keys, { argv = process.argv, env = process.env } = {}) {
  const at = argv.indexOf("--resources");
  const file = at > 0 ? argv[at + 1] : env.IDOU_LIVE_RESOURCES;
  if (!file) {
    process.stderr.write(`Name the real resources to read: --resources <file.json> or IDOU_LIVE_RESOURCES (keys: ${keys.join(", ")}; see scripts/fixtures/live-resources.js).\n`);
    process.exit(2);
  }
  const resources = JSON.parse(readFileSync(file, "utf8"));
  const missing = keys.filter((key) => typeof resources[key] !== "string" || !resources[key]);
  if (missing.length) {
    process.stderr.write(`${file} is missing ${missing.join(", ")} (see scripts/fixtures/live-resources.js).\n`);
    process.exit(2);
  }
  if ("origin" in resources && !/^https:\/\/[a-z0-9-]+\.(?:feishu\.cn|larksuite\.com)$/.test(resources.origin)) {
    process.stderr.write(`${file}: origin must be a tenant's https origin, such as https://<tenant>.feishu.cn.\n`);
    process.exit(2);
  }
  return resources;
}
