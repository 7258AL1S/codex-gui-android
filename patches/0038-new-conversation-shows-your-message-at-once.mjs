// Patch 0038 — in a brand-new conversation, your message appears immediately.
//
// Reported 2026-10-15 03:55 (E94): "在新对话里发文件发不出去". The log shows the whole
// chain succeeding (attachment ready → submit → thread/start → turn/start) — but the
// order inside submitPromptInner was:
//
//   await rpc('thread/start', …)     // 15 s in that run (a freeze)
//   … $('#conversation').innerHTML = ''
//   upsertItem(optimistic)           // only now does anything appear
//
// so the input was cleared and the screen stayed blank for the whole round trip. In an
// existing conversation state.active is already set and the bubble is drawn first, which
// is why the same action behaved differently in a new one.
//
// Fix: draw the optimistic bubble before thread/start, and when the new thread's view is
// cleared afterwards, put the bubble back.
//
// Usage: node patches/0038-new-conversation-shows-your-message-at-once.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const file = resolve(appDir, "public/app.js");
let source = readFileSync(file, "utf8");

const from = "}let optimisticId=null;try{if(!state.active){const startingProjectless=state.projectless,cwd=$('#projectPath').textContent.replace(/^~/,state.config.home);const res=await rpc('thread/start',{cwd,model:state.selectedModel,...permissionThreadPolicy(),sessionStartSource:'startup',...collaborationModeParam()});state.active={...res.thread,projectless:startingProjectless};rememberActiveThread(state.active.id);state.threads.unshift(state.active);renderContextUsage();renderHeader();renderThreads();$('#conversation').innerHTML=''}else if(state.active.canAcceptDirectInput!==true)await resumeActiveThread();const optimistic={id:'local-'+Date.now(),type:'userMessage',content:[...textPart(text),...attachmentContent(attachments)]};optimisticId=optimistic.id;upsertItem(optimistic,'optimistic');await rpc('turn/start',{threadId:state.active.id,input:[...textPart(text),...attachmentInputs(attachments)],model:state.selectedModel,effort:$('#effortSelect').value,cwd:state.active.cwd,...permissionTurnPolicy(state.active.cwd),...collaborationModeParam()});}";
const to = "}let optimisticId=null;try{const optimistic={id:'local-'+Date.now(),type:'userMessage',content:[...textPart(text),...attachmentContent(attachments)]};optimisticId=optimistic.id;if(!state.active){const startingProjectless=state.projectless,cwd=$('#projectPath').textContent.replace(/^~/,state.config.home);upsertItem(optimistic,'optimistic');const res=await rpc('thread/start',{cwd,model:state.selectedModel,...permissionThreadPolicy(),sessionStartSource:'startup',...collaborationModeParam()});state.active={...res.thread,projectless:startingProjectless};rememberActiveThread(state.active.id);state.threads.unshift(state.active);renderContextUsage();renderHeader();renderThreads();$('#conversation').querySelectorAll('#emptyState,.list-state').forEach(node=>node.remove());if(!state.items.get(optimisticId)?.isConnected){state.items.delete(optimisticId);upsertItem(optimistic,'optimistic')}}else{if(state.active.canAcceptDirectInput!==true)await resumeActiveThread();upsertItem(optimistic,'optimistic')}await rpc('turn/start',{threadId:state.active.id,input:[...textPart(text),...attachmentInputs(attachments)],model:state.selectedModel,effort:$('#effortSelect').value,cwd:state.active.cwd,...permissionTurnPolicy(state.active.cwd),...collaborationModeParam()});}";

if (source.includes("upsertItem(optimistic,'optimistic');const res=await rpc('thread/start'")) {
  console.log("skip  already applied");
} else {
  const hits = source.split(from).length - 1;
  if (hits !== 1) throw new Error(`anchor matched ${hits} times, expected 1`);
  writeFileSync(file, source.split(from).join(to));
  console.log("apply new conversation shows the message before thread/start (1x)");
}

console.log("done — rebuild the bundle: bun build public/app.js --target=browser --outfile=public/app.bundle.js");
