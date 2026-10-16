// Patch 0091 — P7 收尾三件：HTML 预览、拍照入口、MCP 重载。
//
// 一、HTML 预览（本地网页产物）
// 新增 `GET /api/files/preview?path=…`：按扩展名给 content-type、`content-disposition: inline`，
// 并**强制加 `Content-Security-Policy: sandbox`**——被预览的本地 HTML 会拿到一个不透明源
// （opaque origin），因此它**拿不到桥的同源数据**（fetch `/api/*` 会被 CORS 挡住、也读不到 localStorage）。
// 这一点是这个接口能不能存在的前提：否则一个"预览"就等于把桥的 API 交给任意本地 HTML。
// 文件面板对 .html/.htm 显示「预览」按钮 → 打开侧栏浏览器面板指向这个 URL。
//
// 二、拍照入口
// 不用改 APK：加一个 `accept="image/*" capture="environment"` 的隐藏 input + 相机按钮，
// 安卓上这会让系统文件选择器**直接起相机**；回来仍走既有的 change → uploads → localImage 链路。
//
// 三、MCP 重载
// 设置页（插件）加一个「重新加载 MCP 配置」按钮 → 协议 `config/mcpServer/reload`（本机列表是空的，
// 但用户改完 config.toml 后能立刻生效，比重启桥强）。
//
// Usage: node patches/0091-html-preview-and-camera.mjs [appDir]
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

// --- 桥：/api/files/preview ---------------------------------------------------
edit("server.ts", '"/api/files/preview"', [
  [
    '  if (url.pathname === "/api/files/download") {',
    '// 预览只对这些类型开放（其余让用户用 open/share 交给系统应用）。\n'
      + 'function previewContentType(extension: string): string | null {\n'
      + '  const map: Record<string, string> = {\n'
      + '    ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",\n'
      + '    ".svg": "image/svg+xml", ".md": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8",\n'
      + '    ".json": "application/json; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",\n'
      + '    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",\n'
      + '  };\n'
      + '  return map[extension] || null;\n'
      + '}\n'
      + '\n'
      + '  if (url.pathname === "/api/files/preview") {\n'
      + '    try {\n'
      + '      const file = resolveLocalFile(url.searchParams.get("path"), { cwd: defaultCwd, home: homeDir, allowedRoots: fileRoots });\n'
      + '      const extension = extname(file.path).toLowerCase();\n'
      + '      const type = previewContentType(extension);\n'
      + '      if (!type) throw new Error(`No preview for ${extension || "this file type"}; use open/share instead`);\n'
      + '      res.writeHead(200, {\n'
      + '        "content-type": type,\n'
      + '        "content-length": String(file.size),\n'
      + '        "content-disposition": "inline",\n'
      + '        // 关键：给被预览的本地页面一个不透明源，它就摸不到桥的同源数据（P7 安全前提）。\n'
      + '        "content-security-policy": "sandbox",\n'
      + '        "cache-control": "no-store",\n'
      + '        "x-content-type-options": "nosniff",\n'
      + '      });\n'
      + '      const stream = createReadStream(file.path);\n'
      + '      stream.on("error", () => res.destroy());\n'
      + '      req.on("aborted", () => stream.destroy());\n'
      + '      stream.pipe(res);\n'
      + '    } catch (error) {\n'
      + '      res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });\n'
      + '      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));\n'
      + '    }\n'
      + '    return;\n'
      + '  }\n'
      + '  if (url.pathname === "/api/files/download") {',
    "preview route",
  ],
]);

// --- 前端：预览按钮 + 相机入口 ------------------------------------------------
edit("public/index.html", 'id="cameraPicker"', [
  [
    '<input type="file" id="attachmentPicker" class="attachment-input" multiple accept="image/*,video/*">',
    '<label class="composer-circle-button add-control" for="cameraPicker" title="Take a photo" aria-label="Take a photo"><span class="icon-slot" data-icon="image"></span></label>'
      + '<input type="file" id="cameraPicker" class="attachment-input" accept="image/*" capture="environment">'
      + '<input type="file" id="attachmentPicker" class="attachment-input" multiple accept="image/*,video/*">',
    "camera entry",
  ],
  [
    '          <button class="icon-button small" id="filesViewerShare" type="button" title="Share">',
    '          <button class="icon-button small" id="filesViewerPreview" type="button" title="Preview" hidden><span class="icon-slot" data-icon="monitor"></span></button>\n'
      + '          <button class="icon-button small" id="filesViewerShare" type="button" title="Share">',
    "preview button",
  ],
]);

