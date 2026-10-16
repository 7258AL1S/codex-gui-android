// Patch 0012 — a page that loads while a request is pending must be able to answer it.
//
// Approvals / questions arrive as live events, so a page that was reloaded (or a
// phone browser opened after the request appeared) shows nothing, and the turn
// waits with no way to answer — the failure mode we have seen for real (E32).
// The bridge now keeps the pending requests and exposes them at
// /api/requests/pending (verified end to end in E54); this patch renders them.
//
// Usage: node patches/0012-restore-pending-requests.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const file = resolve(appDir, "public/app.js");
let source = readFileSync(file, "utf8");
let changed = 0;

const CALL_SITE = "state.connected=true;setStatus('connected','Codex connected');if(shouldLoad){loadInitial()";
const CALL_SITE_NEW = "state.connected=true;setStatus('connected','Codex connected');void restorePendingRequests();if(shouldLoad){loadInitial()";

if (source.includes(CALL_SITE_NEW)) {
  console.log("skip  call restorePendingRequests on connect (already applied)");
} else {
  const hits = source.split(CALL_SITE).length - 1;
  if (hits !== 1) throw new Error(`call-site anchor matched ${hits} times`);
  source = source.replace(CALL_SITE, CALL_SITE_NEW);
  changed += 1;
  console.log("apply call restorePendingRequests on connect");
}

const MARKER = "async function restorePendingRequests(";
if (source.includes(MARKER)) {
  console.log("skip  restorePendingRequests definition (already applied)");
} else {
  source += `

// A reload (or a browser opened after the fact) has no live request event to
// render, so ask the bridge what is still unanswered and rebuild the cards.
// Reusing onServerRequest keeps one rendering path for approvals, questions and
// MCP forms — and it is the same id the bridge will accept an answer for.
async function restorePendingRequests(){
  try{
    const response=await fetch('/api/requests/pending',{headers:{accept:'application/json'}});
    if(!response.ok)return;
    const payload=await response.json();
    for(const request of payload?.data||[]){
      if(state.requestCards.has(request.id))continue;
      await onServerRequest(request);
    }
  }catch(error){
    console.error('[codex-webui] could not restore pending requests',error);
  }
}
`;
  changed += 1;
  console.log("apply restorePendingRequests definition");
}

if (changed > 0) {
  writeFileSync(file, source);
  console.log(`\nwrote ${changed} change(s) to ${file}`);
}
console.log("rebuild the bundle:  bun build public/app.js --target=browser --outfile=public/app.bundle.js");
