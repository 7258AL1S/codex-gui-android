// Patch 0097 — 输入区附件入口：删掉没用的相机按钮，把「+」换成图片图标。
//
// 为什么删（不是"感觉没用"，是有代码证据）：APK 的 `MainActivity.WebChromeClient.onShowFileChooser`
// 用的是 `Intent.createChooser(params.createIntent(), …)` —— 页面上 `capture="environment"`
// 这个"直接开相机"的提示被**忽略**了，所以第三个按钮点下去和第二个"图片/视频"入口行为一模一样。
// 真机相机入口需要 APK 侧 `FileProvider` + `ACTION_IMAGE_CAPTURE`（VERIFICATION.md 一直列为待办），
// 不该用"看起来像相机"的按钮冒充。
//
// 顺手把剩下的图片入口图标从 `plus` 换成 `image`（用户要求）："+ 号"表达不了它是图片/视频入口。
//
// Usage: node patches/0097-composer-attach-icons.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const file = resolve(appDir, "public/index.html");
const html = readFileSync(file, "utf8");

// 幂等判据：这个串是 0091 自己加的，删掉之后就不存在了。
if (!html.includes('title="Take a photo"')) {
  console.log("skip  public/index.html (already applied)");
  process.exit(0);
}

const PLUS_CONTROL = '<label class="composer-circle-button add-control" for="attachmentPicker" title="Attach images or videos" aria-label="Attach images or videos"><span class="icon-slot" data-icon="plus"></span></label>';
const IMAGE_CONTROL = PLUS_CONTROL.replace('data-icon="plus"', 'data-icon="image"');
const CAMERA_CONTROL = '<label class="composer-circle-button add-control" for="cameraPicker" title="Take a photo" aria-label="Take a photo"><span class="icon-slot" data-icon="image"></span></label><input type="file" id="cameraPicker" class="attachment-input" accept="image/*" capture="environment">';

if (!html.includes(PLUS_CONTROL)) throw new Error("cannot locate the composer plus control");
if (!html.includes(CAMERA_CONTROL)) throw new Error("cannot locate the camera control");

writeFileSync(file, html.replace(PLUS_CONTROL, IMAGE_CONTROL).replace(CAMERA_CONTROL, ""));
console.log("apply public/index.html: 删除相机按钮（capture 被宿主的 file chooser 忽略），图片入口图标 plus → image");
console.log("done — 前端改动只需重建 bundle：cd app && bun build public/app.js --target=browser --outfile=public/app.bundle.js");
