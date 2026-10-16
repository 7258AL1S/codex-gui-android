// Patch 0074 — fileChange 的 path 是**绝对路径**，撤销前必须按仓库根归一化。
//
// 现场（真机 + 接口级别复现）：
//     $ curl -X POST …/api/review/patch -d '{"…","action":"undo"}'
//     {"error":"Review diff contains an unsafe path"}
// 因为本机 app-server 给的 changes 长这样（`thread/read` 原样）：
//     {"path":"/data/data/com.termux/files/home/tmp/git-demo/mobile-probe.txt","kind":{"type":"update"},"diff":"@@ -1 +1,2 @@…"}
// 而 `git apply` 只接受仓库内**相对**路径（`a/mobile-probe.txt`）。绝对路径拼出来的
// `diff --git a//data/…` 会被 applyReviewPatch 的安全校验拦下（拦得对，但功能就没了）。
//
// 修法：桥在合成 diff 之前，把 path 按"该会话工作区所属 git 仓库的根"裁成相对路径：
//   - 仓库根来自 thread 的 environments[0].cwd 或 thread/read 里的 cwd（有缓存，避免每个 item 一次往返）；
//   - 不在仓库内的绝对路径保持原样 → 校验会拒绝（这是正确行为：git 撤不了仓库外的东西）。
// 实时通知（item/completed）与回源重建（thread/read）两条路都走同一套。
//
// Usage: node patches/0074-relativize-file-change-paths.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const file = resolve(appDir, "server.ts");
let source = readFileSync(file, "utf8");

if (source.includes("reviewDiffFromChanges")) {
  console.log("skip  server.ts (already applied)");
} else {
  const helpers = [
    "// fileChange 的 path 是绝对路径（本机 app-server 实测），git apply 只认仓库内相对路径。",
    "// 每个 thread 的仓库根只查一次（cwd 基本不变），避免每个 item 都往返一趟。",
    "const repoRootCache = new Map<string, string | null>();",
    "",
    "async function repositoryRootFor(threadId: string, cwdHint?: string | null) {",
    "  if (repoRootCache.has(threadId)) return repoRootCache.get(threadId)!;",
    "  let base = cwdHint || null;",
    "  if (!base) {",
    "    try {",
    "      const thread = await request(\"thread/read\", { threadId, includeTurns: false });",
    "      base = thread?.thread?.environments?.[0]?.cwd || thread?.thread?.cwd || null;",
    "    } catch { /* 拿不到就当没有 */ }",
    "  }",
    "  let root: string | null = null;",
    "  if (base) {",
    "    try {",
    "      root = execFileSync(\"git\", [\"-C\", base, \"rev-parse\", \"--show-toplevel\"], { encoding: \"utf8\", stdio: [\"ignore\", \"pipe\", \"ignore\"] }).trim() || null;",
    "    } catch { root = null; }",
    "  }",
    "  repoRootCache.set(threadId, root);",
    "  return root;",
    "}",
    "",
    "async function reviewDiffFromChanges(threadId: string, changes: any[], cwdHint?: string | null) {",
    "  if (!Array.isArray(changes) || !changes.length) return \"\";",
    "  const needsRoot = changes.some((change: any) => String(change?.path || \"\").startsWith(\"/\"));",
    "  const root = needsRoot ? await repositoryRootFor(threadId, cwdHint) : null;",
    "  const relative = changes.map((change: any) => {",
    "    const path = String(change?.path || \"\");",
    "    if (root && path.startsWith(`${root}/`)) return { ...change, path: path.slice(root.length + 1) };",
    "    return change;",
    "  });",
    "  return unifiedDiffFromFileChanges(relative);",
    "}",
    "",
  ].join("\n");

  const steps = [
    [
      "function recordFileChangeDiff({ threadId, turnId, changes }: any) {\n  const diff = unifiedDiffFromFileChanges(Array.isArray(changes) ? changes : []);\n  if (diff) reviewDiffs.record({ threadId, turnId, diff });\n}",
      helpers + "async function recordFileChangeDiff({ threadId, turnId, changes }: any) {\n"
        + "  if (typeof threadId !== \"string\" || typeof turnId !== \"string\") return;\n"
        + "  const diff = await reviewDiffFromChanges(threadId, Array.isArray(changes) ? changes : []);\n"
        + "  if (diff) reviewDiffs.record({ threadId, turnId, diff });\n"
        + "}",
      "record with relative paths",
    ],
    [
      "    if (message.method === \"item/fileChange/patchUpdated\") recordFileChangeDiff(message.params || {});\n    if (message.method === \"item/completed\" && message.params?.item?.type === \"fileChange\") {\n      recordFileChangeDiff({ ...message.params, changes: message.params.item.changes });\n    }",
      "    if (message.method === \"item/fileChange/patchUpdated\") void recordFileChangeDiff(message.params || {});\n"
        + "    if (message.method === \"item/completed\" && message.params?.item?.type === \"fileChange\") {\n"
        + "      void recordFileChangeDiff({ ...message.params, changes: message.params.item.changes });\n"
        + "    }",
      "fire-and-forget recording",
    ],
    [
      "      const changes = (turn.items || []).flatMap((item: any) => item?.type === \"fileChange\" && Array.isArray(item.changes) ? item.changes : []);\n      const diff = unifiedDiffFromFileChanges(changes);\n      if (!diff) continue;",
      "      const changes = (turn.items || []).flatMap((item: any) => item?.type === \"fileChange\" && Array.isArray(item.changes) ? item.changes : []);\n"
        + "      const cwd = result?.thread?.environments?.[0]?.cwd || result?.thread?.cwd || null;\n"
        + "      const diff = await reviewDiffFromChanges(threadId, changes, cwd);\n"
        + "      if (!diff) continue;",
      "recovery uses the same synthesis",
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
