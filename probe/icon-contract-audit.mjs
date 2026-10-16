// 前端用到的每个图标名都必须有定义。
//
// 为什么（VERIFICATION.md E114）：`codexIconSvg()` 对未知名字是**抛异常**，
// 而 `renderUserInputRequest()` 第一行就 `codexIcon('question')`、
// `renderElicitationRequest()` 用 `codexIcon('plug')`——两个名字当时都没定义，
// 结果**两张卡片整个渲染不出来**，界面上什么都不显示（真机 + 刷新后都一样）。
// 症状是"点了没反应"，看代码却一切正常，因为没有东西指向图标表。
//
// 后来 0048 让未知图标退化成问号，这里再加一道静态检查：名字必须存在（正常路径不靠退化）。
//
// Usage: node probe/icon-contract-audit.mjs [appDir]
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(process.argv[2] ?? fileURLToPath(new URL("../app", import.meta.url)));
const publicDir = resolve(appDir, "public");

const iconSource = readFileSync(resolve(publicDir, "codex-icons.js"), "utf8");
// 图标表是 `name: '<path…>'` 形式；只取对象字面量里那一批。
const tableStart = iconSource.indexOf("codexIconNodes");
const tableEnd = iconSource.indexOf("};", tableStart);
const table = tableStart >= 0 && tableEnd > tableStart ? iconSource.slice(tableStart, tableEnd) : "";
const defined = new Set([...table.matchAll(/^\s*"?([A-Za-z][A-Za-z0-9]*)"?\s*:\s*['"`]/gm)].map((m) => m[1]));

const files = readdirSync(publicDir).filter((name) => name.endsWith(".js") && name !== "app.bundle.js");
const used = new Map();
for (const name of files) {
  const source = readFileSync(resolve(publicDir, name), "utf8");
  for (const match of source.matchAll(/codexIcon\(\s*['"]([A-Za-z][A-Za-z0-9]*)['"]/g)) used.set(match[1], name);
}

const missing = [...used].filter(([icon]) => !defined.has(icon));
console.log(`图标表定义 ${defined.size} 个；前端按名字引用 ${used.size} 个`);
if (missing.length) {
  for (const [icon, file] of missing) {
    console.log(`FAIL  ${file} 用了未定义的图标 "${icon}" —— 在修好之前它会抛异常并吃掉整张卡片`);
  }
  process.exit(1);
}
console.log("ok — 所有被引用的图标名都有定义");
