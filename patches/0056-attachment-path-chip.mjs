// Patch 0056 — 附件消息渲染成芯片，而不是把完整绝对路径铺满气泡。
//
// 现场（E119，用户 02:26 截图 + adb 复现）：桥给文档附件生成的文本是固定句式
//   「附件（本地路径，可直接读取）：/data/data/com.termux/files/home/.codex/codex-webui/uploads/<长文件名>」
// 用户气泡是 `white-space:pre-wrap`，没有 overflow-wrap，于是这条 250+ 字符的无空格长串
// 直接横向溢出卡片、右半边被裁掉；补上 overflow-wrap 之后不再溢出，但气泡被拉成 **7 行**、
// 每行只放得下几个字符，仍然没法看。
//
// 桌面端是把附件显示成一行芯片（文件名 + 图标）的，这里照做：
//   - 默认只显示文件名，点一下展开完整路径（可复制）；
//   - 只是**渲染层**：发给模型、写进历史的文本仍然是完整路径，协议与 server.ts 都不动。
//
// 附带：`.user-message` 那两条 overflow-wrap 兜底规则也放进本脚本（它们是同一现场的直接修复），
// 这样从快照重放时不会再漏掉。
//
// Usage: node patches/0056-attachment-path-chip.mjs [appDir]
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

// --- app.js -----------------------------------------------------------------

const HELPERS = [
  "// --- 附件芯片（patches/0056）----------------------------------------------",
  "// 桥给文档附件生成的文本是固定句式「附件（本地路径，可直接读取）：<绝对路径>」（server.ts:568）。",
  "// 手机上原样铺开会把气泡拉成七八行、每行只放得下几个字符（E119 真机截图），",
  "// 所以渲染成桌面端那样的一行芯片：默认只显示文件名，点一下展开完整路径。",
  "// 纯渲染层——发给模型、存进历史的文本仍是完整路径。",
  "const USER_ATTACHMENT_LINE=/^附件（本地路径，可直接读取）：(.+)$/;",
  "function userAttachmentChipHtml(path){",
  "  const name=path.split('/').filter(Boolean).pop()||path;",
  "  return '<button type=\"button\" class=\"user-attachment\" data-attachment-path=\"'+escapeHtml(path)+'\" aria-expanded=\"false\">'",
  "    +'<span class=\"user-attachment-icon\">'+icons.file+'</span>'",
  "    +'<span class=\"user-attachment-body\">'",
  "    +'<span class=\"user-attachment-name\">'+escapeHtml(name)+'</span>'",
  "    +'<span class=\"user-attachment-path\">'+escapeHtml(path)+'</span>'",
  "    +'</span>'",
  "    +'<span class=\"user-attachment-hint\">'+escapeHtml(t('Path'))+'</span>'",
  "    +'</button>';",
  "}",
  "function userMessageBody(text,images){",
  "  const chips=[],rest=[];",
  "  for(const line of String(text||'').split('\\n')){",
  "    const match=USER_ATTACHMENT_LINE.exec(line);",
  "    if(match&&match[1].trim())chips.push(userAttachmentChipHtml(match[1].trim()));",
  "    else rest.push(line);",
  "  }",
  "  const remaining=rest.join('\\n').trim();",
  "  return [remaining?escapeHtml(remaining):'',chips.join(''),images&&images.length?('<div class=\"user-message-grid\">'+images.join('')+'</div>'):''].filter(Boolean).join('');",
  "}",
  "",
  "function userMessageHtml(item){",
].join("\n");

edit("public/app.js", "userAttachmentChipHtml", [
  [
    "function userMessageHtml(item){\n",
    HELPERS + "\n",
    "userMessageBody helpers before userMessageHtml",
  ],
  [
    "  const body=[text?escapeHtml(text):'',images.length?'<div class=\"user-message-grid\">'+images.join('')+'</div>':''].filter(Boolean).join('');",
    "  const body=userMessageBody(text,images);",
    "userMessageHtml uses userMessageBody",
  ],
  [
    "  const html=userMessageHtml(item);\n  if(host.dataset.renderKey===html)return;",
    "  const html=userMessageHtml(item);\n"
      + "  // claimOptimisticUser 靠 textContent 认领本地气泡；芯片会改变 textContent（文件名+提示语），\n"
      + "  // 所以把原文存在 dataset 上，认领时优先用它。\n"
      + "  host.dataset.rawText=textFromInput(item.content);\n"
      + "  if(host.dataset.renderKey===html)return;",
    "renderUserMessage stores the raw text",
  ],
  [
    "const el=candidates.find(node=>node.querySelector('.user-message')?.textContent===text);",
    "const el=candidates.find(node=>{const host=node.querySelector('.user-message');return (host?.dataset.rawText??host?.textContent)===text});",
    "claimOptimisticUser compares the raw text",
  ],
  [
    "$('#windowCodexMark').innerHTML=codexInterfaceMark('window-codex-mark');",
    "// 芯片是 innerHTML 生成的，展开/收起用事件委托，重渲染不必重新绑定。\n"
      + "document.addEventListener('click',event=>{\n"
      + "  const chip=event.target?.closest?.('.user-attachment');\n"
      + "  if(!chip)return;\n"
      + "  const open=chip.classList.toggle('open');\n"
      + "  chip.setAttribute('aria-expanded',open?'true':'false');\n"
      + "  const hint=chip.querySelector('.user-attachment-hint');\n"
      + "  if(hint)hint.textContent=open?t('Collapse path'):t('Path');\n"
      + "});\n"
      + "$('#windowCodexMark').innerHTML=codexInterfaceMark('window-codex-mark');",
    "attachment chip click delegation",
  ],
]);

