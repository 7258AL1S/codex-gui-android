// Patch 0044 — the page must not die where the Notification API does not exist.
//
// Found in the field 2026-10-16 00:26 (E102). Inside the APK's WebView the bundle aborted
// during evaluation:
//
//   client: bundle import FAILED: Notification is not defined
//   client: bootstrap FAILED: Notification is not defined
//
// Cause: syncTaskNotifySettings() reads `Notification.permission` with no existence check,
// it is reached from the top-level wiring block, and `codex-webui-task-notify` was true in
// localStorage so the && did not short-circuit. The page then rendered only static markup —
// which is why the model chip stayed on "正在加载…" and almost nothing responded.
//
// The guard is the same shape the other three call sites already use; the difference is that
// this one is on the path taken at load time, so its absence was fatal.
//
// Usage: node patches/0044-webview-notification-guard.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const file = resolve(appDir, "public/app.js");
let source = readFileSync(file, "utf8");

const from = "function syncTaskNotifySettings(){const toggle=$('#settingsTaskNotifyToggle');if(toggle)toggle.checked=taskNotifyEnabled()&&Notification.permission!=='denied'}";
const to = "// 注意顺序：只有在 Notification 真的存在时才碰它。放在 `&&` 的左边会让 truthy 的\n"
  + "// task-notify 设置直接把它求值，于是在没有 Notification 的环境（Android WebView）里\n"
  + "// 整块 bundle 求值失败——界面只剩静态标记（E102）。\n"
  + "function notificationSupported(){return typeof Notification!=='undefined'}\n"
  + "function syncTaskNotifySettings(){const toggle=$('#settingsTaskNotifyToggle');if(toggle)toggle.checked=taskNotifyEnabled()&&notificationSupported()&&Notification.permission!=='denied'}";

if (source.includes("function notificationSupported()")) {
  console.log("skip  already applied");
} else {
  if (source.split(from).length - 1 !== 1) throw new Error("cannot locate syncTaskNotifySettings exactly once");
  source = source.replace(from, to);
  writeFileSync(file, source);
  console.log("apply notification guard on the load-time path");
}

// 其它两处也统一到同一个判断（它们本来就带 `in window` 检查，但形式不一致容易再分叉）。
// 单独一步、幂等：先应用过一次之后仍然要把它们对齐。
for (const variant of ["'Notification' in window", "'Notification'in window"]) {
  if (source.includes(variant)) {
    source = source.split(variant).join("notificationSupported()");
  }
}
writeFileSync(file, source);

// 静态自检：不允许再出现裸的 Notification.permission（函数声明行与已加判断的行除外）
const offenders = source.split("\n").filter((line) =>
  /Notification\.(permission|requestPermission)/.test(line) && !/notificationSupported\(\)/.test(line));
if (offenders.length) {
  console.error("FAIL  unguarded Notification use:");
  for (const line of offenders) console.error("  " + line.trim().slice(0, 120));
  process.exit(1);
}
console.log("ok — 没有裸的 Notification.* 使用");

console.log("done — rebuild the bundle: bun build public/app.js --target=browser --outfile=public/app.bundle.js");
