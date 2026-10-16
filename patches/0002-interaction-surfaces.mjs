// Patch 0002 — handle the two interaction surfaces upstream refuses.
//
// Upstream app.js `onServerRequest` only accepts the three approval methods and
// answers everything else with JSON-RPC -32601 "Unsupported request". That means
// when the model asks the user a question (item/tool/requestUserInput) or an MCP
// server requests form input / browser authorization
// (mcpServer/elicitation/request), the GUI is mute and the turn parks on
// waitingOnUserInput (VERIFICATION.md E32).
//
// The rendering/response logic lives in public/codex-surfaces.js as pure
// functions (unit-tested by probe/interaction-surfaces.test.mjs); this patch only
// adds the DOM wiring in app.js.
//
// Usage: node patches/0002-interaction-surfaces.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const file = resolve(appDir, "public/app.js");
let source = readFileSync(file, "utf8");
let changed = 0;

function replaceOnce(name, from, to) {
  const hits = source.split(from).length - 1;
  if (hits === 0) {
    if (source.includes(to.slice(0, 60))) { console.log(`skip  ${name} (already applied)`); return; }
    throw new Error(`cannot apply "${name}": anchor not found`);
  }
  if (hits > 1) throw new Error(`cannot apply "${name}": anchor matched ${hits} times`);
  source = source.replace(from, to);
  changed += 1;
  console.log(`apply ${name}`);
}

replaceOnce(
  "import the new surface builders",
  "import { buildApprovalModel, createReviewPreferences, parseUnifiedDiff, permissionRows, splitDiffHunk, summarizeActivity, unifiedDiffFromFileChanges } from './codex-surfaces.js';",
  "import { buildApprovalModel, buildElicitationModel, buildElicitationResponse, buildUserInputModel, buildUserInputResponse, createReviewPreferences, missingElicitationFields, parseUnifiedDiff, permissionRows, splitDiffHunk, summarizeActivity, unifiedDiffFromFileChanges } from './codex-surfaces.js';",
);

replaceOnce(
  "route requestUserInput / elicitation before the approval-only guard",
  "async function onServerRequest(req){const p=req.params||{};if(!['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval'].includes(req.method)){",
  "async function onServerRequest(req){const p=req.params||{};if(req.method==='item/tool/requestUserInput'){renderUserInputRequest(req);return}if(req.method==='mcpServer/elicitation/request'){renderElicitationRequest(req);return}if(!['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval'].includes(req.method)){",
);

