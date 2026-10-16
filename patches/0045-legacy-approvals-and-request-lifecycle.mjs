// Patch 0045 — P5 第一块：旧版审批 + 请求生命周期（重复 / 已解决）
//
// 1) 旧版审批：`execCommandApproval` / `applyPatchApproval` 是 codex 早期协议的审批入口，
//    回应是**字符串枚举** approved | approved_for_session | denied | abort。
//    之前前端对这两个方法只会回 -32601 "Unsupported request"——也就是说，遇到走旧协议的
//    会话，模型会一直等（或被判失败），而界面上什么都不显示。
//    这里给它们和现代三条同款的卡片与按钮（允许一次 / 允许本会话 / 拒绝 / 取消），
//    因为 `answer()` 对非 permission 类型统一发 `{decision}`，所以只要 decision 用旧版字面量即可。
//
// 2) 生命周期：同一 requestId 重复送达（断线重连、多客户端）不再重复插卡片；
//    服务端广播 `serverRequest/resolved` 时把卡片标记为"已在别处处理"并移除。
//
// Usage: node patches/0045-legacy-approvals-and-request-lifecycle.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);

function patchFile(file, rules, appendText, appendMarker) {
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
  if (appendText && !source.includes(appendMarker)) {
    source += appendText;
    changed += 1;
    console.log(`apply append to ${file}`);
  }
  if (changed > 0) writeFileSync(file, source);
  return changed;
}

// --- 1. 模型构造（纯函数，放到 codex-surfaces.js，跟着现有 14 项断言一起被测） ---
patchFile(resolve(appDir, "public/codex-surfaces.js"), [], `

// 旧版审批（codex 早期协议）。decision 是**字符串**枚举：
//   approved / approved_for_session / denied / abort
// 与新版 {decision:"accept"} 不同，所以这里单独构造，但按钮语义与卡片结构保持同款，
// 复用同一套渲染与提交路径（app.js 的 answer() 对非 permission 类型统一发 {decision}）。
export function buildLegacyApprovalModel(method, params = {}) {
  const isPatch = method === "applyPatchApproval";
  const command = Array.isArray(params.command) ? params.command.join(" ") : String(params.command || "");
  const files = params.fileChanges ? Object.keys(params.fileChanges) : [];
  if (isPatch) {
    return {
      kind: "patch",
      identity: "Edit files",
      // 注意：这里刻意不用模板字符串——本文件是"补丁脚本里的模板字符串"，
      // 里面再出现反引号/美元花括号会把补丁脚本自己拆掉（这条踩过三次）。
      title: "Allow ChatGPT to edit the following " + (files.length === 1 ? "file" : "files") + "?",
      subtitle: params.grantRoot || params.cwd || null,
      reason: params.reason || null,
      command: null,
      legacyFiles: files,
      legacy: method,
      primary: { label: "Allow once", decision: "approved" },
      scoped: { label: "Allow all edits", decision: "approved_for_session" },
      deny: { label: "Deny", decision: "denied" },
      cancel: { label: "Cancel", decision: "abort" },
      leading: null,
    };
  }
  return {
    kind: "exec",
    identity: "Terminal",
    title: "Allow ChatGPT to run this command?",
    subtitle: params.cwd || null,
    reason: params.reason || null,
    command: command || null,
    legacy: method,
    primary: { label: "Allow once", decision: "approved" },
    scoped: { label: "Allow this conversation", decision: "approved_for_session" },
    deny: { label: "Deny", decision: "denied" },
    cancel: { label: "Cancel", decision: "abort" },
    leading: null,
  };
}
`, "export function buildLegacyApprovalModel(");

