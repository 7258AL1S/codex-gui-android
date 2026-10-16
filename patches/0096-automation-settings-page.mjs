// Patch 0096 — 设置里的「定时任务」页（P8 的界面侧）。
//
// 后端是桥自己的 `/api/automation`（协议里没有任何 schedul* 方法，见 app/automation-service.js 头部），
// 这个补丁只加界面：任务列表（下次运行 / 上次结果 / 运行一次 / 暂停恢复 / 删除）、创建表单、
// 运行记录，以及**如实写出后台边界**的那段说明（不承诺"到点一定执行"）。
//
// 三处改动：
//   index.html  侧栏 Coding 组里加一个 Automation 入口（图标 loaderCircle）
//   app.js      settingsPages 注册 + hosted 列表 + renderAutomationSettings() + automationCall()
//   i18n.js     追加中文字典
//
// Usage: node patches/0096-automation-settings-page.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
// 幂等标记**按文件取**：之前四个文件共用一个 "automation-settings"，而 i18n.js 里没有这个串 →
// 每次重跑都会再追加一整块中文字典（E136 又踩了一次，和 0098 是同一类坑）。
const MARKERS = {
  "public/index.html": "automation-settings",
  "public/app.js": "automation-settings",
  "public/i18n.js": "Registered the 15-minute wake-up",
  "public/style.css": ".settings-automation-form",
};

function patch(file, apply) {
  const path = resolve(appDir, file);
  const original = readFileSync(path, "utf8");
  const marker = MARKERS[file];
  if (!marker) throw new Error(`no idempotency marker registered for ${file}`);
  if (original.includes(marker)) {
    console.log(`skip  ${file} (already applied)`);
    return;
  }
  const updated = apply(original);
  if (!updated || updated === original) throw new Error(`patch ${file}: nothing changed`);
  writeFileSync(path, updated);
  console.log(`apply ${file}`);
}