// --- i18n.js ----------------------------------------------------------------

edit("public/i18n.js", '"Path": "路径"', [
  [
    '  "Search": "搜索",\n',
    '  "Path": "路径",\n  "Collapse path": "收起路径",\n  "Search": "搜索",\n',
    "Path / Collapse path entries",
  ],
]);

// --- style.css --------------------------------------------------------------

const WRAP_CSS = [
  "/* 用户气泡里的超长无空格串（典型：附件路径",
  "   `附件（本地路径，可直接读取）：/data/.../uploads/<长文件名>`）此前会横向溢出卡片，",
  "   右半边被裁掉——`white-space:pre-wrap` 只在空格处换行（E119 真机截图）。",
  "   助手侧 `.message-text` 早就有 word-break，用户侧漏了。 */",
  ".user-message{overflow-wrap:anywhere;word-break:break-word}",
  ".user-message code{overflow-wrap:anywhere;word-break:break-all}",
].join("\n");

const CHIP_CSS = [
  "/* 附件芯片（patches/0056）：默认一行文件名，点一下展开完整路径。",
  "   <button> 要显式清掉浏览器默认样式（字体、内边距、背景），并解掉",
  "   父级 `.user-message` 的 white-space:pre-wrap。 */",
  ".user-attachment{display:flex;align-items:center;gap:7px;width:100%;max-width:100%;margin-top:6px;padding:6px 8px;border:1px solid var(--border-strong);border-radius:10px;background:color-mix(in srgb,var(--app-text) 7%,transparent);color:inherit;font:inherit;text-align:left;white-space:normal}",
  ".user-attachment+.user-attachment{margin-top:5px}",
  ".user-attachment-icon{flex:none;display:grid;place-items:center;width:16px;height:16px;color:var(--app-text-tertiary)}",
  ".user-attachment-icon svg{width:14px;height:14px}",
  ".user-attachment-body{flex:1;min-width:0;display:grid;gap:2px}",
  ".user-attachment-name{font:11.5px/1.5 var(--mono);overflow-wrap:anywhere;word-break:break-all}",
  ".user-attachment-hint{flex:none;color:var(--app-text-tertiary);font-size:10.5px}",
  ".user-attachment-path{display:none;font:10.5px/1.55 var(--mono);color:var(--app-text-tertiary);overflow-wrap:anywhere;word-break:break-all}",
  ".user-attachment.open .user-attachment-path{display:block}",
  ".user-attachment.open .user-attachment-hint{opacity:.65}",
].join("\n");

{
  const path = resolve(appDir, "public/style.css");
  let css = readFileSync(path, "utf8");
  const anchor = ".user-message-placeholder{color:var(--app-text-tertiary)}";
  if (!css.includes(anchor)) throw new Error("style.css: cannot locate .user-message-placeholder");
  let changed = false;
  if (!css.includes("E119 真机截图")) {
    css = css.replace(anchor, anchor + "\\n" + WRAP_CSS);
    changed = true;
    console.log("apply style.css: user-message overflow-wrap");
  } else {
    console.log("skip  style.css overflow-wrap (already applied)");
  }
  if (!css.includes(".user-attachment{")) {
    css = css.replace(".user-message code{overflow-wrap:anywhere;word-break:break-all}", ".user-message code{overflow-wrap:anywhere;word-break:break-all}\n" + CHIP_CSS);
    changed = true;
    console.log("apply style.css: attachment chip");
  } else {
    console.log("skip  style.css attachment chip (already applied)");
  }
  if (changed) writeFileSync(path, css);
}

console.log("done — rebuild the bundle: cd app && bun build public/app.js --target=browser --outfile=public/app.bundle.js");
