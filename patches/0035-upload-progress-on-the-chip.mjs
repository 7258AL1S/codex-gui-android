// Patch 0035 — an upload shows its progress on the file chip itself.
//
// The user asked for a progress bar "on the file background". fetch() cannot report
// upload progress, so the body goes out through XMLHttpRequest instead and the
// chip's own background layer becomes the bar: read → upload (with a real
// percentage, straight from `upload.onprogress`) → waiting for the bridge.
//
// The in-place update matters: re-rendering the whole tray on every progress event
// would rebuild every other chip and fight the user's own edits.
//
// Usage: node patches/0035-upload-progress-on-the-chip.mjs [appDir]
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
    // The chip grows a fill layer, a label and a phase readout; a pending chip is
    // visually distinguishable so "still uploading" is obvious at a glance.
    name: "the attachment chip renders a progress layer",
    from: "for(const attachment of state.composerAttachments){const chip=document.createElement('div');chip.className='composer-context-chip';chip.dataset.attachmentId=attachment.id;chip.innerHTML=codexIcon(attachment.kind==='image'?'image':'file')+'<span>'+escapeHtml(attachment.name)+'</span><button type=\"button\" aria-label=\"Remove '+escapeHtml(attachment.name)+'\">'+codexIcon('x')+'</button>';chip.querySelector('button').onclick=()=>{state.composerAttachments=state.composerAttachments.filter(item=>item.id!==attachment.id);renderContextTray()};tray.append(chip)}",
    to: "for(const attachment of state.composerAttachments){const chip=document.createElement('div');chip.className='composer-context-chip'+(attachment.pending?' pending':'');chip.dataset.attachmentId=attachment.id;const phase=attachment.pending?(attachment.phase||t('(uploading…)')):'';const fill=Math.round(Math.max(0,Math.min(1,Number(attachment.progress)||0))*100);chip.innerHTML='<span class=\"composer-context-fill\" style=\"width:'+fill+'%\" aria-hidden=\"true\"></span>'+codexIcon(attachment.kind==='image'?'image':'file')+'<span class=\"composer-context-label\">'+escapeHtml(attachment.name)+'</span>'+(phase?'<span class=\"composer-context-phase\">'+escapeHtml(phase)+'</span>':'')+'<button type=\"button\" aria-label=\"Remove '+escapeHtml(attachment.name)+'\">'+codexIcon('x')+'</button>';chip.querySelector('button').onclick=()=>{state.composerAttachments=state.composerAttachments.filter(item=>item.id!==attachment.id);renderContextTray()};tray.append(chip)}",
    skipIf: "composer-context-fill",
  },
  {
    name: "the placeholder starts in the reading phase",
    from: "      state.composerAttachments.push({id:placeholderId,name:file.name+' '+t('(uploading…)'),kind:'file',pending:true});\n      renderContextTray();\n      const dataBase64=await readFileAsDataUrl(file);\n      clientLog('upload read in '+(Date.now()-startedAt)+'ms');\n      const response=await uploadWithRetry(file,dataBase64,startedAt);",
    to: "      state.composerAttachments.push({id:placeholderId,name:file.name,kind:'file',pending:true,progress:0,phase:t('(reading…)')});\n      renderContextTray();\n      const dataBase64=await readFileAsDataUrl(file);\n      clientLog('upload read in '+(Date.now()-startedAt)+'ms');\n      updateAttachmentProgress(placeholderId,0,t('(uploading…)'));\n      const response=await uploadWithRetry(file,dataBase64,startedAt,(fraction,label)=>updateAttachmentProgress(placeholderId,fraction,label));",
    skipIf: "progress:0,phase:t('(reading…)')",
  },
  {
    // Only a pending chip has a bar; a finished one is a plain chip again.
    name: "the fill layer only exists while the upload is pending",
    from: "'<span class=\"composer-context-fill\" style=\"width:'+fill+'%\" aria-hidden=\"true\"></span>'+codexIcon(",
    to: "(attachment.pending?'<span class=\"composer-context-fill\" style=\"width:'+fill+'%\" aria-hidden=\"true\"></span>':'')+codexIcon(",
    skipIf: "attachment.pending?'<span class=\"composer-context-fill\"",
  },
  {
    // fetch() has no upload progress events; XHR does. The shim keeps the call site
    // (`response.status/ok/json()`) unchanged.
    name: "the upload goes out over XHR so progress is real",
    from: "async function uploadWithRetry(file,dataBase64,startedAt,attempt=1){\n  const controller=new AbortController();\n  const timer=setTimeout(()=>controller.abort(),45000);\n  try{\n    const response=await fetch('/api/uploads',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:file.name,dataBase64}),signal:controller.signal});\n    if(response.status>=500&&attempt<2){\n      clientLog('upload retry: '+file.name+' (HTTP '+response.status+' after '+(Date.now()-startedAt)+'ms)');\n      return uploadWithRetry(file,dataBase64,startedAt,attempt+1);\n    }\n    return response;\n  }catch(error){\n    if(attempt<2){\n      clientLog('upload retry: '+file.name+' ('+((error&&error.message)||error)+' after '+(Date.now()-startedAt)+'ms)');\n      return uploadWithRetry(file,dataBase64,startedAt,attempt+1);\n    }\n    throw error;\n  }finally{clearTimeout(timer)}\n}",
    to: "function postUploadWithProgress(body,onProgress){\n  return new Promise((resolve,reject)=>{\n    const xhr=new XMLHttpRequest();\n    xhr.open('POST','/api/uploads');\n    xhr.setRequestHeader('content-type','application/json');\n    xhr.timeout=45000;\n    if(xhr.upload&&onProgress){\n      xhr.upload.onprogress=(event)=>{if(!event.lengthComputable||!event.total)return;const fraction=event.loaded/event.total;onProgress(fraction,Math.round(fraction*100)+'%')};\n      // Bytes are out but the bridge has not answered yet: on this device that wait is\n      // exactly where freezes show up, so it gets its own label (E90/E91).\n      xhr.upload.onload=()=>onProgress(1,t('waiting for the bridge…'));\n    }\n    xhr.onload=()=>{\n      let payload=null;\n      try{payload=JSON.parse(xhr.responseText||'{}')}catch{payload=null}\n      resolve({ok:xhr.status>=200&&xhr.status<300,status:xhr.status,json:async()=>payload||{}});\n    };\n    xhr.onerror=()=>reject(new Error('Failed to fetch'));\n    xhr.ontimeout=()=>reject(Object.assign(new Error('Bridge request timed out: /api/uploads'),{name:'TimeoutError'}));\n    xhr.onabort=()=>reject(Object.assign(new Error('Upload aborted'),{name:'AbortError'}));\n    xhr.send(body);\n  });\n}\nasync function uploadWithRetry(file,dataBase64,startedAt,onProgress,attempt=1){\n  const body=JSON.stringify({name:file.name,dataBase64});\n  try{\n    const response=await postUploadWithProgress(body,onProgress);\n    if(response.status>=500&&attempt<2){\n      clientLog('upload retry: '+file.name+' (HTTP '+response.status+' after '+(Date.now()-startedAt)+'ms)');\n      return uploadWithRetry(file,dataBase64,startedAt,onProgress,attempt+1);\n    }\n    return response;\n  }catch(error){\n    if(attempt<2){\n      clientLog('upload retry: '+file.name+' ('+((error&&error.message)||error)+' after '+(Date.now()-startedAt)+'ms)');\n      return uploadWithRetry(file,dataBase64,startedAt,onProgress,attempt+1);\n    }\n    throw error;\n  }\n}",
    skipIf: "function postUploadWithProgress(body,onProgress)",
  },
], `

// --- upload progress on the chip (patches/0035) ----------------------------
// The bar is the chip's own background layer, so the answer to "how far along is
// this file?" lives on the file itself. Updated in place: a full tray re-render on
// every progress event would rebuild the other chips under the user's fingers.
function updateAttachmentProgress(id,fraction,phase){
  const chip=document.querySelector('.composer-context-chip[data-attachment-id="'+id+'"]');
  if(!chip)return;
  const fill=chip.querySelector('.composer-context-fill');
  if(fill)fill.style.width=Math.round(Math.max(0,Math.min(1,Number(fraction)||0))*100)+'%';
  const phaseNode=chip.querySelector('.composer-context-phase');
  if(phaseNode&&phase)phaseNode.textContent=phase;
}
`, "function updateAttachmentProgress(id,fraction,phase)");

patchFile(resolve(appDir, "public/i18n.js"), [
  {
    name: "Chinese for the upload phases",
    from: '"no answer from the bridge (the phone may have slept)": "桥没有响应（手机可能休眠了），会自动重试一次",',
    to: '"no answer from the bridge (the phone may have slept)": "桥没有响应（手机可能休眠了），会自动重试一次",\n  "(reading…)": "（读取中…）",\n  "waiting for the bridge…": "等待桥响应…",',
    skipIf: '"waiting for the bridge…"',
  },
]);

console.log("done — rebuild the bundle: bun build public/app.js --target=browser --outfile=public/app.bundle.js");
