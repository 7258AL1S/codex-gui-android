// Patch 0034 — say what actually happened, and pick the upload back up when the
// phone wakes, instead of leaving the user staring at "signal is aborted without reason".
//
// From 2026-10-15 03:05 (E90): a 20 KB zip was uploaded twice (both attempts reached
// the bridge and landed on disk) while the device slept for ~50 s. The status was 0
// and the toast read:
//
//   上传失败: campus-network-auto-login-main.zip — signal is aborted without reason
//
// which tells the user nothing. The freeze also hit the conversation load, leaving
// "Loading conversation…" on screen with no next step.
//
// So: translate abort/timeout into an actionable sentence, remember the failed file
// (the File handle is already in memory — no base64 copy), and retry once when the
// page is visible again, which is exactly the moment the device comes back.
//
// Usage: node patches/0034-upload-failure-wording-and-resume-retry.mjs [appDir]
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
    name: "a successful upload clears the resume marker",
    from: "      clientLog('attachment ready: '+payload.name+' ('+payload.bytes+' bytes, '+payload.kind+') in '+(Date.now()-startedAt)+'ms');",
    to: "      clientLog('attachment ready: '+payload.name+' ('+payload.bytes+' bytes, '+payload.kind+') in '+(Date.now()-startedAt)+'ms');\n      pendingUploadRetry=null;",
    skipIf: "pendingUploadRetry=null;",
  },
  {
    name: "a failed upload explains itself and is remembered",
    from: "      const detail=error&&error.message?error.message:String(error);\n      clientLog('attachment failed: '+file.name+' -> '+detail);\n      toast(t('Upload failed')+': '+file.name+' — '+detail,6000);",
    to: "      const detail=uploadErrorText(error);\n      clientLog('attachment failed: '+file.name+' -> '+((error&&error.message)||error)+' @'+((error&&error.name)||''));\n      toast(t('Upload failed')+': '+file.name+' — '+detail,9000);\n      pendingUploadRetry={file,at:Date.now()};",
    skipIf: "pendingUploadRetry={file,at:Date.now()};",
  },
  {
    name: "a stuck history load is reported instead of leaving a spinner",
    from: "  catch(e){if(deferTransition){toast(e?.message||'Could not load side task');return false}",
    to: "  catch(e){clientLog('history load FAILED for '+id+': '+((e&&e.message)||e));if(deferTransition){toast(e?.message||'Could not load side task');return false}",
    skipIf: "history load FAILED for ",
  },
], `

// --- upload failure wording + resume retry (patches/0034) ------------------
// The raw error names ("signal is aborted without reason") are engine jargon; the
// user needs to know whether to wait, retry, or change a phone setting (E90).
let pendingUploadRetry=null;
function uploadErrorText(error){
  const raw=(error&&error.message)?String(error.message):String(error);
  if(/abort|timeout|timed out|Failed to fetch|network/i.test(raw))return t('no answer from the bridge (the phone may have slept)');
  return raw;
}
// The device sleeping is the usual cause, and waking up is the usual cure: retry the
// file we already hold (the File handle, not a base64 copy) once the page is visible.
function retryPendingUpload(){
  const pending=pendingUploadRetry;
  if(!pending||Date.now()-pending.at<8000)return;
  pendingUploadRetry=null;
  clientLog('upload resume retry after the page became visible again');
  void uploadAttachments([pending.file]);
}
`, "function uploadErrorText(error)");

// Wire the retry into the visibility listener that 0031 installed.
patchFile(resolve(appDir, "public/app.js"), [
  {
    name: "retry the remembered upload when the page becomes visible",
    from: "  document.addEventListener('visibilitychange',()=>heartbeatLog('visibility: '+document.visibilityState));",
    to: "  document.addEventListener('visibilitychange',()=>{heartbeatLog('visibility: '+document.visibilityState);if(document.visibilityState==='visible')retryPendingUpload()});",
    skipIf: "if(document.visibilityState==='visible')retryPendingUpload()",
  },
]);

patchFile(resolve(appDir, "public/i18n.js"), [
  {
    name: "Chinese for the upload failure sentence",
    from: '"Still uploading — wait a moment.": "附件还在上传中，稍等一下。",',
    to: '"Still uploading — wait a moment.": "附件还在上传中，稍等一下。",\n  "no answer from the bridge (the phone may have slept)": "桥没有响应（手机可能休眠了），会自动重试一次",',
    skipIf: '"no answer from the bridge (the phone may have slept)":',
  },
]);

console.log("done — rebuild the bundle: bun build public/app.js --target=browser --outfile=public/app.bundle.js");
