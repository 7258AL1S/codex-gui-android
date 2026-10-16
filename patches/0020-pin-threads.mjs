// Patch 0020 — pin / unpin, using the section the server already provides.
//
// Audit (E56) found threadSection/* unused by the UI, but threadSection/list
// already returns a "Pinned" section, and ThreadSectionMoveParams is exactly
// { threadId, sectionId | null } — so pinning is "move into that section".
//
// Usage: node patches/0020-pin-threads.mjs [appDir]
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

patchFile(resolve(appDir, "public/app.js"), [
  {
    name: "Pinned gets its own group name",
    from: "function sidebarProjectName(key){if(key==='__tasks__')return'Tasks';",
    to: "function sidebarProjectName(key){if(key==='__tasks__')return'Tasks';if(key==='__pinned__')return'Pinned';",
    skipIf: "if(key==='__pinned__')return'Pinned'",
  },
  {
    name: "pull pinned threads out of the cwd groups",
    from: "for(const thread of state.threads){if(q&&!titleOf(thread).toLowerCase().includes(q)&&!thread.cwd?.toLowerCase().includes(q))continue;const key=sidebarProjectKey(thread),",
    to: "const pinnedThreads=[];for(const thread of state.threads){if(q&&!titleOf(thread).toLowerCase().includes(q)&&!thread.cwd?.toLowerCase().includes(q))continue;if(state.pinnedSectionId&&thread.section?.id===state.pinnedSectionId){pinnedThreads.push(thread);continue}const key=sidebarProjectKey(thread),",
    skipIf: "const pinnedThreads=[];",
  },
  {
    name: "render the Pinned group first",
    from: "  const currentKey=currentSidebarProjectKey(),ordered=[...groups.values()].sort(",
    to: "  if(pinnedThreads.length)groups.set('__pinned__',{key:'__pinned__',threads:pinnedThreads,recency:Number.MAX_SAFE_INTEGER});\n  const currentKey=currentSidebarProjectKey(),ordered=[...groups.values()].sort(",
    skipIf: "groups.set('__pinned__'",
  },
  {
    name: "menu gets Pin / Unpin",
    from: "  add(t('Fork'),()=>forkThread(thread));\n  if(thread.archived)add(t('Restore'),()=>unarchiveThread(thread));else add(t('Archive'),()=>archiveThread(thread));",
    to: "  add(t('Fork'),()=>forkThread(thread));\n  const isPinned=Boolean(state.pinnedSectionId&&thread.section?.id===state.pinnedSectionId);\n  add(isPinned?t('Unpin'):t('Pin'),()=>togglePinThread(thread));\n  if(thread.archived)add(t('Restore'),()=>unarchiveThread(thread));else add(t('Archive'),()=>archiveThread(thread));",
    skipIf: "add(isPinned?t('Unpin'):t('Pin')",
  },
  {
    name: "load the section list at startup",
    from: "$('#archivedButton')?.addEventListener('click',()=>toggleArchivedView());",
    to: "$('#archivedButton')?.addEventListener('click',()=>toggleArchivedView());void loadThreadSections();",
    skipIf: "void loadThreadSections();",
  },
], `

// Pinning uses the server's own sections: threadSection/list already ships a
// "Pinned" one, and threadSection/move takes { threadId, sectionId | null }.
async function loadThreadSections(){
  try{
    const result=await rpc('threadSection/list',{});
    const pinned=(result?.data||[]).find(section=>String(section?.name||'').toLowerCase()==='pinned');
    state.pinnedSectionId=pinned?.id??null;
  }catch(error){console.error('Could not load thread sections',error)}
}

async function togglePinThread(thread){
  if(!thread?.id)return;
  if(!state.pinnedSectionId)await loadThreadSections();
  if(!state.pinnedSectionId){toast(t('Could not pin thread'));return}
  const isPinned=thread.section?.id===state.pinnedSectionId;
  try{
    await rpc('threadSection/move',{threadId:thread.id,sectionId:isPinned?null:state.pinnedSectionId});
    await refreshThreadList();renderThreads();
    toast(isPinned?t('Thread unpinned'):t('Thread pinned'));
  }catch(error){console.error('Could not pin thread',error);toast(t('Could not pin thread'))}
}
`, "async function loadThreadSections(");

patchFile(resolve(appDir, "public/i18n.js"), [], `
Object.assign(ZH_CN, {
  "Pin": "置顶",
  "Unpin": "取消置顶",
  "Pinned": "置顶",
  "Thread pinned": "已置顶",
  "Thread unpinned": "已取消置顶",
  "Could not pin thread": "置顶失败",
});
`, '"Unpin": "取消置顶"');

console.log("\nrebuild the bundle:  bun build public/app.js --target=browser --outfile=public/app.bundle.js");
