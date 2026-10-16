// Patch 0021 — call the section-move method the RUNNING server accepts.
//
// probe / manual check: `threadSection/move` (the name in the generated types) is
// rejected with "Invalid request: unknown variant", while `thread/section/move`
// returns a normal result. The generated types and the runtime disagree on this
// name (VERIFICATION.md E59), so the pin action must use the runtime's spelling.
//
// Usage: node patches/0021-fix-section-method-name.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const file = resolve(appDir, "public/app.js");
let source = readFileSync(file, "utf8");

const FROM = "await rpc('threadSection/move',{threadId:thread.id,sectionId:isPinned?null:state.pinnedSectionId});";
const TO = "await rpc('thread/section/move',{threadId:thread.id,sectionId:isPinned?null:state.pinnedSectionId});";

if (source.includes(TO)) {
  console.log("skip  section-move method name (already corrected)");
} else if (source.includes(FROM)) {
  source = source.replace(FROM, TO);
  writeFileSync(file, source);
  console.log("apply section-move method name correction");
} else {
  throw new Error("anchor not found — did patch 0020 change?");
}

console.log("rebuild the bundle:  bun build public/app.js --target=browser --outfile=public/app.bundle.js");
