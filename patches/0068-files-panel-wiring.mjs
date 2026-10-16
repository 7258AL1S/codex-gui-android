// Patch 0068 — 补上 0067 漏掉的接线（幂等标记撞车）。
//
// 0067 用 `kind==='files'` 当幂等标记，但**上游底部面板里本来就有这个字符串**
// （`action.onclick=kind==='files'?openFolderPicker:null`），于是 `edit()` 一进来就判定
// "已经打过补丁"、把 app.js 的四步全跳过了——后果是文件面板的代码被追加进文件，
// 但 launcher 点「文件」还是走老的 utility 分支（真机日志：`side panel view=utility`）。
//
// PATCHES.md 里 0018/0019 记过同一类坑（"幂等标记撞了上游已有词条"），这次自己又踩了一次。
// 教训写在这里：**标记必须是补丁自己引入的字符串**，不能是上游可能已有的代码片段。
//
// Usage: node patches/0068-files-panel-wiring.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const file = resolve(appDir, "public/app.js");
let source = readFileSync(file, "utf8");

const MARKER = "const filesPanelMarker=null;";
if (source.includes(MARKER)) {
  console.log("skip  public/app.js (already applied)");
  process.exit(0);
}

const steps = [
  [
    "if(kind==='git'){openGitPanel();return}const tab=$('#utilityTab');",
    "if(kind==='git'){openGitPanel();return}if(kind==='files'){openFilesPanel();return}const tab=$('#utilityTab');",
    "launcher routes to the files panel",
  ],
  [
    ",git=view==='git';const gitPanel=$('#gitPanel');if(gitPanel)gitPanel.hidden=!git;",
    ",git=view==='git',files=view==='files';const gitPanel=$('#gitPanel');if(gitPanel)gitPanel.hidden=!git;const filesPanel=$('#filesPanel');if(filesPanel)filesPanel.hidden=!files;",
    "files panel hidden toggle",
  ],
  [
    "if(utility||browser||terminal||sideTask||git)$('#utilityTab').hidden=false;",
    "if(utility||browser||terminal||sideTask||git||files)$('#utilityTab').hidden=false;",
    "reveal the utility tab for files",
  ],
  [
    "title||(launcher?'New tab':review?'Review':git?t('Git'):$('#utilityTab').textContent)",
    "title||(launcher?'New tab':review?'Review':git?t('Git'):files?t('Files'):$('#utilityTab').textContent)",
    "files panel title",
  ],
  [
    "const filesState={path:null,parent:null,root:null,entries:[],notice:null,busy:false,open:null,editing:false};",
    "// 用一个只可能由本补丁引入的字符串做标记：上游也许会有 `kind==='files'`，但不会有这个。\n"
      + "// 标记本身不参与逻辑（永远为 false），只用来让脚本认出\"打过了\"。\n"
      + "const filesPanelMarker=null;\n"
      + "const filesState={path:null,parent:null,root:null,entries:[],notice:null,busy:false,open:null,editing:false};",
    "unique marker",
  ],
];

for (const [from, to, label] of steps) {
  const hits = source.split(from).length - 1;
  if (hits !== 1) throw new Error("cannot locate " + label + " exactly once (hits=" + hits + ")");
  source = source.replace(from, to);
  console.log("apply public/app.js: " + label);
}
writeFileSync(file, source);
console.log("done — rebuild the bundle: cd app && bun build public/app.js --target=browser --outfile=public/app.bundle.js");
