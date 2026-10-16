// Patch 0084 — P6 的两项遗留：**审查目标**（当前改动 / 分支对比 / 指定提交 / 自定义）与**行内定位**。
//
// 一、审查目标
// 协议里 `review/start {threadId, target}` 早就可用，`ReviewTarget` 恰好四种变体（proto-ts/v2/ReviewTarget.ts）：
//   {type:"uncommittedChanges"} | {type:"baseBranch", branch} | {type:"commit", sha, title} | {type:"custom", instructions}
// 之前完全没接（app.js / server.ts 里 0 处引用），所以"审查"面板只能看模型这一回合的 diff。
// 现在补一个目标选择弹层：分支与提交列表直接用 Git 面板已经有的 `/api/git branches` / `/api/git log`
// （不重复造接口）。注意语义：**审查会真发起一次回合**，结论出现在对话里，不是只渲染 diff——
// 所以文案要写清楚"结果在对话里看"。
//
// 二、行内定位
// `agentMessage` 项带 `memoryCitation:{entries:[{path,lineStart,lineEnd,note}]}`（ThreadItem.ts）。
// 之前没渲染（P4/P6 都记着）。现在渲染成一行芯片，点一下打开文件面板并滚到对应行。
// 行号定位用等宽行高估算（查看器是 `<pre>`），差几行不影响"跳过去看"这个用途。
//
// Usage: node patches/0084-review-targets-and-citations.mjs [appDir]
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

// --- index.html：审查目标按钮 + 弹层 ------------------------------------------

const DIALOG = [
  '<dialog class="review-target-dialog" id="reviewTargetDialog" aria-labelledby="reviewTargetTitle">',
  '  <div class="review-target-card">',
  '    <div class="review-target-head"><strong id="reviewTargetTitle">审查什么？</strong><button class="icon-button small" id="reviewTargetClose" type="button"><span class="icon-slot" data-icon="x"></span></button></div>',
  '    <div class="review-target-list" id="reviewTargetList"></div>',
  '    <div class="review-target-custom" id="reviewTargetCustom" hidden>',
  '      <textarea id="reviewTargetInput" rows="3" placeholder="审查要求（例如：重点看并发与错误处理）" spellcheck="false"></textarea>',
  '      <button type="button" class="review-target-go" id="reviewTargetGo">开始审查</button>',
  '    </div>',
  '  </div>',
  '</dialog>',
].join("\n");

edit("public/index.html", 'id="reviewTargetDialog"', [
  [
    '        <div class="change-summary"><span id="changeSummary">No changes yet</span>',
    '        <div class="change-summary"><button class="icon-button small" title="Review target" id="reviewTargetButton"><span class="icon-slot" data-icon="search"></span></button><span id="changeSummary">No changes yet</span>',
    "review target button",
  ],
  [
    '<dialog class="git-confirm-dialog" id="gitConfirmDialog"',
    DIALOG + "\n" + '<dialog class="git-confirm-dialog" id="gitConfirmDialog"',
    "review target dialog",
  ],
]);

// --- app.js：目标选择 + 行内定位 ----------------------------------------------

