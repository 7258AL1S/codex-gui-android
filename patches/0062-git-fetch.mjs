// Patch 0062 — Git 面板补一个 Fetch，并在打开面板时尽力取一次远端引用。
//
// 为什么必须有：`ahead/behind` 是拿**本地** remote-tracking ref 算出来的，不 fetch 永远是
// 上次的样子（probe/git-api.mjs 把这条语义钉住了：远端多一个提交后，不 fetch 的 behind 仍是 0，
// fetch 之后才是 1）。桌面端会自动 fetch，这里照做——但手机上要克制：
//   - 打开面板：先渲染本地状态，再**尽力**fetch 一次并刷新；本地无 remote / 断网 / 要凭据都静默跳过；
//   - 手动点 Fetch：失败原因原样弹出来（网络、鉴权、远端拒绝都要看得见）。
//
// Usage: node patches/0062-git-fetch.mjs [appDir]
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

edit("public/index.html", 'id="gitFetch"', [
  [
    '        <button type="button" id="gitPull">Pull</button>',
    '        <button type="button" id="gitFetch">Fetch</button>\n        <button type="button" id="gitPull">Pull</button>',
    "fetch button",
  ],
]);

edit("public/app.js", "autoFetchGitPanel", [
  [
    "  for(const id of ['#gitRefresh','#gitPull','#gitPush','#gitCommitButton','#gitWorktreeCreate','#gitWorktreePrune']){",
    "  for(const id of ['#gitRefresh','#gitFetch','#gitPull','#gitPush','#gitCommitButton','#gitWorktreeCreate','#gitWorktreePrune']){",
    "sync fetch button",
  ],
  [
    "  setSidePanelOpen(true,false);\n  setSidePanelView('git',t('Git'));\n  void refreshGitPanel();\n}",
    "  setSidePanelOpen(true,false);\n"
      + "  setSidePanelView('git',t('Git'));\n"
      + "  void refreshGitPanel().then(autoFetchGitPanel);\n"
      + "}\n"
      + "\n"
      + "// 尽力取一次远端引用：本地没有 remote、断网、需要凭据都属正常，静默跳过——\n"
      + "// 它只负责把 ahead/behind 从\"上次的样子\"更新成\"现在的样子\"。\n"
      + "async function autoFetchGitPanel(){\n"
      + "  try{await gitCall('fetch')}catch(error){return}\n"
      + "  await refreshGitPanel();\n"
      + "}",
    "auto fetch on open",
  ],
  [
    "  const pull=$('#gitPull');\n  if(pull)pull.onclick=function(){void gitRemoteAction('pull')};",
    "  const fetch=$('#gitFetch');\n"
      + "  if(fetch)fetch.onclick=async function(){\n"
      + "    try{await gitCall('fetch');toast(t('Fetched'))}catch(error){toast(error.message)}\n"
      + "    await refreshGitPanel();\n"
      + "  };\n"
      + "  const pull=$('#gitPull');\n  if(pull)pull.onclick=function(){void gitRemoteAction('pull')};",
    "wire fetch button",
  ],
]);

edit("public/i18n.js", '"Fetch": "取回远端"', [
  ['  "Pull": "拉取",\n', '  "Fetch": "取回远端",\n  "Fetched": "已取回远端引用",\n  "Pull": "拉取",\n', "fetch entries"],
]);

console.log("done — rebuild the bundle: cd app && bun build public/app.js --target=browser --outfile=public/app.bundle.js");
