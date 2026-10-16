// Patch 0043 — keep the screen awake for as long as the page is visible.
//
// 2026-10-15 23:30-23:37 (E100): with both the battery policy on "unrestricted" and the
// Termux wake lock held, the bridge still logged stalls of 158 s / 167 s / 230 s — and
// they line up with the windows where nobody was touching the phone. 0040 only held a
// screen wake lock *while a request was in flight*, which cannot cover the case that
// actually hurts: you send a message, then read/watch the streamed answer without
// touching the screen, the screen times out, the device sleeps, and the stream stops
// arriving. That is "加载不出来".
//
// So the lock is now held whenever the document is visible and dropped the moment it is
// hidden (the browser also drops it by itself). The cost is honest and bounded: while you
// are looking at this page, the screen will not time out; switch away or close the tab and
// it is released immediately.
//
// Usage: node patches/0043-keep-the-screen-awake-while-the-page-is-open.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const file = resolve(appDir, "public/app.js");
let source = readFileSync(file, "utf8");

const oldAcquire = "async function acquireScreenLock(){\n  try{\n    if(!navigator.wakeLock||screenLock)return;\n    screenLock=await navigator.wakeLock.request('screen');\n    screenLock.addEventListener('release',()=>{screenLock=null});\n    clientLog('screen wake lock held ('+bridgeWaits+' wait(s))');\n  }catch(error){/* unsupported or denied: never fatal */}\n}";
const newAcquire = "async function acquireScreenLock(reason){\n  try{\n    if(!navigator.wakeLock||screenLock)return;\n    screenLock=await navigator.wakeLock.request('screen');\n    screenLock.addEventListener('release',()=>{screenLock=null});\n    clientLog('screen wake lock held ('+(reason||'wait')+')');\n  }catch(error){/* unsupported or denied: never fatal */}\n}\n"
  + "// While the page is visible the screen must not time out: a sleeping device stops the\n"
  + "// stream, which is exactly what \"the answer never finishes loading\" looks like. Held\n"
  + "// from the first paint, dropped when the page is hidden (the browser times it out\n"
  + "// anyway), retaken when the user comes back.\n"
  + "function syncScreenLock(){\n"
  + "  if(document.visibilityState==='visible')void acquireScreenLock('page visible');\n"
  + "  else try{screenLock?.release?.()}catch(error){/* ignore */}\n"
  + "}";

const oldEnd = "function endBridgeWait(){\n  bridgeWaits=Math.max(0,bridgeWaits-1);\n  if(bridgeWaits>0)return;\n  clearTimeout(bridgeWaitWarnTimer);\n  try{screenLock?.release?.()}catch(error){/* ignore */}\n  screenLock=null;\n}";
const newEnd = "function endBridgeWait(){\n  bridgeWaits=Math.max(0,bridgeWaits-1);\n  if(bridgeWaits>0)return;\n  clearTimeout(bridgeWaitWarnTimer);\n  // Keep the screen lock while the page is visible — see syncScreenLock.\n  if(document.visibilityState!=='visible')try{screenLock?.release?.()}catch(error){/* ignore */}\n}";

const oldVis = "document.addEventListener('visibilitychange',()=>{\n  if(document.visibilityState==='visible'&&bridgeWaits>0)void acquireScreenLock();\n});";
const newVis = "document.addEventListener('visibilitychange',syncScreenLock);\nif(document.readyState==='complete')syncScreenLock();\nelse document.addEventListener('DOMContentLoaded',syncScreenLock);";

if (source.includes("syncScreenLock()")) {
  console.log("skip  already applied");
} else {
  for (const [needle, label] of [[oldAcquire, "acquireScreenLock"], [oldEnd, "endBridgeWait"], [oldVis, "visibility listener"]]) {
    if (source.split(needle).length - 1 !== 1) throw new Error(`cannot locate ${label} exactly once`);
  }
  source = source.replace(oldAcquire, newAcquire).replace(oldEnd, newEnd).replace(oldVis, newVis);
  writeFileSync(file, source);
  console.log("apply screen wake lock follows page visibility (3 anchors)");
}

console.log("done — rebuild the bundle: bun build public/app.js --target=browser --outfile=public/app.bundle.js");