// 注入到 app.js 的页面代码（用行数组拼，避免模板字符串里的引号互相打架）。
const AUTOMATION_PAGE_JS = [
  "// ---- 定时任务页（patches/0096）：后端是桥自己的 /api/automation，不是 app-server 方法 ----",
  "async function automationCall(action,extra){",
  "  const response=await fetch('/api/automation',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.assign({action:action},extra||{}))});",
  "  const data=await response.json().catch(function(){return{}});",
  "  if(!response.ok)throw new Error((data&&data.error)||'Automation request failed');",
  "  return data;",
  "}",
  "function automationClock(ms){",
  "  if(!ms)return '—';",
  "  const date=new Date(ms),now=new Date();",
  "  const clock=String(date.getHours()).padStart(2,'0')+':'+String(date.getMinutes()).padStart(2,'0');",
  "  return date.toDateString()===now.toDateString()?clock:(String(date.getMonth()+1)+'/'+String(date.getDate())+' '+clock);",
  "}",
  "// 状态标签用英文当源串，中文交给 i18n（项目和其它页面一致）",
  "const automationRunLabels={ok:'Completed',failed:'Failed',timeout:'Timed out',interrupted:'Interrupted',skipped:'Skipped',running:'Running'};",
  "function automationRunLabel(status){return t(automationRunLabels[status]||status||'')}",
  "function automationField(labelText,control){",
  "  const row=document.createElement('div');row.className='settings-write-row';",
  "  row.append(Object.assign(document.createElement('strong'),{textContent:t(labelText)}),control);",
  "  return row;",
  "}",
  "function automationInput(type,placeholder,value){",
  "  const input=document.createElement('input');input.type=type;",
  "  if(placeholder)input.placeholder=t(placeholder);",
  "  if(value!==undefined)input.value=value;",
  "  input.autocomplete='off';input.spellcheck=false;",
  "  return input;",
  "}",
  "function automationSelect(options,value){",
  "  const select=document.createElement('select');",
  "  for(const option of options){const item=document.createElement('option');item.value=option.value;item.textContent=t(option.label);if(option.value===value)item.selected=true;select.append(item)}",
  "  return select;",
  "}",
  "function automationCreateForm(reload){",
  "  const form=document.createElement('div');form.className='settings-automation-form';",
  "  const name=automationInput('text','Task name','');",
  "  const prompt=automationInput('text','Prompt to send each run','');",
  "  const defaultCwd=(state.workspaceContext&&state.workspaceContext.cwd)||state.config.defaultCwd||'';",
  "  const cwd=automationInput('text','Working directory',defaultCwd);",
  "  const scheduleType=automationSelect([{value:'daily',label:'Daily'},{value:'weekdays',label:'Weekdays'},{value:'weekly',label:'Weekly'},{value:'hourly',label:'Every N hours'}],'daily');",
  "  const interval=automationSelect([1,2,3,4,6,8,12].map(function(hours){return{value:String(hours),label:String(hours)+' h'}}),'1');",
  "  const time=document.createElement('input');time.type='time';time.value='09:00';",
  "  const dayBoxes={};",
  "  const dayRow=document.createElement('div');dayRow.className='settings-write-row';",
  "  dayRow.append(Object.assign(document.createElement('strong'),{textContent:t('Day of week')}));",
  "  for(const day of ['mon','tue','wed','thu','fri','sat','sun']){",
  "    const label=document.createElement('label');label.className='settings-day-toggle';",
  "    const box=document.createElement('input');box.type='checkbox';box.value=day;dayBoxes[day]=box;",
  "    label.append(box,document.createTextNode(t(day)));dayRow.append(label);",
  "  }",
  "  const intervalRow=automationField('Every N hours',interval);",
  "  const timeRow=automationField('Time',time);",
  "  const targetMode=automationSelect([{value:'newThread',label:'A new conversation'},{value:'continueThread',label:'An existing conversation'}],'newThread');",
  "  const targetThread=automationInput('text','Conversation id','');",
  "  const targetThreadRow=automationField('Conversation id',targetThread);",
  "  const catchUp=automationSelect([{value:'runOnce',label:'Run the newest missed slot once'},{value:'skip',label:'Do not catch up (still logged)'}],'runOnce');",
  "  const permission=automationSelect([{value:'default',label:'Ask for approval (may wait for you)'},{value:'full-access',label:'Full access (unattended)'}],'default');",
  "  const timeout=automationInput('number','Turn timeout (minutes)','30');",
  "  const syncSchedule=function(){",
  "    const type=scheduleType.value;",
  "    intervalRow.hidden=type!=='hourly';",
  "    timeRow.hidden=type==='hourly';",
  "    dayRow.hidden=type!=='weekly';",
  "  };",
  "  const syncTarget=function(){targetThreadRow.hidden=targetMode.value!=='continueThread'};",
  "  scheduleType.onchange=syncSchedule;targetMode.onchange=syncTarget;",
  "  form.append(",
  "    automationField('Task name',name),",
  "    automationField('Prompt to send each run',prompt),",
  "    automationField('Working directory',cwd),",
  "    automationField('Schedule',scheduleType),",
  "    intervalRow,",
  "    timeRow,",
  "    dayRow,",
  "    automationField('Run in',targetMode),",
  "    targetThreadRow,",
  "    automationField('If the bridge was away',catchUp),",
  "    automationField('Approval mode',permission),",
  "    automationField('Turn timeout (minutes)',timeout),",
  "  );",
  "  const submitRow=document.createElement('div');submitRow.className='settings-write-row';",
  "  const submit=document.createElement('button');submit.type='button';submit.className='settings-save';submit.textContent=t('Create task');",
  "  submit.onclick=async function(){",
  "    const type=scheduleType.value;",
  "    const schedule=type==='hourly'",
  "      ? {type:'hourly',intervalHours:Number(interval.value)||1}",
  "      : type==='weekly'",
  "        ? {type:'weekly',time:time.value,days:Object.keys(dayBoxes).filter(function(day){return dayBoxes[day].checked})}",
  "        : {type:type,time:time.value};",
  "    const target=targetMode.value==='continueThread'?{mode:'continueThread',threadId:targetThread.value.trim()}:{mode:'newThread'};",
  "    submit.disabled=true;",
  "    try{",
  "      await automationCall('create',{job:{name:name.value.trim(),prompt:prompt.value.trim(),cwd:cwd.value.trim(),schedule:schedule,target:target,catchUp:catchUp.value,permissionMode:permission.value,turnTimeoutMinutes:Number(timeout.value)||30}});",
  "      toast(t('A scheduled task was created'));reload();",
  "    }catch(error){toast(error.message)}finally{submit.disabled=false}",
  "  };",
  "  submitRow.append(submit);form.append(submitRow);",
  "  syncSchedule();syncTarget();",
  "  return form;",
  "}",
  "async function renderAutomationSettings(rows){",
  "  let data;",
  "  try{const response=await fetch('/api/automation');if(!response.ok)throw new Error(String(response.status));data=await response.json()}",
  "  catch(error){rows.append(settingsNotice(t('Could not read the local scheduler')+': '+(error&&error.message?error.message:String(error)),'warning'));return true}",
  "  const jobs=Array.isArray(data.jobs)?data.jobs:[],runs=Array.isArray(data.runs)?data.runs:[],limits=data.limits||{};",
  "  rows.append(settingsNotice(t('Scheduled tasks are driven by the local bridge')));",
  "  rows.append(settingsRow(t('What is guaranteed'),String(limits.background||'—'),t('Bridge tick')+': '+Math.round((limits.tickMs||0)/1000)+'s · '+t('Concurrency')+': '+String(limits.concurrency||'?')));",
  "  // 保活与限制（FEATURES 第 7 节最后一行）：三种机制各自解决什么、不解决什么，写清楚而不是含糊承诺。",
  "  const aliveTitle=document.createElement('div');aliveTitle.className='settings-section-title';aliveTitle.textContent=t('Keeping it alive');",
  "  rows.append(aliveTitle);",
  "  rows.append(settingsRow(t('termux-wake-lock'),t('Keeps the CPU awake (codex-gui-web takes it while the bridge runs)'),t('Costs one Termux notification and cannot stop Android from reclaiming the app process.')));",
  "  rows.append(settingsRow(t('Foreground service + pinned notification (APK)'),t('What the APK uses today'),t('Makes the bridge process foreground, so it is far less likely to be killed — not a promise that it never will be.')));",
  "  // 兜底唤醒：这块以前写的是\"本项目尚未接入（未验证）\"——那是错的。15 分钟周期的作业",
  "  // 从 2026-10-15 起就挂着（watchdog.log 每小时 6~8 拍），桥被停掉时它真的拉起来过（E136）。",
  "  const wake=data.wake||{};",
  "  const wakeValue=wake.installed?(t('Registered')+(wake.jobs&&wake.jobs.length?'（'+wake.jobs.length+'）':'')):(wake.scriptExists?t('Not registered'):t('Wake script missing'));",
  "  const wakeRow=settingsRow(t('JobScheduler / termux-job-scheduler'),wakeValue,wake.lastRun?(t('Last run')+': '+wake.lastRun):t('Never ran yet'));",
  "  if(!wake.installed&&wake.scriptExists){",
  "    const install=document.createElement('button');install.type='button';install.className='settings-save';install.textContent=t('Register now');",
  "    install.onclick=async function(){install.disabled=true;try{await automationCall('wakeInstall',{});toast(t('Registered the 15-minute wake-up'));reload()}catch(error){toast(error.message)}finally{install.disabled=false}};",
  "    wakeRow.append(install);",
  "  }",
  "  rows.append(wakeRow);",
  "  if(wake.installed)rows.append(settingsNotice(t('A 15-minute system job keeps the wake lock alive and starts the bridge if it is not running; when the bridge comes back it settles the missed slots with the catch-up rule above. Expect up to ~15 minutes of lateness after the bridge was gone — that is the platform minimum for periodic jobs, not something I can tune away.')));",
  "  const reload=function(){void renderSettingsLive('automation-settings')};",
  "  if(!jobs.length)rows.append(settingsNotice(t('No scheduled tasks yet — create one below.')));",
  "  for(const job of jobs){",
  "    const last=job.lastRun?(t('Last run')+': '+automationRunLabel(job.lastRun.status)):t('Never ran');",
  "    const row=settingsRow(job.name,job.enabled?automationClock(job.nextRunAt):t('Paused'),job.scheduleLabel+' · '+last);",
  "    const actions=document.createElement('div');actions.className='settings-write-row';",
  "    const runButton=document.createElement('button');runButton.type='button';runButton.className='settings-save';runButton.textContent=t('Run now');",
  "    runButton.onclick=async function(){runButton.disabled=true;try{await automationCall('runNow',{id:job.id});toast(t('Started'));setTimeout(reload,1500)}catch(error){toast(error.message)}finally{runButton.disabled=false}};",
  "    const toggle=document.createElement('button');toggle.type='button';toggle.className='settings-save';toggle.textContent=job.enabled?t('Pause'):t('Resume');",
  "    toggle.onclick=async function(){try{await automationCall(job.enabled?'disable':'enable',{id:job.id});reload()}catch(error){toast(error.message)}};",
  "    const remove=document.createElement('button');remove.type='button';remove.className='settings-save';remove.textContent=t('Delete');",
  "    remove.onclick=async function(){",
  "      const confirmed=await gitConfirm({title:t('Delete this scheduled task?'),message:job.name,confirmLabel:t('Delete')});",
  "      if(!confirmed)return;",
  "      try{await automationCall('remove',{id:job.id});reload()}catch(error){toast(error.message)}",
  "    };",
  "    actions.append(runButton,toggle,remove);row.append(actions);rows.append(row);",
  "  }",
  "  rows.append(automationCreateForm(reload));",
  "  rows.append(settingsRow(t('Run history'),String(runs.length),''));",
  "  if(!runs.length)rows.append(settingsNotice(t('No runs yet.')));",
  "  for(const run of runs.slice(0,10)){",
  "    const detail=run.summary||run.error||run.slotId||'';",
  "    rows.append(settingsRow((run.jobName||'')+' · '+automationRunLabel(run.status),automationClock(run.finishedAt||run.startedAt),String(detail).slice(0,140)));",
  "  }",
  "  if(runs.length){",
  "    const clearRow=document.createElement('div');clearRow.className='settings-write-row';",
  "    const clearButton=document.createElement('button');clearButton.type='button';clearButton.className='settings-save';clearButton.textContent=t('Clearing run history');",
  "    clearButton.onclick=async function(){",
  "      const confirmed=await gitConfirm({title:t('Clearing run history'),message:String(runs.length),confirmLabel:t('Delete')});",
  "      if(!confirmed)return;",
  "      try{await automationCall('clearRuns',{});reload()}catch(error){toast(error.message)}",
  "    };",
  "    clearRow.append(clearButton);rows.append(clearRow);",
  "  }",
  "  return true;",
  "}",
].join("\n");

