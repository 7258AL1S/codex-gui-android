// Patch 0103 — 模型输出的本地文件链接：点开就是"在应用里打开"，而不是一条点了没反应的下载链接。
//
// 0102 补上了缺失的监听，但只覆盖了**带行号**的引用（`path:12`）。用户报的场景更常见：
// 模型输出 `[PLAN.md](docs/PLAN.md)` 这种**不带行号**的 Markdown 链接 —— 渲染器走的是
// `data-file-download` 分支（"下载"），而点击处理器对它是"放行"。
// 在 APK 里 WebView 没有任何 DownloadListener，于是**点了什么都不发生**（用户看到的"没反应"）。
//
// 这个补丁把两处都改成"点文件 = 在应用里打开"：
//   1. `rendering.js`：本地路径（无论有没有行号）一律渲染成 `data-file-reference` 引用；
//      下载能力不丢 —— 侧栏查看器本来就有「下载」按钮（E128）。
//   2. `app.js` 的点击处理器：`a[data-file-download]` 不再放行，也按"打开文件"处理
//      （兜住缓存页面/别的来源产生的旧标记）。
//
// 配套：APK 侧补 `DownloadListener` 与 `shouldOverrideUrlLoading`（见 0.3.20），
// 这样即使真有下载/外链，也不再是"静默无反应"。
//
// Usage: node patches/0103-file-links-open-in-app.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const MARKERS = {
  "public/rendering.js": "所以要求\n  // \"最后一段带扩展名\"",
  "public/app.js": "file-download link routed to the viewer",
};

function patch(file, apply) {
  const path = resolve(appDir, file);
  const original = readFileSync(path, "utf8");
  const marker = MARKERS[file];
  if (!marker) throw new Error(`no idempotency marker registered for ${file}`);
  if (original.includes(marker)) {
    console.log(`skip  ${file} (already applied)`);
    return;
  }
  const updated = apply(original);
  if (!updated || updated === original) throw new Error(`patch ${file}: nothing changed`);
  writeFileSync(path, updated);
  console.log(`apply ${file}`);
}

const replaceOnce = (text, from, to, label) => {
  if (!text.includes(from)) throw new Error(`cannot locate: ${label}`);
  return text.replace(from, to);
};

patch("public/rendering.js", (js) => {
  const OLD = `  if (reference.lineStart == null) {
    const filename = imageTitle(reference.path);
    return \`<a class="file-citation file-download" href="\${escapeHtml(localDownloadUrl(reference.path, cwd))}" data-file-download="\${escapeHtml(reference.path)}" download="\${escapeHtml(filename)}" title="\${escapeHtml(\`Download \${reference.path}\`)}">\${label}</a>\`;
  }`;
  const NEW = `  // file-links-open-in-app（patches/0103）：本地路径一律当"打开"，不再直接给下载链接。
  // 原因：带 download 的链接在 APK 的 WebView 里没人处理（没有 DownloadListener），
  // 点了完全没反应；而查看器里本来就有「下载」「分享」「打开」按钮，能力一点没少。
  if (reference.lineStart == null) {
    return \`<a class="file-citation" href="#file-reference" data-file-reference="\${escapeHtml(reference.path)}" title="\${escapeHtml(\`Open \${reference.path}\`)}">\${label}</a>\`;
  }`;
  let out = replaceOnce(js, OLD, NEW, "renderFileReference 的无行号分支");
  // 第三种形态：**裸相对路径**（`docs/PLAN.md`、`docs/PLAN.md:12-18`）。
  // 原来的 `parseFileReference` 只认 `/`、`~/`、`./`、`../`、`C:\` 开头 —— 模型输出里
  // 最常见的相对路径反而不认，于是渲染成普通链接：在 APK 里点了会去导航到一个 404 地址。
  // 但也不能什么相对字符串都当路径（`settings`、`page/2` 是路由不是文件）：
  // 要求"最后一段带扩展名"，行号后缀可选。
  out = replaceOnce(
    out,
    "  const match = path.match(/^((?:\\/|~\\/|\\.{1,2}\\/|[A-Za-z]:[\\\\/])[^?#]*?)(?::(\\d+)(?:-(\\d+))?)?$/);",
    [
      "  // 裸相对路径（`docs/PLAN.md`、`src/server.ts`）也算文件引用 —— 模型输出里最常见的就是这种。",
      "  // 但不能什么相对字符串都当路径（`settings`、`page/2` 是路由不是文件），所以要求",
      "  // \"最后一段带扩展名\"且不含空格/查询串；写文件时大小写、数字、连字符都允许。",
      "  const relativeFile = /^(?![a-z][a-z0-9+.-]*:)([A-Za-z0-9._~%+=@-]+(?:\\/[A-Za-z0-9._~%+=@-]+)*\\.[A-Za-z0-9]{1,12})(?::(\\d+)(?:-(\\d+))?)?$/i.exec(path);",
      "  const match = relativeFile || path.match(/^((?:\\/|~\\/|\\.{1,2}\\/|[A-Za-z]:[\\\\/])[^?#]*?)(?::(\\d+)(?:-(\\d+))?)?$/);",
    ].join("\n"),
    "parseFileReference 的相对路径支持",
  );
  return out;
});

patch("public/app.js", (js) => {
  const OLD = "if(target?.closest('a[data-file-download]'))return;";
  const NEW = "if(target?.closest('a[data-file-download]')){/* file-download link routed to the viewer（patches/0103）：放过它=点了没反应，所以也按打开处理 */}";
  return replaceOnce(js, OLD, NEW, "点击处理器里的 download 放行分支");
});

console.log("done — 重建 bundle：cd app && bun build public/app.js --target=browser --outfile=public/app.bundle.js");
