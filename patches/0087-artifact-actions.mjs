// Patch 0087 — P7 产物与系统集成：图片内联预览 + 打开/分享/存到 Download。
//
// 现状：文件面板只能看文本（`<pre>`），二进制就一句"不支持预览"；也没有"交给别的应用"的路。
// 手机上的真实需求是：看一眼图片、把 PDF/APK 丢给系统应用打开或分享、把产物放进 Download 目录。
//
// 三条路都复用现成能力，不新造轮子：
//   - 图片内联：桥的 `/api/images/local?path=…`（本来就按图片类型直出，消息里的图片缩略图走它）；
//   - 打开/分享：Termux 的 `termux-open --view/--send`（C 类依赖，`allow-external-apps=true` 已设）；
//   - 存到 Download：桥把文件复制到 `/sdcard/Download/codex-gui/`（用户可见的位置）。
// 桥侧统一一个受控出口：`POST /api/files/action {action, path}`，路径照样过允许根校验。
//
// Usage: node patches/0087-artifact-actions.mjs [appDir]
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

// --- 桥：/api/files/action ----------------------------------------------------
edit("server.ts", '"/api/files/action"', [
  [
    '  if (url.pathname === "/api/files/download") {',
    '  if (url.pathname === "/api/files/action") {\n'
      + '    if (req.method !== "POST") {\n'
      + '      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "POST" });\n'
      + '      res.end(JSON.stringify({ error: "Method not allowed" }));\n'
      + '      return;\n'
      + '    }\n'
      + '    let actionBody = "";\n'
      + '    req.setEncoding("utf8");\n'
      + '    req.on("data", (chunk) => { actionBody += chunk; if (actionBody.length > 16_000) req.destroy(new Error("Payload too large")); });\n'
      + '    req.on("end", () => {\n'
      + '      let status = 200;\n'
      + '      let payload: any;\n'
      + '      try {\n'
      + '        const body = JSON.parse(actionBody || "{}");\n'
      + '        const action = String(body.action ?? "");\n'
      + '        const file = resolveLocalFile(String(body.path || ""), { cwd: defaultCwd, home: homeDir, allowedRoots: fileRoots });\n'
      + '        if (action === "open" || action === "share") {\n'
      + '          // Termux:API 的 termux-open：open=默认应用查看，share=走分享面板（--send）。\n'
      + '          const args = action === "share" ? ["--send", file.path] : ["--view", file.path];\n'
      + '          const result = spawnSync("termux-open", args, { encoding: "utf8" });\n'
      + '          if (result.error) throw new Error(`termux-open is unavailable: ${result.error.message}`);\n'
      + '          if (result.status !== 0) throw new Error((result.stderr || "termux-open failed").trim().slice(0, 200));\n'
      + '          payload = { ok: true, action, path: file.path };\n'
      + '        } else if (action === "saveToDownloads") {\n'
      + '          const targetDir = "/sdcard/Download/codex-gui";\n'
      + '          mkdirSync(targetDir, { recursive: true });\n'
      + '          const target = resolve(targetDir, file.filename);\n'
      + '          copyFileSync(file.path, target);\n'
      + '          payload = { ok: true, action, path: target, size: file.size };\n'
      + '        } else {\n'
      + '          throw new Error(`Unsupported file action: ${action || "(empty)"}`);\n'
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
      + '  if (url.pathname === "/api/files/download") {',
    "file action route",
  ],
  [
    'import { chmodSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";',
    'import { chmodSync, copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";',
    "copyFileSync import",
  ],
  [
    'import { execFileSync, spawn, type ChildProcess } from "node:child_process";',
    'import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";',
    "spawnSync import",
  ],
]);

// --- 前端：查看器里的图片与动作按钮 -------------------------------------------
edit("public/index.html", 'id="filesViewerImage"', [
  [
    '          <button class="icon-button small" id="filesViewerSave" type="button" title="Save" hidden><span class="icon-slot" data-icon="check"></span></button>',
    '          <button class="icon-button small" id="filesViewerOpen" type="button" title="Open in another app"><span class="icon-slot" data-icon="arrowUp"></span></button>\n'
      + '          <button class="icon-button small" id="filesViewerShare" type="button" title="Share"><span class="icon-slot" data-icon="paperclip"></span></button>\n'
      + '          <button class="icon-button small" id="filesViewerDownload" type="button" title="Save to Downloads"><span class="icon-slot" data-icon="square"></span></button>\n'
      + '          <button class="icon-button small" id="filesViewerSave" type="button" title="Save" hidden><span class="icon-slot" data-icon="check"></span></button>',
    "artifact action buttons",
  ],
  [
    '        <pre class="files-viewer-text" id="filesViewerText"></pre>',
    '        <div class="files-viewer-image" id="filesViewerImage" hidden><img id="filesViewerImageNode" alt=""></div>\n'
      + '        <pre class="files-viewer-text" id="filesViewerText"></pre>',
    "image container",
  ],
]);