const JS = [
  "",
  "// --- 审查目标（patches/0084）------------------------------------------------",
  "// `review/start {threadId,target}`：target 四种变体见 proto-ts/v2/ReviewTarget.ts。",
  "// 它会**真发起一次审查回合**（结论出现在对话里），所以按钮文案与 toast 都要说清楚。",
  "async function startReview(target){",
  "  const threadId=state.active?.id;",
  "  if(!threadId){toast(t('No active conversation'));return}",
  "  try{",
  "    const result=await rpc('review/start',{threadId,target});",
  "    clientLog('review/start -> '+JSON.stringify(result||{}).slice(0,140));",
  "    toast(t('Review started — the result appears in the conversation'));",
  "  }catch(error){clientLog('review/start FAILED: '+error.message);toast(error.message)}",
  "  closeReviewTarget();",
  "}",
  "",
  "function closeReviewTarget(){",
  "  const dialog=$('#reviewTargetDialog');",
  "  if(dialog&&dialog.open)try{dialog.close()}catch(error){}",
  "}",
  "",
  "function reviewTargetOption(label,description,onclick){",
  "  const button=document.createElement('button');",
  "  button.type='button';",
  "  button.className='review-target-option';",
  "  button.innerHTML='<strong>'+escapeHtml(label)+'</strong><small>'+escapeHtml(description)+'</small>';",
  "  button.onclick=onclick;",
  "  return button;",
  "}",
  "",
  "async function openReviewTarget(){",
  "  const dialog=$('#reviewTargetDialog'),list=$('#reviewTargetList'),custom=$('#reviewTargetCustom');",
  "  if(!dialog||!list)return;",
  "  list.innerHTML='';",
  "  if(custom)custom.hidden=true;",
  "  list.append(",
  "    reviewTargetOption(t('Uncommitted changes'),t('Everything not yet committed'),function(){void startReview({type:'uncommittedChanges'})}),",
  "    reviewTargetOption(t('Compare against a branch'),t('Pick a base branch'),function(){void listReviewBranches()}),",
  "    reviewTargetOption(t('Review a commit'),t('Pick a recent commit'),function(){void listReviewCommits()}),",
  "    reviewTargetOption(t('Custom instructions'),t('Describe what to review'),function(){if(custom)custom.hidden=false;const input=$('#reviewTargetInput');if(input)input.focus()}),",
  "  );",
  "  try{dialog.showModal()}catch(error){toast(error.message)}",
  "}",
  "",
  "async function listReviewBranches(){",
  "  const list=$('#reviewTargetList');",
  "  if(!list)return;",
  "  list.innerHTML='<div class=\"review-target-empty\">'+escapeHtml(t('Loading…'))+'</div>';",
  "  try{",
  "    const data=await gitCall('branches');",
  "    list.innerHTML='';",
  "    for(const branch of (data.branches||[]).slice(0,20)){",
  "      list.append(reviewTargetOption(branch.name,branch.short||'',function(){void startReview({type:'baseBranch',branch:branch.name})}));",
  "    }",
  "    if(!list.childElementCount)list.innerHTML='<div class=\"review-target-empty\">'+escapeHtml(t('No branches'))+'</div>';",
  "  }catch(error){list.innerHTML='<div class=\"review-target-empty\">'+escapeHtml(error.message)+'</div>'}",
  "}",
  "",
  "async function listReviewCommits(){",
  "  const list=$('#reviewTargetList');",
  "  if(!list)return;",
  "  list.innerHTML='<div class=\"review-target-empty\">'+escapeHtml(t('Loading…'))+'</div>';",
  "  try{",
  "    const data=await gitCall('log',{limit:20});",
  "    list.innerHTML='';",
  "    for(const commit of (data.commits||[])){",
  "      list.append(reviewTargetOption(commit.short+' · '+commit.subject,commit.date||'',function(){void startReview({type:'commit',sha:commit.sha,title:commit.subject})}));",
  "    }",
  "    if(!list.childElementCount)list.innerHTML='<div class=\"review-target-empty\">'+escapeHtml(t('No commits'))+'</div>';",
  "  }catch(error){list.innerHTML='<div class=\"review-target-empty\">'+escapeHtml(error.message)+'</div>'}",
  "}",
  "",
  "// --- 行内定位：agentMessage.memoryCitation（patches/0084）--------------------",
  "// 协议形状：{entries:[{path,lineStart,lineEnd,note}]}（ThreadItem.ts / MemoryCitationEntry.ts）。",
  "// 点一下 → 打开文件面板 → 打开该文件 → 滚到那一行附近。",
  "function citationHtml(item){",
  "  const entries=item?.memoryCitation?.entries;",
  "  if(!Array.isArray(entries)||!entries.length)return '';",
  "  return '<div class=\"message-citations\">'+entries.map(function(entry,index){",
  "    const path=String(entry?.path||'');",
  "    if(!path)return '';",
  "    const label=shortPath(path)+' :'+String(entry.lineStart||1)+(entry.lineEnd&&entry.lineEnd!==entry.lineStart?'-'+entry.lineEnd:'');",
  "    return '<button type=\"button\" class=\"message-citation\" data-citation-index=\"'+index+'\" title=\"'+escapeHtml(entry.note||label)+'\">'+escapeHtml(label)+'</button>';",
  "  }).join('')+'</div>';",
  "}",
  "",
  "async function openCitation(path,line){",
  "  const target=String(path||'');",
  "  if(!target)return;",
  "  openFilesPanel();",
  "  await openFilesFile(target);",
  "  const viewer=$('#filesViewerText');",
  "  if(!viewer)return;",
  "  // 等一帧再滚：查看器刚被填充。行高按等宽字号估算（差几行不影响定位用途）。",
  "  requestAnimationFrame(function(){",
  "    const lineHeight=parseFloat(getComputedStyle(viewer).lineHeight)||18;",
  "    viewer.scrollTop=Math.max(0,(Number(line||1)-3)*lineHeight);",
  "  });",
  "}",
  "",
  "function wireReviewTargets(){",
  "  const button=$('#reviewTargetButton');",
  "  if(button)button.onclick=function(){void openReviewTarget()};",
  "  const close=$('#reviewTargetClose');",
  "  if(close)close.onclick=closeReviewTarget;",
  "  const go=$('#reviewTargetGo');",
  "  if(go)go.onclick=function(){const field=$('#reviewTargetInput');const value=field?field.value.trim():'';if(!value){toast(t('Describe what to review'));return}void startReview({type:'custom',instructions:value})};",
  "  // 行内定位用事件委托：消息随时会重渲染，绑定在 document 上最省事。",
  "  document.addEventListener('click',function(event){",
  "    const chip=event.target?.closest?.('.message-citation');",
  "    if(!chip)return;",
  "    const message=chip.closest('.assistant-response');",
  "    const item=message&&state.items.get(message.dataset.itemId||'');",
  "    const entries=item?.memoryCitation?.entries;",
  "    const entry=entries?entries[Number(chip.dataset.citationIndex)]:null;",
  "    if(entry)void openCitation(entry.path,entry.lineStart);",
  "  });",
  "}",
  "wireReviewTargets();",
  "",
].join("\n");

