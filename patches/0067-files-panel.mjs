// Patch 0067 — 文件面板（P6 的"文件树 / 搜索 / 文本读取与基本编辑"）。
//
// 后端来源是**协议自带**的 `fs/readDirectory` / `fs/readFile` / `fs/writeFile`（A 类），
// 由桥转成 `POST /api/fs {action, path|cwd|query}`：
//   - 路径一律先用 `resolveBrowsePath` 过一遍允许根（home），`~` 展开在桥里做；
//   - 读取有大小上限（2 MB），超过就明说读不了，而不是塞一个截断结果假装成功；
//   - 写入同样是 base64 直传协议（不做"前端存了但后端没写"的假成功）。
// 形状已用 probe/raw-rpc.mjs 实测：readDirectory → {fileName,isDirectory,isFile}[]、
// readFile → {dataBase64}、writeFile 真的落到磁盘。
//
// 搜索复用桥里已有的 `searchWorkspaceFiles`（与 composer 的 @ 补全同一个实现），
// 不再另写一遍——省得两处行为不一致。
//
// 手机上不做"多栏文件树"，做一层可上下走的列表：搜索框 + 上级 + 目录/文件行 + 文本查看/编辑。
//
// Usage: node patches/0067-files-panel.mjs [appDir]
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

// --- 桥：/api/fs -------------------------------------------------------------

edit("server.ts", '"/api/fs"', [
  [
    'const browseRoots = defaultBrowseRoots(homeDir);',
    'const browseRoots = defaultBrowseRoots(homeDir);\n'
      + '// 文件面板的额外根（默认空；不动用户任何配置，只是留一个口子）。\n'
      + 'const extraFileRoots = (process.env.CODEX_WEBUI_FILE_ROOTS || "").split(":").filter(Boolean).map((entry) => resolve(entry));\n'
      + '// 手机上打开 2 MB 以上的文本没有意义（渲染会卡死），写入同理。\n'
      + 'const FILE_READ_MAX_BYTES = 2 * 1024 * 1024;\n'
      + 'const FILE_WRITE_MAX_BYTES = 2 * 1024 * 1024;',
    "file panel roots and caps",
  ],
  [
    '  if (url.pathname === "/api/git") {',
    '  if (url.pathname === "/api/fs") {\n'
      + '    if (req.method !== "POST") {\n'
      + '      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "POST" });\n'
      + '      res.end(JSON.stringify({ error: "Method not allowed" }));\n'
      + '      return;\n'
      + '    }\n'
      + '    let fsBody = "";\n'
      + '    req.setEncoding("utf8");\n'
      + '    req.on("data", (chunk) => {\n'
      + '      fsBody += chunk;\n'
      + '      if (fsBody.length > 8_000_000) req.destroy(new Error("File payload too large"));\n'
      + '    });\n'
      + '    req.on("end", async () => {\n'
      + '      let status = 200;\n'
      + '      let payload: any;\n'
      + '      try {\n'
      + '        const body = JSON.parse(fsBody || "{}");\n'
      + '        const action = String(body.action ?? "");\n'
      + '        const allowedRoots = [...browseRoots, ...extraFileRoots];\n'
      + '        if (action === "list") {\n'
      + '          const dir = resolveBrowsePath(String(body.path || "~"), allowedRoots, homeDir);\n'
      + '          // 形状：{entries:[…]}（FsReadDirectoryResponse），不是裸数组。\n'
      + '          const listing = await request("fs/readDirectory", { path: dir });\n'
      + '          const entries = Array.isArray(listing?.entries) ? listing.entries : [];\n'
      + '          payload = {\n'
      + '            ok: true,\n'
      + '            path: dir,\n'
      + '            parent: dir === resolve("/") ? null : resolve(dir, ".."),\n'
      + '            entries: (entries || []).map((entry: any) => ({\n'
      + '              name: entry.fileName,\n'
      + '              directory: Boolean(entry.isDirectory),\n'
      + '              file: Boolean(entry.isFile),\n'
      + '              path: resolve(dir, entry.fileName),\n'
      + '            })).sort((a: any, b: any) => (a.directory === b.directory ? a.name.localeCompare(b.name) : a.directory ? -1 : 1)),\n'
      + '          };\n'
      + '        } else if (action === "read") {\n'
      + '          const target = resolveBrowsePath(String(body.path || ""), allowedRoots, homeDir);\n'
      + '          const metadata = await request("fs/getMetadata", { path: target });\n'
      + '          if (metadata?.isDirectory) throw new Error("That path is a directory");\n'
      + '          // 协议 getMetadata **不返回大小**（只有 isDirectory/isFile/isSymlink/时间戳），\n'
      + '          // 所以大小上限用本地 stat 预检（桥和 app-server 在同一台机器上），读完再按真实长度复核一次。\n'
      + '          const stat = statSync(target);\n'
      + '          if (stat.size > FILE_READ_MAX_BYTES) throw new Error(`File is too large to open here (${Math.round(stat.size / 1024)} KB)`);\n'
      + '          const result = await request("fs/readFile", { path: target });\n'
      + '          const data = Buffer.from(String(result?.dataBase64 || ""), "base64");\n'
      + '          if (data.length > FILE_READ_MAX_BYTES) throw new Error("File is too large to open here");\n'
      + '          const binary = data.includes(0);\n'
      + '          payload = {\n'
      + '            ok: true,\n'
      + '            path: target,\n'
      + '            size: data.length,\n'
      + '            binary,\n'
      + '            text: binary ? "" : data.toString("utf8"),\n'
      + '          };\n'
      + '        } else if (action === "write") {\n'
      + '          const target = resolveBrowsePath(String(body.path || ""), allowedRoots, homeDir);\n'
      + '          const data = Buffer.from(String(body.dataBase64 || ""), "base64");\n'
      + '          if (data.length > FILE_WRITE_MAX_BYTES) throw new Error("File is too large to write from here");\n'
      + '          await request("fs/writeFile", { path: target, dataBase64: data.toString("base64") });\n'
      + '          payload = { ok: true, path: target, size: data.length };\n'
      + '        } else if (action === "search") {\n'
      + '          const cwd = String(body.cwd || defaultCwd);\n'
      + '          const items = await searchWorkspaceFiles(cwd, String(body.query || ""), { allowedRoots, limit: 30 });\n'
      + '          payload = { ok: true, cwd, items };\n'
      + '        } else {\n'
      + '          throw new Error(`Unsupported file action: ${action}`);\n'
      + '        }\n'
      + '      } catch (error) {\n'
      + '        status = 400;\n'
      + '        payload = { error: error instanceof Error ? error.message : String(error) };\n'
      + '      }\n'
      + '      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });\n'
      + '      res.end(JSON.stringify(payload));\n'
      + '    });\n'
      + '    return;\n'
      + '  }\n'
      + '  if (url.pathname === "/api/git") {',
    "files route",
  ],
]);