// ---- 1. index.html：侧栏入口 ----
patch("public/index.html", (html) => {
  const anchor = '<button type="button" data-settings-page="hooks-settings"><span class="icon-slot" data-icon="wrench"></span><span>Hooks</span></button>';
  if (!html.includes(anchor)) throw new Error("cannot locate the Hooks nav button");
  const button = '<button type="button" data-settings-page="automation-settings"><span class="icon-slot" data-icon="loaderCircle"></span><span>Automation</span></button>';
  return html.replace(anchor, anchor + button);
});

// ---- 2. app.js：注册页面 + 渲染 ----
patch("public/app.js", (js) => {
  const pagesAnchor = "'hooks-settings':{title:'Hooks',rows:[['Configured hooks','None']]}";
  if (!js.includes(pagesAnchor)) throw new Error("cannot locate settingsPages hooks entry");
  let updated = js.replace(pagesAnchor, `${pagesAnchor},'${marker}':{title:'Automation'}`);

  const hostedAnchor = "const hosted=['agent','profile','plugins-settings','skills-settings','hooks-settings','experimental-settings'];";
  if (!updated.includes(hostedAnchor)) throw new Error("cannot locate the hosted page list");
  updated = updated.replace(
    hostedAnchor,
    "const hosted=['agent','profile','plugins-settings','skills-settings','hooks-settings','experimental-settings','automation-settings'];",
  );

  const dispatchAnchor = "  rows.replaceChildren();\n";
  if (!updated.includes(dispatchAnchor)) throw new Error("cannot locate renderSettingsLive body");
  updated = updated.replace(
    dispatchAnchor,
    `${dispatchAnchor}  if(page==='${marker}')return renderAutomationSettings(rows);\n`,
  );

  const insertAnchor = "async function renderSettingsLive(page){";
  if (!updated.includes(insertAnchor)) throw new Error("cannot locate renderSettingsLive");
  updated = updated.replace(insertAnchor, `${AUTOMATION_PAGE_JS}\n${insertAnchor}`);
  return updated;
});

