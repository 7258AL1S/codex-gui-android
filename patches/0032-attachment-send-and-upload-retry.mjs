// Patch 0032 — an attachment must be sendable, and an upload must not hang forever.
//
// From the 2026-10-15 02:5x round (E88):
//   * the image chip appeared with "（上传中…）" and stayed there — the POST never
//     got a response because the bridge was frozen for ~43s mid-request, so the
//     chip had no end state and the user could not tell failure from progress;
//   * tapping send afterwards did *nothing*: the text box was empty, and
//     submitPromptInner returns early on empty text even when the composer holds
//     an attachment. The log line was `submit: finished in 0ms (gate released)`.
//
// So: allow an attachment-only send, give the upload a timeout + one retry, and say
// something when a send is intentionally ignored.
//
// Usage: node patches/0032-attachment-send-and-upload-retry.mjs [appDir]
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
    // An empty text box with an attachment in it is a legitimate message.
    name: "an attachment-only message can be sent",
    from: "if(turnId&&!text){if(state.active)await rpc('turn/interrupt',{threadId:state.active.id,turnId});return}if(!text)return;if(!state.selectedModel)",
    to: "if(turnId&&!text){if(state.active)await rpc('turn/interrupt',{threadId:state.active.id,turnId});return}const readyAttachments=state.composerAttachments.filter(item=>!item.pending),pendingUploads=state.composerAttachments.length-readyAttachments.length,hasContext=readyAttachments.length>0||state.composerMentions.length>0;if(!text&&!hasContext){if(pendingUploads){clientLog('submit: ignored — text empty, '+pendingUploads+' upload(s) still pending');toast(t('Still uploading — wait a moment.'),4000)}return}if(!state.selectedModel)",
    skipIf: "const readyAttachments=state.composerAttachments.filter",
  },
  {
    // The protocol wants a text part only when there is text.
    name: "text parts are omitted when empty",
    from: "input:[{type:'text',text},...attachmentInputs()]",
    to: "input:[...textPart(text),...attachmentInputs()]",
    expect: 4,
    skipIf: "...textPart(text),...attachmentInputs()]",
  },
  {
    name: "the optimistic bubble does the same",
    from: "content:[{type:'text',text},...attachmentContent()]",
    to: "content:[...textPart(text),...attachmentContent()]",
    skipIf: "...textPart(text),...attachmentContent()]",
  },
  {
    // A frozen bridge swallows a request without any error of its own, so the
    // client has to bound the wait: 45s, one retry, then a real failure message.
    name: "uploads time out and retry once",
    from: "      const response=await fetch('/api/uploads',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:file.name,dataBase64})});\n      clientLog('upload http '+response.status+' in '+(Date.now()-startedAt)+'ms');",
    to: "      const response=await uploadWithRetry(file,dataBase64,startedAt);\n      clientLog('upload http '+response.status+' in '+(Date.now()-startedAt)+'ms');",
    skipIf: "await uploadWithRetry(file,dataBase64,startedAt)",
  },
], `

// --- attachment send + upload retry (patches/0032) -------------------------
// A text part only exists when there is text: an image alone is a valid message.
function textPart(text){return text?[{type:'text',text}]:[]}

// The bridge can be frozen mid-request (E87/E88). Without a bound the fetch simply
// never settles, the chip stays on "（上传中…）" and the user cannot tell whether it
// is working. One retry covers the "frozen for a few seconds, then thawed" case,
// which is the common one on this device.
async function uploadWithRetry(file,dataBase64,startedAt,attempt=1){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),45000);
  try{
    const response=await fetch('/api/uploads',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:file.name,dataBase64}),signal:controller.signal});
    if(response.status>=500&&attempt<2){
      clientLog('upload retry: '+file.name+' (HTTP '+response.status+' after '+(Date.now()-startedAt)+'ms)');
      return uploadWithRetry(file,dataBase64,startedAt,attempt+1);
    }
    return response;
  }catch(error){
    if(attempt<2){
      clientLog('upload retry: '+file.name+' ('+((error&&error.message)||error)+' after '+(Date.now()-startedAt)+'ms)');
      return uploadWithRetry(file,dataBase64,startedAt,attempt+1);
    }
    throw error;
  }finally{clearTimeout(timer)}
}
`, "async function uploadWithRetry(");

patchFile(resolve(appDir, "public/i18n.js"), [
  {
    name: "Chinese for the ignored-send hint",
    from: '"Still sending the previous message. Try again in a moment.": "上一条消息还在发送中，稍等片刻再试。",',
    to: '"Still sending the previous message. Try again in a moment.": "上一条消息还在发送中，稍等片刻再试。",\n  "Still uploading — wait a moment.": "附件还在上传中，稍等一下。",',
    skipIf: '"Still uploading — wait a moment."',
  },
]);

console.log("done — rebuild the bundle: bun build public/app.js --target=browser --outfile=public/app.bundle.js");