// --- 前端：文件面板 ----------------------------------------------------------

const PANEL_HTML = [
  '    <section class="side-panel-files" id="filesPanel" role="tabpanel" hidden aria-label="Files">',
  '      <div class="files-toolbar">',
  '        <button class="icon-button small" id="filesUp" type="button" title="Go up"><span class="icon-slot" data-icon="arrowUp"></span></button>',
  '        <span class="files-path" id="filesPath">—</span>',
  '        <button class="icon-button small" id="filesRoot" type="button" title="Workspace root"><span class="icon-slot" data-icon="folderOpen"></span></button>',
  '      </div>',
  '      <form class="files-search" id="filesSearchForm">',
  '        <input id="filesSearchInput" type="search" placeholder="Search files" autocomplete="off" spellcheck="false">',
  '      </form>',
  '      <div class="files-notice" id="filesNotice" hidden></div>',
  '      <div class="files-list" id="filesList"></div>',
  '      <div class="files-viewer" id="filesViewer" hidden>',
  '        <div class="files-viewer-head">',
  '          <button class="icon-button small" id="filesViewerClose" type="button" title="Close file"><span class="icon-slot" data-icon="chevronLeft"></span></button>',
  '          <span class="files-viewer-name" id="filesViewerName"></span>',
  '          <button class="icon-button small" id="filesViewerEdit" type="button" title="Edit"><span class="icon-slot" data-icon="wrench"></span></button>',
  '          <button class="icon-button small" id="filesViewerSave" type="button" title="Save" hidden><span class="icon-slot" data-icon="check"></span></button>',
  '        </div>',
  '        <pre class="files-viewer-text" id="filesViewerText"></pre>',
  '        <textarea class="files-viewer-editor" id="filesViewerEditor" hidden spellcheck="false"></textarea>',
  '      </div>',
  '    </section>',
].join("\n");

edit("public/index.html", 'id="filesPanel"', [
  [
    '    <section class="side-panel-git" id="gitPanel" role="tabpanel" hidden aria-label="Git">',
    PANEL_HTML + "\n" + '    <section class="side-panel-git" id="gitPanel" role="tabpanel" hidden aria-label="Git">',
    "files panel section",
  ],
]);

