// Patch 0037 — an image the user sent must be visible in their own bubble.
//
// Reported 2026-10-15 03:44 (E93): the model could describe the photo, but the
// transcript never showed it. Cause: a user message was rendered as
// `textContent = textFromInput(content)`, and
//   * `textFromInput` only reads parts whose type is exactly "text" — the live/echoed
//     shape uses "input_text", so an image message rendered as an empty bubble;
//   * nothing looked at image parts at all, so the optimistic bubble (localImage)
//     showed the caption and silently dropped the picture.
//
// The model side was already fine — the rollout shows the picture reaching it as
// {input_text:"<image name=[Image #1] path=\"…\">"} + {input_image:data:…}.
//
// Usage: node patches/0037-render-user-message-images.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);

function patchFile(file, rules, appendText, appendMarker) {
  let source = readFileSync(file, "utf8");
  let changed = 0;
  for (const rule of rules) {
    if (rule.skipIf && source.includes(rule.skipIf)) { console.log(`skip  ${rule.name} (marker present)`); continue; }
    const expected = rule.expect ?? 1;
    const hits = source.split(rule.from).length - 1;
    if (hits !== expected) throw new Error(`cannot apply "${rule.name}" in ${file}: anchor matched ${hits} times, expected ${expected}`);
    source = source.split(rule.from).join(rule.to);
    changed += 1;
    console.log(`apply ${rule.name} (${hits}x)`);
  }
  if (appendText && !source.includes(appendMarker)) {
    source += appendText;
    changed += 1;
    console.log(`apply append to ${file}`);
  }
  if (changed > 0) writeFileSync(file, source);
  return changed;
}

patchFile(resolve(appDir, "public/app.js"), [
  {
    name: "import the image renderer",
    from: "import { agentMessageText, renderAssistantMarkdown, renderItemImages } from './rendering.js';",
    to: "import { agentMessageText, isImageReference, renderAssistantMarkdown, renderImagePreview, renderItemImages } from './rendering.js';",
    skipIf: "isImageReference, renderAssistantMarkdown",
  },
  {
    // The echo uses input_text; the optimistic bubble uses text. Both are the user's
    // words. The `<image …>` marker the server injects is not: it is replaced by the
    // picture itself, so it must not leak into the caption (or into the match that
    // pairs an optimistic bubble with its echoed twin).
    name: "textFromInput understands input_text and ignores image markers",
    from: "function textFromInput(content=[]){return content.filter(x=>x.type==='text').map(x=>x.text).join('\\n')}",
    to: "function textFromInput(content=[]){return content.map(part=>typeof part?.text==='string'?part.text:'').filter(text=>text.trim()&&!/^\\s*<image\\b[\\s\\S]*?<\\/image>\\s*$/.test(text)&&!/^\\s*<image\\b[^>]*>\\s*$/.test(text)).join('\\n')}",
    skipIf: "typeof part?.text==='string'",
  },
  {
    name: "a user bubble renders text and pictures",
    from: "  if(item.type==='userMessage')el.querySelector('.user-message').textContent=textFromInput(item.content);",
    to: "  if(item.type==='userMessage')renderUserMessage(el,item);",
    skipIf: "renderUserMessage(el,item);",
  },
], `

// --- user message rendering (patches/0037) ---------------------------------
// Which sources are pictures? localImage (the optimistic bubble), anything carrying
// a path/url/image_url that passes the image check, and the <image … path="…">
// marker the app-server writes into a text part. Paths win over inline data URLs:
// they are a few bytes and /api/images/local serves them, while a data URL is the
// whole file in the DOM.
function userMessageImageSources(content=[]){
  const paths=[],dataUrls=[];
  const classify=source=>{
    const value=String(source||'').trim();
    if(!value||!isImageReference(value))return;
    if(/^data:/i.test(value))dataUrls.push(value);
    else paths.push(value);
  };
  for(const part of content||[]){
    classify(part?.path||part?.url||part?.src||part?.imageUrl||part?.image_url);
    const text=String(part?.text||part?.input_text||'');
    if(!text.includes('<image'))continue;
    const marker=/<image\\b[^>]*?\\bpath="([^"]+)"/g;
    let match;
    while((match=marker.exec(text)))classify(match[1]);
  }
  return {paths:[...new Set(paths)],dataUrls:[...new Set(dataUrls)]};
}
function userMessageImageTitle(source){
  const value=String(source||'');
  if(/^data:/i.test(value))return 'Image';
  const name=value.split(/[\\\\/]/).filter(Boolean).at(-1)||'Image';
  try{return decodeURIComponent(name)}catch{return name}
}
function userMessageHtml(item){
  const cwd=imageCwd(item),text=textFromInput(item.content),{paths,dataUrls}=userMessageImageSources(item.content);
  const sources=paths.length?paths:dataUrls.slice(0,2);
  const images=sources
    .map(source=>renderImagePreview(source,{cwd,title:userMessageImageTitle(source),className:'user-message-image'}))
    .filter(Boolean);
  const body=[text?escapeHtml(text):'',images.length?'<div class="user-message-grid">'+images.join('')+'</div>':''].filter(Boolean).join('');
  return body||'<span class="user-message-placeholder">'+escapeHtml(t('(attachment)'))+'</span>';
}
// Re-rendering on every upsert would fight the user (selection, scroll position,
// half-loaded thumbnails), so the markup is compared before it is replaced.
function renderUserMessage(el,item){
  const host=el.querySelector('.user-message');
  if(!host)return;
  const html=userMessageHtml(item);
  if(host.dataset.renderKey===html)return;
  host.dataset.renderKey=html;
  host.innerHTML=html;
}
`, "function userMessageHtml(item)");

patchFile(resolve(appDir, "public/i18n.js"), [
  {
    name: "Chinese for the attachment-only bubble",
    from: '"waiting for the bridge…": "等待桥响应…",',
    to: '"waiting for the bridge…": "等待桥响应…",\n  "(attachment)": "（附件）",',
    skipIf: '"(attachment)": "（附件）"',
  },
]);

console.log("done — rebuild the bundle: bun build public/app.js --target=browser --outfile=public/app.bundle.js");
