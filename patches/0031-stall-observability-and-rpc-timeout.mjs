// Patch 0031 — make "nothing happens" measurable, and stop a dead socket from
// swallowing a send silently.
//
// What the 2026-10-14 evening round showed (E87):
//   * the upload itself works (`attachment picked` → bridge saved the file), but the
//     browser's copy of the response arrived seconds later, while the user was
//     already tapping send and getting nothing;
//   * a submission can leave the composer gate busy for 45 s with no visible reason
//     (`submit: SKIPPED — gate busy`), which reads as "the app is dead";
//   * the bridge log could not answer "when did the browser send this?" because
//     client lines carried no timestamps.
//
// So: timestamps + page id on every client line, an immediate "uploading" chip,
// a visible message when the gate is busy, and a per-RPC timeout so a half-open
// WebSocket (readyState OPEN, peer gone — the classic Android background case)
// rejects and falls back to SSE instead of hanging forever.
//
// Usage: node patches/0031-stall-observability-and-rpc-timeout.mjs [appDir]
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
    // Every client line now carries the client clock and a page id. The bridge logs
    // the arrival delta, so "the request sat somewhere for 4 s" stops being invisible.
    name: "client log carries time, page id, visibility and transport",
    from: "function clientLog(message){\n  try{\n    fetch('/api/client-log',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:String(message)})}).catch(function(){});\n  }catch(error){/* diagnostics must never break the app */}\n}",
    to: "function clientLog(message){\n  try{\n    if(!globalThis.__codexPageId)globalThis.__codexPageId=(Math.random().toString(36)+Date.now().toString(36)).slice(2,9);\n    fetch('/api/client-log',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:String(message),at:Date.now(),pid:globalThis.__codexPageId,vis:document.visibilityState,transport:String(state.transport||'?')})}).catch(function(){});\n  }catch(error){/* diagnostics must never break the app */}\n}",
    skipIf: "__codexPageId=(Math.random()",
  },
  {
    // A half-open socket accepts send() and never answers. Without a timeout the
    // promise below never settles, which is how a whole turn's worth of sends can
    // disappear while the UI keeps looking healthy.
    name: "an rpc over the websocket times out and re-connects instead of hanging",
    from: "  if(state.ws?.readyState===WebSocket.OPEN){try{state.ws.send(JSON.stringify({type:'rpc',id,method,params}));return new Promise((resolve,reject)=>state.pending.set(id,{resolve,reject}))}catch{fallbackToSse(state.ws);return Promise.reject(transportSwitchError())}}\n  return Promise.reject(transportSwitchError());\n}",
    to: "  if(state.ws?.readyState===WebSocket.OPEN){try{state.ws.send(JSON.stringify({type:'rpc',id,method,params}));return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{if(!state.pending.delete(id))return;clientLog('rpc TIMEOUT after 20000ms: '+method);reject(new Error('Bridge request timed out: '+method));fallbackToSse(state.ws)},20000);state.pending.set(id,{resolve:(value)=>{clearTimeout(timer);resolve(value)},reject:(error)=>{clearTimeout(timer);reject(error)}})})}catch{fallbackToSse(state.ws);return Promise.reject(transportSwitchError())}}\n  return Promise.reject(transportSwitchError());\n}",
    skipIf: "rpc TIMEOUT after 20000ms",
  },
  {
    // Pending uploads must never be sent as paths the bridge has not stored yet.
    name: "placeholder attachments are not sent",
    from: "function attachmentInputs(){\n  return state.composerAttachments.map(attachment=>attachment.kind==='image'",
    to: "function attachmentInputs(){\n  return state.composerAttachments.filter(attachment=>!attachment.pending).map(attachment=>attachment.kind==='image'",
    skipIf: "filter(attachment=>!attachment.pending)",
  },
  {
    // Tell the user *why* a tap did nothing instead of swallowing it.
    name: "a swallowed submit says so",
    from: "  if(submitGate.busy){clientLog('submit: SKIPPED — a previous submission is still in flight (gate busy)');return}",
    to: "  if(submitGate.busy){clientLog('submit: SKIPPED — a previous submission is still in flight (gate busy)');toast(t('Still sending the previous message. Try again in a moment.'),4000);return}",
    skipIf: "Still sending the previous message",
  },
  {
    name: "a submission reports how long it took",
    from: "  try{\n    return await submitGate.run(()=>submitPromptInner(event));\n  }catch(error){",
    to: "  const submitStartedAt=Date.now();\n  try{\n    const outcome=await submitGate.run(()=>submitPromptInner(event));\n    clientLog('submit: finished in '+(Date.now()-submitStartedAt)+'ms (gate released)');\n    return outcome;\n  }catch(error){",
    skipIf: "submit: finished in ",
  },
  {
    name: "a failed resume is reported instead of vanishing",
    from: "async function resumeActiveThread(){if(!state.active)return null;const modelOverride=state.active.model?{}:{model:state.selectedModel||undefined};const resumed=await rpc('thread/resume',{threadId:state.active.id,...modelOverride});state.active={...state.active,...resumed.thread};renderHeader();return resumed}",
    to: "async function resumeActiveThread(){if(!state.active)return null;const modelOverride=state.active.model?{}:{model:state.selectedModel||undefined};let resumed;try{resumed=await rpc('thread/resume',{threadId:state.active.id,...modelOverride})}catch(error){clientLog('thread/resume FAILED for '+state.active.id+': '+((error&&error.message)||error));throw error}state.active={...state.active,...resumed.thread};renderHeader();return resumed}",
    skipIf: "thread/resume FAILED for ",
  },
  {
    // Some threads cannot be turn-listed by this app-server build (E87), and the
    // user-visible result is an empty conversation. Fall back to resume, which
    // returns the same turns.
    name: "opening a thread falls back to resume when read has no turns",
    from: "  try{const result=await rpc('thread/read',{threadId:id,includeTurns:true}),thread={...(summary||{}),...result.thread};",
    to: "  try{const loaded=await loadThreadHistory(id),thread={...(summary||{}),...loaded};",
    skipIf: "const loaded=await loadThreadHistory(id)",
  },
  {
    name: "uploads show a chip while the bytes are still moving",
    from: "async function uploadAttachments(files){\n  for(const file of files){\n    try{\n      const dataBase64=await readFileAsDataUrl(file);\n      const response=await fetch('/api/uploads',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:file.name,dataBase64})});\n      const payload=await response.json().catch(()=>({}));\n      if(!response.ok)throw new Error((payload&&payload.error)||('HTTP '+response.status));\n      state.composerAttachments.push({id:payload.path,name:payload.name,path:payload.path,kind:payload.kind,bytes:payload.bytes});\n      renderContextTray();\n      clientLog('attachment ready: '+payload.name+' ('+payload.bytes+' bytes, '+payload.kind+')');\n    }catch(error){\n      const detail=error&&error.message?error.message:String(error);\n      clientLog('attachment failed: '+file.name+' -> '+detail);\n      toast(t('Upload failed')+': '+file.name+' — '+detail,6000);\n    }\n  }\n}",
    to: "async function uploadAttachments(files){\n  for(const file of files){\n    const placeholderId='pending-'+Date.now()+'-'+Math.random().toString(36).slice(2,6);\n    const startedAt=Date.now();\n    try{\n      clientLog('upload start: '+file.name+' ('+file.size+' bytes, '+file.type+')');\n      // Show the chip immediately: the bytes may take a while to move, and a silent\n      // picker round-trip is what made this look broken (E87).\n      state.composerAttachments.push({id:placeholderId,name:file.name+' '+t('(uploading…)'),kind:'file',pending:true});\n      renderContextTray();\n      const dataBase64=await readFileAsDataUrl(file);\n      clientLog('upload read in '+(Date.now()-startedAt)+'ms');\n      const response=await fetch('/api/uploads',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:file.name,dataBase64})});\n      clientLog('upload http '+response.status+' in '+(Date.now()-startedAt)+'ms');\n      const payload=await response.json().catch(()=>({}));\n      if(!response.ok)throw new Error((payload&&payload.error)||('HTTP '+response.status));\n      state.composerAttachments=state.composerAttachments.filter(item=>item.id!==placeholderId);\n      state.composerAttachments.push({id:payload.path,name:payload.name,path:payload.path,kind:payload.kind,bytes:payload.bytes});\n      renderContextTray();\n      clientLog('attachment ready: '+payload.name+' ('+payload.bytes+' bytes, '+payload.kind+') in '+(Date.now()-startedAt)+'ms');\n    }catch(error){\n      state.composerAttachments=state.composerAttachments.filter(item=>item.id!==placeholderId);\n      renderContextTray();\n      const detail=error&&error.message?error.message:String(error);\n      clientLog('attachment failed: '+file.name+' -> '+detail);\n      toast(t('Upload failed')+': '+file.name+' — '+detail,6000);\n    }\n  }\n}",
    skipIf: "upload start: ",
  },
], `

// --- stall diagnostics + history fallback (patches/0031) -------------------
// Everything here is diagnostic or a fallback: it must never break a normal load.

// Android backgrounds the tab while the system file picker is up; the page can be
// frozen and resume arbitrarily later. Recording the transitions is the only way to
// tell "the bridge was slow" from "the page was not running" (E87).
function heartbeatLog(message){
  try{
    if(!globalThis.__codexPageId)globalThis.__codexPageId=(Math.random().toString(36)+Date.now().toString(36)).slice(2,9);
    const payload=JSON.stringify({message:String(message),at:Date.now(),pid:globalThis.__codexPageId,vis:document.visibilityState});
    if(navigator.sendBeacon){navigator.sendBeacon('/api/client-log',new Blob([payload],{type:'application/json'}));return}
    clientLog(message);
  }catch(error){/* diagnostics must never break the app */}
}
try{
  document.addEventListener('visibilitychange',()=>heartbeatLog('visibility: '+document.visibilityState));
  addEventListener('pagehide',()=>heartbeatLog('pagehide'));
  addEventListener('pageshow',()=>heartbeatLog('pageshow'));
  addEventListener('freeze',()=>heartbeatLog('freeze'));
  addEventListener('resume',()=>heartbeatLog('resume'));
  addEventListener('online',()=>heartbeatLog('online'));
  addEventListener('offline',()=>heartbeatLog('offline'));
  let lastTransport=state.transport;
  setInterval(()=>{if(state.transport!==lastTransport){lastTransport=state.transport;clientLog('transport switched to '+state.transport)}},1000);
}catch(error){/* diagnostics must never break the app */}

// History for an opened thread. thread/read with includeTurns is tried first because it
// is the documented path and matches the previous behaviour; some threads answer
// "list_turns is not supported yet" (E87), and then thread/resume — which returns
// the same turns and also attaches the thread — is used instead of showing the user
// an empty conversation.
async function loadThreadHistory(id){
  try{
    const result=await rpc('thread/read',{threadId:id,includeTurns:true});
    const thread=result?.thread||{};
    clientLog('history via thread/read: '+((thread.turns||[]).length)+' turns');
    return thread;
  }catch(readError){
    clientLog('thread/read failed for '+id+': '+((readError&&readError.message)||readError));
    const resumed=await rpc('thread/resume',{threadId:id});
    const thread=resumed?.thread||{};
    clientLog('history via thread/resume: '+((thread.turns||[]).length)+' turns');
    return thread;
  }
}
`, "async function loadThreadHistory(id)");

patchFile(resolve(appDir, "public/i18n.js"), [
  {
    name: "Chinese for the new composer strings",
    from: '"Upload failed": "上传失败",',
    to: '"Upload failed": "上传失败",\n  "(uploading…)": "（上传中…）",\n  "Still sending the previous message. Try again in a moment.": "上一条消息还在发送中，稍等片刻再试。",',
    skipIf: '"Still sending the previous message. Try again in a moment."',
  },
]);

console.log("done — rebuild the bundle: bun build public/app.js --target=browser --outfile=public/app.bundle.js");
