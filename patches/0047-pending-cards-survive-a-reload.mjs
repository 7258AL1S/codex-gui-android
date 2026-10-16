// Patch 0047 — 重连/刷新后，待回答的审批卡片要真的回来。
//
// 实测（E113）：审批还挂着（`/api/requests/pending` 有货），页面在此时刷新/重启 →
// 卡片**没有**重新出现。原因不是恢复函数没跑，而是顺序：
//   restorePendingRequests() 把卡片插进会话容器 → 随后 openThread() 重建整段会话
//   （`innerHTML=''` + 重画 turns）→ 卡片被一起抹掉；
//   而 `state.requestCards` 里还留着那个 id，于是下一次恢复又认为"已经有了"而跳过。
//
// 两处修正：
//   1) 恢复前先清掉"已经不在 DOM 里"的记录（卡片被抹掉 = 需要重建）；
//   2) 会话渲染完（openThread 成功路径）再恢复一次。
//
// Usage: node patches/0047-pending-cards-survive-a-reload.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);

function patchFile(file, rules) {
  let source = readFileSync(file, "utf8");
  let changed = 0;
  for (const rule of rules) {
    if (rule.skipIf && source.includes(rule.skipIf)) { console.log(`skip  ${rule.name} (marker present)`); continue; }
    const expected = rule.expect ?? 1;
    const hits = source.split(rule.from).length - 1;
    if (hits !== expected) throw new Error(`cannot apply "${rule.name}" in ${file}: anchor matched ${hits} times, expected ${expected}`);
    source = source.split(rule.from).join(rule.to);
    changed += 1;
    console.log(`apply ${rule.name} (${hits}x)`);
  }
  if (changed > 0) writeFileSync(file, source);
  return changed;
}

patchFile(resolve(appDir, "public/app.js"), [
  {
    name: "a card that is no longer in the DOM is re-rendered",
    from: "    const payload=await response.json();\n    for(const request of payload?.data||[]){\n      if(state.requestCards.has(request.id))continue;",
    to: "    const payload=await response.json();\n    // 卡片被会话重绘抹掉时，state 里还留着记录——那种情况必须重建，否则永远补不回来。\n    for(const [id,card] of [...state.requestCards])if(!card.isConnected)state.requestCards.delete(id);\n    for(const request of payload?.data||[]){\n      if(state.requestCards.has(request.id))continue;",
    skipIf: "if(!card.isConnected)state.requestCards.delete(id)",
  },
  {
    name: "re-assert pending cards after the conversation is rendered",
    from: "scrollOpenedThreadToBottom();scheduleActiveThreadSync(0);return true}",
    to: "scrollOpenedThreadToBottom();scheduleActiveThreadSync(0);void restorePendingRequests();return true}",
    skipIf: "scheduleActiveThreadSync(0);void restorePendingRequests();return true}",
  },
]);

console.log("done — rebuild the bundle: bun build public/app.js --target=browser --outfile=public/app.bundle.js");
