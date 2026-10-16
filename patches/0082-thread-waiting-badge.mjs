// Patch 0082 — 会话级状态提示：模型在等你（审批 / 回答）时，侧栏那一行要看得出来。
//
// P2 的遗留项原文：「`waitingOnApproval` / `waitingOnUserInput` 的**显式状态提示**（会话级徽章/横幅）
// ——只做了"能恢复应答"，还没做视觉提示」。
// 之前的状态只有"顶栏那个连接小圆点"，而且它说的是"桥连上没有"，跟"哪个会话在等你"无关：
// 你在别的会话里干活时，完全看不出另一个会话正卡在审批/提问上。
//
// 数据来源是现成的：`thread/list` 每一项都带 `status`，形状是
//   {"type":"active","activeFlags":["waitingOnApproval"|"waitingOnUserInput"]}
// （`proto-ts/v2/ThreadStatus.ts`），而侧栏每 3 秒就会刷新一次列表——不需要新接口。
//
// Usage: node patches/0082-thread-waiting-badge.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);

function edit(file, marker, steps) {
  const path = resolve(appDir, file);
  let source = readFileSync(path, "utf8");
  if (source.includes(marker)) {
    console.log("skip  " + file + " (already applied)");
    return;
  }
  for (const [from, to, label] of steps) {
    const hits = source.split(from).length - 1;
    if (hits !== 1) throw new Error(file + ": cannot locate " + label + " exactly once (hits=" + hits + ")");
    source = source.replace(from, to);
    console.log("apply " + file + ": " + label);
  }
  writeFileSync(path, source);
}

edit("public/app.js", "function threadWaitingFlag", [
  [
    "function renderThreads(){",
    "// 会话是不是卡在\"等用户\"上：`thread/list` 的 status.activeFlags（ThreadStatus.ts）。\n"
      + "// 审批优先于提问（同一回合里先碰上审批的概率更高，且它更需要马上处理）。\n"
      + "function threadWaitingFlag(thread){\n"
      + "  const flags=thread?.status?.type==='active'?thread.status.activeFlags:null;\n"
      + "  if(!Array.isArray(flags)||!flags.length)return null;\n"
      + "  if(flags.includes('waitingOnApproval'))return 'approval';\n"
      + "  if(flags.includes('waitingOnUserInput'))return 'input';\n"
      + "  return null;\n"
      + "}\n"
      + "function renderThreads(){",
    "waiting flag helper",
  ],
  [
    "const time=document.createElement('time');time.textContent=formatAge(thread.recencyAt||thread.updatedAt);meta.append(time);",
    "const time=document.createElement('time');time.textContent=formatAge(thread.recencyAt||thread.updatedAt);meta.append(time);\n"
      + "const waiting=threadWaitingFlag(thread);\n"
      + "if(waiting){const badge=document.createElement('span');badge.className='thread-waiting '+(waiting==='approval'?'approval':'input');badge.textContent=t(waiting==='approval'?'Needs approval':'Needs an answer');meta.prepend(badge);row.dataset.waiting=waiting}",
    "badge in the row",
  ],
]);

edit("public/i18n.js", '"Needs approval":', [
  ['  "Waiting for approval": "正在等待审批",\n',
   '  "Waiting for approval": "正在等待审批",\n'
     + '  "Needs approval": "等你审批",\n'
     + '  "Needs an answer": "等你回答",\n',
   "zh entries"],
]);

{
  const path = resolve(appDir, "public/style.css");
  let css = readFileSync(path, "utf8");
  if (css.includes(".thread-waiting")) {
    console.log("skip  public/style.css (already applied)");
  } else {
    css += [
      "",
      "/* 会话级等待徽章（patches/0082）：模型卡在审批/提问上时，侧栏那一行要看得出来。",
      "   注意 `.thread-meta` 在窄屏被 `display:none` 藏起来过——徽章必须一起放行。 */",
      ".thread-waiting{flex:0 0 auto;margin-right:6px;padding:0 5px;border-radius:6px;font-size:9.5px;line-height:15px;white-space:nowrap}",
      ".thread-waiting.approval{background:color-mix(in srgb,var(--warning,#d7a95e) 26%,transparent);color:var(--warning,#d7a95e)}",
      ".thread-waiting.input{background:color-mix(in srgb,var(--accent,#e7e7e7) 22%,transparent);color:var(--text,#ececec)}",
      ".thread-item[data-waiting] .thread-name{color:var(--text-strong,#fff)}",
      "@media (max-width:720px){.thread-meta:has(.thread-waiting){display:flex}}",
      "",
    ].join("\n");
    writeFileSync(path, css);
    console.log("apply public/style.css: waiting badge");
  }
}

console.log("done — rebuild the bundle: cd app && bun build public/app.js --target=browser --outfile=public/app.bundle.js");