{
  const path = resolve(appDir, "public/app.js");
  const source = readFileSync(path, "utf8");
  if (source.includes("function openReviewTarget(){")) {
    console.log("skip  public/app.js (already applied)");
  } else {
    writeFileSync(path, source + JS);
    console.log("apply public/app.js: review targets + citations");
  }
}

edit("public/app.js", "citationHtml(item)", [
  [
    "body.innerHTML=renderAssistantMarkdown(text,{cwd})+renderItemImages(item,{cwd,className:'message-image-grid structured-message-images',excludeText:text});",
    "body.innerHTML=renderAssistantMarkdown(text,{cwd})+renderItemImages(item,{cwd,className:'message-image-grid structured-message-images',excludeText:text})+citationHtml(item);",
    "render citations under the message",
  ],
  [
    "el=document.createElement('div');el.innerHTML='<div class=\"message-text\"></div>';placeAgentMessage(el,item,timeline)",
    "el=document.createElement('div');el.dataset.itemId=item.id;el.innerHTML='<div class=\"message-text\"></div>';placeAgentMessage(el,item,timeline)",
    "keep the item id on the node",
  ],
]);

// --- CSS --------------------------------------------------------------------

{
  const path = resolve(appDir, "public/style.css");
  let css = readFileSync(path, "utf8");
  if (css.includes(".review-target-dialog")) {
    console.log("skip  public/style.css (already applied)");
  } else {
    css += [
      "",
      "/* 审查目标弹层 + 消息里的引用芯片（patches/0084）。 */",
      ".review-target-dialog{border:0;padding:0;background:transparent;max-width:min(460px,94vw)}",
      ".review-target-dialog::backdrop{background:rgba(0,0,0,.55)}",
      ".review-target-card{display:flex;flex-direction:column;gap:10px;max-height:70vh;padding:16px;border:1px solid var(--app-border-default,var(--border-strong));border-radius:14px;background:var(--app-panel,var(--surface));color:var(--app-text)}",
      ".review-target-head{display:flex;align-items:center;justify-content:space-between;gap:8px}",
      ".review-target-list{display:flex;flex-direction:column;gap:4px;overflow:auto;max-height:46vh}",
      ".review-target-option{display:flex;flex-direction:column;gap:2px;padding:9px 10px;border:1px solid var(--app-border-default,var(--border));border-radius:9px;background:transparent;color:var(--app-text);text-align:left}",
      ".review-target-option strong{font-size:12.5px;font-weight:550}",
      ".review-target-option small{font-size:10.5px;color:var(--app-text-tertiary)}",
      ".review-target-empty{color:var(--app-text-tertiary);font-size:11.5px;padding:6px 2px}",
      ".review-target-custom{display:flex;flex-direction:column;gap:8px}",
      ".review-target-custom[hidden]{display:none}",
      ".review-target-custom textarea{width:100%;min-height:70px;padding:8px 10px;border:1px solid var(--app-border-default,var(--border));border-radius:9px;background:transparent;color:var(--app-text);font-size:12px}",
      ".review-target-go{min-height:36px;border:0;border-radius:9px;background:var(--app-text);color:var(--app-main);font-size:12.5px;font-weight:600}",
      ".message-citations{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}",
      ".message-citation{padding:2px 7px;border:1px solid var(--app-border-default,var(--border));border-radius:7px;background:transparent;color:var(--app-text-secondary);font:10.5px var(--mono);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".message-citation:hover{color:var(--app-text)}",
      "",
    ].join("\n");
    writeFileSync(path, css);
    console.log("apply public/style.css: review targets + citations");
  }
}

edit("public/i18n.js", '"Review target": "审查目标"', [
  ['  "Needs an answer": "等你回答",\n',
   '  "Needs an answer": "等你回答",\n'
     + '  "Review target": "审查目标",\n'
     + '  "Uncommitted changes": "当前改动",\n'
     + '  "Everything not yet committed": "所有还没提交的改动",\n'
     + '  "Compare against a branch": "对比某个分支",\n'
     + '  "Pick a base branch": "选一个基线分支",\n'
     + '  "Review a commit": "审查某个提交",\n'
     + '  "Pick a recent commit": "从最近提交里选",\n'
     + '  "Custom instructions": "自定义审查要求",\n'
     + '  "Describe what to review": "请写明要审查什么",\n'
     + '  "Review started — the result appears in the conversation": "审查已开始——结果会出现在对话里",\n'
     + '  "No branches": "没有可用的分支",\n'
     + '  "No commits": "没有可用的提交",\n'
     + '  "No active conversation": "当前没有打开的会话",\n',
   "zh entries"],
]);

console.log("done — rebuild the bundle: cd app && bun build public/app.js --target=browser --outfile=public/app.bundle.js");
