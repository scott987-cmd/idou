// What the knowledge copy holds, as a picture: one node per document, one link
// per pair that keeps talking about the same things. Deliberately arithmetic
// rather than a model call — the graph is a view of stored evidence, so it must
// not cost anything, must not leave the machine, and must give the same answer
// twice for the same pages.
//
// There is no Chinese tokenizer here. Character bigrams are a crude stand-in,
// but across a shared corpus the terms that matter still rise: a bigram that
// appears everywhere is worth nothing, and one that appears in two documents
// and nowhere else is what actually links them.

// Function words and connectives that survive bigramming and would otherwise
// link every pair of documents to every other.
const STOP_GRAMS = new Set(["的的", "我们", "可以", "通过", "进行", "以及", "这个", "那个", "如果", "因为", "所以", "但是", "并且", "其中", "相关", "需要", "一个", "没有", "以上", "以下", "由于", "对于", "关于", "以及", "同时", "目前", "已经", "还有", "什么", "这些", "那些", "不是", "就是", "或者", "而且", "然后", "此外", "例如", "比如"]);
const STOP_WORDS = new Set(["the", "and", "for", "with", "that", "this", "from", "are", "was", "were", "has", "have", "not", "but", "you", "all", "can", "its", "into", "out", "our", "their", "than", "then", "when", "will", "would", "should", "could", "https", "http", "www", "com"]);
const MIN_SHARED = 2;
const TOP_TERMS = 14;

export function documentTerms(text) {
  const counts = new Map();
  const bump = (term) => counts.set(term, (counts.get(term) ?? 0) + 1);
  for (const word of String(text).toLocaleLowerCase().match(/[a-z][a-z0-9+#.-]{2,23}/g) ?? []) {
    if (!STOP_WORDS.has(word)) bump(word);
  }
  // Only runs of Han characters; punctuation and Latin are already handled and
  // must not glue two unrelated characters into a term.
  for (const run of String(text).replace(/[^一-鿿]+/gu, " ").split(" ")) {
    for (let index = 0; index + 2 <= run.length; index += 1) {
      const gram = run.slice(index, index + 2);
      if (!STOP_GRAMS.has(gram)) bump(gram);
    }
  }
  return counts;
}

// Nodes carry their own term counts; this turns the set of them into a graph.
// A term present in nearly every document carries no information about which
// two documents belong together, so it is weighted down to nothing.
export function knowledgeGraph(documents, { minShared = MIN_SHARED, topTerms = TOP_TERMS } = {}) {
  const pages = documents.slice(0, 200);
  const frequency = new Map();
  const counted = pages.map((page) => {
    const counts = documentTerms(`${page.title}\n${page.title}\n${page.text}`);
    for (const term of counts.keys()) frequency.set(term, (frequency.get(term) ?? 0) + 1);
    return counts;
  });
  const idf = (term) => Math.log((pages.length + 1) / ((frequency.get(term) ?? 0) + 0.5));
  const nodes = pages.map((page, index) => {
    const ranked = [...counted[index]]
      // A term in one document only says nothing about relationships either, so
      // it is kept out of the linking vocabulary but not out of the corpus.
      .filter(([term]) => (frequency.get(term) ?? 0) >= 2 && (frequency.get(term) ?? 0) <= Math.max(2, pages.length * 0.6))
      .map(([term, count]) => [term, count * idf(term)])
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, topTerms);
    return { ...page, weight: ranked.reduce((sum, [, score]) => sum + score, 0), terms: ranked.map(([term]) => term), scores: new Map(ranked) };
  });
  const links = [];
  for (let a = 0; a < nodes.length; a += 1) {
    for (let b = a + 1; b < nodes.length; b += 1) {
      const shared = nodes[a].terms.filter((term) => nodes[b].scores.has(term));
      if (shared.length < minShared) continue;
      const strength = shared.reduce((sum, term) => sum + Math.min(nodes[a].scores.get(term), nodes[b].scores.get(term)), 0);
      links.push({ source: nodes[a].id, target: nodes[b].id, shared: shared.slice(0, 6), strength: Number(strength.toFixed(3)) });
    }
  }
  links.sort((a, b) => b.strength - a.strength);
  return { nodes: nodes.map(({ scores, text, ...rest }) => ({ ...rest, weight: Number(rest.weight.toFixed(3)) })), links: links.slice(0, 600) };
}
