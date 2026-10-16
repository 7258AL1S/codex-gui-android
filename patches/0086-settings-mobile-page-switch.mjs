// Patch 0086 — 手机上在设置里点条目要真的切过去（上游只改高亮，不切视图）。
//
// 现场：手机上打开设置 → 顶部箭头进入条目列表 → 点「配置」→ 高亮变了、**画面还停在列表**，
// 看起来就是"点了没反应"。原因是 `setSettingsPage()` 只做了两件事（设 active、渲染内容），
// 没有把移动端的视图标记从"列表"切到"内容"（`dialog.dataset.mobilePage`），而那个标记只有
// `showSettings()` 会设置。
//
// 修法：在 `setSettingsPage()` 末尾补一句——对话框开着、当前是移动端布局、且正停在列表上时，
// 切到内容视图。桌面端不受影响（那边本来就同屏显示）。
//
// Usage: node patches/0086-settings-mobile-page-switch.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const file = resolve(appDir, "public/app.js");
let source = readFileSync(file, "utf8");

if (source.includes("settings-page-switch")) {
  console.log("skip  public/app.js (already applied)");
} else {
  const from = "$('#settingsPageTitle').textContent=t(settingsPages[selected].title);$('#settingsContent')?.scrollTo({top:0});if(updateRoute&&settingsRoutePage())";
  const to = "$('#settingsPageTitle').textContent=t(settingsPages[selected].title);$('#settingsContent')?.scrollTo({top:0});\n"
    + "  // settings-page-switch：手机上点了条目要真的切到内容视图（上游只设 active，不切视图）。\n"
    + "  const settingsDialog=$('#settingsDialog');\n"
    + "  if(settingsDialog?.open&&settingsDialog.dataset.mobilePage==='false'&&matchMedia('(max-width:480px)').matches)settingsDialog.dataset.mobilePage='true';\n"
    + "  if(updateRoute&&settingsRoutePage())";
  const hits = source.split(from).length - 1;
  if (hits !== 1) throw new Error("cannot locate the tail of setSettingsPage exactly once (hits=" + hits + ")");
  writeFileSync(file, source.replace(from, to));
  console.log("apply public/app.js: mobile settings page switch");
}

console.log("done — rebuild the bundle: cd app && bun build public/app.js --target=browser --outfile=public/app.bundle.js");
