// What a smoke needs beyond a bare checkout, said by the smoke itself.
//
// A line near the top of the file:
//
//   // @requires live: <why>     real money, a real account or the real machine
//   // @requires docker: <why>   the isolated app runtime
//
// run-desktop-acceptance.js runs a smoke by default only when it needs neither,
// and reports it as skipped -- never as passed -- otherwise. The runner used to
// keep this list by hand, and the list fell behind the smokes: on 2026-09-25
// the default run made a paid model call (smoke-scheduled-task-e2e.js), tried
// to open the operator's own signed-in application (smoke-feishu-dock-live.js),
// and failed two smokes that refuse to start without --live. test/
// smoke-requirements.test.js reads every smoke's source and fails when what it
// does and what it declares disagree.
export const KINDS = ["live", "docker"];

export function declaredRequirements(source) {
  const head = String(source).split("\n").slice(0, 60);
  const found = new Map();
  for (const line of head) {
    const match = /^\s*\/\/\s*@requires\s+([a-z]+)\s*:\s*(\S.*)$/.exec(line);
    if (match && KINDS.includes(match[1])) found.set(match[1], match[2].trim());
  }
  return found;
}

// What the source shows it needs, whatever it declares. Deliberately plain
// patterns: the point is that a new smoke written the way these were is caught.
export function evidentRequirements(source) {
  const text = String(source), needs = new Map();
  // Refuses to run at all without --live (an optional --live mode is fine).
  if (/!==\s*["']--live["']\)\s*throw|if\s*\(\s*!\s*process\.argv\.includes\(\s*["']--live["']\s*\)\s*\)\s*throw/.test(text)) needs.set("live", "它自己要求 --live 才运行");
  // The operator's own signed-in application data.
  if (/Application Support["'`]?\s*,\s*["'`](?:我的豆包|i豆)|Application Support\/(?:我的豆包|i豆)|\bdesktopProfileDir\(/.test(text)) needs.set("live", "它用的是本机真实的应用数据目录");
  // The operator's real deployment file, used by default and not given up
  // when IDOU_SMOKE_NO_LIVE=1 says to.
  if (/homedir\(\)\s*,\s*["']\.(?:mydoubao|idou)["']\s*,\s*["'](?:mydoubao|idou)\.env["']|\blocalEnvFile\(/.test(text) && !/IDOU_SMOKE_NO_LIVE/.test(text)) needs.set("live", "它默认读取本机真实的部署文件（真实密钥、付费模型）");
  return needs;
}
