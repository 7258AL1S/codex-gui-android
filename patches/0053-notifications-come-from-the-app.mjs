// Patch 0053 — 通知改由应用自己发（E116）。
//
// 现状：APK 里页面的 Web Notification API 不存在（`Notification is undefined`，E102），
// 于是"任务完成 / agent 有话要说"这些提醒只能靠 agent 调 `termux-notification`——
// 通知的来源是 Termux，不是应用。
//
// 三处改动（页面侧）：
//   1) 检测原生接口 `window.CodexNative.notify`（APK 用 addJavascriptInterface 注入），
//      存在就向桥注册一次（`POST /api/notify/register`），桥据此决定走原生还是退回 Termux；
//   2) `maybeNotifyTaskCompleted()` 优先走原生通知；浏览器里没有原生接口，退回 Web Notification；
//   3) 处理桥广播的 `notification/native`（agent/CLI 侧发起的提醒）→ 交给原生接口。
//
// Usage: node patches/0053-notifications-come-from-the-app.mjs [appDir]
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
    // 原生优先：APK 的 JS 接口存在时，通知由应用发（Termux 不再是来源）。
    name: "task completion prefers the native notifier",
    from: "function maybeNotifyTaskCompleted(p){if(!taskNotifyEnabled())return;if(!(notificationSupported())||Notification.permission!=='granted')return;if(document.hasFocus()&&!document.hidden)return;const thread=state.threads.find(x=>x.id===p.threadId),title=thread?.name||t('Task completed');try{new Notification(t('Task completed'),{body:title,tag:`codex-turn-${p.turn?.id||Date.now()}`})}catch{}}",
    to: "function maybeNotifyTaskCompleted(p){if(!taskNotifyEnabled())return;if(document.hasFocus()&&!document.hidden)return;const thread=state.threads.find(x=>x.id===p.threadId),title=thread?.name||t('Task completed'),tag='codex-turn-'+(p.turn?.id||Date.now());if(nativeNotify(t('Task completed'),title,tag))return;if(!(notificationSupported())||Notification.permission!=='granted')return;try{new Notification(t('Task completed'),{body:title,tag})}catch{}}",
    skipIf: "nativeNotify(t('Task completed'),title,tag)",
  },
  {
    name: "the bridge's native-notification event goes to the app",
    from: "function onNotification(method,p){if(method==='serverRequest/resolved'){resolveRequestCard(p?.requestId,'server');return}",
    to: "function onNotification(method,p){if(method==='serverRequest/resolved'){resolveRequestCard(p?.requestId,'server');return}if(method==='notification/native'){const title=String(p?.title||'Codex'),body=String(p?.body||''),tag=String(p?.tag||'codex-status');clientLog('native notification: '+title+' — '+body.slice(0,60));if(!nativeNotify(title,body,tag)){if((notificationSupported())&&Notification.permission==='granted')try{new Notification(title,{body,tag})}catch(error){}}return}",
    skipIf: "native notification: ",
  },
], `

// --- 原生通知（patches/0053）-----------------------------------------------
// APK 通过 addJavascriptInterface 注入 window.CodexNative；浏览器里它不存在，
// 于是同一份页面在两处都能工作：原生优先，浏览器退回 Web Notification。
function nativeNotifier(){
  try{
    const api=globalThis.CodexNative;
    return api&&typeof api.notify==='function'?api:null;
  }catch(error){return null}
}
function nativeNotify(title,body,tag){
  const api=nativeNotifier();
  if(!api)return false;
  try{api.notify(String(title||'Codex'),String(body||''),String(tag||'codex-status'));return true}
  catch(error){clientLog('native notify FAILED: '+((error&&error.message)||error));return false}
}
// 注册一次：桥据此知道"有应用在跑"，agent/CLI 侧的通知就能走原生而不是 Termux。
try{
  if(nativeNotifier()){
    fetch('/api/notify/register',{method:'POST'}).then(()=>clientLog('native notifier registered')).catch(function(){});
  }else{
    clientLog('no native notifier (browser?) — notifications fall back to the Web Notification API');
  }
}catch(error){/* diagnostics must never break the app */}
`, "function nativeNotify(title,body,tag){");

patchFile(resolve(appDir, "public/i18n.js"), [
  {
    name: "nothing to translate for the notifier itself, but keep Task completed",
    from: '"Answered elsewhere": "已在别处处理",',
    to: '"Answered elsewhere": "已在别处处理",\n  "Task completed": "任务完成",',
    skipIf: '"Task completed": "任务完成"',
  },
]);

console.log("done — rebuild the bundle: bun build public/app.js --target=browser --outfile=public/app.bundle.js");
