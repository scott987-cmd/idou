// Reading a Feishu group's members, as the application's own bot.
//
// This is the one thing the administrator directory needs from Feishu, kept in
// a file of its own so that admin-directory.js never learns how to talk to it
// -- and so the whole of what this server asks Feishu about people is one
// function long, and can be read in one sitting.
//
// It asks for members and nothing else. Not their profiles, not their
// departments, not what they said: which open_ids are in this group.
//
// The bot has to be a member of that group. Feishu does not let an application
// read the membership of a group it is not in, so "add the 机器人 to your admin
// group" is a real setup step -- and when it has not been done, what comes back
// says exactly that rather than an empty list, because an empty list would read
// as "nobody is an administrator" and be indistinguishable from a group that is
// genuinely empty.
const MEMBERS_PATH = (chatId) => `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members`
  + "?member_id_type=open_id&page_size=100";

// Feishu's own codes for the two failures worth telling apart. Everything else
// is reported as it came: inventing a friendlier cause is how a real one hides.
const NOT_A_MEMBER = new Set([230002, 232002]);
const SCOPE_REFUSED = new Set([99991672, 99991679]);

export function chatMemberReader({ bot, feishu, fetch: fetchImpl = fetch, pages = 6 }) {
  if (!bot || typeof bot.token !== "function") throw new Error("读取群成员需要应用机器人");
  if (!feishu?.openApi?.origin) throw new Error("读取群成员需要一个说 OpenAPI 的飞书部署");
  return async function readChatMembers(chatId) {
    const token = await bot.token();
    const found = [];
    let cursor = null;
    for (let page = 0; page < pages; page += 1) {
      const url = `${feishu.openApi.origin}${MEMBERS_PATH(chatId)}${cursor ? `&page_token=${encodeURIComponent(cursor)}` : ""}`;
      const response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(20_000),
        headers: { authorization: `Bearer ${token}` } });
      let payload; try { payload = await response.json(); } catch { throw new Error("飞书返回了无法解析的内容"); }
      if (payload?.code !== 0) {
        if (SCOPE_REFUSED.has(payload?.code)) {
          throw new Error(`这个飞书应用没有读取群成员的权限（code=${payload.code}）：在开发者后台给它加上「获取群成员信息」。`);
        }
        if (NOT_A_MEMBER.has(payload?.code)) {
          throw new Error(`应用机器人不在这个群里（code=${payload.code}）：把它拉进管理员群。`);
        }
        throw new Error(`飞书拒绝了读取群成员：code=${payload?.code} ${String(payload?.msg ?? "").slice(0, 160)}`);
      }
      for (const item of payload?.data?.items ?? []) if (item?.member_id) found.push(String(item.member_id));
      cursor = payload?.data?.has_more ? payload?.data?.page_token ?? null : null;
      if (!cursor) return found;
    }
    // A group that needs more pages than this is not an administrator list.
    // Saying so beats quietly treating the first few hundred as the whole.
    throw new Error("这个群的成员太多，不像是管理员群");
  };
}