// --- 2. app.js：接入旧版方法、去重、已解决 ---
patchFile(resolve(appDir, "public/app.js"), [
  {
    name: "import the legacy builder",
    from: "import { buildApprovalModel, buildElicitationModel,",
    to: "import { buildApprovalModel, buildLegacyApprovalModel, buildElicitationModel,",
    skipIf: "buildLegacyApprovalModel, buildElicitationModel",
  },
  {
    // 旧版两条也走同一张卡片；同时挡住重复送达（重连会重放）。
    name: "accept legacy approvals and ignore duplicates",
    from: "const p=req.params||{};if(req.method==='item/tool/requestUserInput'){renderUserInputRequest(req);return}",
    to: "const p=req.params||{};if(state.requestCards.has(req.id)){clientLog('approval: duplicate request '+req.id+' ignored');return}if(req.method==='item/tool/requestUserInput'){renderUserInputRequest(req);return}",
    skipIf: "duplicate request ",
  },
  {
    name: "legacy methods get a model instead of -32601",
    from: "if(!['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval'].includes(req.method)){",
    to: "const legacyApproval=req.method==='execCommandApproval'||req.method==='applyPatchApproval';if(legacyApproval){clientLog('approval: legacy '+req.method+' -> same card, decision enum approved|approved_for_session|denied|abort')}if(!legacyApproval&&!['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval'].includes(req.method)){",
    skipIf: "legacyApproval",
  },
  {
    name: "and use the legacy model builder for them",
    from: "const group=ensureActivity(p.turnId||'approval',$('#conversation'),p.itemId),model=buildApprovalModel(req),",
    to: "const group=ensureActivity(p.turnId||'approval',$('#conversation'),p.itemId),model=legacyApproval?buildLegacyApprovalModel(req.method,p):buildApprovalModel(req),",
    skipIf: "legacyApproval?buildLegacyApprovalModel(req.method,p)",
  },
  {
    // 旧版 patch 没有 turnId，diffForTurn 拿不到东西：退化成文件清单，别让卡片空白。
    name: "a legacy patch card lists the files",
    from: "if(model.kind==='patch'){const review=diffForTurn(p.turnId);",
    // 这里也不用反引号（原因同 buildLegacyApprovalModel 那条注释）：改用单引号拼接。
    to: "if(model.kind==='patch'){if(model.legacyFiles){return model.legacyFiles.map(path=>'<div class=\"approval-command\"><code>'+escapeHtml(shortPath(path))+'</code></div>').join('')}const review=diffForTurn(p.turnId);",
    skipIf: "model.legacyFiles){return model.legacyFiles.map",
  },
  {
    // 记录 requestId 到 DOM 上（"已在别处处理"时定位用）。
    // 锚点要带上下文：`state.requestCards.set(req.id,card);` 在审批/提问/elicitation 三处都有。
    name: "remember which turn a card belongs to",
    from: "group.after(card);state.requestCards.set(req.id,card);setApprovalWaiting(group,p.itemId,true);",
    to: "group.after(card);card.dataset.requestId=String(req.id);state.requestCards.set(req.id,card);setApprovalWaiting(group,p.itemId,true);",
    skipIf: "card.dataset.requestId=String(req.id);",
  },
], `

// --- 请求生命周期（patches/0045）-------------------------------------------
// 服务端在请求被任何一方回答后会广播 serverRequest/resolved（桥把它当通知转发）。
// 多客户端/重连时，本地还留着卡片就必须收掉——否则用户会对着一个已经被回答的卡片点，
// 点了也没有效果（这正是 PLAN 里"已解决 / 重复点击"那两条要防的）。
function resolveRequestCard(requestId, reason){
  const card=state.requestCards.get(requestId);
  if(!card)return;
  clientLog('approval: request '+requestId+' resolved elsewhere'+(reason?': '+reason:''));
  card.querySelectorAll('button').forEach(button=>button.disabled=true);
  card.classList.add('resolved');
  const note=document.createElement('div');
  note.className='approval-subtitle';
  note.textContent=t('Answered elsewhere');
  card.querySelector('.approval-content')?.append(note);
  setTimeout(()=>card.remove(),1200);
  state.requestCards.delete(requestId);
}
`, "function resolveRequestCard(requestId, reason){");

// onNotification 是服务端通知的统一入口，在那里接 resolved。
patchFile(resolve(appDir, "public/app.js"), [
  {
    name: "handle serverRequest/resolved in onNotification",
    from: "function onNotification(method,p){",
    to: "function onNotification(method,p){if(method==='serverRequest/resolved'){resolveRequestCard(p?.requestId,'server');return}",
    skipIf: "resolveRequestCard(p?.requestId,'server')",
  },
]);

patchFile(resolve(appDir, "public/i18n.js"), [
  {
    name: "Chinese for the resolved note",
    from: '"Waiting for the upload to finish…": "正在等待附件上传完成…",',
    to: '"Waiting for the upload to finish…": "正在等待附件上传完成…",\n  "Answered elsewhere": "已在别处处理",',
    skipIf: '"Answered elsewhere"',
  },
]);

console.log("done — rebuild the bundle: bun build public/app.js --target=browser --outfile=public/app.bundle.js");