const JS = [
  "",
  "// --- 产物动作（patches/0087）------------------------------------------------",
  "// 打开/分享走 Termux 的 termux-open（外部应用），存到 Download 走桥侧复制；",
  "// 图片走桥的 /api/images/local 内联显示（消息里的缩略图也是它）。",
  "const FILES_IMAGE_EXTENSIONS=/^(png|jpe?g|gif|webp|bmp|heic|heif|avif)$/i;",
  "",
  "function filesImageUrl(path){return '/api/images/local?path='+encodeURIComponent(path)}",
  "",
  "async function filesArtifactAction(action){",
  "  const target=filesState.open?.path;",
  "  if(!target)return;",
  "  if(action==='saveToDownloads'){",
  "    const ok=await gitConfirm({title:t('Copy into Downloads?'),message:shortPath(target)+' → /sdcard/Download/codex-gui/',confirmLabel:t('Copy')});",
  "    if(!ok)return;",
  "  }",
  "  try{",
  "    const response=await fetch('/api/files/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,path:target})});",
  "    const data=await response.json().catch(function(){return {}});",
  "    if(!response.ok)throw new Error(data.error||('Files '+action+' failed'));",
  "    clientLog('files '+action+' -> '+(data.path||'ok'));",
  "    toast(action==='saveToDownloads'?t('Copied to Downloads')+': '+shortPath(data.path||''):t('Handed to the system app'));",
  "  }catch(error){clientLog('files '+action+' FAILED: '+error.message);toast(error.message)}",
  "}",
  "",
  "function wireFilesArtifactActions(){",
  "  const open=$('#filesViewerOpen');",
  "  if(open)open.onclick=function(){void filesArtifactAction('open')};",
  "  const share=$('#filesViewerShare');",
  "  if(share)share.onclick=function(){void filesArtifactAction('share')};",
  "  const download=$('#filesViewerDownload');",
  "  if(download)download.onclick=function(){void filesArtifactAction('saveToDownloads')};",
  "}",
  "wireFilesArtifactActions();",
  "",
].join("\n");

{
  const path = resolve(appDir, "public/app.js");
  const source = readFileSync(path, "utf8");
  if (source.includes("function filesArtifactAction(")) {
    console.log("skip  public/app.js (already applied)");
  } else {
    writeFileSync(path, source + JS);
    console.log("apply public/app.js: artifact actions");
  }
}

edit("public/app.js", "filesImageUrl(data.path)", [
  [
    "    const text=$('#filesViewerText');\n    const editor=$('#filesViewerEditor');\n    const edit=$('#filesViewerEdit');\n    const save=$('#filesViewerSave');\n    if(data.binary){",
    "    const text=$('#filesViewerText');\n"
      + "    const editor=$('#filesViewerEditor');\n"
      + "    const edit=$('#filesViewerEdit');\n"
      + "    const save=$('#filesViewerSave');\n"
      + "    const imageBox=$('#filesViewerImage'),imageNode=$('#filesViewerImageNode');\n"
      + "    const extension=String(data.path||'').split('.').pop();\n"
      + "    // 图片直接内联显示（走 /api/images/local）；其余二进制仍如实说\"不能预览\"，但可以打开/分享。\n"
      + "    const isImage=!data.binary&&FILES_IMAGE_EXTENSIONS.test(extension||'');\n"
      + "    if(isImage){\n"
      + "      if(text)text.hidden=true;\n"
      + "      if(editor)editor.hidden=true;\n"
      + "      if(imageNode)imageNode.src=filesImageUrl(data.path);\n"
      + "      if(imageBox)imageBox.hidden=false;\n"
      + "      if(edit)edit.hidden=true;\n"
      + "      if(save)save.hidden=true;\n"
      + "      return;\n"
      + "    }\n"
      + "    if(imageBox)imageBox.hidden=true;\n"
      + "    if(imageNode)imageNode.removeAttribute('src');\n"
      + "    if(data.binary){",
    "inline image preview",
  ],
]);

{
  const path = resolve(appDir, "public/style.css");
  let css = readFileSync(path, "utf8");
  if (css.includes(".files-viewer-image")) {
    console.log("skip  public/style.css (already applied)");
  } else {
    css += [
      "",
      "/* 图片内联预览（patches/0087）。 */",
      ".files-viewer-image{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;overflow:auto;border:1px solid var(--app-border-default,var(--border));border-radius:9px;background:color-mix(in srgb,var(--app-text) 3%,transparent)}",
      ".files-viewer-image[hidden]{display:none}",
      ".files-viewer-image img{max-width:100%;max-height:100%;object-fit:contain}",
      "",
    ].join("\n");
    writeFileSync(path, css);
    console.log("apply public/style.css: inline image");
  }
}

edit("public/i18n.js", '"Handed to the system app"', [
  ['  "Could not load: ": "加载失败：",\n',
   '  "Could not load: ": "加载失败：",\n'
     + '  "Open in another app": "用其他应用打开",\n'
     + '  "Share": "分享",\n'
     + '  "Save to Downloads": "存到 Download",\n'
     + '  "Handed to the system app": "已交给系统应用",\n'
     + '  "Copy into Downloads?": "复制到 Download 目录？",\n'
     + '  "Copy": "复制",\n'
     + '  "Copied to Downloads": "已复制到 Download",\n',
   "zh entries"],
]);

console.log("done — rebuild the bundle: cd app && bun build public/app.js --target=browser --outfile=public/app.bundle.js");
