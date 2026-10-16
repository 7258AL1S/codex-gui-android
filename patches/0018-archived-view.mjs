// Patch 0018 — an entry point for archived threads, so "恢复" is reachable.
//
// patches/0014 added Restore to the row menu, but nothing could ever show an
// archived thread: thread/list only returns them with archived:true (verified in
// probe/p3-thread-ops.mjs). That left a half-finished feature of my own.
//
// Usage: node patches/0018-archived-view.mjs [appDir]
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
    name: "sidebar gets an Archived row",
    from: '<button class="sidebar-row projects-button" id="projectButton" type="button"><span class="icon-slot" data-icon="folderOpen"></span><span>Projects</span></button>',
    to: '<button class="sidebar-row projects-button" id="projectButton" type="button"><span class="icon-slot" data-icon="folderOpen"></span><span>Projects</span></button>\n      <button class="sidebar-row projects-button archived-button" id="archivedButton" type="button" aria-pressed="false"><span class="icon-slot" data-icon="list"></span><span>Archived</span></button>',
    skipIf: 'id="archivedButton"',
  },
]);

patchFile(resolve(appDir, "public/app.js"), [
  {
    // The list source follows the view; archived rows are tagged so the row menu
    // offers "Restore" instead of "Archive".
    name: "refreshThreadList respects the archived view",
    from: "async function refreshThreadList(){if(threadListInFlight){scheduleThreadListRefresh(1000);return}threadListInFlight=true;try{const result=await rpc('thread/list',{limit:50,sortKey:'recency_at',sortDirection:'desc'});applyThreadSummaries(result.data||[])}catch{}finally{threadListInFlight=false;scheduleThreadListRefresh()}}",
    to: "async function refreshThreadList(){if(threadListInFlight){scheduleThreadListRefresh(1000);return}threadListInFlight=true;try{const showArchived=state.archivedView===true;const result=await rpc('thread/list',{limit:50,sortKey:'recency_at',sortDirection:'desc',archived:showArchived});const list=(result.data||[]).map(thread=>showArchived?{...thread,archived:true}:thread);applyThreadSummaries(list)}catch{}finally{threadListInFlight=false;scheduleThreadListRefresh()}}",
    skipIf: "const showArchived=state.archivedView===true",
  },
  {
    name: "bind the Archived button",
    from: "$('#threadSearch').addEventListener('input',()=>{renderThreads();scheduleThreadSearch()});",
    to: "$('#threadSearch').addEventListener('input',()=>{renderThreads();scheduleThreadSearch()});$('#archivedButton')?.addEventListener('click',()=>toggleArchivedView());",
    skipIf: "toggleArchivedView()",
  },
], `

// Archived threads are invisible in the normal list (thread/list returns them only
// with archived:true), so without this the Restore action had no way in.
async function toggleArchivedView(){
  state.archivedView=!state.archivedView;
  const button=$('#archivedButton');
  if(button)button.setAttribute('aria-pressed',String(state.archivedView));
  await refreshThreadList();
  renderThreads();
  toast(state.archivedView?t('Showing archived threads'):t('Showing active threads'));
}
`, "async function toggleArchivedView(");

patchFile(resolve(appDir, "public/i18n.js"), [], `
Object.assign(ZH_CN, {
  "Archived": "已归档",
  "Showing archived threads": "正在显示已归档会话",
  "Showing active threads": "正在显示进行中的会话",
});
`, '"Archived": "已归档"');

patchFile(resolve(appDir, "public/style.css"), [], `

/* Archived toggle (patch 0018). */
.archived-button[aria-pressed="true"]{background:var(--surface-hover);color:var(--text-strong)}
.archived-button[aria-pressed="true"] span:last-child::after{content:" ●";color:var(--success)}
`, "/* Archived toggle (patch 0018). */");

console.log("\nrebuild the bundle:  bun build public/app.js --target=browser --outfile=public/app.bundle.js");
