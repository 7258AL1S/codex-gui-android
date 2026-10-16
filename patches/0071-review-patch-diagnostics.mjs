// Patch 0071 — 给"撤销"按钮加一行诊断：点了要能看见（谁被点了、按钮是不是禁用的）。
//
// 起因：真机上点撤销没有任何反应，也没有 toast——分不清是"没点到"、"按钮 disabled"还是"请求失败"。
// 这类"点了没反应"的问题必须能在日志里回答（沿用 0050 的做法）。
//
// Usage: node patches/0071-review-patch-diagnostics.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const file = resolve(appDir, "public/app.js");
let source = readFileSync(file, "utf8");
if (source.includes("review patch click:")) {
  console.log("skip  public/app.js (already applied)");
} else {
  const from = "async function applyActiveReviewPatch(){const review=state.activeReview;if(!review?.turnId||!state.active?.id)return;const action=reviewPatchState,button=$('#reviewPatch');";
  const to = "async function applyActiveReviewPatch(){const review=state.activeReview;clientLog('review patch click: hasTurn='+Boolean(review?.turnId)+' thread='+String(state.active?.id||'-')+' disabled='+String($('#reviewPatch')?.disabled)+' action='+reviewPatchState);if(!review?.turnId||!state.active?.id)return;const action=reviewPatchState,button=$('#reviewPatch');";
  const hits = source.split(from).length - 1;
  if (hits !== 1) throw new Error("cannot locate applyActiveReviewPatch (hits=" + hits + ")");
  writeFileSync(file, source.replace(from, to));
  console.log("apply public/app.js: review patch diagnostics");
}

console.log("done — rebuild the bundle: cd app && bun build public/app.js --target=browser --outfile=public/app.bundle.js");
