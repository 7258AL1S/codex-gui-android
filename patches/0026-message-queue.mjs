// Patch 0026 — the third option: queue a message.
//
// P4 asks for an explicit distinction between 追加 / 排队 / 新开回合, and those are
// three different protocol calls (E72):
//   turn/steer        -> 追加, affects the turn that is running now
//   thread/queue/add  -> 排队, runs after the current turn finishes
//   turn/start        -> 新开回合, when nothing is running
// Only the first and third existed in the UI, so "排队" was unreachable.
//
// Usage: node patches/0026-message-queue.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);

function patchFile(file, rules, appendText, appendMarker) {
  let source = readFileSync(file, "utf8");
  let changed = 0;
  for (const rule of rules) {
    if (rule.skipIf && source.includes(rule.skipIf)) { console.log(`skip  ${rule.name} (marker present)`); continue; }
    const hits = source.split(rule.from).length - 1;
    if (hits === 0) throw new Error(`cannot apply "${rule.name}" in ${file}: anchor not found`);
    if (hits > 1) throw new Error(`cannot apply "${rule.name}" in ${file}: anchor matched ${hits} times`);
    source = source.replace(rule.from, rule.to);
    changed += 1;
    console.log(`apply ${rule.name}`);
  }
  if (appendText && !source.includes(appendMarker)) {
    source += appendText;
    changed += 1;
    console.log(`apply append to ${file}`);
  }
  if (changed > 0) writeFileSync(file, source);
  return changed;
}

patchFile(resolve(appDir, "public/index.html"), [
  {
    name: "queue button next to send",
    // type=button so it never submits the form.
    from: '<button class="send-button" id="sendButton" data-composer-control="send" type="submit"',
    to: '<button class="send-button queue-button" id="queueButton" type="button" data-composer-control="queue" title="Queue for after this turn" aria-label="Queue" hidden><span class="icon-slot" data-icon="list"></span></button>\n            <button class="send-button" id="sendButton" data-composer-control="send" type="submit"',
    skipIf: 'id="queueButton"',
  },
]);

patchFile(resolve(appDir, "public/app.js"), [
  {
    name: "queue button follows the composer mode",
    from: "button.title=t(label)",
    to: "const queueButton=$('#queueButton');if(queueButton)queueButton.hidden=mode!=='steer';button.title=t(label)",
    skipIf: "queueButton.hidden=mode!=='steer'",
  },
  {
    name: "bind the queue button",
    from: "$('#collabModeButton')?.addEventListener('click',()=>toggleCollaborationMode());",
    to: "$('#collabModeButton')?.addEventListener('click',()=>toggleCollaborationMode());$('#queueButton')?.addEventListener('click',(event)=>{event.preventDefault();queueMessage()});",
    skipIf: "queueMessage()});",
  },
], `

// 排队：等当前回合结束后再执行（thread/queue/add）。与 turn/steer 的「追加」是两件事，
// 这也是 P4 要求区分三者的那一档（E72）。
async function queueMessage(){
  const input=$('#prompt');
  const text=input.value.trim();
  if(!text)return;
  if(!state.active?.id){toast(t('No active thread to queue into'));return}
  try{
    await rpc('thread/queue/add',{threadId:state.active.id,input:[{type:'text',text}]});
    input.value='';
    state.composerMentions=[];
    renderContextTray();
    resizePrompt();
    syncComposerSubmitState();
    await refreshQueue();
    toast(t('Queued for after this turn'));
  }catch(error){console.error('Could not queue message',error);toast(t('Could not queue message'))}
}

// 队列当前是**只读展示**：删除/排序需要先探明 thread/queue/delete 与 reorder 的参数
// （E72 只确认了 add 与 list 的形状），留待下一步。
async function refreshQueue(){
  let tray=$('#queueTray');
  if(!tray){
    // Created on demand so this patch does not depend on the composer markup.
    const composer=$('#composer');
    if(!composer)return;
    tray=document.createElement('div');
    tray.id='queueTray';
    tray.className='queue-tray';
    tray.hidden=true;
    composer.parentNode.insertBefore(tray,composer);
  }
  if(!state.active?.id){tray.hidden=true;return}
  try{
    const result=await rpc('thread/queue/list',{threadId:state.active.id});
    const items=result?.data||[];
    tray.innerHTML='';
    tray.hidden=items.length===0;
    for(const item of items.slice(0,5)){
      const text=(item?.input||[]).map(part=>part?.text||'').join(' ').trim()||t('Queued message');
      const chip=document.createElement('span');
      chip.className='queue-chip';
      chip.textContent=text.length>60?text.slice(0,60)+'…':text;
      tray.append(chip);
    }
    if(items.length>5){const more=document.createElement('span');more.className='queue-chip';more.textContent=\`+\${items.length-5}\`;tray.append(more)}
  }catch(error){console.error('Could not read the queue',error)}
}
`, "async function queueMessage(");

patchFile(resolve(appDir, "public/i18n.js"), [], `
Object.assign(ZH_CN, {
  "Queue": "排队",
  "Queue for after this turn": "排队（本轮结束后执行）",
  "Queued for after this turn": "已排队，本轮结束后执行",
  "Queued message": "排队中的消息",
  "Could not queue message": "排队失败",
  "No active thread to queue into": "当前没有可排队的会话",
});
`, '"Queued for after this turn": "已排队，本轮结束后执行"');

patchFile(resolve(appDir, "public/style.css"), [], `

/* Queued messages (patch 0026). */
.queue-button{background:#3a3a3a;color:var(--text)}
.queue-button:hover{background:#464646}
.queue-tray{display:flex;flex-wrap:wrap;gap:6px;padding:6px 10px 0}
.queue-tray[hidden]{display:none}
.queue-chip{max-width:100%;padding:3px 8px;border:1px solid var(--border);border-radius:999px;background:var(--surface-hover);color:var(--muted);font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
`, "/* Queued messages (patch 0026). */");

console.log("\nrebuild the bundle:  bun build public/app.js --target=browser --outfile=public/app.bundle.js");
