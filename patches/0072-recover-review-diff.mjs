// Patch 0072 — 撤销的 diff 丢了就**回源重建**，别让"桥重启过"变成撤不了的借口。
//
// 现场（真机）：手机上按撤销没有任何反应。诊断日志证明按钮没被禁用、请求也发出去了：
//   client: review patch click: hasTurn=true thread=01a140fe-… disabled=false action=undo
// 真正的原因在桥这边：`ReviewDiffStore` 是**内存**的，只记实时通知（`turn/diff/updated`、
// `item/completed{fileChange}`）。我两点之间重启过桥，store 空了 →
// `reviewDiffs.begin()` 抛 "Review diff is unavailable or expired" → 页面只弹一个 toast，
// 看起来就是"点了没反应"。
//
// 但这一轮的改动并没有丢：`thread/read{includeTurns:true}` 里那个 fileChange item 带着
// `changes`（path/kind/diff），用同一套 `unifiedDiffFromFileChanges` 就能重新合成补丁。
// 所以：store 里没有就先回源重建一次，再重试；仍然没有才把原始错误抛回去。
//
// Usage: node patches/0072-recover-review-diff.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const file = resolve(appDir, "server.ts");
let source = readFileSync(file, "utf8");

if (source.includes("recoverReviewDiff")) {
  console.log("skip  server.ts (already applied)");
} else {
  const steps = [
    [
      "function recordReviewDiffsFromRpc(method: string, params: any, result: any) {",
      "// 桥重启过之后内存里就没有那一轮的 diff 了，但回源能重建：`thread/read{includeTurns}`\n"
        + "// 里的 fileChange item 带着 changes（path/kind/diff），合成逻辑与实时通知完全相同。\n"
        + "async function recoverReviewDiff(threadId: string, turnId: string) {\n"
        + "  try {\n"
        + "    const result = await request(\"thread/read\", { threadId, includeTurns: true });\n"
        + "    const turns = result?.thread?.turns || [];\n"
        + "    for (const turn of turns) {\n"
        + "      if (turn?.id !== turnId) continue;\n"
        + "      const changes = (turn.items || []).flatMap((item: any) => item?.type === \"fileChange\" && Array.isArray(item.changes) ? item.changes : []);\n"
        + "      const diff = unifiedDiffFromFileChanges(changes);\n"
        + "      if (!diff) continue;\n"
        + "      reviewDiffs.record({ threadId, turnId, diff });\n"
        + "      console.log(`[codex-webui] recovered review diff for turn ${turnId} (${changes.length} file(s))`);\n"
        + "      return true;\n"
        + "    }\n"
        + "  } catch (error) {\n"
        + "    console.error(\"[codex-webui] review diff recovery failed\", error);\n"
        + "  }\n"
        + "  return false;\n"
        + "}\n"
        + "\n"
        + "function recordReviewDiffsFromRpc(method: string, params: any, result: any) {",
      "recovery helper",
    ],
    [
      "        requestPayload = parseReviewPatchRequest(payload);\n        const stored = reviewDiffs.begin(requestPayload.threadId, requestPayload.turnId, requestPayload.action);",
      "        requestPayload = parseReviewPatchRequest(payload);\n"
        + "        let stored;\n"
        + "        try {\n"
        + "          stored = reviewDiffs.begin(requestPayload.threadId, requestPayload.turnId, requestPayload.action);\n"
        + "        } catch (error) {\n"
        + "          // 内存里没有（桥重启过、或这一轮是在别处跑的）：先回源重建再重试一次。\n"
        + "          if (!await recoverReviewDiff(requestPayload.threadId, requestPayload.turnId)) throw error;\n"
        + "          stored = reviewDiffs.begin(requestPayload.threadId, requestPayload.turnId, requestPayload.action);\n"
        + "        }",
      "retry after recovery",
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
