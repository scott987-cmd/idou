import test from "node:test";
import assert from "node:assert/strict";
import { bundleStaticApp, resolveAppPath, mimeFor, escapeForElement } from "../src/apps/single-file.js";

const file = (path, text) => ({ path, bytes: Buffer.from(text, "utf8") });
const png = (path) => ({ path, bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) });

test("样式、脚本和图片都被收进同一个文件，页面不再依赖任何同目录文件", () => {
  const result = bundleStaticApp({ entry: "index.html", files: [
    file("index.html", `<!doctype html><link rel="stylesheet" href="app.css"><img src="logo.png"><script src="app.js"></script>`),
    file("app.css", "body{color:red}"), file("app.js", "console.log(1)"), png("logo.png")] });
  assert.match(result.html, /<style>\s*body\{color:red\}/);
  assert.match(result.html, /<script>\s*console\.log\(1\)/);
  assert.match(result.html, /src="data:image\/png;base64,/);
  assert.doesNotMatch(result.html, /href="app\.css"|src="app\.js"|src="logo\.png"/);
  assert.deepEqual(result.inlined, ["app.css", "app.js", "logo.png"]);
  assert.deepEqual(result.external, []);
  assert.deepEqual(result.missing, []);
});

test("脚本里出现 </script> 不能把文件截断", () => {
  const result = bundleStaticApp({ entry: "index.html", files: [
    file("index.html", `<script src="a.js"></script>`),
    file("a.js", `const s = "</script><img src=x onerror=alert(1)>";`)] });
  // Left unescaped this ends the script element early and the rest becomes markup.
  assert.doesNotMatch(result.html, /<\/script><img/);
  assert.match(result.html, /<\\\/script>/);
  assert.equal(result.html.match(/<\/script>/g).length, 1);
});

test("样式里出现 </style> 同样不能截断", () => {
  const result = bundleStaticApp({ entry: "index.html", files: [
    file("index.html", `<link rel="stylesheet" href="a.css">`),
    file("a.css", `body{content:"</style><script>alert(1)</script>"}`)] });
  assert.doesNotMatch(result.html, /<\/style><script>/);
  assert.match(result.html, /<\\\/style>/);
});

test("CSS 里的 url() 也跟着进来，包括被样式引用的图片", () => {
  const result = bundleStaticApp({ entry: "index.html", files: [
    file("index.html", `<link rel="stylesheet" href="css/app.css">`),
    file("css/app.css", `body{background:url("../img/bg.png")}`), png("img/bg.png")] });
  assert.match(result.html, /background:url\("data:image\/png;base64,/);
  assert.ok(result.inlined.includes("img/bg.png"));
});

test("外部链接原样保留并如实报告，不假装是自包含的", () => {
  const result = bundleStaticApp({ entry: "index.html", files: [
    file("index.html", `<script src="https://cdn.example.com/x.js"></script><img src="//cdn.example.com/a.png">`)] });
  assert.match(result.html, /https:\/\/cdn\.example\.com\/x\.js/);
  assert.deepEqual(result.external, ["//cdn.example.com/a.png", "https://cdn.example.com/x.js"]);
});

test("引用了包里没有的文件会被报出来，而不是悄悄变成坏链接", () => {
  const result = bundleStaticApp({ entry: "index.html", files: [file("index.html", `<img src="gone.png">`)] });
  assert.deepEqual(result.missing, ["gone.png"]);
  assert.match(result.html, /src="gone\.png"/);
});

test("路径不能跳出应用目录", () => {
  assert.equal(resolveAppPath("index.html", "../../etc/passwd"), null);
  assert.equal(resolveAppPath("a/b/page.html", "../style.css"), "a/style.css");
  assert.equal(resolveAppPath("index.html", "/assets/x.png"), "assets/x.png");
  assert.equal(resolveAppPath("index.html", "img.png?v=2#frag"), "img.png");
  for (const bad of ["", "   ", "#top", "data:text/html,x", "javascript:alert(1)"]) assert.equal(resolveAppPath("index.html", bad), null);
});

test("没有入口就不出包", () => {
  assert.throws(() => bundleStaticApp({ entry: "index.html", files: [file("other.html", "x")] }), /找不到应用入口/);
});

test("没被引用到的文件会列出来，让人知道它们没进包", () => {
  const result = bundleStaticApp({ entry: "index.html", files: [file("index.html", "<p>hi</p>"), file("orphan.js", "x")] });
  assert.deepEqual(result.unused, ["orphan.js"]);
});

test("类型和转义的基本约定", () => {
  assert.equal(mimeFor("a/b.PNG"), "image/png");
  assert.equal(mimeFor("x.unknown"), "application/octet-stream");
  assert.equal(escapeForElement("</SCRIPT>", "script"), "<\\/SCRIPT>");
});
