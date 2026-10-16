// Patch 0098 — 上传走原始字节（用户："上传图片和文件好慢，而且没进度条了"）。
//
// 量的结论反直觉：桥接收 8.49 MB 只要 0.08–0.10s，慢的是浏览器侧把文件读成 data URL、
// 再 JSON.stringify 成 11.3 MB 字符串（主线程同步 + 体积涨 33%）；更要命的是**字符串 body 的
// `upload.onprogress` 没有 `lengthComputable/length`**，代码里的早退分支让进度条永远停在 0。
//
// 这个补丁把上传改成发 File 原始字节，桥侧边收边写盘；旧 base64+JSON 路径保留兼容。
//
// Usage: node patches/0098-raw-upload.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
// 幂等标记**按文件取**：一开始四个文件共用 `x-upload-name`，结果 style.css / upload-service.js
// 里根本没有这个串，于是被重复追加了一份（CSS 块和 saveUploadStream 各多出一份，后者甚至会让
// 桥启动失败）。改成一个文件一个标记，标记只可能是补丁自己写进去的。
const MARKERS = {
  "public/app.js": "x-upload-name",
  "public/style.css": ".composer-context-chip.waiting .composer-context-fill",
  "upload-service.js": "export async function saveUploadStream",
  "server.ts": "saveUploadStream(req, {",
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

const replaceOnce = (text, from, to, label) => {
  if (!text.includes(from)) throw new Error(`cannot locate: ${label}`);
  return text.replace(from, to);
};

// ---- 1. 前端：发原始字节 + waiting 条纹 + 删掉 data URL 读取 ----
patch("public/app.js", (js) => {
  let out = js;
  out = replaceOnce(out, "function postUploadWithProgress(body,onProgress){", "function postUploadWithProgress(file,onProgress){", "postUploadWithProgress 签名");
  out = replaceOnce(
    out,
    "    xhr.setRequestHeader('content-type','application/json');\n",
    [
      "    // 直接发文件本身（原始字节），不再 base64 + JSON（patches/0098）。",
      "    // 两个原因：① base64 让体积涨 33%，而且 `JSON.stringify` 一个十几 MB 的字符串是",
      "    // 主线程同步操作；② **字符串 body 的 upload.onprogress 拿不到 lengthComputable/length**，",
      "    // 于是下面的早退分支把进度条永远按在 0 —— 用户看到的就是\"没有进度条\"。",
      "    // File body 有确定长度，进度事件可用；桥那边也改成边收边写盘。",
      "    xhr.setRequestHeader('content-type',file.type||'application/octet-stream');",
      "    xhr.setRequestHeader('x-upload-name',encodeURIComponent(file.name));",
      "",
    ].join("\n"),
    "uploads 请求头",
  );
  out = replaceOnce(
    out,
    "        const render=()=>onProgress(1,t('waiting for the bridge…')+' '+Math.round((Date.now()-sentAt)/1000)+'s');",
    "        const render=()=>onProgress(1,t('waiting for the bridge…')+' '+Math.round((Date.now()-sentAt)/1000)+'s',{waiting:true});",
    "等待桥响应的回调",
  );
  out = replaceOnce(out, "    xhr.send(body);", "    xhr.send(file);", "xhr.send");
  out = replaceOnce(
    out,
    "async function uploadWithRetry(file,dataBase64,startedAt,onProgress,attempt=1){\n  const body=JSON.stringify({name:file.name,dataBase64});\n  try{\n    const response=await postUploadWithProgress(body,onProgress);",
    "async function uploadWithRetry(file,startedAt,onProgress,attempt=1){\n  try{\n    const response=await postUploadWithProgress(file,onProgress);",
    "uploadWithRetry 头部",
  );
  out = out.replaceAll("return uploadWithRetry(file,dataBase64,startedAt,onProgress,attempt+1);", "return uploadWithRetry(file,startedAt,onProgress,attempt+1);");
  out = replaceOnce(
    out,
    "function readFileAsDataUrl(file){\n  return new Promise((resolvePromise,rejectPromise)=>{\n    const reader=new FileReader();\n    reader.onload=()=>resolvePromise(String(reader.result||''));\n    reader.onerror=()=>rejectPromise(new Error(t('Could not read the selected file')));\n    reader.readAsDataURL(file);\n  });\n}",
    "// 这里原来有个 readFileAsDataUrl()：上传前把整个文件读成 data URL，再 base64 塞进 JSON。\n// patches/0098 起改成直接把 File 当 body 发（见 postUploadWithProgress），这个函数就没有调用者了。",
    "readFileAsDataUrl",
  );
  out = replaceOnce(
    out,
    "      state.composerAttachments.push({id:placeholderId,name:file.name,kind:'file',pending:true,progress:0,phase:t('(reading…)')});\n      renderContextTray();\n      const dataBase64=await readFileAsDataUrl(file);\n      clientLog('upload read in '+(Date.now()-startedAt)+'ms');\n      updateAttachmentProgress(placeholderId,0,t('(uploading…)'));\n      const response=await uploadWithRetry(file,dataBase64,startedAt,(fraction,label)=>updateAttachmentProgress(placeholderId,fraction,label));",
    "      state.composerAttachments.push({id:placeholderId,name:file.name,kind:String(file.type||'').startsWith('image/')?'image':'file',pending:true,progress:0,phase:t('(uploading…)')});\n      renderContextTray();\n      const response=await uploadWithRetry(file,startedAt,(fraction,label,options)=>updateAttachmentProgress(placeholderId,fraction,label,options));",
    "uploadAttachments 占位与调用",
  );
  out = replaceOnce(
    out,
    "function updateAttachmentProgress(id,fraction,phase){\n  const chip=document.querySelector('.composer-context-chip[data-attachment-id=\"'+id+'\"]');\n  if(!chip)return;\n  const fill=chip.querySelector('.composer-context-fill');\n  if(fill)fill.style.width=Math.round(Math.max(0,Math.min(1,Number(fraction)||0))*100)+'%';\n  const phaseNode=chip.querySelector('.composer-context-phase');\n  if(phaseNode&&phase)phaseNode.textContent=phase;\n}",
    "function updateAttachmentProgress(id,fraction,phase,options){\n  const chip=document.querySelector('.composer-context-chip[data-attachment-id=\"'+id+'\"]');\n  if(!chip)return;\n  const fill=chip.querySelector('.composer-context-fill');\n  if(fill)fill.style.width=Math.round(Math.max(0,Math.min(1,Number(fraction)||0))*100)+'%';\n  const phaseNode=chip.querySelector('.composer-context-phase');\n  if(phaseNode&&phase)phaseNode.textContent=phase;\n  // 字节已经发完、还在等桥回答时走条纹动画：这一段在本机是最长的等待，\n  // \"在动\"和\"卡死\"必须一眼能分开（patches/0098）。\n  chip.classList.toggle('waiting',Boolean(options&&options.waiting));\n}",
    "updateAttachmentProgress",
  );
  return out;
});

// ---- 2. 前端样式：等桥响应时的条纹 ----
patch("public/style.css", (css) => `${css}

/* patches/0098：字节发完、还在等桥回答时（本机最长的一段等待）走条纹动画 ——
   "在动"和"卡死"必须一眼分得开；之前这一段只有一行灰字。 */
.composer-context-chip.waiting .composer-context-fill{
  background:repeating-linear-gradient(115deg,color-mix(in srgb,var(--app-text) 28%,transparent) 0 8px,color-mix(in srgb,var(--app-text) 10%,transparent) 8px 16px);
  animation:composer-context-wait 1.1s linear infinite;
}
@keyframes composer-context-wait{from{background-position:0 0}to{background-position:32px 0}}
`);

// ---- 3. 桥侧：流式落盘 ----
patch("upload-service.js", (source) => {
  let out = replaceOnce(
    source,
    'import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";',
    'import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";\nimport { open, unlink } from "node:fs/promises";',
    "upload-service 导入",
  );
  out += `

/**
 * 原始字节流版本（浏览器直接把 \`File\` 当 body 发，不走 base64+JSON）。
 *
 * 为什么要有它：base64 会让体积涨 33%，客户端还要先把整个文件读成 data URL、再
 * \`JSON.stringify\` 成一个十几 MB 的字符串 —— 那一步在 WebView 主线程上是同步的，
 * 而且**字符串 body 的 \`xhr.upload.onprogress\` 拿不到 \`lengthComputable/length\`**，
 * 于是进度条永远停在 0（用户看到的"没有进度条"就是这个）。发原始字节就没有这两件事：
 * 体积不膨胀、进度事件可用、桥这边也是边收边写盘（不再把整份内容堆在内存里）。
 */
export async function saveUploadStream(body, { dir, name, maxBytes = UPLOAD_MAX_BYTES, now = Date.now } = {}) {
  if (!dir) throw new Error("Uploads are not configured");
  if (!body || typeof body[Symbol.asyncIterator] !== "function") throw new Error("Upload body is not a stream");
  const root = resolve(dir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const safe = sanitizeUploadName(name);
  const stamp = new Date(now()).toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const target = resolve(root, \`\${stamp}-\${randomUUID().slice(0, 8)}-\${safe}\`);
  const prefix = root.endsWith(sep) ? root : \`\${root}\${sep}\`;
  if (!target.startsWith(prefix)) throw new Error("Refusing to write outside the upload directory");

  const handle = await open(target, "wx", 0o600);
  let bytes = 0;
  try {
    for await (const chunk of body) {
      bytes += chunk.length;
      // 先写超出部分再报错是不行的：宁可这里拒掉，也不要落一个半截文件。
      if (bytes > maxBytes) throw tooLarge(maxBytes);
      await handle.write(chunk);
    }
    if (!bytes) throw new Error("Empty file");
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(target).catch(() => {});
    throw error;
  }
  await handle.close();
  return { path: target, name: safe, bytes, kind: uploadKind(safe) };
}
`;
  return out;
});

// ---- 4. 桥侧路由：按 content-type 分流 ----
patch("server.ts", (source) => {
  let out = replaceOnce(
    source,
    'import { createUploadPruner, saveUpload, UPLOAD_MAX_BYTES } from "./upload-service.js";',
    'import { createUploadPruner, saveUpload, saveUploadStream, UPLOAD_MAX_BYTES } from "./upload-service.js";',
    "server.ts 导入",
  );
  out = replaceOnce(
    out,
    "      const saved = saveUpload(await readJsonBody(req, uploadBodyLimit), { dir: uploadDir });",
    [
      "      // 两条入口：",
      "      //   1) 原始字节（页面现在走这条）：`content-type` 是文件自己的 MIME，文件名在",
      "      //      `x-upload-name` 里（URL 编码）—— 体积不膨胀、边收边写盘；",
      "      //   2) base64+JSON（保留兼容：旧页面、以及只认这套的探针）。",
      "      const contentType = String(req.headers[\"content-type\"] || \"\");",
      "      const rawName = req.headers[\"x-upload-name\"];",
      "      const saved = /application\\/json/i.test(contentType) || !rawName",
      "        ? saveUpload(await readJsonBody(req, uploadBodyLimit), { dir: uploadDir })",
      "        : await saveUploadStream(req, {",
      "            dir: uploadDir,",
      "            name: (() => { try { return decodeURIComponent(String(rawName)); } catch { return String(rawName); } })(),",
      "          });",
    ].join("\n"),
    "server.ts /api/uploads",
  );
  return out;
});

console.log("done — 重构 bundle：cd app && bun build public/app.js --target=browser --outfile=public/app.bundle.js，然后重启桥");
