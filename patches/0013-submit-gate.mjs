// Patch 0013 — one submission at a time.
//
// The server merges overlapping turn/start calls into a single turn but records
// the user message twice (E49), and clientUserMessageId does not suppress it
// (E51). So the client must refuse the second submission. The gate itself is
// createSubmitGate() in ui-core.js, unit-tested by probe/submit-gate.test.mjs.
//
// Trap worth spelling out: the E40 fallback calls submitPrompt() *from inside* a
// submission. If that call went through the gate it would be blocked by our own
// in-flight state and the fallback would silently stop working — so it is routed
// to submitPromptInner() instead.
//
// Usage: node patches/0013-submit-gate.mjs [appDir]
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
  "import createSubmitGate",
  "createOverlayBackGuard, filterAppModels,",
  "createOverlayBackGuard, createSubmitGate, filterAppModels,",
  "createSubmitGate, filterAppModels",
);

replaceOnce(
  "wrap submitPrompt in the gate",
  "async function submitPrompt(event){event.preventDefault();",
  "const submitGate=createSubmitGate();\nasync function submitPrompt(event){return submitGate.run(()=>submitPromptInner(event))}\nasync function submitPromptInner(event){event.preventDefault();",
  "submitGate.run(()=>submitPromptInner(event))",
);

replaceOnce(
  "E40 fallback must bypass the gate (we are already inside a submission)",
  "restoreInput();submitPrompt({preventDefault(){}});return}",
  "restoreInput();submitPromptInner({preventDefault(){}});return}",
  "submitPromptInner({preventDefault(){}})",
);

if (changed > 0) writeFileSync(file, source);
console.log(`\n${changed} change(s) written to ${file}`);
console.log("rebuild the bundle:  bun build public/app.js --target=browser --outfile=public/app.bundle.js");