const JS = [
  "",
  "// --- HTML 预览（patches/0091）-----------------------------------------------",
  "// 走桥的 /api/files/preview（带 CSP sandbox：被预览的本地页面拿不到桥的同源数据），",
  "// 显示在侧栏浏览器面板里。只在能预览的类型上给按钮，其余仍是打开/分享。",
  "const FILES_PREVIEWABLE=/^(html?|svg|md|txt|json|css|js|png|jpe?g|gif|webp)$/i;",
  "",
  "function filesPreviewable(path){return FILES_PREVIEWABLE.test(String(path||'').split('.').pop()||'')}",
  "",
  "function previewFilesArtifact(){",
  "  const target=filesState.open?.path;",
  "  if(!target)return;",
  "  // 必须给绝对 URL：面板的地址解析器会把相对路径当成主机名（实测变成 https://api/files/…）。
  const url=location.origin+'/api/files/preview?path='+encodeURIComponent(target);",
  "  clientLog('files preview -> '+target);",
  "  // 用面板自己的导航函数：它会设 iframe 的 sandbox 属性、清掉空态、维护历史；",
  "  // 直接写 frame.src 会被面板随后的渲染覆盖掉（真机撞过：面板停在“输入网址开始浏览”）。",
  "  openBrowserPanel();",
  "  navigateBrowser(url);",
  "  toast(t('Previewing in the Browser panel'));",
  "}",
  "",
  "function syncFilesPreviewButton(){",
  "  const button=$('#filesViewerPreview');",
  "  if(!button)return;",
  "  const path=filesState.open?.path;",
  "  button.hidden=!(path&&filesPreviewable(path));",
  "}",
  "",
].join("\n");

{
  const path = resolve(appDir, "public/app.js");
  const source = readFileSync(path, "utf8");
  if (source.includes("function previewFilesArtifact(")) {
    console.log("skip  public/app.js (already applied)");
  } else {
    writeFileSync(path, source + JS);
    console.log("apply public/app.js: preview helpers");
  }
}

edit("public/app.js", "preview.onclick=previewFilesArtifact", [
  [
    "  const download=$('#filesViewerDownload');\n  if(download)download.onclick=function(){void filesArtifactAction('saveToDownloads')};",
    "  const download=$('#filesViewerDownload');\n"
      + "  if(download)download.onclick=function(){void filesArtifactAction('saveToDownloads')};\n"
      + "  const preview=$('#filesViewerPreview');\n"
      + "  if(preview)preview.onclick=previewFilesArtifact;",
    "wire the preview button",
  ],
  [
    "    if(save)save.hidden=true;\n  }catch(error){filesState.notice=error.message}",
    "    if(save)save.hidden=true;\n    syncFilesPreviewButton();\n  }catch(error){filesState.notice=error.message}",
    "sync the preview button when a file opens",
  ],
]);

// --- MCP 重载 -----------------------------------------------------------------
edit("public/app.js", "Reload MCP config');", [
  [
    "      const mcp=servers?.data||servers?.servers||[];",
    "      const mcp=servers?.data||servers?.servers||[];\n"
      + "      const reload=document.createElement('button');\n"
      + "      reload.type='button';reload.className='settings-save';reload.textContent=t('Reload MCP config');\n"
      + "      reload.onclick=async function(){\n"
      + "        try{const result=await rpc('config/mcpServer/reload',{});clientLog('mcp reload -> '+JSON.stringify(result||{}).slice(0,80));toast(t('MCP config reloaded'));void renderSettingsLive('plugins-settings')}\n"
      + "        catch(error){toast(error.message)}\n"
      + "      };",
    "mcp reload button",
  ],
  [
    "      rows.append(settingsRow(t('MCP servers'),servers?.__error?servers.__error:String(mcp.length),servers?.__error?'':mcp.map(function(item){return (item.name||item.id)+'·'+(item.status||item.state||'?')}).slice(0,6).join(', ')));",
    "      rows.append(settingsRow(t('MCP servers'),servers?.__error?servers.__error:String(mcp.length),servers?.__error?'':mcp.map(function(item){return (item.name||item.id)+'·'+(item.status||item.state||'?')}).slice(0,6).join(', ')),reload);",
    "place the reload button",
  ],
]);

edit("public/i18n.js", '"Reload MCP config"', [
  ['  "MCP servers": "MCP 服务器",\n',
   '  "MCP servers": "MCP 服务器",\n'
     + '  "Reload MCP config": "重新加载 MCP 配置",\n'
     + '  "MCP config reloaded": "MCP 配置已重新加载",\n'
     + '  "Preview": "预览",\n'
     + '  "Previewing in the Browser panel": "在侧栏浏览器面板里预览",\n'
     + '  "Take a photo": "拍照",\n',
   "zh entries"],
]);

console.log("done — rebuild the bundle: cd app && bun build public/app.js --target=browser --outfile=public/app.bundle.js");
