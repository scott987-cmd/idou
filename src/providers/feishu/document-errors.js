// The envelope the CLI prints last. Some shortcuts write progress lines first --
// `drive +upload` prints 「Uploading: …」 and 「File exceeds 20MB, using multipart
// upload」 before its JSON -- so the output as a whole is not JSON, and parsing it
// whole lost Feishu's reason: a live upload the tenant refused for size reached
// the person only as the generic failure below.
function envelopeOf(text) {
  if (typeof text !== "string" || !text) return null;
  try { return JSON.parse(text); } catch { /* progress lines before the JSON */ }
  for (let at = text.lastIndexOf("\n{"), tries = 0; at >= 0 && tries < 20; at = at > 0 ? text.lastIndexOf("\n{", at - 1) : -1, tries += 1) {
    try { const value = JSON.parse(text.slice(at + 1)); if (value && typeof value === "object") return value; } catch { /* an earlier brace, keep looking */ }
  }
  return null;
}

export function feishuFailure(result) {
  const envelope = envelopeOf(result.stderr) ?? envelopeOf(result.stdout);
  const error = envelope?.error;
  // A document edit that changes nothing is not reported as an error: the CLI
  // exits 1 with ok:false, result "failed" and the reason only in a warning --
  // degrade_code=1011 when the block id or the text to replace is no longer in
  // the document (it was edited after it was read) or the new content equals the
  // old. Measured on a live document with the pinned 1.0.96, for block_replace
  // on a replaced block and for str_replace on text that is gone (2026-09-24).
  // Read for an error field only, it was reported as a login, network or
  // permission problem, and the person went looking for the wrong thing.
  const warning = !error && envelope?.data?.result === "failed" && Array.isArray(envelope.data.warnings) ? String(envelope.data.warnings[0] ?? "") : "";
  if (/\bdegrade_code=1011\b/.test(warning)) {
    return new Error(`飞书没有改动文档：要改的那一段在文档里找不到了——文档读取之后又被改过，块编号或原文已经变了；也可能新内容和原来一样。请重新读取文档，按最新内容再改。这次没有写入任何内容。飞书返回：${warning.slice(0, 300)}`);
  }
  if (warning) return new Error(`飞书没有完成这次修改，没有写入任何内容。飞书返回：${warning.slice(0, 300)}`);
  const message = String(error?.message || "");
  if (/keychain/i.test(message)) return new Error("飞书 CLI 钥匙串不可用，请在本机交互环境修复已有 CLI 配置；应用不会自动降级密钥存储。");
  // Not Feishu's answer. The CLI reaches Feishu through this application's
  // sidecar and the control plane's proxy, which name their own refusals with a
  // feishu_cli_… code (feishu-cli-proxy.js); and nginx in front of the control
  // plane answers with an HTML error page while it restarts. Both were passed
  // on as 「飞书返回」 -- the page whole -- or as 「飞书拒绝了这次操作」, which sends
  // the person to Feishu for a restart of our own server (2026-09-26, a site
  // refresh during one). The shapes are the pinned CLI's own.
  const own = /^feishu_cli_[a-z_]+$/.test(message) ? message : null;
  if (own === "feishu_cli_proxy_denied") return new Error("i豆 服务端没有放行这次飞书调用：它不认这次登录（多半刚重启过，应用会自动重新连接），或这个会话没有开通飞书命令行。这次没有调用飞书，稍后再试；一直这样，请到「设置 → 飞书账号」重新登录。");
  if (own === "feishu_cli_proxy_busy") return new Error("i豆 服务端此刻代办的飞书调用太多，这次没有调用飞书，请稍后再试。");
  if (own === "feishu_cli_proxy_unavailable") return new Error("i豆 服务端这次没能连上飞书，调用没有完成，请稍后再试。");
  if (own) return new Error(`i豆 服务端按安全规则拒绝了这次飞书调用，没有发出去（${own}）。`);
  if (/<html/i.test(message)) {
    const status = Number.isInteger(error?.code) ? error.code : /^HTTP (\d{3})\b/.exec(message)?.[1];
    return new Error(`网关返回了错误页${status ? `（HTTP ${status}）` : ""}，这次调用没有完成：多半是 i豆 服务端正在重启，也可能是到飞书的网关暂时不可用，稍后再试。`);
  }
  // Feishu names the permissions it is missing. Passing those names through
  // turns a dead end into one console step; they are permission identifiers,
  // never a credential, and anything oddly shaped is dropped rather than shown.
  if (error?.subtype === "missing_scope") {
    const scopes = (Array.isArray(error.missing_scopes) ? error.missing_scopes : [])
      .filter(scope => typeof scope === "string" && /^[A-Za-z0-9_.:-]{1,120}$/.test(scope)).slice(0, 8);
    return new Error(scopes.length
      ? `飞书授权范围不足：缺少 ${scopes.join(" 或 ")}。请在开放平台开通对应权限，并同步写进部署配置的 FEISHU_CLI_SCOPES，然后重新登录。`
      : "飞书授权范围不足，请为当前用户配置对应权限后重试。");
  }
  // This is reached by document, spreadsheet, Base and Drive calls alike, so it
  // must not claim the operation was a document read -- a spreadsheet write that
  // failed on permissions was reported as "无法读取飞书文档", which sent the
  // Agent looking for a sharing problem instead of the missing scope. Feishu's
  // own wording is carried through, bounded, because it usually names the cause.
  // Feishu names the missing scopes at the END of its message ("... required one
  // of the following scopes: ..."), so a short cap truncates away the one thing
  // worth reading. Measured against a live 99991679 refusal.
  // Drive's per-file size limit belongs to the tenant, not to a login, network or
  // permission problem. Measured live: a tenant that accepts exactly 20 MiB
  // answers one byte more with 1061043 at upload_prepare, and nothing is uploaded.
  if (error?.code === 1061043) return new Error(`飞书拒绝了这次上传：文件超过了当前租户允许的单个文件大小，没有上传任何内容。飞书返回：${message.slice(0, 200)}`);
  if (error?.subtype === "quota_exceeded") return new Error(`飞书拒绝了这次操作：超出了配额或大小上限，没有改用本地缓存代替。飞书返回：${message.slice(0, 600)}`);
  const detail = message ? `飞书返回：${message.slice(0, 600)}` : "";
  if (/authentication|authorization/.test(error?.type || "") || /permission|forbidden|denied/i.test(message)) {
    return new Error(`飞书拒绝了这次操作：当前用户未登录，或这个应用没有这项权限。请检查登录状态、应用已开通的权限，以及这份内容的分享范围。${detail}`);
  }
  return new Error(`飞书服务调用失败，请检查当前 CLI 登录、网络和资源权限；未使用本地缓存代替授权。${detail}`);
}

export function successfulUserPayload(result) {
  if (result.code !== 0) throw feishuFailure(result);
  let payload;
  try { payload = JSON.parse(result.stdout); } catch { throw new Error("飞书 CLI 返回了无法识别的响应"); }
  if (payload.ok !== true) throw feishuFailure(result);
  if (payload.identity !== "user") throw new Error("飞书文档必须使用用户身份，不能使用机器人身份代替。");
  return payload;
}
