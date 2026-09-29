// The two read-only operations the Agent has on this person's own knowledge
// copy. Everything else on the bridge changes something in Feishu and ends in a
// confirmation card; these change nothing, so they do not ask. What they can
// reach is exactly what the attached excerpts already came from: this login's
// stored documents, each re-read and permission-checked against Feishu before
// any of its text comes back. There is no route from here to an arbitrary
// Feishu URL -- a document the person never opened cannot be read through the
// knowledge copy, and a task narrowed to chosen documents cannot see past them.
//
// They exist because one search made with the person's own words carries every
// sentence an answer needs about three quarters of the time (measured on the
// 16-document evaluation corpus). The rest is usually one wording away: the
// question says 师傅, the document says 导师津贴. An agent that can ask again in
// the document's words finds those; one that cannot says "资料里没有" about a
// document it is holding.

// What one call may hand back. The Agent's own shell call truncates at a few
// thousand tokens, so a large answer is worse than a bounded one.
const SEARCH = Object.freeze({ rows: 8, chars: 6000, excerpt: 900, verify: 4, perDocument: 3 });
const READ = Object.freeze({ chars: 4000, maxAround: 6000, matches: 80, matchChars: 12000 });
const REFERENCE = /^[a-f0-9]{6,64}$/;
// The operations below, which the bridge lets a task run several of at once.
export const KNOWLEDGE_READS = Object.freeze(["kb-search", "kb-read"]);

const text = (value, name, limit) => {
  if (typeof value !== "string" || !value.trim() || value.length > limit) throw new Error(`${name} 无效`);
  return value.trim();
};

// A document is named by a prefix of the id the excerpts carry: short enough
// for the model to copy without mistakes, and the store refuses an ambiguous
// one rather than guessing which document was meant.
export function agentKnowledgeActions({ getScope, businessAccess = null }) {
  if (typeof getScope !== "function") throw new Error("Invalid agent knowledge action wiring");
  // Bound to a task in the live scope, so a channel from a previous account
  // cannot read this one's documents, and a task narrowed to chosen documents
  // keeps that choice: the scope the person set is the scope the Agent gets.
  const bind = (taskId) => {
    const scope = getScope();
    if (!scope) throw new Error("应用尚未就绪");
    businessAccess?.();
    const task = scope.service.get(taskId); // Throws for an unknown or foreign task.
    if (!scope.wiki) throw new Error("本机知识副本不可用。");
    if (!task.knowledgeScope) throw new Error("这个任务没有选择知识范围，企业知识不可用。请让用户在任务里选择知识范围。");
    return { scope, task, ids: task.knowledgeScope.mode === "selected" ? task.knowledgeScope.ids : null };
  };
  return {
    "kb-search": async (params, taskId) => {
      const { scope, ids } = bind(taskId);
      const query = text(params?.query, "--query", 200);
      const result = await scope.wiki.search(query, { ids, verify: SEARCH.verify, perDocument: SEARCH.perDocument, maxRows: SEARCH.rows, maxChars: SEARCH.chars });
      return {
        query,
        // The same shape the attached excerpts have, so the Agent cites the same
        // way whether a passage arrived with the question or was searched for.
        excerpts: result.hits.map((hit) => ({ id: hit.id.slice(0, 12), title: hit.title, sourceUrl: hit.sourceUrl, revision: hit.revision,
          ...(hit.section ? { section: hit.section } : {}), excerpt: hit.excerpt.slice(0, SEARCH.excerpt) })),
        unverified: result.unavailable,
        note: result.hits.length
          ? "已按当前飞书身份重新核验来源。引用时用 sourceUrl；要看某篇文档更多内容用 kb-read。"
          : "这次检索没有命中。换文档里会用的说法再试一次；仍然没有，就如实说知识库里没有。",
      };
    },
    "kb-read": async (params, taskId) => {
      const { scope, ids } = bind(taskId);
      const reference = text(params?.doc, "--doc", 64).toLowerCase();
      if (!REFERENCE.test(reference)) throw new Error("--doc 要用摘录里的文档 id（十六进制，至少 6 位）。");
      const around = params?.around === undefined ? 0 : Number(params.around);
      if (!Number.isFinite(around) || around < 0 || around > READ.maxAround * 100) throw new Error("--around 要是文档里的字符位置。");
      const match = params?.match === undefined ? null : text(params.match, "--match", 50);
      // Reading more of a document is still a verified read: the text comes back
      // from Feishu now, not from whatever was stored when the person opened it.
      const document = await scope.wiki.document(reference, { ids });
      // Every line holding a word, with the table's header rows: how a question
      // like "which contracts expire in September" is answered from a table of
      // thousands of rows, which paging through four thousand characters at a
      // time could never finish.
      if (match) {
        const lines = document.text.split("\n");
        const rule = /^\s*\|[\s:|-]+\|?\s*$/u;
        const header = lines.filter((line, index) => /^\s*\|/u.test(line) && rule.test(lines[index + 1] ?? "")).slice(0, 3);
        const found = lines.filter((line) => line.includes(match) && !header.includes(line) && !rule.test(line));
        const shown = [];
        let used = 0;
        for (const line of found) {
          if (shown.length >= READ.matches || used + line.length > READ.matchChars) break;
          shown.push(line); used += line.length;
        }
        return { id: document.id.slice(0, 12), title: document.title, sourceUrl: document.sourceUrl, revision: document.revision, chars: document.text.length,
          match, matched: found.length, header, lines: shown,
          note: found.length > shown.length ? `共 ${found.length} 行含「${match}」，只列出前 ${shown.length} 行；换更具体的词再查，不要据此下完整结论。` : `共 ${found.length} 行含「${match}」，已全部列出。` };
      }
      const middle = Math.min(document.text.length, Math.floor(around));
      const start = Math.max(0, middle - Math.floor(READ.chars / 2));
      const excerpt = document.text.slice(start, start + READ.chars);
      const to = start + excerpt.length;
      return { id: document.id.slice(0, 12), title: document.title, sourceUrl: document.sourceUrl, revision: document.revision,
        chars: document.text.length, from: start, to, excerpt,
        note: document.text.length > to ? `这篇还有 ${document.text.length - to} 字，用 --around ${to} 接着读。` : "已读到文档末尾。" };
    },
  };
}
