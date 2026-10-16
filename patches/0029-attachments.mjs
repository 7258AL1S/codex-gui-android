// Patch 0029 — attachments through the system file chooser.
//
// The `+` button used to be a dead end: `toast('File attachments require the
// native desktop attachment bridge.')`. The protocol wants a *path*
// (`UserInput.localImage{path}` / `UserInput.mention{name,path}`) and a browser
// never hands a page one, so the bytes go to `POST /api/uploads` (bridge writes
// them under its own state dir) and the returned path is what we send.
//
// Usage: node patches/0029-attachments.mjs [appDir]
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
    name: "composer keeps a list of uploaded attachments",
    from: "composerMentions:[],",
    to: "composerMentions:[],composerAttachments:[],",
    skipIf: "composerMentions:[],composerAttachments:[],",
  },
  {
    name: "the + button opens the file chooser",
    from: 'document.querySelector(\'[data-composer-control="add"]\').onclick=()=>toast(\'File attachments require the native desktop attachment bridge.\');',
    to: 'document.querySelector(\'[data-composer-control="add"]\').onclick=()=>openAttachmentPicker();',
    skipIf: "onclick=()=>openAttachmentPicker()",
  },
  {
    // Same tray as @-mentions, so both kinds of context sit in one row.
    name: "attachment chips render in the composer tray",
    from: "tray.hidden=!state.composerMentions.length}",
    to: "for(const attachment of state.composerAttachments){const chip=document.createElement('div');chip.className='composer-context-chip';chip.dataset.attachmentId=attachment.id;chip.innerHTML=codexIcon(attachment.kind==='image'?'image':'file')+'<span>'+escapeHtml(attachment.name)+'</span><button type=\"button\" aria-label=\"Remove '+escapeHtml(attachment.name)+'\">'+codexIcon('x')+'</button>';chip.querySelector('button').onclick=()=>{state.composerAttachments=state.composerAttachments.filter(item=>item.id!==attachment.id);renderContextTray()};tray.append(chip)}tray.hidden=!state.composerMentions.length&&!state.composerAttachments.length}",
    skipIf: "tray.hidden=!state.composerMentions.length&&!state.composerAttachments.length}",
  },
  {
    // Attachments are consumed on send and put back if the send fails — same
    // contract the text and the mentions already follow (E40's recovery path).
    name: "attachments are consumed on send and restored on failure",
    from: "const mentions=state.composerMentions;input.value='';state.composerMentions=[];renderContextTray();resizePrompt();const restoreInput=()=>{input.value=text;state.composerMentions=mentions;renderContextTray();resizePrompt()};",
    to: "const mentions=state.composerMentions,attachments=state.composerAttachments;input.value='';state.composerMentions=[];state.composerAttachments=[];renderContextTray();resizePrompt();const restoreInput=()=>{input.value=text;state.composerMentions=mentions;state.composerAttachments=attachments;renderContextTray();resizePrompt()};",
    skipIf: "const mentions=state.composerMentions,attachments=state.composerAttachments;",
  },
  {
    // Two steer calls (first attempt + the THREAD_NOT_FOUND retry), turn/start,
    // and queue/add all send `input`; every one of them carries the attachments.
    name: "every outbound input array carries the attachments",
    from: "input:[{type:'text',text}]",
    to: "input:[{type:'text',text},...attachmentInputs()]",
    expect: 4,
    skipIf: "...attachmentInputs()]",
  },
  {
    // The optimistic bubble should show the picture immediately, not only after
    // the turn lands (the item renderer scans content parts for image types).
    name: "the optimistic user message shows the attachments too",
    from: "type:'userMessage',content:[{type:'text',text}]",
    to: "type:'userMessage',content:[{type:'text',text},...attachmentContent()]",
    skipIf: "...attachmentContent()]",
  },
], `

// --- attachments (patches/0029) -------------------------------------------
// Images are sent as localImage{path} so the transcript can render them through
// /api/images/local; anything else becomes a mention{name,path}. Both are just
// paths: the bytes already landed in the bridge's upload directory.
function attachmentInputs(){
  return state.composerAttachments.map(attachment=>attachment.kind==='image'
    ?{type:'localImage',path:attachment.path}
    :{type:'mention',name:attachment.name,path:attachment.path});
}
function attachmentContent(){return attachmentInputs()}

function openAttachmentPicker(){
  let picker=document.getElementById('attachmentPicker');
  if(!picker){
    picker=document.createElement('input');
    picker.type='file';
    picker.multiple=true;
    picker.id='attachmentPicker';
    picker.hidden=true;
    picker.onchange=()=>{const files=Array.prototype.slice.call(picker.files||[]);picker.value='';void uploadAttachments(files)};
    document.body.append(picker);
  }
  picker.click();
}

function readFileAsDataUrl(file){
  return new Promise((resolvePromise,rejectPromise)=>{
    const reader=new FileReader();
    reader.onload=()=>resolvePromise(String(reader.result||''));
    reader.onerror=()=>rejectPromise(new Error(t('Could not read the selected file')));
    reader.readAsDataURL(file);
  });
}

async function uploadAttachments(files){
  for(const file of files){
    try{
      const dataBase64=await readFileAsDataUrl(file);
      const response=await fetch('/api/uploads',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:file.name,dataBase64})});
      const payload=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error((payload&&payload.error)||('HTTP '+response.status));
      state.composerAttachments.push({id:payload.path,name:payload.name,path:payload.path,kind:payload.kind,bytes:payload.bytes});
      renderContextTray();
      clientLog('attachment ready: '+payload.name+' ('+payload.bytes+' bytes, '+payload.kind+')');
    }catch(error){
      const detail=error&&error.message?error.message:String(error);
      clientLog('attachment failed: '+file.name+' -> '+detail);
      toast(t('Upload failed')+': '+file.name+' — '+detail,6000);
    }
  }
}
`, "function openAttachmentPicker(");

patchFile(resolve(appDir, "public/index.html"), [
  {
    name: "hidden file input for the chooser",
    from: '<div class="composer-context-tray" id="composerContextTray" aria-label="Attached context" hidden></div>',
    to: '<input type="file" id="attachmentPicker" multiple hidden aria-hidden="true">\n        <div class="composer-context-tray" id="composerContextTray" aria-label="Attached context" hidden></div>',
    skipIf: 'id="attachmentPicker"',
  },
  {
    // The picker uploads files; folders come in through @-mentions instead.
    name: "the + button stops promising folders",
    from: 'title="Attach files and folders" aria-label="Attach files and folders"',
    to: 'title="Attach files" aria-label="Attach files"',
    skipIf: 'title="Attach files" aria-label="Attach files"',
  },
]);

patchFile(resolve(appDir, "public/i18n.js"), [
  {
    name: "Chinese for the new strings",
    from: '"Attach files and folders": "附加文件和文件夹",',
    to: '"Attach files and folders": "附加文件和文件夹",\n  "Attach files": "附加文件",\n  "Upload failed": "上传失败",\n  "Could not read the selected file": "无法读取所选文件",',
    skipIf: '"Upload failed": "上传失败"',
  },
]);

console.log("done — rebuild the bundle: bun build public/app.js --target=browser --outfile=public/app.bundle.js");