const JS_BLOCK = [
  "",
  "// --- 文件面板（patches/0067）------------------------------------------------",
  "// 后端是协议的 fs/readDirectory / fs/readFile / fs/writeFile（桥转成 /api/fs）。",
  "// 手机上一屏只做一件事：列表（目录在前）→ 点文件进查看 → 编辑切换 → 保存。",
  "// 读取上限 2 MB、超出/二进制都明说，不截断也不假装成功。",
  "const filesState={path:null,parent:null,root:null,entries:[],notice:null,busy:false,open:null,editing:false};",
  "",
  "function filesWorkspaceRoot(){return state.active?.cwd||state.workspaceContext?.cwd||state.config?.defaultCwd||null}",
  "",
  "function formatBytes(bytes){",
  "  const value=Number(bytes)||0;",
  "  if(value<1024)return value+' B';",
  "  if(value<1024*1024)return (value/1024).toFixed(1)+' KB';",
  "  return (value/1048576).toFixed(1)+' MB';",
  "}",
  "",
  "async function filesCall(action,extra){",
  "  const response=await fetch('/api/fs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.assign({action},extra||{}))});",
  "  const data=await response.json().catch(function(){return {}});",
  "  clientLog('fs '+action+' -> '+response.status+(response.ok?'':' '+(data.error||'')));",
  "  if(!response.ok)throw new Error(data.error||('Files '+action+' failed'));",
  "  return data;",
  "}",
  "",
  "function renderFilesPanel(){",
  "  const notice=$('#filesNotice');",
  "  if(notice){",
  "    if(filesState.notice){notice.hidden=false;notice.textContent=filesState.notice}",
  "    else{notice.hidden=true;notice.textContent=''}",
  "  }",
  "  const path=$('#filesPath');",
  "  if(path)path.textContent=filesState.path?shortPath(filesState.path):'—';",
  "  const up=$('#filesUp');",
  "  if(up)up.disabled=!filesState.path||filesState.path===filesState.root;",
  "  const list=$('#filesList');",
  "  if(!list)return;",
  "  list.innerHTML='';",
  "  if(filesState.busy){list.innerHTML='<div class=\"files-empty\">'+escapeHtml(t('Loading…'))+'</div>';return}",
  "  if(!filesState.entries.length){list.innerHTML='<div class=\"files-empty\">'+escapeHtml(t('Nothing here'))+'</div>';return}",
  "  for(const entry of filesState.entries){",
  "    const row=document.createElement('button');",
  "    row.type='button';",
  "    row.className='files-row'+(entry.directory?' directory':'');",
  "    row.innerHTML='<span class=\"icon-slot\">'+codexIcon(entry.directory?'folderOpen':'file')+'</span>'",
  "      +'<span class=\"files-row-name\">'+escapeHtml(entry.name)+'</span>';",
  "    row.onclick=function(){entry.directory?void openFilesDir(entry.path):void openFilesFile(entry.path)};",
  "    list.append(row);",
  "  }",
  "}",
  "",
  "async function openFilesDir(path){",
  "  if(!path)return;",
  "  filesState.busy=true;filesState.notice=null;renderFilesPanel();",
  "  try{",
  "    const data=await filesCall('list',{path});",
  "    filesState.path=data.path;",
  "    filesState.parent=data.parent;",
  "    filesState.entries=data.entries||[];",
  "    if(!filesState.root)filesState.root=data.path;",
  "  }catch(error){filesState.notice=error.message;filesState.entries=[]}",
  "  filesState.busy=false;",
  "  renderFilesPanel();",
  "}",
  "",
  "async function openFilesFile(path){",
  "  filesState.busy=true;filesState.notice=null;renderFilesPanel();",
  "  try{",
  "    const data=await filesCall('read',{path});",
  "    filesState.open=data;",
  "    filesState.editing=false;",
  "    const viewer=$('#filesViewer');",
  "    if(viewer)viewer.hidden=false;",
  "    const name=$('#filesViewerName');",
  "    if(name)name.textContent=shortPath(data.path)+' · '+formatBytes(data.size);",
  "    const text=$('#filesViewerText');",
  "    const editor=$('#filesViewerEditor');",
  "    const edit=$('#filesViewerEdit');",
  "    const save=$('#filesViewerSave');",
  "    if(data.binary){",
  "      if(text){text.hidden=false;text.textContent=t('Binary file — no text preview')}",
  "      if(editor){editor.hidden=true;editor.value=''}",
  "      if(edit)edit.hidden=true;",
  "    }else{",
  "      if(text){text.hidden=false;text.textContent=data.text}",
  "      if(editor){editor.hidden=true;editor.value=data.text}",
  "      if(edit)edit.hidden=false;",
  "    }",
  "    if(save)save.hidden=true;",
  "  }catch(error){filesState.notice=error.message}",
  "  filesState.busy=false;",
  "  renderFilesPanel();",
  "}",
  "",
  "function closeFilesFile(){",
  "  filesState.open=null;filesState.editing=false;",
  "  const viewer=$('#filesViewer');",
  "  if(viewer)viewer.hidden=true;",
  "}",
  "",
  "function toggleFilesEdit(){",
  "  if(!filesState.open||filesState.open.binary)return;",
  "  filesState.editing=!filesState.editing;",
  "  const text=$('#filesViewerText'),editor=$('#filesViewerEditor'),save=$('#filesViewerSave');",
  "  if(editor)editor.hidden=!filesState.editing;",
  "  if(text)text.hidden=filesState.editing;",
  "  if(save)save.hidden=!filesState.editing;",
  "  if(filesState.editing&&editor)editor.focus();",
  "}",
  "",
  "async function saveFilesFile(){",
  "  const editor=$('#filesViewerEditor');",
  "  if(!filesState.open||!editor)return;",
  "  const target=filesState.open.path;",
  "  const ok=await gitConfirm({title:t('Save file?'),message:shortPath(target),confirmLabel:t('Save')});",
  "  if(!ok)return;",
  "  try{",
  "    const bytes=new TextEncoder().encode(editor.value);",
  "    let raw='';",
  "    for(const byte of bytes)raw+=String.fromCharCode(byte);",
  "    const data=await filesCall('write',{path:target,dataBase64:btoa(raw)});",
  "    filesState.open={path:target,size:data.size,binary:false,text:editor.value};",
  "    const text=$('#filesViewerText');",
  "    if(text)text.textContent=editor.value;",
  "    toggleFilesEdit();",
  "    toast(t('Saved'));",
  "  }catch(error){toast(error.message)}",
  "}",
  "",
  "async function searchFiles(query){",
  "  const needle=String(query||'').trim();",
  "  if(!needle){await openFilesDir(filesState.path||filesWorkspaceRoot());return}",
  "  filesState.busy=true;filesState.notice=null;renderFilesPanel();",
  "  try{",
  "    const root=filesWorkspaceRoot()||filesState.root;",
  "    const data=await filesCall('search',{cwd:root,query:needle});",
  "    filesState.entries=(data.items||[]).map(function(item){return {name:shortPath(item.path||item.name||''),path:item.path,directory:false}});",
  "    filesState.path=null;",
  "    if(!filesState.entries.length)filesState.notice=t('No matches');",
  "  }catch(error){filesState.notice=error.message;filesState.entries=[]}",
  "  filesState.busy=false;",
  "  renderFilesPanel();",
  "}",
  "",
  "function openFilesPanel(){",
  "  const tab=$('#utilityTab');",
  "  if(tab){tab.textContent=t('Files');tab.dataset.sidePanelTab='files';tab.hidden=false}",
  "  setSidePanelOpen(true,false);",
  "  setSidePanelView('files',t('Files'));",
  "  const root=filesWorkspaceRoot();",
  "  filesState.root=root;",
  "  closeFilesFile();",
  "  void openFilesDir(filesState.path||root);",
  "}",
  "",
  "function wireFilesPanel(){",
  "  const up=$('#filesUp');",
  "  if(up)up.onclick=function(){if(filesState.parent)void openFilesDir(filesState.parent)};",
  "  const root=$('#filesRoot');",
  "  if(root)root.onclick=function(){const target=filesWorkspaceRoot();filesState.root=target;void openFilesDir(target)};",
  "  const form=$('#filesSearchForm');",
  "  if(form)form.onsubmit=function(event){event.preventDefault();void searchFiles($('#filesSearchInput').value)};",
  "  const close=$('#filesViewerClose');",
  "  if(close)close.onclick=closeFilesFile;",
  "  const edit=$('#filesViewerEdit');",
  "  if(edit)edit.onclick=toggleFilesEdit;",
  "  const save=$('#filesViewerSave');",
  "  if(save)save.onclick=function(){void saveFilesFile()};",
  "}",
  "wireFilesPanel();",
  "",
].join("\n");

