export function textLineNumbers(text) {
  const count = Math.max(1, String(text ?? "").split("\n").length);
  return Array.from({ length: count }, (_, index) => String(index + 1)).join("\n");
}

export function previewPageReference(page) {
  if (!page || typeof page.path !== "string" || typeof page.revision !== "string" || typeof page.title !== "string") throw new Error("当前页面还没有加载完成");
  return { kind: "page", key: `page:${page.path}:${page.revision}`, path: page.path, revision: page.revision,
    title: page.title.slice(0, 500), address: `/${page.path}`, state: "current" };
}
