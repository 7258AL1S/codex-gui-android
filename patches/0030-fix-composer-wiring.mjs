// Patch 0030 — stop a missing composer control from killing the whole bundle.
//
// patches/0029 kept upstream's `document.querySelector('[data-composer-control="add"]')`
// wiring line, but the `+` control was later replaced by two <label for=…> elements
// (that is the only picker path that works on Android, see E86) and the attribute went
// with the old button. The line therefore assigned `.onclick` on null, which aborts
// module evaluation: no "app boot", no "build:", no composer wiring, blank-ish page
// that still renders static markup — and it looked like a cache problem for hours.
//
// Usage: node patches/0030-fix-composer-wiring.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);

function patchFile(file, rules, appendText, appendMarker) {
  let source = readFileSync(file, "utf8");
  let changed = 0;
  for (const rule of rules) {
    if (rule.skipIf && source.includes(rule.skipIf)) { console.log(`skip  ${rule.name} (marker present)`); continue; }
    const expected = rule.expect ?? 1;
    const hits = source.split(rule.from).length - 1;
    if (hits !== expected) throw new Error(`cannot apply "${rule.name}" in ${file}: anchor matched ${hits} times, expected ${expected}`);
    source = source.split(rule.from).join(rule.to);
    changed += 1;
    console.log(`apply ${rule.name} (${hits}x)`);
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
    name: "the legacy add-control wiring tolerates the control being gone",
    from: 'document.querySelector(\'[data-composer-control="add"]\').onclick=()=>openAttachmentPicker();',
    to: 'const addControl=document.querySelector(\'[data-composer-control="add"]\');if(addControl)addControl.onclick=()=>openAttachmentPicker();',
    skipIf: "if(addControl)addControl.onclick=()=>openAttachmentPicker();",
  },
  {
    // Same trap one line further down: `dictation` still exists, but a future
    // markup change should degrade to a log line, not to a dead page.
    name: "the dictation wiring tolerates the control being gone",
    from: 'document.querySelector(\'[data-composer-control="dictation"]\').onclick=()=>toast(\'Dictation requires the native desktop audio bridge.\');',
    to: 'const dictationControl=document.querySelector(\'[data-composer-control="dictation"]\');if(dictationControl)dictationControl.onclick=()=>toast(\'Dictation requires the native desktop audio bridge.\');',
    skipIf: "if(dictationControl)dictationControl.onclick=",
  },
], `

// Boot fingerprint. Everything above this line runs during module evaluation, so
// "did the bundle reach the end?" is answerable from the bridge log alone. A missing
// element in the wiring block used to abort the module before any of it was visible
// (E86) — this line plus probe/dom-contract-audit.mjs is the guard against a repeat.
try{
  clientLog('bundle evaluated to end; controls wired, attachments bound');
}catch(error){/* diagnostics must never break the app */}
`, "bundle evaluated to end; controls wired");

console.log("done — rebuild the bundle: bun build public/app.js --target=browser --outfile=public/app.bundle.js");
