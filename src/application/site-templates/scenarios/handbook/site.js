// The chapter being read is marked in the contents. A page that works without
// this -- the contents are plain links -- is only helped by it.
(function () {
  var links = Array.prototype.slice.call(document.querySelectorAll(".toc a[href^='#']"));
  var chapters = links.map(function (link) { return document.getElementById(link.getAttribute("href").slice(1)); }).filter(Boolean);
  if (!chapters.length || !("IntersectionObserver" in window)) return;
  var mark = function (id) {
    links.forEach(function (link) {
      if (link.getAttribute("href") === "#" + id) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    });
  };
  mark(chapters[0].id);
  var seen = new Map();
  var watcher = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) { seen.set(entry.target.id, entry.isIntersecting ? entry.intersectionRatio : 0); });
    var best = chapters.find(function (chapter) { return (seen.get(chapter.id) || 0) > 0; });
    if (best) mark(best.id);
  }, { rootMargin: "0px 0px -60% 0px", threshold: [0, 0.01, 0.5] });
  chapters.forEach(function (chapter) { watcher.observe(chapter); });
})();
