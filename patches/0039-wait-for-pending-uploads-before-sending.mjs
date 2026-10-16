// Patch 0039 — a message sent while its attachment is still uploading no longer drops it.
//
// Reported 2026-10-15 03:55 (E94) as "在新对话里发文件发不出去". The bridge log shows the
// upload succeeding (`upload http 200` → `attachment ready: …(2).pdf`), yet the new
// thread's rollout contains exactly one user part:
//
//   USER: ["input_text:这个能看到吗"]          ← no mention{path}, no localImage
//
// The user typed and pressed send while the bytes were still in flight. The composer
// snapshot taken at that moment held the *placeholder* chip, and attachmentInputs()
// skips placeholders (`!attachment.pending`), so the message went out without the file
// and without saying anything. The 15 s submit in the same log is the freeze on top.
//
// Fix: if the snapshot contains pending uploads, wait for them (bounded, with a toast and
// the chip's own progress bar already on screen), then send whatever actually landed.
//
// Usage: node patches/0039-wait-for-pending-uploads-before-sending.mjs [appDir]
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
    name: "a send waits for uploads that are still in flight",
    from: "if(!state.selectedModel){toast(t('This provider returned no models. Check the Codex model catalog configuration.'),6000);syncModelLabel();return}",
    to: "if(!state.selectedModel){toast(t('This provider returned no models. Check the Codex model catalog configuration.'),6000);syncModelLabel();return}const pendingAtSend=attachments.filter(item=>item.pending);if(pendingAtSend.length){clientLog('submit: waiting for '+pendingAtSend.length+' upload(s) to finish');toast(t('Waiting for the upload to finish…'),3500);const uploadDeadline=Date.now()+60000;while(state.composerAttachments.some(item=>item.pending)&&Date.now()<uploadDeadline)await new Promise(resolve=>setTimeout(resolve,400));clientLog('submit: upload wait finished ('+(state.composerAttachments.some(item=>item.pending)?'still pending, sending without it':'all ready')+')')}",
    skipIf: "submit: waiting for '+pendingAtSend.length",
  },
  {
    // The snapshot was taken before the upload finished, so the finished chip lives in
    // the live state — merge both, newest wins, and drop placeholders.
    name: "outbound inputs use the merged, finished attachments",
    from: "...textPart(text),...attachmentInputs(attachments)]",
    to: "...textPart(text),...attachmentInputs(attachmentsForSend(attachments))]",
    expect: 4,
    skipIf: "...attachmentInputs(attachmentsForSend(attachments))]",
  },
  {
    name: "the optimistic bubble uses the merged list too",
    from: "...textPart(text),...attachmentContent(attachments)]",
    to: "...textPart(text),...attachmentContent(attachmentsForSend(attachments))]",
    skipIf: "...attachmentContent(attachmentsForSend(attachments))]",
  },
], `

// --- sending with an upload in flight (patches/0039) -----------------------
// The snapshot is what the composer held when send was pressed; the live state may have
// gained the finished attachment since. Take both, drop placeholders, keep order.
function attachmentsForSend(snapshot=[]){
  const merged=snapshot.filter(item=>!item.pending);
  for(const item of state.composerAttachments){
    if(item.pending)continue;
    if(merged.some(existing=>existing.id===item.id))continue;
    merged.push(item);
  }
  return merged;
}
`, "function attachmentsForSend(snapshot=[]){");

patchFile(resolve(appDir, "public/i18n.js"), [
  {
    name: "Chinese for the upload-wait toast",
    from: '"(attachment)": "（附件）",',
    to: '"(attachment)": "（附件）",\n  "Waiting for the upload to finish…": "正在等待附件上传完成…",',
    skipIf: '"Waiting for the upload to finish…"',
  },
]);

// Follow-up caught by probe/attachments-for-send.test.mjs: the first version deduped
// only while merging the live state, so a snapshot that already held the same
// attachment twice sent it twice.
patchFile(resolve(appDir, "public/app.js"), [
  {
    // TDZ regression: the wait block was inserted *before* `const mentions=…,attachments=…`,
    // so `attachments.filter(...)` threw "Cannot access 'attachments2' before initialization"
    // and every send died instantly (found in the field log, E96). The snapshot is taken a
    // few statements later and nothing changes the composer in between, so read the live
    // list here instead — that removes the ordering constraint instead of relying on it.
    name: "the pending-upload check does not touch the snapshot before it exists",
    from: "const pendingAtSend=attachments.filter(item=>item.pending);",
    to: "const pendingAtSend=state.composerAttachments.filter(item=>item.pending);",
    skipIf: "const pendingAtSend=state.composerAttachments.filter(item=>item.pending);",
  },
  {
    name: "collapsing duplicates happens over both lists",
    from: "function attachmentsForSend(snapshot=[]){\n  const merged=snapshot.filter(item=>!item.pending);\n  for(const item of state.composerAttachments){\n    if(item.pending)continue;\n    if(merged.some(existing=>existing.id===item.id))continue;\n    merged.push(item);\n  }\n  return merged;\n}",
    to: "function attachmentsForSend(snapshot=[]){\n  const merged=[],seen=new Set();\n  for(const item of [...snapshot,...state.composerAttachments]){\n    if(!item||item.pending)continue;\n    const key=item.id||item.path;\n    if(!key||seen.has(key))continue;\n    seen.add(key);\n    merged.push(item);\n  }\n  return merged;\n}",
    skipIf: "const merged=[],seen=new Set();",
  },
]);

console.log("done — rebuild the bundle: bun build public/app.js --target=browser --outfile=public/app.bundle.js");
