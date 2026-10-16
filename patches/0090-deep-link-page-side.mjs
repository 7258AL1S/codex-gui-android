// Patch 0090 — 深链的页面侧：把 threadId 传给原生接口，并定义 `window.codexDeepLinkOpen`。
//
// 与 patches/0089（APK 侧）配对：
//   - `nativeNotify(title, body, tag, threadId)` 现在把第 4 个参数交给 `CodexNative.notify`
//     （APK 侧新加了同名 4 参重载；老 APK 只会忽略多出来的参数）；
//   - `notification/native` 载荷里的 threadId 会被透传；
//   - 定义 `window.codexDeepLinkOpen(threadId)`：APK 点通知后回调它 → 打开对应会话；
//     会话正开着就什么都不做，避免"点通知把当前页刷新一遍"。
//
// Usage: node patches/0090-deep-link-page-side.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);

function edit(file, marker, steps) {
  const path = resolve(appDir, file);
  let source = readFileSync(path, "utf8");
  if (source.includes(marker)) {
    console.log("skip  " + file + " (already applied)");
    return;
  }
  for (const [from, to, label] of steps) {
    const hits = source.split(from).length - 1;
    if (hits !== 1) throw new Error(file + ": cannot locate " + label + " exactly once (hits=" + hits + ")");
    source = source.replace(from, to);
    console.log("apply " + file + ": " + label);
  }
  writeFileSync(path, source);
}

edit("public/app.js", "codexDeepLinkOpen", [
  [
    "function nativeNotify(title,body,tag){\n  const api=nativeNotifier();\n  if(!api)return false;\n  try{api.notify(String(title||'Codex'),String(body||''),String(tag||'codex-status'));return true}",
    "function nativeNotify(title,body,tag,threadId){\n"
      + "  const api=nativeNotifier();\n"
      + "  if(!api)return false;\n"
      + "  try{\n"
      + "    // 深链（patches/0089/0090）：第 4 个参数是会话 id。\n"
      + "    // 不要用 api.notify.length 判断新老 APK——Java 桥接对象的方法 length 不可靠（实测=0）；\n"
      + "    // 直接按 4 参调用，老 APK 抛异常就退回 3 参。\n"
      + "    if(threadId){\n"
      + "      try{api.notify(String(title||'Codex'),String(body||''),String(tag||'codex-status'),String(threadId));return true}\n"
      + "      catch(error){clientLog('native notify with thread id failed, retrying without it: '+((error&&error.message)||error))}\n"
      + "    }\n"
      + "    api.notify(String(title||'Codex'),String(body||''),String(tag||'codex-status'));\n"
      + "    return true\n"
      + "  }",
    "nativeNotify forwards the thread id",
  ],
  [
    "// 注册一次：桥据此知道\"有应用在跑\"，agent/CLI 侧的通知就能走原生而不是 Termux。",
    "// 深链入口（patches/0090）：APK 点通知后调用它。会话已经开着就不动，避免白刷一次。\n"
      + "globalThis.codexDeepLinkOpen=function(threadId){\n"
      + "  const id=String(threadId||'').trim();\n"
      + "  if(!id)return;\n"
      + "  if(String(state.active?.id||'')===id){clientLog('deep link ignored (already open): '+id);return}\n"
      + "  clientLog('deep link -> open thread '+id);\n"
      + "  void openThread(id);\n"
      + "};\n"
      + "\n"
      + "// 注册一次：桥据此知道\"有应用在跑\"，agent/CLI 侧的通知就能走原生而不是 Termux。",
    "define window.codexDeepLinkOpen",
  ],
  [
    "if(method==='notification/native'){const title=String(p?.title||'Codex'),body=String(p?.body||''),tag=String(p?.tag||'codex-status');",
    "if(method==='notification/native'){const title=String(p?.title||'Codex'),body=String(p?.body||''),tag=String(p?.tag||'codex-status'),link=String(p?.threadId||'');",
    "read the thread id from the notification payload",
  ],
  [
    "if(!nativeNotify(title,body,tag)){",
    "if(!nativeNotify(title,body,tag,link)){",
    "forward the thread id to the native notifier",
  ],
]);

console.log("done — rebuild the bundle: cd app && bun build public/app.js --target=browser --outfile=public/app.bundle.js");