// ---- 3. i18n.js：中文 ----
patch("public/i18n.js", (source) => `${source}

Object.assign(ZH_CN, {
  "Automation": "定时任务",
  "Could not read the local scheduler": "读不到本地调度器",
  "Scheduled tasks are driven by the local bridge": "定时任务由本地桥驱动：协议里没有任何调度方法（ClientRequest 里搜不到 schedul*），所以调度、记录、漏跑补跑都是桥自己实现的，用你设置的时间表在桥进程里到点起回合。",
  "What is guaranteed": "能保证什么",
  "Bridge tick": "扫描间隔",
  "Concurrency": "并发上限",
  "No scheduled tasks yet — create one below.": "还没有定时任务，用下面的表单建一个。",
  "Never ran": "还没跑过",
  "Last run": "上次运行",
  "Run now": "运行一次",
  "Pause": "暂停",
  "Resume": "恢复",
  "Paused": "已暂停",
  "Delete": "删除",
  "Delete this scheduled task?": "删除这个定时任务？",
  "Started": "已开始",
  "Task name": "任务名",
  "Prompt to send each run": "每次运行要发的提示词",
  "Working directory": "工作目录",
  "Schedule": "时间表",
  "Every hour": "每小时",
  "Every N hours": "每 N 小时",
  "Daily": "每天",
  "Weekdays": "工作日",
  "Weekly": "每周",
  "Time": "时间",
  "Day of week": "星期",
  "Run in": "运行在",
  "A new conversation": "新会话",
  "An existing conversation": "继续某个会话",
  "Conversation id": "会话 id",
  "If the bridge was away": "桥不在的那段时间",
  "Run the newest missed slot once": "只补最新一次",
  "Do not catch up (still logged)": "不补跑（但会记账）",
  "Approval mode": "审批策略",
  "Ask for approval (may wait for you)": "需要审批（可能等你回答）",
  "Full access (unattended)": "完全访问（无人值守）",
  "Turn timeout (minutes)": "回合超时（分钟）",
  "Create task": "创建任务",
  "Run history": "运行记录",
  "No runs yet.": "还没有运行记录。",
  "Completed": "完成",
  "Failed": "失败",
  "Timed out": "超时",
  "Interrupted": "被中断",
  "Skipped": "已跳过",
  "Running": "运行中",
  "A scheduled task was created": "已创建定时任务",
  "Clearing run history": "清空运行记录",
  "Registered": "已注册",
  "Not registered": "未注册",
  "Wake script missing": "唤醒脚本不存在",
  "Never ran yet": "还没跑过",
  "Register now": "立即注册",
  "Registered the 15-minute wake-up": "已注册 15 分钟兜底唤醒",
});
`);

// ---- 4. style.css：表单里新出现的控件（select 已有样式，time/number/星期多选没有）----
patch("public/style.css", (css) => `${css}

/* automation-settings（patches/0096）：定时任务表单里的 time/number 输入与星期多选。
   现有样式只覆盖了 input[type=text] 与 select（见 .settings-write-row 那组规则）。 */
.settings-automation-form{display:flex;flex-direction:column;gap:8px}
.settings-write-row input[type=time],.settings-write-row input[type=number]{min-height:32px;padding:0 8px;border:1px solid var(--app-border-default,var(--border-strong));border-radius:8px;background:transparent;color:var(--app-text);font:11.5px var(--mono)}
.settings-day-toggle{display:inline-flex;align-items:center;gap:4px;font:11.5px var(--mono);color:var(--app-text-secondary)}
`);

console.log("done — rebuild the bundle: cd app && bun build public/app.js --target=browser --outfile=public/app.bundle.js");
