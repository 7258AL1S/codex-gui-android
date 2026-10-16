// Patch 0033 — send the attachment snapshot, not the state that was just cleared.
//
// Found by the browser-side session on 2026-10-15 and confirmed here in the source
// (E89). In submitPromptInner the order is:
//
//   const mentions=state.composerMentions,attachments=state.composerAttachments;
//   input.value=''; state.composerMentions=[]; state.composerAttachments=[];   // cleared
//   … await rpc('turn/start',{ …, input:[…attachmentInputs()] })              // reads state
//
// attachmentInputs() reads state.composerAttachments, which is empty by then, so every
// send dropped its attachments: the chip disappeared, the bytes stayed on the bridge,
// and the model only ever saw ["user.text"]. The snapshot existed but was used only for
// the error rollback. Result: "I sent an image/PDF and it never saw it."
//
// Fix: attachmentInputs()/attachmentContent() take the list to use, and the outbound
// calls pass the snapshot.
//
// Usage: node patches/0033-send-the-snapshot-not-the-cleared-state.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);

function patchFile(file, rules) {
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
  if (changed > 0) writeFileSync(file, source);
  return changed;
}

patchFile(resolve(appDir, "public/app.js"), [
  {
    name: "attachmentInputs takes the list to encode",
    from: "function attachmentInputs(){\n  return state.composerAttachments.filter(attachment=>!attachment.pending).map(attachment=>attachment.kind==='image'",
    to: "function attachmentInputs(list=state.composerAttachments){\n  return list.filter(attachment=>!attachment.pending).map(attachment=>attachment.kind==='image'",
    skipIf: "function attachmentInputs(list=",
  },
  {
    name: "attachmentContent passes it through",
    from: "function attachmentContent(){return attachmentInputs()}",
    to: "function attachmentContent(list=state.composerAttachments){return attachmentInputs(list)}",
    skipIf: "function attachmentContent(list=",
  },
  {
    // The four outbound calls (two steer attempts, turn/start, queue/add) all run
    // after the state was cleared — that is the bug.
    name: "outbound input uses the snapshot",
    from: "...textPart(text),...attachmentInputs()]",
    to: "...textPart(text),...attachmentInputs(attachments)]",
    expect: 4,
    skipIf: "...attachmentInputs(attachments)]",
  },
  {
    name: "the optimistic bubble uses the snapshot too",
    from: "...textPart(text),...attachmentContent()]",
    to: "...textPart(text),...attachmentContent(attachments)]",
    skipIf: "...attachmentContent(attachments)]",
  },
]);

console.log("done — rebuild the bundle: bun build public/app.js --target=browser --outfile=public/app.bundle.js");
