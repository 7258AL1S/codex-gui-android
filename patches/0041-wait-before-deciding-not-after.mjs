// Patch 0041 — wait for the upload *before* deciding whether the message is sendable.
//
// Field log 2026-10-15 23:15 (E97): the user attached PATCHES.md, pressed send, and no
// RPC ever reached the bridge, yet the gate reported `submit: finished in 4736ms
// (gate released)`. That is the early return: the guard
//
//   if(!text && !hasContext){ … toast "still uploading" … return }
//
// ran while the attachment was still pending (so hasContext was false), which returns
// instead of waiting — and the wait block I added in 0039 sat *after* that guard, so it
// never executed. With an empty text box the only way to send the file was to press send
// again after the upload finished.
//
// New order: interrupt check → model check → wait for pending uploads → decide → snapshot
// → clear → send. Deciding after the wait also means the snapshot is taken once the bytes
// have landed, so nothing has to be merged in hindsight.
//
// Usage: node patches/0041-wait-before-deciding-not-after.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const file = resolve(appDir, "public/app.js");
let source = readFileSync(file, "utf8");
let changed = 0;

const guard = "const readyAttachments=state.composerAttachments.filter(item=>!item.pending),pendingUploads=state.composerAttachments.length-readyAttachments.length,hasContext=readyAttachments.length>0||state.composerMentions.length>0;if(!text&&!hasContext){if(pendingUploads){clientLog('submit: ignored — text empty, '+pendingUploads+' upload(s) still pending');toast(t('Still uploading — wait a moment.'),4000)}return}";
const waitBlock = "const pendingAtSend=state.composerAttachments.filter(item=>item.pending);if(pendingAtSend.length){clientLog('submit: waiting for '+pendingAtSend.length+' upload(s) to finish');toast(t('Waiting for the upload to finish…'),3500);const uploadDeadline=Date.now()+60000;while(state.composerAttachments.some(item=>item.pending)&&Date.now()<uploadDeadline)await new Promise(resolve=>setTimeout(resolve,400));clientLog('submit: upload wait finished ('+(state.composerAttachments.some(item=>item.pending)?'still pending, sending without it':'all ready')+')')}";
const modelCheck = "if(!state.selectedModel){toast(t('This provider returned no models. Check the Codex model catalog configuration.'),6000);syncModelLabel();return}";

// The applied shape carries this marker (the guard's message says "after the wait").
if (source.includes("still pending after the wait")) {
  console.log("skip  already applied");
} else {
  // 1) take the guard out
  if (source.split(guard).length - 1 !== 1) throw new Error("cannot locate the hasContext guard exactly once");
  source = source.replace(guard, "");
  // 2) put it back right after the wait block
  if (source.split(waitBlock).length - 1 !== 1) throw new Error("cannot locate the pending-upload wait block exactly once");
  source = source.replace(waitBlock, waitBlock + guard.replace("still pending", "still pending after the wait"));
  changed += 1;
  console.log("apply wait before deciding (guard moved after the wait)");
  writeFileSync(file, source);
}

// Sanity: the model check must still run before the wait, or a provider with no models
// would make the user wait a minute for nothing.
const finalSource = readFileSync(file, "utf8");
const modelAt = finalSource.indexOf(modelCheck);
const waitAt = finalSource.indexOf(waitBlock);
const guardAt = finalSource.indexOf("const readyAttachments=");
if (modelAt < 0 || waitAt < 0 || guardAt < 0 || !(modelAt < waitAt && waitAt < guardAt)) {
  throw new Error("order is wrong: expected model check → pending-upload wait → hasContext guard");
}
console.log("verified order: model check → wait for uploads → decide");

console.log("done — rebuild the bundle: bun build public/app.js --target=browser --outfile=public/app.bundle.js");
