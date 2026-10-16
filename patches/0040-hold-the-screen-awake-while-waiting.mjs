// Patch 0040 — do not let the phone fall asleep in the one window where sleeping hurts.
//
// Measured 2026-10-15 04:06 (E95): a 4620-byte .md file took 41930 ms to get an answer,
// with `event loop blocked for ~41606ms` next to it and a 336097 ms (5.6 min) stall in the
// same session. The screen was on — the user was looking at "等待桥响应… 20s" — but the
// device idles into Doze/suspension anyway, and a suspended device delays *both* sides:
// the bridge cannot answer and the page's own timers (the 45 s timeout, the progress
// ticker) stop firing, so the user waits without any of the safety nets working.
//
// A screen wake lock held only while a request is in flight keeps the device out of that
// state during exactly the window that matters, and costs nothing when idle: it is
// released the moment the wait ends, and dropped automatically when the page is hidden.
//
// Usage: node patches/0040-hold-the-screen-awake-while-waiting.mjs [appDir]
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
    name: "an upload holds the screen awake for the duration of the wait",
    from: "function postUploadWithProgress(body,onProgress){\n  return new Promise((resolve,reject)=>{\n    const xhr=new XMLHttpRequest();",
    to: "function postUploadWithProgress(body,onProgress){\n  return new Promise((resolve,reject)=>{\n    beginBridgeWait('upload');\n    const xhr=new XMLHttpRequest();",
    skipIf: "beginBridgeWait('upload')",
  },
  {
    name: "and releases it on every outcome",
    from: "    xhr.onload=()=>{\n      stopTicker();",
    to: "    xhr.onload=()=>{\n      stopTicker();\n      endBridgeWait();",
    skipIf: "stopTicker();\n      endBridgeWait();",
  },
  {
    name: "error paths release it too",
    from: "    xhr.onerror=()=>{stopTicker();reject(new Error('Failed to fetch'))};\n    xhr.ontimeout=()=>{stopTicker();reject(Object.assign(new Error('Bridge request timed out: /api/uploads'),{name:'TimeoutError'}))};\n    xhr.onabort=()=>{stopTicker();reject(Object.assign(new Error('Upload aborted'),{name:'AbortError'}))};",
    to: "    xhr.onerror=()=>{stopTicker();endBridgeWait();reject(new Error('Failed to fetch'))};\n    xhr.ontimeout=()=>{stopTicker();endBridgeWait();reject(Object.assign(new Error('Bridge request timed out: /api/uploads'),{name:'TimeoutError'}))};\n    xhr.onabort=()=>{stopTicker();endBridgeWait();reject(Object.assign(new Error('Upload aborted'),{name:'AbortError'}))};",
    skipIf: "stopTicker();endBridgeWait();reject(new Error('Failed to fetch'))",
  },
  {
    name: "a submit holds it across the whole gate run",
    from: "  const submitStartedAt=Date.now();\n  try{\n    const outcome=await submitGate.run(()=>submitPromptInner(event));\n    clientLog('submit: finished in '+(Date.now()-submitStartedAt)+'ms (gate released)');\n    return outcome;\n  }catch(error){",
    to: "  const submitStartedAt=Date.now();\n  beginBridgeWait('submit');\n  try{\n    const outcome=await submitGate.run(()=>submitPromptInner(event));\n    clientLog('submit: finished in '+(Date.now()-submitStartedAt)+'ms (gate released)');\n    return outcome;\n  }catch(error){",
    skipIf: "beginBridgeWait('submit')",
  },
  {
    name: "the gate run releases it",
    from: "    clientLog('submit CRASHED: '+String((error&&error.message)||error)+' @ '+frame.trim());\n    throw error;\n  }\n}",
    to: "    clientLog('submit CRASHED: '+String((error&&error.message)||error)+' @ '+frame.trim());\n    throw error;\n  }finally{endBridgeWait()}\n}",
    skipIf: "}finally{endBridgeWait()}\n}",
  },
], `

// --- screen wake lock while waiting for the bridge (patches/0040) -----------
// The device suspending mid-request is what turns a 5 KB upload into a 42-second wait,
// and it also freezes the page's own timers — so the timeout and the retry cannot fire
// while it matters. Holding a screen wake lock for the duration of the wait keeps the
// device awake exactly then. It is released as soon as the wait ends (nothing to pay
// while idle) and the browser drops it by itself when the page is hidden.
let bridgeWaits=0,screenLock=null;
async function acquireScreenLock(){
  try{
    if(!navigator.wakeLock||screenLock)return;
    screenLock=await navigator.wakeLock.request('screen');
    screenLock.addEventListener('release',()=>{screenLock=null});
    clientLog('screen wake lock held ('+bridgeWaits+' wait(s))');
  }catch(error){/* unsupported or denied: never fatal */}
}
function beginBridgeWait(reason){
  bridgeWaits+=1;
  clientLog('bridge wait begin ('+reason+'), '+bridgeWaits+' active');
  void acquireScreenLock();
}
function endBridgeWait(){
  bridgeWaits=Math.max(0,bridgeWaits-1);
  if(bridgeWaits>0)return;
  try{screenLock?.release?.()}catch(error){/* ignore */}
  screenLock=null;
}
// The lock is dropped automatically when the page is hidden; re-take it if we are still
// waiting when the user comes back.
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible'&&bridgeWaits>0)void acquireScreenLock();
});
`, "function beginBridgeWait(reason){");

console.log("done — rebuild the bundle: bun build public/app.js --target=browser --outfile=public/app.bundle.js");
