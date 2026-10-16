// Patch 0092 — 文件搜索的路径是"工作区相对路径"，面板当绝对路径用 → 打开必失败。
//
// 现场（真机，P7 收尾时顺手点到）：在文件面板里搜 "preview" → 结果列表正常（`tmp/preview.html`），
// 点它却报 `No such file or directory (os error 2)`。
// 原因：桥的 `searchWorkspaceFiles()` 返回的是**相对工作区的路径**
// （`file-search.js`：`matches.push({ path: relativePath, kind })`），而面板把 `item.path`
// 直接交给了 `openFilesFile()` → 桥按自己的 cwd 解析 → ENOENT。
//
// 修法：搜索映射时把相对路径补成绝对路径（相对 `filesState.root`），并区分 `kind==='folder'`
// （点目录应该"进目录"，不是"读文件"）。
//
// Usage: node patches/0092-files-search-relative-paths.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const file = resolve(appDir, "public/app.js");
let source = readFileSync(file, "utf8");

if (source.includes("filesSearchAbsolutePath")) {
  console.log("skip  public/app.js (already applied)");
} else {
  const steps = [
    [
      "    filesState.entries=(data.items||[]).map(function(item){return {name:shortPath(item.path||item.name||''),path:item.path,directory:false}});",
      "    // 搜索结果给的是**工作区相对路径**（file-search.js 里就是 relativePath），\n"
        + "    // 必须补成绝对路径，否则点开时桥按自己的 cwd 解析、直接 ENOENT（真机撞过）。\n"
        + "    // 注意：这个函数里已经有一个 `root`（工作区根），不要再声明一遍——\n"
        + "    // 第一版就是这么写的，bundle 直接构建失败（duplicate declaration）。\n"
        + "    const filesSearchAbsolutePath=function(raw){const value=String(raw||'');if(!value||value.startsWith('/'))return value;return ((root||'').replace(/\\/+$/,'')+'/'+value).replace(/\\/{2,}/g,'/')};\n"
        + "    filesState.entries=(data.items||[]).map(function(item){const path=filesSearchAbsolutePath(item.path);return {name:shortPath(path||item.name||''),path,directory:item.kind==='folder'}});",
      "resolve search results against the workspace root",
    ],
    [
      "    await openFilesFile(item.path);",
      "    await openFilesFile(item.path);",
      "anchor check (no-op)",
    ],
  ];
  for (const [from, to, label] of steps) {
    if (from === to) continue;
    const hits = source.split(from).length - 1;
    if (hits !== 1) throw new Error("cannot locate " + label + " exactly once (hits=" + hits + ")");
    source = source.replace(from, to);
    console.log("apply public/app.js: " + label);
  }
  writeFileSync(file, source);
}

console.log("done — rebuild the bundle: cd app && bun build public/app.js --target=browser --outfile=public/app.bundle.js");