{
  const path = resolve(appDir, "public/app.js");
  const source = readFileSync(path, "utf8");
  if (source.includes("function openFilesPanel(){")) {
    console.log("skip  public/app.js (files block already applied)");
  } else {
    writeFileSync(path, source + JS_BLOCK);
    console.log("apply public/app.js: files panel block");
  }
}

// 标记必须是本补丁引入的字符串：上游底部面板里本来就有 kind==='files'，用它当标记会把四步全跳过。
edit("public/app.js", "openFilesPanel();return}", [
  [
    "if(kind==='git'){openGitPanel();return}const tab=$('#utilityTab');",
    "if(kind==='git'){openGitPanel();return}if(kind==='files'){openFilesPanel();return}const tab=$('#utilityTab');",
    "launcher routes to the files panel",
  ],
  [
    "const git=view==='git';const gitPanel=$('#gitPanel');if(gitPanel)gitPanel.hidden=!git;",
    "const git=view==='git',files=view==='files';const gitPanel=$('#gitPanel');if(gitPanel)gitPanel.hidden=!git;const filesPanel=$('#filesPanel');if(filesPanel)filesPanel.hidden=!files;",
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
]);

// --- CSS --------------------------------------------------------------------

const CSS = [
  "/* 文件面板（patches/0067）：工具栏 + 搜索 + 列表 + 文本查看/编辑。 */",
  ".side-panel-files{display:flex;flex-direction:column;gap:8px;min-height:0;height:100%;overflow:auto;padding:10px 12px 80px}",
  ".side-panel-files[hidden]{display:none}",
  ".files-toolbar{flex:none;display:flex;align-items:center;gap:8px}",
  ".files-path{flex:1;min-width:0;font:11px var(--mono);color:var(--app-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
  ".files-search{flex:none}",
  ".files-search input{width:100%;min-height:36px;padding:0 10px;border:1px solid var(--app-border-default,var(--border-strong));border-radius:9px;background:transparent;color:var(--app-text);font-size:12.5px}",
  ".files-notice{flex:none;padding:8px 10px;border-radius:9px;background:color-mix(in srgb,var(--app-text) 6%,transparent);color:var(--app-text-secondary);font-size:11.5px;overflow-wrap:anywhere}",
  ".files-list{flex:none;display:flex;flex-direction:column;gap:1px}",
  ".files-empty{color:var(--app-text-tertiary);font-size:11.5px;padding:6px 2px}",
  ".files-row{display:flex;align-items:center;gap:9px;width:100%;min-height:38px;padding:0 6px;border:0;border-radius:8px;background:transparent;color:var(--app-text);font-size:12.5px;text-align:left}",
  ".files-row:hover{background:color-mix(in srgb,var(--app-text) 6%,transparent)}",
  ".files-row-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
  ".files-row.directory .files-row-name{font-weight:550}",
  ".files-viewer{display:flex;flex-direction:column;gap:8px;min-height:0;flex:1}",
  ".files-viewer[hidden]{display:none}",
  ".files-viewer-head{flex:none;display:flex;align-items:center;gap:8px}",
  ".files-viewer-name{flex:1;min-width:0;font:11px var(--mono);color:var(--app-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
  ".files-viewer-text{flex:1;min-height:200px;margin:0;padding:10px;border:1px solid var(--app-border-default,var(--border));border-radius:9px;background:color-mix(in srgb,var(--app-text) 3%,transparent);color:var(--app-text);font:11px/1.55 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto}",
  ".files-viewer-editor{flex:1;min-height:200px;width:100%;padding:10px;border:1px solid var(--app-border-default,var(--border));border-radius:9px;background:transparent;color:var(--app-text);font:11px/1.55 var(--mono);resize:none}",
  ".files-viewer-editor[hidden],.files-viewer-text[hidden]{display:none}",
].join("\n");

{
  const path = resolve(appDir, "public/style.css");
  let css = readFileSync(path, "utf8");
  if (css.includes(".side-panel-files{")) {
    console.log("skip  public/style.css (already applied)");
  } else {
    writeFileSync(path, css + "\n" + CSS + "\n");
    console.log("apply public/style.css: files panel");
  }
}

edit("public/i18n.js", '"Nothing here"', [
  ['  "Terminal is not connected": "终端还没连上",\n',
   '  "Terminal is not connected": "终端还没连上",\n'
     + '  "Nothing here": "这里没有文件",\n'
     + '  "No matches": "没有匹配的文件",\n'
     + '  "Binary file — no text preview": "二进制文件，不提供文本预览",\n'
     + '  "Save": "保存",\n'
     + '  "Save file?": "保存这个文件？",\n'
     + '  "Saved": "已保存",\n',
   "files entries"],
]);

console.log("done — rebuild the bundle: cd app && bun build public/app.js --target=browser --outfile=public/app.bundle.js");
