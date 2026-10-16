// Patch 0036 — the "waiting for the bridge" phase counts seconds.
//
// Measured on 2026-10-15 03:39 (E92): a 200 KB photo needed 52 ms to read and then
// 12.7 s to get an answer — and in the same window the bridge reported a 27 s stall.
// The bytes are never the problem; the answer waits for the phone to schedule the
// Termux process again. That wait used to look like a hung app. Now it is a number
// that keeps moving, so "is it alive?" and "how long has it been?" stop being guesses.
//
// Usage: node patches/0036-count-the-wait-out-loud.mjs [appDir]
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
    name: "the wait for the response is counted and reported",
    from: "    if(xhr.upload&&onProgress){\n      xhr.upload.onprogress=(event)=>{if(!event.lengthComputable||!event.total)return;const fraction=event.loaded/event.total;onProgress(fraction,Math.round(fraction*100)+'%')};\n      // Bytes are out but the bridge has not answered yet: on this device that wait is\n      // exactly where freezes show up, so it gets its own label (E90/E91).\n      xhr.upload.onload=()=>onProgress(1,t('waiting for the bridge…'));\n    }",
    to: "    let waitTicker=null;\n    const stopTicker=()=>{if(waitTicker){clearInterval(waitTicker);waitTicker=null}};\n    if(xhr.upload&&onProgress){\n      xhr.upload.onprogress=(event)=>{if(!event.lengthComputable||!event.total)return;const fraction=event.loaded/event.total;onProgress(fraction,Math.round(fraction*100)+'%')};\n      // Bytes are out but the bridge has not answered yet: on this device that wait is\n      // exactly where freezes show up, so it gets its own label and a running clock\n      // (E90/E91/E92) — a number that moves is the difference between \"working\" and\n      // \"hung\" for whoever is holding the phone.\n      xhr.upload.onload=()=>{\n        const sentAt=Date.now();\n        const render=()=>onProgress(1,t('waiting for the bridge…')+' '+Math.round((Date.now()-sentAt)/1000)+'s');\n        render();\n        stopTicker();\n        waitTicker=setInterval(render,500);\n      };\n    }",
    skipIf: "a number that moves is the difference",
  },
  {
    name: "the clock stops on every completion path",
    from: "    xhr.onload=()=>{\n      let payload=null;\n      try{payload=JSON.parse(xhr.responseText||'{}')}catch{payload=null}\n      resolve({ok:xhr.status>=200&&xhr.status<300,status:xhr.status,json:async()=>payload||{}});\n    };\n    xhr.onerror=()=>reject(new Error('Failed to fetch'));\n    xhr.ontimeout=()=>reject(Object.assign(new Error('Bridge request timed out: /api/uploads'),{name:'TimeoutError'}));\n    xhr.onabort=()=>reject(Object.assign(new Error('Upload aborted'),{name:'AbortError'}));",
    to: "    xhr.onload=()=>{\n      stopTicker();\n      let payload=null;\n      try{payload=JSON.parse(xhr.responseText||'{}')}catch{payload=null}\n      resolve({ok:xhr.status>=200&&xhr.status<300,status:xhr.status,json:async()=>payload||{}});\n    };\n    xhr.onerror=()=>{stopTicker();reject(new Error('Failed to fetch'))};\n    xhr.ontimeout=()=>{stopTicker();reject(Object.assign(new Error('Bridge request timed out: /api/uploads'),{name:'TimeoutError'}))};\n    xhr.onabort=()=>{stopTicker();reject(Object.assign(new Error('Upload aborted'),{name:'AbortError'}))};",
    skipIf: "xhr.onerror=()=>{stopTicker();",
  },
]);

console.log("done — rebuild the bundle: bun build public/app.js --target=browser --outfile=public/app.bundle.js");
