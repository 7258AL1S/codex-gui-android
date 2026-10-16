// Patch 0014 — thread row actions the UI never had: rename, fork, archive.
//
// Audit (see E56): the frontend never calls thread/fork, thread/archive,
// thread/unarchive or thread/name/set, and its search box only filters the pages
// already in memory. All of those work on the server side — verified in
// probe/p3-thread-ops.mjs before wiring anything up.
//
// The row already has a delete button, so this adds a "⋯" menu next to it rather
// than more buttons; on a phone the row is already tight.
//
// Usage: node patches/0014-thread-actions.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const file = resolve(appDir, "public/app.js");
let source = readFileSync(file, "utf8");
let changed = 0;

function replaceOnce(name, from, to, skipIf) {
  if (skipIf && source.includes(skipIf)) { console.log(`skip  ${name} (marker present)`); return; }
  const hits = source.split(from).length - 1;
  if (hits === 0) throw new Error(`cannot apply "${name}": anchor not found`);
  if (hits > 1) throw new Error(`cannot apply "${name}": anchor matched ${hits} times`);
  source = source.replace(from, to);
  changed += 1;
  console.log(`apply ${name}`);
}

const HELPERS = `

// Thread actions the upstream UI never wired up (audit in E56). All three RPCs
// are verified working in probe/p3-thread-ops.mjs.
async function renameThread(thread){
  if(!thread?.id)return;
  const next=prompt(t('Rename thread'),titleOf(thread));
  if(next===null)return;
  const name=String(next).trim();
  if(!name)return;
  try{
    await rpc('thread/name/set',{threadId:thread.id,name});
    await refreshThreadList();renderThreads();
    toast(t('Thread renamed'));
  }catch(error){console.error('Could not rename thread',error);toast(t('Could not rename thread'))}
}

async function forkThread(thread){
  if(!thread?.id)return;
  try{
    const result=await rpc('thread/fork',{threadId:thread.id});
    const forkedId=result?.thread?.id??result?.id;
    await refreshThreadList();renderThreads();
    if(forkedId)await openThread(forkedId);
    toast(t('Thread forked'));
  }catch(error){console.error('Could not fork thread',error);toast(t('Could not fork thread'))}
}

async function archiveThread(thread){
  if(!thread?.id)return;
  try{
    await rpc('thread/archive',{threadId:thread.id});
    const wasActive=state.active?.id===thread.id;
    state.threads=state.threads.filter(item=>item.id!==thread.id);
    await refreshThreadList();
    if(wasActive)startNewTask();else renderThreads();
    toast(t('Thread archived'));
  }catch(error){console.error('Could not archive thread',error);toast(t('Could not archive thread'))}
}

async function unarchiveThread(thread){
  if(!thread?.id)return;
  try{
    await rpc('thread/unarchive',{threadId:thread.id});
    state.threads=state.threads.filter(item=>item.id!==thread.id);
    renderThreads();
    toast(t('Thread restored'));
  }catch(error){console.error('Could not restore thread',error);toast(t('Could not restore thread'))}
}

// A "⋯" button that opens a small popover. Closed on outside click / Escape so it
// behaves on a phone.
function threadActionsButton(thread){
  const wrap=document.createElement('span');
  wrap.className='thread-actions';
  const trigger=document.createElement('button');
  trigger.type='button';
  trigger.className='icon-button small thread-actions-trigger';
  trigger.title=t('Thread actions');
  trigger.setAttribute('aria-label',t('Thread actions'));
  trigger.setAttribute('aria-expanded','false');
  trigger.innerHTML=codexIcon('moreHorizontal');
  const menu=document.createElement('div');
  menu.className='thread-actions-menu';
  menu.hidden=true;
  const add=(label,handler)=>{const button=document.createElement('button');button.type='button';button.className='thread-actions-item';button.textContent=label;button.onclick=(event)=>{event.stopPropagation();close();handler()};menu.append(button)};
  add(t('Rename'),()=>renameThread(thread));
  add(t('Fork'),()=>forkThread(thread));
  if(thread.archived)add(t('Restore'),()=>unarchiveThread(thread));else add(t('Archive'),()=>archiveThread(thread));
  const close=()=>{menu.hidden=true;trigger.setAttribute('aria-expanded','false');document.removeEventListener('click',onOutside,true);document.removeEventListener('keydown',onKey,true)};
  const onOutside=(event)=>{if(!wrap.contains(event.target))close()};
  const onKey=(event)=>{if(event.key==='Escape')close()};
  trigger.onclick=(event)=>{
    event.stopPropagation();
    const open=menu.hidden;
    menu.hidden=!open;
    trigger.setAttribute('aria-expanded',String(open));
    if(open){document.addEventListener('click',onOutside,true);document.addEventListener('keydown',onKey,true)}else close();
  };
  wrap.append(menu,trigger);
  return wrap;
}
`;

const BEFORE_DELETE = "async function deleteThread(thread){";
if (source.includes("async function renameThread(thread){")) {
  console.log("skip  thread action helpers (already applied)");
} else {
  const hits = source.split(BEFORE_DELETE).length - 1;
  if (hits !== 1) throw new Error(`deleteThread anchor matched ${hits} times`);
  source = source.replace(BEFORE_DELETE, HELPERS.trimStart() + "\n" + BEFORE_DELETE);
  changed += 1;
  console.log("apply thread action helpers (rename/fork/archive/unarchive + menu)");
}

replaceOnce(
  "row gets the action button",
  "row.append(name,meta,remove);",
  "row.append(name,meta,remove,threadActionsButton(thread));",
  "threadActionsButton(thread));",
);

if (changed > 0) writeFileSync(file, source);
console.log(`\n${changed} change(s) written to ${file}`);
console.log("rebuild the bundle:  bun build public/app.js --target=browser --outfile=public/app.bundle.js");
