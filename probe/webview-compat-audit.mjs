// 在 Android WebView 里，某些浏览器 API 根本不存在。裸用它们的代价不是"功能降级"，
// 而是**整个 bundle 在求值阶段抛异常**——页面只剩静态标记，看起来像"界面卡住"。
//
// 实例（E102）：`Notification.permission` 在 WebView 里 undefined，且因为
// localStorage 里 task-notify 为 true 而短路失败，于是
//   client: bundle import FAILED: Notification is not defined
// 整个页面死掉（模型名一直停在"正在加载…"）。
//
// 这个体检逐行检查：用到这些 API 的行必须同时出现某个守卫标记。
//
// Usage: node probe/webview-compat-audit.mjs [appDir]
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(process.argv[2] ?? fileURLToPath(new URL("../app", import.meta.url)));
const publicDir = resolve(appDir, "public");

// API 名 → 该行必须出现的守卫标记（任意一个）
const risky = [
  { pattern: /\bNotification\s*\./, guards: ["notificationSupported()", "typeof Notification"] },
  { pattern: /navigator\.sendBeacon/, guards: ["if(navigator.sendBeacon)", "navigator.sendBeacon?"] },
  { pattern: /navigator\.wakeLock/, guards: ["!navigator.wakeLock", "navigator.wakeLock?"] },
  { pattern: /showOpenFilePicker|showSaveFilePicker|showDirectoryPicker/, guards: ["typeof", "?"] },
  { pattern: /navigator\.share\b/, guards: ["navigator.share?", "in navigator", "typeof"] },
];

const files = readdirSync(publicDir).filter((name) => name.endsWith(".js") && name !== "app.bundle.js");
const problems = [];

for (const name of files) {
  const lines = readFileSync(resolve(publicDir, name), "utf8").split("\n");
  lines.forEach((line, index) => {
    for (const { pattern, guards } of risky) {
      if (!pattern.test(line)) continue;
      // 守卫可以在同一行，也可以是紧邻的前两行（例如
      // `if(!navigator.wakeLock)return;` 之后才 `await navigator.wakeLock.request(...)`）。
      const context = [lines[index - 2] || "", lines[index - 1] || "", line].join("\n");
      if (guards.some((guard) => context.includes(guard))) continue;
      problems.push(`${name}:${index + 1} 裸用 ${pattern.source} → 在 WebView 里会抛异常并让整页失效`);
    }
  });
}

console.log(`扫描 ${files.length} 个前端脚本，检查 ${risky.length} 类 WebView 缺失 API`);

if (problems.length) {
  for (const problem of problems) console.log(`FAIL  ${problem}`);
  process.exit(1);
}
console.log("ok — 所有 WebView 里可能不存在的 API 都在守卫之内");
