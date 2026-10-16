// 输入区附件入口的契约测试（patches/0097）。
//
// 钉住三件事：
//   1. **没有相机按钮**：APK 的 onShowFileChooser 用 `params.createIntent()` 起选择器，
//      页面上的 `capture="environment"` 被忽略 —— 那个按钮和"图片/视频"入口行为完全一样，
//      属于"看起来能用其实什么都没多做"的假入口，已删；
//   2. 剩下两个入口：图片/视频（图标 `image`，用户要求把原来的 `+` 换掉）、本地文件（`file`）；
//   3. `app.js` 只绑这两个 input（不能留下指向已删元素的悬空引用）。
//   另外顺带核对图标本身存在 —— 图标名写错会让 icon-slot 渲染成空白。
//
//   node probe/composer-attach-contract.mjs
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "../app/node_modules/jsdom/lib/api.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : `  <- ${detail}`}`);
};

const appDir = resolve(fileURLToPath(new URL("../app", import.meta.url)));
const html = readFileSync(resolve(appDir, "public/index.html"), "utf8");
const dom = new JSDOM(html);
const { document } = dom.window;

const controls = [...document.querySelectorAll("#composer .composer-left label.add-control")];
check("输入区只剩两个附件入口", controls.length === 2, String(controls.length));
check("两个入口分别指向 attachmentPicker / filePicker",
  controls.map((control) => control.getAttribute("for")).join(",") === "attachmentPicker,filePicker",
  controls.map((control) => control.getAttribute("for")).join(","));
check("图片入口的图标是 image（不是原来的 +）",
  controls[0]?.querySelector(".icon-slot")?.getAttribute("data-icon") === "image",
  controls[0]?.querySelector(".icon-slot")?.getAttribute("data-icon"));
check("图片入口仍然是多选 image/*,video/*",
  document.querySelector("#attachmentPicker")?.getAttribute("accept") === "image/*,video/*");
check("文件入口的图标仍是 file",
  controls[1]?.querySelector(".icon-slot")?.getAttribute("data-icon") === "file");

check("相机按钮与它的 input 都已删除（页面上没有 cameraPicker）", !html.includes("cameraPicker"));
check("输入区不再有 capture 提示（避免再次出现「假相机入口」）",
  !/capture=/.test(document.querySelector("#composer")?.outerHTML ?? ""),
  document.querySelector("#composer")?.innerHTML.match(/capture=[^ >]*/)?.[0] ?? "");
check("输入区里没有残留的 + 图标（侧栏的 New chat 不受影响）",
  !document.querySelectorAll("#composer [data-icon=plus]").length);
check("侧栏的 New chat 仍是 + 图标（没被误伤）",
  document.querySelector("#newTask .icon-slot")?.getAttribute("data-icon") === "plus");

const icons = readFileSync(resolve(appDir, "public/codex-icons.js"), "utf8");
check("图标表里有 image（否则图标槽会渲染成空白）", /^\s*image:\s*'/m.test(icons));
check("图标表里有 file", /^\s*file:\s*'/m.test(icons));

const scripts = readdirSync(resolve(appDir, "public")).filter((name) => name.endsWith(".js") && name !== "app.bundle.js");
const dangling = scripts.filter((name) => readFileSync(resolve(appDir, "public", name), "utf8").includes("cameraPicker"));
check("没有脚本再引用 cameraPicker", dangling.length === 0, dangling.join(","));
const appJs = readFileSync(resolve(appDir, "public/app.js"), "utf8");
check("app.js 仍绑着两个 picker",
  /for\(const id of \['attachmentPicker','filePicker'\]\)/.test(appJs),
  appJs.match(/for\(const id of \[[^\]]*\]\)/)?.[0] ?? "");

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
