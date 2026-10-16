// Patch 0054 — 原生通知出口要**每次连上桥都注册一次**。
//
// 现场（E116）：桥重启后，桥侧的"有应用在跑"计数归零（内存计数，重启即丢），
// 而页面只在启动时注册过一次 → 之后 `codex-notify` 会被判成"没有应用在跑"，
// 退回 Termux 通知——正是用户要求换掉的那条路。
//
// 修法：把注册抽成 `registerNativeNotifier()`，除了启动时调用，**桥报告 connected 时也调用**
// （`bridge/status === connected` 是页面既有的"连上了"分支，重连必然经过）。
//
// Usage: node patches/0054-register-native-notifier-on-every-connect.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const file = resolve(appDir, "public/app.js");
let source = readFileSync(file, "utf8");
let changed = 0;

// 1) 启动时的内联注册 → 调用可复用的函数
const inline = "try{\n  if(nativeNotifier()){\n    fetch('/api/notify/register',{method:'POST'}).then(()=>clientLog('native notifier registered')).catch(function(){});\n  }else{\n    clientLog('no native notifier (browser?) — notifications fall back to the Web Notification API');\n  }\n}catch(error){/* diagnostics must never break the app */}";
const call = "registerNativeNotifier();";

if (source.includes("function registerNativeNotifier(")) {
  console.log("skip  already applied");
} else {
  if (source.split(inline).length - 1 !== 1) throw new Error("cannot locate the inline registration block");
  source = source.replace(inline, call);

  // 2) 定义函数
  const definition = `

// 注册原生通知出口。**每次连上桥都要注册**：桥那边是内存计数，重启即归零；
// 页面只在启动时注册过一次的话，桥重启后就会把提醒退回 Termux（E116）。
function registerNativeNotifier(){
  try{
    if(!nativeNotifier())return;
    fetch('/api/notify/register',{method:'POST'})
      .then(()=>clientLog('native notifier registered'))
      .catch(function(){});
  }catch(error){/* diagnostics must never break the app */}
}
`;
  const marker = "function nativeNotify(title,body,tag){";
  const at = source.indexOf(marker);
  if (at < 0) throw new Error("cannot locate nativeNotify to anchor the new function");
  source = source.slice(0, at) + definition.trimStart() + "\n" + source.slice(at);

  // 3) 桥报告 connected 时也注册
  const connected = "if(message.status==='connected'){const shouldLoad=!state.connected;state.connected=true;setStatus('connected','Codex connected');";
  if (source.split(connected).length - 1 !== 1) throw new Error("cannot locate the bridge/status connected branch");
  source = source.replace(connected, connected + "registerNativeNotifier();");
  changed += 1;
  writeFileSync(file, source);
  console.log("apply register-on-every-connect (3 edits)");
}

const finalSource = readFileSync(file, "utf8");
for (const needle of ["function registerNativeNotifier(", "registerNativeNotifier();"]) {
  if (!finalSource.includes(needle)) throw new Error(`missing after patch: ${needle}`);
}
console.log("ok — 启动时与每次 connected 都会注册");
