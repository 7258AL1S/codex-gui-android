// Patch 0042 — when the wait is long, say what it is and what fixes it.
//
// 2026-10-15 23:20 (E98): the same 27 KB upload answers in 2.9 ms from Termux
// (`curl` timing, taken while the browser was still waiting), the wake locks are held on
// both sides, and yet the field log carries 73 stalls, the recent ones 15.7 s / 21.3 s /
// 24.3 s / 42.8 s / 63.3 s. Nothing in the page can shorten that, but the page can stop
// being mysterious about it: after ~8 s of waiting it says once, in the user's language,
// that the Termux process is being suspended and which setting changes that.
//
// Usage: node patches/0042-say-why-the-wait-is-long.mjs [appDir]
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
    name: "the wait warns once when it looks like a suspension",
    from: "function beginBridgeWait(reason){\n  bridgeWaits+=1;\n  clientLog('bridge wait begin ('+reason+'), '+bridgeWaits+' active');\n  void acquireScreenLock();\n}",
    to: "function beginBridgeWait(reason){\n  bridgeWaits+=1;\n  clientLog('bridge wait begin ('+reason+'), '+bridgeWaits+' active');\n  void acquireScreenLock();\n  if(bridgeWaits===1&&!bridgeWaitWarned){\n    clearTimeout(bridgeWaitWarnTimer);\n    bridgeWaitWarnTimer=setTimeout(()=>{\n      if(!bridgeWaits||bridgeWaitWarned)return;\n      bridgeWaitWarned=true;\n      clientLog('bridge wait exceeded 8s — the app is probably suspended');\n      toast(t('The bridge has not answered for 8s. Termux is probably suspended; setting its battery policy to “Unrestricted” fixes it.'),9000);\n    },8000);\n  }\n}",
    skipIf: "bridge wait exceeded 8s",
  },
  {
    name: "and stops counting when the wait ends",
    from: "function endBridgeWait(){\n  bridgeWaits=Math.max(0,bridgeWaits-1);\n  if(bridgeWaits>0)return;",
    to: "function endBridgeWait(){\n  bridgeWaits=Math.max(0,bridgeWaits-1);\n  if(bridgeWaits>0)return;\n  clearTimeout(bridgeWaitWarnTimer);",
    skipIf: "clearTimeout(bridgeWaitWarnTimer);\n  try{screenLock?.release?.()}",
  },
], `

// --- explaining a long wait (patches/0042) ---------------------------------
let bridgeWaitWarnTimer=null,bridgeWaitWarned=false;
`, "let bridgeWaitWarnTimer=null,bridgeWaitWarned=false;");

patchFile(resolve(appDir, "public/i18n.js"), [
  {
    name: "Chinese for the suspension hint",
    from: '"Waiting for the upload to finish…": "正在等待附件上传完成…",',
    to: '"Waiting for the upload to finish…": "正在等待附件上传完成…",\n  "The bridge has not answered for 8s. Termux is probably suspended; setting its battery policy to “Unrestricted” fixes it.": "等待桥响应已超过 8 秒：Termux 很可能被系统挂起了。把 Termux 的省电策略设成「无限制」就能改善。",',
    skipIf: '"等待桥响应已超过 8 秒',
  },
]);

console.log("done — rebuild the bundle: bun build public/app.js --target=browser --outfile=public/app.bundle.js");