const APPEND = `

// --- interaction surfaces the upstream client does not implement ------------

function interactionCard(datasetKey){
  const card=document.createElement('section');
  card.className='approval-card';
  card.dataset[datasetKey]='';
  card.innerHTML='<div class="approval-body" data-interaction-body></div>';
  return card;
}

function interactionAnswer(card,req,respond){
  card.querySelectorAll('button,input,select,textarea').forEach(node=>{node.disabled=true});
  respondToCodex(req.id,respond).catch(error=>{if(!error?.silentTransportSwitch)toast(error.message)});
  card.remove();
  state.requestCards.delete(req.id);
}

// item/tool/requestUserInput — the model asking the user a question.
// Leaving it unanswered parks the turn on waitingOnUserInput, so there is always
// a way to answer.
function renderUserInputRequest(req){
  const p=req.params||{},model=buildUserInputModel(req);
  const group=ensureActivity(p.turnId||'user-input',$('#conversation'),p.itemId);
  const card=interactionCard('codexUserInputSurface');
  const body=card.querySelector('[data-interaction-body]');
  body.insertAdjacentHTML('beforebegin',\`<div class="approval-content"><div class="approval-identity">\${codexIcon('question')}<span>\${escapeHtml(model.identity)}</span></div><div class="approval-title">\${escapeHtml(model.title)}</div></div>\`);
  const form=document.createElement('form');
  form.className='approval-actions';
  form.style.flexDirection='column';
  form.style.alignItems='stretch';
  form.innerHTML=model.questions.map((q,index)=>{
    const options=(q.options||[]).map((o,optionIndex)=>\`<label class="approval-choice"><input type="radio" name="q\${index}" value="\${escapeHtml(o.label)}"><span>\${escapeHtml(o.label)}</span>\${o.description?\`<em>\${escapeHtml(o.description)}</em>\`:''}</label>\`).join('');
    const freeText=q.options&&!q.isOther?'':\`<input class="approval-text" type="\${q.isSecret?'password':'text'}" data-free="\${escapeHtml(q.id)}" placeholder="\${q.options?'其他（可留空）':'输入你的回答'}">\`;
    return \`<div class="approval-question"><div class="approval-question-header">\${escapeHtml(q.header||'问题')}</div><div class="approval-question-text">\${escapeHtml(q.question)}</div>\${options?\`<div class="approval-choices">\${options}</div>\`:''}\${freeText}</div>\`;
  }).join('');
  const actions=document.createElement('div');
  actions.className='approval-actions-main';
  actions.innerHTML='<button type="submit" class="approval-primary" autofocus>提交回答</button>';
  form.append(actions);
  body.replaceWith(form);
  form.onsubmit=(event)=>{
    event.preventDefault();
    const answers={};
    model.questions.forEach((q,index)=>{
      const picked=form.querySelector(\`input[name="q\${index}"]:checked\`);
      const free=form.querySelector(\`[data-free="\${q.id}"]\`);
      const values=[];
      if(picked)values.push(picked.value);
      if(free&&free.value.trim())values.push(free.value.trim());
      if(values.length)answers[q.id]=values;
    });
    interactionAnswer(card,req,buildUserInputResponse(model,answers));
  };
  group.after(card);
  state.requestCards.set(req.id,card);
  scrollBottom();
}

// mcpServer/elicitation/request — MCP form input or browser authorization.
function renderElicitationRequest(req){
  const p=req.params||{},model=buildElicitationModel(req);
  const group=ensureActivity(p.turnId||'elicitation',$('#conversation'),null);
  const card=interactionCard('codexElicitationSurface');
  const body=card.querySelector('[data-interaction-body]');
  body.insertAdjacentHTML('beforebegin',\`<div class="approval-content"><div class="approval-identity">\${codexIcon('plug')}<span>\${escapeHtml(model.identity)}</span></div><div class="approval-title">\${escapeHtml(model.title)}</div>\${model.message?\`<div class="approval-subtitle">\${escapeHtml(model.message)}</div>\`:''}\${model.untyped?'<div class="approval-reason"><span>说明</span><p>该请求使用未类型化的自定义表单，客户端不会凭空生成字段，只能拒绝或取消。</p></div>':''}</div>\`);
  const wrapper=document.createElement('div');
  const collect=()=>{
    const values={};
    card.querySelectorAll('[data-field]').forEach(node=>{
      const name=node.dataset.field;
      if(node.type==='checkbox'&&node.dataset.multi!=='1'){values[name]=node.checked;return}
      if(node.type==='checkbox'){(values[name]=values[name]||[]).push(node.value);return}
      if(node.tagName==='SELECT'&&node.multiple)values[name]=[...node.selectedOptions].map(o=>o.value);
      else if(node.value!=='')values[name]=node.value;
    });
    return values;
  };
  const refresh=()=>{
    if(!model.canAccept){accept.disabled=true;return}
    accept.disabled=missingElicitationFields(model,collect()).length>0;
  };
  if(model.mode==='url'){
    wrapper.innerHTML=\`<div class="approval-body"><a class="approval-review-link" href="\${escapeHtml(model.url||'#')}" target="_blank" rel="noreferrer noopener">在浏览器中打开授权页面</a></div>\`;
  }else if(model.mode==='form'){
    wrapper.className='approval-body';
    wrapper.innerHTML=model.fields.map(field=>{
      const options=(field.options||[]).map(o=>\`<option value="\${escapeHtml(o.value)}">\${escapeHtml(o.label)}</option>\`).join('');
      let control='';
      if(field.kind==='select')control=\`<select data-field="\${escapeHtml(field.name)}">\${options}</select>\`;
      else if(field.kind==='multiselect')control=\`<div class="approval-choices">\${(field.options||[]).map(o=>\`<label class="approval-choice"><input type="checkbox" data-field="\${escapeHtml(field.name)}" data-multi="1" value="\${escapeHtml(o.value)}"><span>\${escapeHtml(o.label)}</span></label>\`).join('')}</div>\`;
      else if(field.kind==='boolean')control=\`<label class="approval-choice"><input type="checkbox" data-field="\${escapeHtml(field.name)}"><span>是</span></label>\`;
      else if(field.kind==='number')control=\`<input class="approval-text" type="number" data-field="\${escapeHtml(field.name)}" value="\${field.default??''}">\`;
      else if(field.kind==='text')control=\`<input class="approval-text" type="text" data-field="\${escapeHtml(field.name)}" value="\${escapeHtml(String(field.default??''))}">\`;
      else control='<div class="approval-reason"><p>此字段类型暂不支持自动填写</p></div>';
      return \`<div class="approval-question"><div class="approval-question-header">\${escapeHtml(field.label)}\${field.required?' *':''}</div>\${field.description?\`<div class="approval-question-text">\${escapeHtml(field.description)}</div>\`:''}\${control}</div>\`;
    }).join('');
  }
  const actions=document.createElement('div');
  actions.className='approval-actions-main';
  actions.innerHTML='<button type="button" class="approval-deny">拒绝</button><button type="button" class="approval-cancel">取消</button><button type="button" class="approval-primary">提交</button>';
  const accept=actions.querySelector('.approval-primary');
  accept.textContent=model.mode==='url'?'我已在浏览器完成':'提交';
  wrapper.append(actions);
  body.replaceWith(wrapper);
  wrapper.addEventListener('input',refresh);
  actions.querySelector('.approval-deny').addEventListener('click',()=>interactionAnswer(card,req,buildElicitationResponse(model,{},'decline')));
  actions.querySelector('.approval-cancel').addEventListener('click',()=>interactionAnswer(card,req,buildElicitationResponse(model,{},'cancel')));
  accept.addEventListener('click',()=>interactionAnswer(card,req,buildElicitationResponse(model,collect(),'accept')));
  refresh();
  group.after(card);
  state.requestCards.set(req.id,card);
  scrollBottom();
}
`;

if (!source.includes("function renderUserInputRequest(req)")) {
  source += APPEND;
  changed += 1;
  console.log("apply append interaction surface renderers");
} else {
  console.log("skip  append interaction surface renderers (already applied)");
}

if (changed > 0) {
  writeFileSync(file, source);
  console.log(`\nwrote ${changed} change(s) to ${file}`);
  console.log("rebuild the bundle:  bun build public/app.js --target=browser --outfile=public/app.bundle.js");
} else {
  console.log("\nnothing to do");
}
