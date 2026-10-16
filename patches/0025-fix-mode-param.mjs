// Patch 0025 — collaborationMode.settings.model must be a string.
//
// probe/p4-mode-effect.mjs showed the server rejecting the call with
//   Invalid request: invalid type: null, expected a string
// because patch 0024 passed `model: state.selectedModel || null`. A null model is
// only acceptable in some positions; here it is not.
//
// Fix: only send the mode once a real model id is known, and always as a string.
//
// Usage: node patches/0025-fix-mode-param.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const file = resolve(appDir, "public/app.js");
let source = readFileSync(file, "utf8");

const FROM = "  return{collaborationMode:{mode,settings:{model:state.selectedModel||null,reasoning_effort:null,developer_instructions:null}}};";
const TO = "  // A null model is rejected here (\"invalid type: null, expected a string\"),\n  // so if no model is known yet, skip the override entirely.\n  if(!state.selectedModel)return{};\n  return{collaborationMode:{mode,settings:{model:String(state.selectedModel),reasoning_effort:null,developer_instructions:null}}};";

if (source.includes("if(!state.selectedModel)return{};")) {
  console.log("skip  mode param guard (already applied)");
} else if (source.includes(FROM)) {
  source = source.replace(FROM, TO);
  writeFileSync(file, source);
  console.log("apply mode param guard");
} else {
  throw new Error("anchor not found");
}

console.log("rebuild the bundle:  bun build public/app.js --target=browser --outfile=public/app.bundle.js");
