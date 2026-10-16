// Patch 0102 — 点模型输出里的文件路径能打开了（用户报"点 .md 没反应"）。
//
// 根因（真实 bug，不是"没做"）：渲染层确实生成了可点的引用
// （`public/rendering.js` 里 `<a class="file-citation" data-file-reference="…">`），
// 点击处理器也确实派发了 `codex-webui:file-reference` 事件 —— 但**全前端没有任何地方监听它**。
// 而点击处理器先 `preventDefault()` 了，所以连浏览器默认行为都没有：点了就是"什么也没发生"。
// （这也解释了为什么之前"可点击文件"只测到 `<a>` 生成、没测到"点了之后"。）
//
// 这个补丁把缺失的监听补上，并且定好三件事：
//   1. 路径解析：绝对路径原样；`~/` 展开成家目录；相对路径按当前会话 cwd 拼；
//   2. 打开方式：复用侧栏 Files 面板（`openFilesPanel()` + `openFilesFile()`），不新造界面；
//   3. **打不开要说出来**：把桥返回的真实错误 toast 出来，并写进桥日志（`clientLog`），不静默。
//   另外顺手把行号用起来：引用带 `:12-18` 时在查看器里滚到对应位置，并在标题上标出范围。
//
// Usage: node patches/0102-file-reference-click.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const MARKERS = {
  "public/app.js": "openFileReference",
  "public/i18n.js": "\"Could not open {path}\"",
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

const ANCHOR = "function openFilesPanel(){";

const CODE = [
  "// ---- 点模型输出里的文件引用（patches/0102）-----------------------------------",
  "// 之前这里缺了监听：渲染层生成的 `<a data-file-reference>` 被点击后只派发一个事件，",
  "// 没有任何人接，而点击处理器已经 preventDefault 了 —— 用户看到的就是\"点了没反应\"。",
  "function resolveFileReferencePath(rawPath,cwd){",
  "  const value=String(rawPath||'').trim();",
  "  if(!value)return '';",
  "  if(value.startsWith('~/'))return String(state.config?.home||'').replace(/\\/$/,'')+'/'+value.slice(2);",
  "  if(value.startsWith('/'))return value;",
  "  const base=String(cwd||'').replace(/\\/$/,'');",
  "  if(!base)return value;",
  "  // 相对路径里可能有 ./ 前缀，交给桥那边的路径解析去规范化，这里只负责拼出绝对路径",
  "  return base+(value.startsWith('./')?value.slice(1):'/'+value);",
  "}",
  "async function openFileReference(reference){",
  "  const raw=String(reference?.path||'').trim();",
  "  if(!raw){clientLog('file reference: empty path, ignored');return}",
  "  const cwd=filesWorkspaceRoot();",
  "  const target=resolveFileReferencePath(raw,cwd);",
  "  clientLog('file reference click: '+raw+' -> '+target);",
  "  openFilesPanel();",
  "  try{",
  "    await openFilesFile(target);",
  "    if(filesState.notice)throw new Error(filesState.notice);",
  "    const lineStart=Number(reference?.lineStart)||0;",
  "    const lineEnd=Number(reference?.lineEnd)||0;",
  "    if(lineStart>0){",
  "      const name=$('#filesViewerName');",
  "      if(name)name.textContent=shortPath(target)+(lineEnd&&lineEnd!==lineStart?': '+lineStart+'-'+lineEnd:': '+lineStart);",
  "      // 文本查看器是个滚动容器：按行号比例滚过去就够了（精确到行的排版依赖字体，不值当）。",
  "      const viewer=$('#filesViewerText');",
  "      const total=String(filesState.open?.text||'').split('\\n').length;",
  "      if(viewer&&total>1)viewer.scrollTop=Math.max(0,(lineStart-1)/(total-1)*(viewer.scrollHeight-viewer.clientHeight));",
  "    }",
  "  }catch(error){",
  "    const detail=(error&&error.message)||String(error);",
  "    clientLog('file reference FAILED: '+target+' -> '+detail);",
  "    toast(t('Could not open this file')+': '+detail,9000);",
  "  }",
  "}",
  "addEventListener('codex-webui:file-reference',function(event){void openFileReference(event.detail||{})});",
  "",
].join("\n");

patch("public/app.js", (js) => {
  if (!js.includes(ANCHOR)) throw new Error("cannot locate openFilesPanel()");
  return js.replace(ANCHOR, `${CODE}${ANCHOR}`);
});

patch("public/i18n.js", (source) => `${source}

Object.assign(ZH_CN, {
  "Could not open this file": "打不开这个文件",
});
`);

console.log("done — 重建 bundle：cd app && bun build public/app.js --target=browser --outfile=public/app.bundle.js");
