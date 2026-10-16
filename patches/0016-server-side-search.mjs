// Patch 0016 — the sidebar search now asks the server instead of filtering only
// what is already in memory.
//
// Upstream wires the input straight to renderThreads(), which filters
// state.threads — i.e. only the pages already loaded. thread/list supports
// searchTerm (verified in probe/p3-thread-ops.mjs), so a phone can actually find
// an old chat.
//
// Usage: node patches/0016-server-side-search.mjs [appDir]
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

replaceOnce(
  "search input also asks the server",
  "$('#threadSearch').addEventListener('input',renderThreads);",
  "$('#threadSearch').addEventListener('input',()=>{renderThreads();scheduleThreadSearch()});",
  "scheduleThreadSearch()",
);

const MARKER = "function scheduleThreadSearch(";
if (source.includes(MARKER)) {
  console.log("skip  server-side search helpers (already applied)");
} else {
  source += `

// Debounced server-side search. The immediate renderThreads() keeps typing
// responsive against what is already loaded; this then replaces the list with
// whatever the server finds across all history.
let threadSearchTimer=null;
function scheduleThreadSearch(){
  const query=$('#threadSearch').value.trim();
  if(threadSearchTimer)clearTimeout(threadSearchTimer);
  threadSearchTimer=setTimeout(()=>searchThreadsOnServer(query),220);
}
async function searchThreadsOnServer(query){
  try{
    const result=await rpc('thread/list',{limit:50,searchTerm:query||null});
    state.threads=result?.data||[];
    renderThreads();
  }catch(error){console.error('Could not search threads',error)}
}
`;
  changed += 1;
  console.log("apply server-side search helpers");
}

if (changed > 0) writeFileSync(file, source);
console.log(`\n${changed} change(s) written to ${file}`);
console.log("rebuild the bundle:  bun build public/app.js --target=browser --outfile=public/app.bundle.js");
