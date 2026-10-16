// Patch 0052 — 空表单（没有任何字段）的 elicitation 提交不了。
//
// 现场（E115）：MCP 工具授权用的就是 elicitation，`requestedSchema` 是
// `{type:"object",properties:{}}`（**没有字段**，只是要用户点"同意"）。而
// `buildElicitationModel` 的 form 分支算的是
//
//   canAccept: fields.length > 0 && fields.every(field => field.kind !== "unsupported")
//
// 于是 `fields.length === 0` → canAccept=false → app.js 的 refresh() 里
// `if(!model.canAccept){accept.disabled=true}` → **提交按钮从渲染起就是禁用的**。
// 用户在 GUI 里只能拒绝/取消，任何"无字段的 MCP 表单/工具授权"都批准不了。
//
// 修法：允许 0 个字段（没有输入可填 = 直接确认），仍然拒绝"有无法识别的字段"的情况
// （那才是原来注释里说的"不凭空生成字段"）。
//
// Usage: node patches/0052-an-empty-form-must-be-submittable.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const file = resolve(appDir, "public/codex-surfaces.js");
let source = readFileSync(file, "utf8");

const from = "    canAccept: fields.length > 0 && fields.every((field) => field.kind !== \"unsupported\"),";
const to = "    // 0 个字段是合法情形（无输入可填，等同于「确认」）：MCP 工具授权就是这种。\n"
  + "    // 只有出现客户端无法识别的字段时才必须挡住——那才是「不凭空生成字段」。\n"
  + "    canAccept: fields.every((field) => field.kind !== \"unsupported\"),";

if (source.includes("0 个字段是合法情形")) {
  console.log("skip  already applied");
} else {
  if (source.split(from).length - 1 !== 1) throw new Error("cannot locate the canAccept expression exactly once");
  writeFileSync(file, source.replace(from, to));
  console.log("apply empty forms are submittable (1x)");
}
source = readFileSync(file, "utf8");
if (/fields\.length > 0 && fields\.every/.test(source)) {
  console.error("FAIL  仍然存在 fields.length > 0 的短路");
  process.exit(1);
}
console.log("ok — 空表单可通过，含无法识别字段的表单仍被挡");
