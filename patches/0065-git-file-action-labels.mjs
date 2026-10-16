// Patch 0065 — 文件行里的动作按钮漏译：显示成 "stage" / "discard" 而不是「暂存」「丢弃改动」。
//
// 原因是我在 renderGitList 里把动作名（stage/unstage/discard）直接当词条键用了，
// 而 i18n 表里的键是首字母大写的 Stage/Unstage/Discard。改成显式映射，
// 顺带把"动作名"和"显示文案"这两件事分开——以后加动作不会再踩。
//
// Usage: node patches/0065-git-file-action-labels.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const file = resolve(appDir, "public/app.js");
let source = readFileSync(file, "utf8");

if (source.includes("GIT_FILE_ACTION_LABELS")) {
  console.log("skip  public/app.js (already applied)");
} else {
  const steps = [
    [
      "    button.textContent=t(action);\n    button.onclick=function(){void runGitFileAction(action,entry.path)};",
      "    button.textContent=t(GIT_FILE_ACTION_LABELS[action]||action);\n"
        + "    button.onclick=function(){void runGitFileAction(action,entry.path)};",
      "use label table",
    ],
    [
      "function gitFileRow(entry,actions){",
      "// 动作名（协议/桥用的）与显示文案分开：前者是 stage/unstage/discard，后者走 i18n。\n"
        + "const GIT_FILE_ACTION_LABELS={stage:'Stage',unstage:'Unstage',discard:'Discard'};\n"
        + "function gitFileRow(entry,actions){",
      "label table",
    ],
    [
      "  const labels={stage:t('Stage'),unstage:t('Unstage'),discard:t('Discard')};",
      "  const labels={stage:t('Stage'),unstage:t('Unstage'),discard:t('Discard')};\n"
        + "  // 丢弃是唯一会真的丢东西的动作：确认文案与按钮文案一致，别让用户猜哪个按钮更狠。",
      "discard confirm note",
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

console.log("done — rebuild the bundle: cd app && bun build public/app.js --target=browser --outfile=public/app.bundle.js");
