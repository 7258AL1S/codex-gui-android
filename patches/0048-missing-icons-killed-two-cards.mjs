// Patch 0048 — 缺一个图标名，整张卡片就没了。
//
// 真机现象（E114）：Plan 模式下模型确实发来了 `item/tool/requestUserInput`
// （`/api/requests/pending` 里能看到完整 questions），但应用界面上**什么都没有**，
// 刷新后也没有。把这条链路搬进 jsdom 一跑，真因立刻现形：
//
//   Error: Unknown Codex icon: question
//     at codexIconSvg (…) / renderUserInputRequest (…)
//
// `codexIconSvg()` 对未知名字是**抛异常**，而 `renderUserInputRequest()` 第一行就要
// `codexIcon('question')` → 整张卡片渲染中断。同一处还有 `codexIcon('plug')`
// （elicitation 卡片用）也是未定义 → 意味着 MCP 表单那条路同样是坏的。
//
// 三件事：
//   1) 补上 `question`（复用 circleHelp 的路径）与 `plug`（Lucide plug 轮廓）；
//   2) `codexIconSvg()` 未知名字**不再抛**，退化成 circleHelp 并打一条 error——
//      图标缺失不该让整张卡片消失；
//   3) 新增 `probe/icon-contract-audit.mjs`：前端用到的图标名必须都有定义。
//
// Usage: node patches/0048-missing-icons-killed-two-cards.mjs [appDir]
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

patchFile(resolve(appDir, "public/codex-icons.js"), [
  {
    // question = circleHelp 的别名（同一个问号轮廓）；plug 用 Lucide 的 plug 路径。
    name: "define the two missing icons",
    from: "  x: '<path d=\"M18 6 6 18\"/><path d=\"m6 6 12 12\"/>',",
    to: "  x: '<path d=\"M18 6 6 18\"/><path d=\"m6 6 12 12\"/>',\n"
      + "  // 别名：调用点用的名字和图标表里的名字历史上不一致（E114）\n"
      + "  question: '<circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3\"/><path d=\"M12 17h.01\"/>',\n"
      + "  plug: '<path d=\"M12 22v-5\"/><path d=\"M9 8V2\"/><path d=\"M15 8V2\"/><path d=\"M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z\"/>',",
    skipIf: "question: '<circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3\"/>",
  },
  {
    name: "an unknown icon degrades instead of throwing",
    from: "export function codexIconSvg(name) {\n  const nodes = codexIconNodes[name];\n  if (!nodes) throw new Error(`Unknown Codex icon: ${name}`);\n  return `<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\">${nodes}</svg>`;\n}",
    to: "export function codexIconSvg(name) {\n  let nodes = codexIconNodes[name];\n  if (!nodes) {\n    // 抛异常会让整张卡片（甚至整段渲染）消失——2026-10-16 就是这样丢掉了一个\n    // requestUserInput 卡片。图标缺失是外观问题，不该升级成功能故障。\n    console.error(`[codex-webui] unknown icon \"${name}\", falling back to question mark`);\n    nodes = codexIconNodes.question;\n  }\n  return `<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\">${nodes}</svg>`;\n}",
    skipIf: "falling back to question mark",
  },
]);

console.log("done — rebuild the bundle: bun build public/app.js --target=browser --outfile=public/app.bundle.js");
