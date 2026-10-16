// Patch 0094 — 横屏下的高度夹子：别让 `min-height` 大过可用高度。
//
// 来源：P7 的"横屏/平板布局"这一项。设备当时锁屏（adb offline），真机只能验到
// 对话与终端（E123/E129 已在横屏下验过），于是把设置页/对话框/面板的 CSS 逐条静态核了一遍：
//
//   - `.settings-dialog` 用 `calc(100dvh - 46px)` + 固定两栏 grid → 横屏没问题（dvh 会跟着变）；
//   - `.side-panel-files` 是 flex 列 + `height:100%` → 跟着面板高走，没问题；
//   - **`.folder-card` 有问题**：桌面规则是 `min-height:430px` + `max-height:min(650px,calc(100vh - 28px))`。
//     手机横屏（约 891×412 CSS px）**不匹配 `max-width:480px` 那套移动规则**，于是走桌面规则：
//     可用高度 ≈ 100vh-28 ≈ 384px，比 min-height:430px **还小**——CSS 里 min 赢过 max，
//     卡片会被撑到 430px、高于视口 → 底部按钮被推到屏幕外。
//
// 修法：横屏时把 min-height 也夹进可用高度（`min(430px, calc(100dvh - 28px))`），
// 并把 `100vh` 换成 `100dvh`（移动端键盘/横屏下 dvh 才是可见高度）。竖屏行为不变。
//
// 诚实标注：这是**静态修复**，真机横屏截图待设备解锁后补（PLAN 里记着）。
//
// Usage: node patches/0094-landscape-height-clamp.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const file = resolve(appDir, "public/style.css");
let css = readFileSync(file, "utf8");

if (css.includes("landscape-height-clamp")) {
  console.log("skip  public/style.css (already applied)");
} else {
  css += [
    "",
    "/* landscape-height-clamp（patches/0094）：手机上横屏不匹配 ≤480px 的移动规则，会走桌面规则，",
    "   于是 `.folder-card` 的 min-height:430px 大过可用高度（≈100vh-28），CSS 里 min 赢过 max →",
    "   卡片比屏幕还高、底部按钮跑到屏幕外。这里把 min 也夹进可见高度，并把 100vh 换成 100dvh。 */",
    "@media (orientation: landscape){",
    "  .folder-dialog{max-height:min(650px,calc(100dvh - 28px))}",
    "  .folder-card{min-height:min(430px,calc(100dvh - 28px));max-height:min(650px,calc(100dvh - 28px))}",
    "}",
    "",
  ].join("\n");
  writeFileSync(file, css);
  console.log("apply public/style.css: landscape height clamp");
}

console.log("done — rebuild the bundle: cd app && bun build public/app.js --target=browser --outfile=public/app.bundle.js");
