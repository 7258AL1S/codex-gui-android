// Patch 0064 — Git 面板必须能被 hidden 藏起来。
//
// 真机截图 + 日志（patches/0063 加的诊断）里看得很清楚：
//   client: side panel view=launcher … sections=…,gitPanel(hidden), …
//   而屏幕上 Git 面板**照样显示**，还和 launcher 的列表叠在一起。
//
// 原因：`.side-panel-git{display:flex}` 被追加在 style.css 末尾，而把 `[hidden]` 变成
// `display:none` 的规则在前头——两者特异度相同（0,1,0），后写的赢，`hidden` 属性就失效了。
// 上游的面板（如 `.side-panel-browser`）之所以没这个问题，是因为它们在 `[hidden]` 规则之前。
// 修法：给这个类补一条 `[hidden]` 规则（特异度更高），而不是去挪文件顺序。
//
// 顺带把 0063 诊断里的 id 列表写对（'launcher' 不是元素 id，应为 'sidePanelLauncher'）。
//
// Usage: node patches/0064-git-panel-hidden.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);

function edit(file, marker, steps) {
  const path = resolve(appDir, file);
  let source = readFileSync(path, "utf8");
  if (source.includes(marker)) {
    console.log("skip  " + file + " (already applied)");
    return;
  }
  for (const [from, to, label] of steps) {
    const hits = source.split(from).length - 1;
    if (hits !== 1) throw new Error(file + ": cannot locate " + label + " exactly once (hits=" + hits + ")");
    source = source.replace(from, to);
    console.log("apply " + file + ": " + label);
  }
  writeFileSync(path, source);
}

edit("public/style.css", ".side-panel-git[hidden]{display:none}", [
  [
    ".side-panel-git{display:flex;flex-direction:column;gap:10px;min-height:0;overflow:auto;padding:10px 12px 80px}",
    "/* `display:flex` 会盖掉 `[hidden]{display:none}`（同特异度、后写的赢）——必须显式补一条，\n"
      + "   否则未选中时面板照样显示（E121 真机截图里它和 launcher 叠在一起）。 */\n"
      + ".side-panel-git{display:flex;flex-direction:column;gap:10px;min-height:0;overflow:auto;padding:10px 12px 80px}\n"
      + ".side-panel-git[hidden]{display:none}",
    "hidden rule",
  ],
]);

edit("public/app.js", "'sidePanelLauncher','reviewPanelContent'", [
  [
    "['launcher','reviewPanelContent','browserPanel','sideTerminalPanel','sideTaskPanel','utilityPanelContent','gitPanel']",
    "['sidePanelLauncher','reviewPanelContent','browserPanel','sideTerminalPanel','sideTaskPanel','utilityPanelContent','gitPanel']",
    "diagnostic ids",
  ],
]);

console.log("done — rebuild the bundle: cd app && bun build public/app.js --target=browser --outfile=public/app.bundle.js");
