// Patch 0070 — 把后端给的 fileChange 变成**可用的** unified diff（P6 的"真实 diff + 安全撤销"）。
//
// 真机实测（本机 app-server 0.162.1，`thread/read` 读回来的原样数据）：
//   kind=add    → diff 是**整份文件内容**：      "hello\n"
//   kind=update → diff 是**没有头部的 diff 主体**： "@@ -1 +1,2 @@\n hello\n+world\n"
//
// 原来的 `unifiedDiffFromFileChanges` 只会补 `--- /dev/null` / `+++ b/<path>` 两行，
// 于是 add 的情形合成出来是：
//     diff --git a/p b/p
//     --- /dev/null
//     +++ b/p
//     hello                     ← 没有 @@ 头、没有 + 前缀
// 结果：前端 `parseUnifiedDiff` 数不出任何增删行（`hasChanges=false`）→ **审阅面板里看不到这一轮的改动**，
// 撤销按钮因此永远不可用；桥那边的 `git apply` 同样会拒绝这个补丁。
// 这正是真机上"改了文件但审阅是空的"的原因（E122）。
//
// 修法：add/delete 自己补齐 `new file mode` / `@@ -0,0 +1,N @@` / 每行 `+`（或 `-`）前缀；
// update 保持原样（它本来就有 hunk）。
//
// 这份实现被两处共用：前端 `public/app.js`（渲染）与桥 `server.ts`（撤销用的 patch），
// 所以放在 `public/codex-surfaces.js` 里一改两得。
//
// Usage: node patches/0070-synthesize-file-change-diff.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const file = resolve(appDir, "public/codex-surfaces.js");
let source = readFileSync(file, "utf8");

if (source.includes("fileContentPatch")) {
  console.log("skip  public/codex-surfaces.js (already applied)");
} else {
  const from = [
    "export function unifiedDiffFromFileChanges(changes = []) {",
    "  const sections = [];",
    "  for (const change of changes) {",
    "    const path = String(change?.path || change?.filePath || \"\");",
    "    const diff = String(change?.diff || change?.unified_diff || \"\").trimEnd();",
    "    if (!path || !diff || /[\\r\\n]/.test(path)) continue;",
    "    if (/^diff --git /m.test(diff)) {",
    "      sections.push(diff);",
    "      continue;",
    "    }",
    "    const kind = fileChangeKind(change);",
    "    const oldPath = kind === \"add\" ? \"/dev/null\" : `a/${path}`;",
    "    const newPath = kind === \"delete\" ? \"/dev/null\" : `b/${path}`;",
    "    const metadata = /^--- /m.test(diff) && /^\\+\\+\\+ /m.test(diff)",
    "      ? diff",
    "      : `--- ${oldPath}\\n+++ ${newPath}\\n${diff}`;",
    "    sections.push(`diff --git a/${path} b/${path}\\n${metadata}`);",
    "  }",
    "  return sections.join(\"\\n\");",
    "}",
  ].join("\n");
  const to = [
    "// add/delete 时后端给的是**整份内容**（不是 diff）：必须自己补 hunk 头与 +/- 前缀，",
    "// 否则 `git apply` 和前端解析都不认（E122：真机上「审阅」面板看不到这一轮的改动）。",
    "function fileContentPatch(path, content, kind) {",
    "  const lines = content === \"\" ? [] : content.split(\"\\n\");",
    "  const marker = kind === \"add\" ? \"+\" : \"-\";",
    "  const hunk = lines.length",
    "    ? `@@ -${kind === \"add\" ? \"0,0\" : `1,${lines.length}`} +${kind === \"add\" ? `1,${lines.length}` : \"0,0\"} @@\\n${lines.map((line) => marker + line).join(\"\\n\")}`",
    "    : null;",
    "  return [",
    "    `diff --git a/${path} b/${path}`,",
    "    kind === \"add\" ? \"new file mode 100644\" : \"deleted file mode 100644\",",
    "    kind === \"add\" ? \"--- /dev/null\" : `--- a/${path}`,",
    "    kind === \"add\" ? `+++ b/${path}` : \"+++ /dev/null\",",
    "    hunk,",
    "  ].filter(Boolean).join(\"\\n\");",
    "}",
    "",
    "export function unifiedDiffFromFileChanges(changes = []) {",
    "  const sections = [];",
    "  for (const change of changes) {",
    "    const path = String(change?.path || change?.filePath || \"\");",
    "    const diff = String(change?.diff || change?.unified_diff || \"\");",
    "    if (!path || /[\\r\\n]/.test(path)) continue;",
    "    if (/^diff --git /m.test(diff)) {",
    "      sections.push(diff.trimEnd());",
    "      continue;",
    "    }",
    "    const kind = fileChangeKind(change);",
    "    if (kind === \"add\" || kind === \"delete\") {",
    "      sections.push(fileContentPatch(path, diff.replace(/\\n$/, \"\"), kind));",
    "      continue;",
    "    }",
    "    const body = diff.trimEnd();",
    "    if (!body) continue;",
    "    const metadata = /^--- /m.test(body) && /^\\+\\+\\+ /m.test(body)",
    "      ? body",
    "      : `--- a/${path}\\n+++ b/${path}\\n${body}`;",
    "    sections.push(`diff --git a/${path} b/${path}\\n${metadata}`);",
    "  }",
    "  // git apply 要求补丁以换行结尾，少这一行会报 \"corrupt patch\"。",
    "  return sections.length ? sections.join(\"\\n\") + \"\\n\" : \"\";",
    "}",
  ].join("\n");
  const hits = source.split(from).length - 1;
  if (hits !== 1) throw new Error("cannot locate unifiedDiffFromFileChanges exactly once (hits=" + hits + ")");
  writeFileSync(file, source.replace(from, to));
  console.log("apply public/codex-surfaces.js: synthesize add/delete patches");
}

console.log("done — rebuild the bundle: cd app && bun build public/app.js --target=browser --outfile=public/app.bundle.js");
