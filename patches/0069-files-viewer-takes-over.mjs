// Patch 0069 — 打开文件后，查看器要接管面板（而不是堆在列表下面）。
//
// 真机截图（~/shots/p6-54-band.png）：点文件后，查看器被追加在列表**下面**，
// 手机上得先滚过整个目录才看得到内容——等于"打开了却看不见"。
//
// 改法：查看器打开时藏起搜索框与列表，关闭时还原；两处都补 `[hidden]` 规则，
// 因为 `.files-list{display:flex}` 同样会盖掉 `[hidden]{display:none}`（0064 的同一类坑）。
//
// Usage: node patches/0069-files-viewer-takes-over.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const file = resolve(appDir, "public/app.js");
let source = readFileSync(file, "utf8");

if (source.includes("filesPanelFocusViewer")) {
  console.log("skip  public/app.js (already applied)");
} else {
  const steps = [
    [
      "    const viewer=$('#filesViewer');\n    if(viewer)viewer.hidden=false;",
      "    // 手机上查看器要独占面板：列表让位（否则内容排在整页目录下面，等于打不开）。\n"
        + "    filesPanelFocusViewer(true);",
      "hide the list while viewing",
    ],
    [
      "function closeFilesFile(){",
      "function filesPanelFocusViewer(viewing){\n"
        + "  const list=$('#filesList'),search=$('#filesSearchForm'),viewer=$('#filesViewer');\n"
        + "  if(list)list.hidden=viewing;\n"
        + "  if(search)search.hidden=viewing;\n"
        + "  if(viewer)viewer.hidden=!viewing;\n"
        + "}\n"
        + "function closeFilesFile(){",
      "focus helper",
    ],
    [
      "  filesState.open=null;filesState.editing=false;\n  const viewer=$('#filesViewer');\n  if(viewer)viewer.hidden=true;\n}",
      "  filesState.open=null;filesState.editing=false;\n  filesPanelFocusViewer(false);\n}",
      "restore the list on close",
    ],
  ];
  for (const [from, to, label] of steps) {
    const hits = source.split(from).length - 1;
    if (hits !== 1) throw new Error("cannot locate " + label + " exactly once (hits=" + hits + ")");
    source = source.replace(from, to);
    console.log("apply public/app.js: " + label);
  }
  writeFileSync(file, source);
}

{
  const path = resolve(appDir, "public/style.css");
  let css = readFileSync(path, "utf8");
  if (css.includes(".files-list[hidden]")) {
    console.log("skip  public/style.css (already applied)");
  } else {
    const from = ".files-list{flex:none;display:flex;flex-direction:column;gap:1px}";
    if (css.split(from).length - 1 !== 1) throw new Error("cannot locate .files-list rule");
    writeFileSync(path, css.replace(from, from + "\n"
      + "/* display:flex 会盖掉 [hidden]{display:none}（同特异度、后写的赢）——和 0064 同一类坑。 */\n"
      + ".files-list[hidden],.files-search[hidden]{display:none}\n"
      + "/* .icon-button 也自带 display，同样会盖掉 hidden——查看器的\"保存\"按钮靠这条才藏得住。 */\n"
      + ".icon-button[hidden]{display:none}"));
    console.log("apply public/style.css: hidden rules");
  }
}

console.log("done — rebuild the bundle: cd app && bun build public/app.js --target=browser --outfile=public/app.bundle.js");
