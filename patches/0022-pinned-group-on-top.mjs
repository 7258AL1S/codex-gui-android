// Patch 0022 — Pinned must be the first group, not merely the most recent.
//
// User report: the Pinned group appeared, but not at the top. Cause: the sort
// puts the CURRENT project first — (a.key===currentKey ? -1 : ...) — and that rule
// is evaluated before recency, so my recency: MAX_SAFE_INTEGER never won against
// "this is the project you are looking at".
//
// Usage: node patches/0022-pinned-group-on-top.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const file = resolve(appDir, "public/app.js");
let source = readFileSync(file, "utf8");

const FROM = "const currentKey=currentSidebarProjectKey(),ordered=[...groups.values()].sort((a,b)=>(a.key===currentKey?-1:b.key===currentKey?1:b.recency-a.recency));";
const TO = "const currentKey=currentSidebarProjectKey(),ordered=[...groups.values()].sort((a,b)=>a.key==='__pinned__'?-1:b.key==='__pinned__'?1:a.key===currentKey?-1:b.key===currentKey?1:b.recency-a.recency);";

if (source.includes(TO)) {
  console.log("skip  pinned group ordering (already applied)");
} else if (source.includes(FROM)) {
  source = source.replace(FROM, TO);
  writeFileSync(file, source);
  console.log("apply pinned group is always first");
} else {
  throw new Error("anchor not found");
}

console.log("rebuild the bundle:  bun build public/app.js --target=browser --outfile=public/app.bundle.js");
