// Patch 0063 — Git 面板的对比度修复 + 让面板自己会说话（诊断）。
//
// 1) 真机截图发现提交按钮是**白底白字**：我写的是 `color:var(--app-bg)`，而这个应用里根本没有
//    `--app-bg`（主按钮用的是 `background:var(--app-text); color:var(--app-main)`，见
//    `.password-login button`）。未定义的变量让 color 变成无效值 → 继承成浅色 → 白字白底。
//    确认框卡片同样改成与 `.permission-confirm-card` 一致的那组变量。
// 2) 顺手给 Git 面板加上 clientLog：动作结果、渲染状态、以及"侧栏标签栏现在长什么样"。
//    上一次是靠自己盯着截图猜，太慢——这类 UI 问题应该在日志里直接读到。
//
// Usage: node patches/0063-git-panel-contrast-and-diagnostics.mjs [appDir]
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

edit("public/style.css", ".git-primary{min-height:36px;border:0;border-radius:9px;background:var(--app-text);color:var(--app-main)", [
  [
    ".git-primary{min-height:36px;border:0;border-radius:9px;background:var(--app-text);color:var(--app-bg);font-size:12.5px;font-weight:600}",
    "/* 主按钮的取色必须和 `.password-login button` 一致：--app-text 背景 + --app-main 文字。\n"
      + "   之前写的 --app-bg 在这个应用里不存在 → color 无效 → 白底白字（E121 截图）。 */\n"
      + ".git-primary{min-height:36px;border:0;border-radius:9px;background:var(--app-text);color:var(--app-main);font-size:12.5px;font-weight:600}",
    "primary button contrast",
  ],
  [
    ".git-confirm-card{display:flex;flex-direction:column;gap:14px;padding:16px;border:1px solid var(--border-strong);border-radius:14px;background:var(--app-bg,#1d1d1d);color:var(--app-text)}",
    ".git-confirm-card{display:flex;flex-direction:column;gap:14px;padding:16px;border:1px solid var(--app-border-default,var(--border-strong));border-radius:14px;background:var(--app-panel,var(--surface));box-shadow:var(--app-elevation-shadow,none);color:var(--app-text)}",
    "confirm card inherits the app dialog look",
  ],
]);

edit("public/app.js", "git panel['+", [
  [
    "  if(!response.ok)throw new Error(data.error||('Git '+action+' failed'));\n  return data;",
    "  clientLog('git '+action+' -> '+response.status+(response.ok?'':' '+(data.error||'')));\n"
      + "  if(!response.ok)throw new Error(data.error||('Git '+action+' failed'));\n  return data;",
    "log git call results",
  ],
  [
    "  gitState.loaded=true;\n  gitState.busy=false;\n  renderGitPanel();",
    "  gitState.loaded=true;\n"
      + "  gitState.busy=false;\n"
      + "  clientLog('git panel['+(gitState.repo||'no repo')+'] err='+(gitState.error||'-')+' staged='+gitState.staged.length+' changes='+gitState.unstaged.length+' untracked='+gitState.untracked.length+' worktrees='+gitState.worktrees.length);\n"
      + "  renderGitPanel();",
    "log the refreshed state",
  ],
  [
    "function setSidePanelView(view,title){const launcher=view==='launcher',review=view==='review',",
    "function sidePanelTabsSnapshot(){try{return [...document.querySelectorAll('.side-panel-tab,#newTab')].map(function(tab){return (tab.dataset.sidePanelTab||tab.id)+(tab.hidden?'(hidden)':'')+(tab.classList.contains('active')?'(active)':'')+'='+String(tab.textContent||'').trim()}).join(' | ')}catch(error){return 'unavailable'}}\n"
      + "function setSidePanelView(view,title){clientLog('side panel view='+view+' title='+(title||'')+' sections='+['launcher','reviewPanelContent','browserPanel','sideTerminalPanel','sideTaskPanel','utilityPanelContent','gitPanel'].map(function(id){const el=$('#'+id);return id+(el?(el.hidden?'(hidden)':'(shown)'):'(missing)')}).join(',')+' tabs='+sidePanelTabsSnapshot());const launcher=view==='launcher',review=view==='review',",
    "log the panel view switch",
  ],
]);

console.log("done — rebuild the bundle: cd app && bun build public/app.js --target=browser --outfile=public/app.bundle.js");
