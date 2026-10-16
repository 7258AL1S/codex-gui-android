// Patch 0075 — 读会话时的补录钩子也必须用相对路径（0074 漏掉的那一条路）。
//
// 0074 把"实时通知"和"回源重建"两条路都改成了按仓库根归一化，但真机上撤销仍然报
// `Review diff contains an unsafe path`——加日志才看清：真正记下 diff 的是**第三条路**，
// 也就是 `recordReviewDiffsFromRpc()`（页面读 `thread/turns/list` / `thread/read` 时补录，
// 这样打开旧会话也能撤销）。它还在直接用 `unifiedDiffFromFileChanges()`，于是记下来的补丁
// 带着绝对路径 `a//data/data/…`，被 applyReviewPatch 的安全校验挡下。
//
// 教训：同一个事实（"fileChange 的 path 是绝对路径"）有三条入口，改一条不够。
// 现在三条路统一走 `reviewDiffFromChanges()`。
//
// Usage: node patches/0075-review-hook-relative-paths.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const file = resolve(appDir, "server.ts");
let source = readFileSync(file, "utf8");

if (source.includes("async function recordReviewDiffsFromRpc")) {
  console.log("skip  server.ts (already applied)");
} else {
  const steps = [
    [
      "function recordReviewDiffsFromRpc(method: string, params: any, result: any) {",
      "// 读会话时补录 diff（打开旧会话也能撤销）。它同样必须走相对路径那套合成，\n"
        + "// 否则记下来的补丁带绝对路径，撤销时会被安全校验拒之门外（E122 真机）。\n"
        + "async function recordReviewDiffsFromRpc(method: string, params: any, result: any) {",
      "make the hook async",
    ],
    [
      "    const diff = unifiedDiffFromFileChanges(changes);\n    if (typeof turn?.id === \"string\" && diff) reviewDiffs.record({ threadId, turnId: turn.id, diff });",
      "    const diff = await reviewDiffFromChanges(threadId, changes, result?.thread?.environments?.[0]?.cwd || null);\n"
        + "    if (typeof turn?.id === \"string\" && diff) reviewDiffs.record({ threadId, turnId: turn.id, diff });",
      "synthesize with relative paths",
    ],
    [
      "      recordReviewDiffsFromRpc(method, params, result);",
      "      await recordReviewDiffsFromRpc(method, params, result);",
      "await the hook",
    ],
  ];
  for (const [from, to, label] of steps) {
    const hits = source.split(from).length - 1;
    if (hits !== 1) throw new Error("cannot locate " + label + " exactly once (hits=" + hits + ")");
    source = source.replace(from, to);
    console.log("apply server.ts: " + label);
  }
  writeFileSync(file, source);
}

console.log("done — restart the bridge: ~/bin/codex-gui-web restart");
