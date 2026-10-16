// Patch 0099 — 定时任务的「继续某个会话」不再要用户手抄 threadId（P8 最后一块）。
//
// 之前那张表单里 "Conversation id" 是一个空文本框：用户得自己去别处找到会话 id、
// 复制、粘贴。这是整个界面里唯一还在要人抄 id 的地方。现在改成真的会话选择器：
// 用页面已有的 `rpc('thread/list')`（浏览器白名单里本来就有这个方法）拉最近 50 条会话，
// 显示成"标题/预览 · id 前 8 位"。
//
// 关键在失败路径：拉不到就**退回手填**并说明真实原因，绝不显示一个空下拉框让用户以为"没有会话"。
//
// Usage: node patches/0099-automation-thread-picker.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const MARKERS = {
  "public/app.js": "automationThreadPicker",
  "public/i18n.js": "\"Pick a conversation first\"",
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

const replaceOnce = (text, from, to, label) => {
  if (!text.includes(from)) throw new Error(`cannot locate: ${label}`);
  return text.replace(from, to);
};

patch("public/app.js", (js) => {
  let out = js;

  out = replaceOnce(
    out,
    "  const targetThread=automationInput('text','Conversation id','');\n  const targetThreadRow=automationField('Conversation id',targetThread);",
    [
      "  // automationThreadPicker（patches/0099）：会话选择器。真的从 thread/list 拉最近 50 条；",
      "  // 拉不到就退回手填并说明原因——空下拉框会让人误以为\"没有会话\"。",
      "  const targetPick=document.createElement('select');",
      "  const targetPickRow=automationField('An existing conversation',targetPick);",
      "  const targetThread=automationInput('text','Conversation id','');",
      "  const targetThreadRow=automationField('Conversation id (manual)',targetThread);",
      "  const targetNotice=settingsNotice(t('Loading conversations…'));",
      "  const targetNoticeRow=document.createElement('div');targetNoticeRow.className='settings-write-row';targetNoticeRow.append(targetNotice);",
      "  let targetFallback=false,targetsLoaded=false;",
      "  const loadTargets=async function(){",
      "    try{",
      "      const result=await rpc('thread/list',{limit:50,sortKey:'recency_at',sortDirection:'desc'});",
      "      const threads=(result&&result.data)||[];",
      "      targetPick.replaceChildren();",
      "      if(!threads.length){",
      "        targetPick.append(Object.assign(document.createElement('option'),{value:'',textContent:t('No conversations yet')}));",
      "        targetNotice.textContent=t('No conversations to continue yet — the first one appears here after you chat once.');",
      "        return;",
      "      }",
      "      for(const thread of threads){",
      "        const label=String(thread.name||thread.title||thread.preview||t('Untitled')).slice(0,60)+' · '+String(thread.id).slice(0,8);",
      "        targetPick.append(Object.assign(document.createElement('option'),{value:thread.id,textContent:label}));",
      "      }",
      "      targetNoticeRow.hidden=true;",
      "    }catch(error){",
      "      targetFallback=true;",
      "      targetNotice.textContent=t('Could not load conversations')+': '+(error&&error.message?error.message:String(error))+' '+t('— type the conversation id instead.');",
      "      syncTarget();",
      "    }",
      "  };",
    ].join("\n"),
    "会话选择器控件",
  );

  out = replaceOnce(
    out,
    "  const syncTarget=function(){targetThreadRow.hidden=targetMode.value!=='continueThread'};",
    [
      "  const syncTarget=function(){",
      "    const continuing=targetMode.value==='continueThread';",
      "    targetPickRow.hidden=!continuing||targetFallback;",
      "    targetThreadRow.hidden=!continuing||!targetFallback;",
      "    targetNoticeRow.hidden=!continuing;",
      "    if(continuing&&!targetsLoaded&&!targetFallback){targetsLoaded=true;void loadTargets()}",
      "  };",
    ].join("\n"),
    "syncTarget",
  );

  out = replaceOnce(
    out,
    "    targetThreadRow,\n",
    "    targetPickRow,\n    targetThreadRow,\n    targetNoticeRow,\n",
    "表单里的 target 行",
  );

  out = replaceOnce(
    out,
    "    const target=targetMode.value==='continueThread'?{mode:'continueThread',threadId:targetThread.value.trim()}:{mode:'newThread'};",
    [
      "    const chosenThread=targetFallback?targetThread.value.trim():String(targetPick.value||'').trim();",
      "    if(targetMode.value==='continueThread'&&!chosenThread){toast(t('Pick a conversation first'));submit.disabled=false;return}",
      "    const target=targetMode.value==='continueThread'?{mode:'continueThread',threadId:chosenThread}:{mode:'newThread'};",
    ].join("\n"),
    "提交时的 target",
  );

  // 任务列表里也把"继续哪个会话"显出来（只显示 id 前 8 位，不假装知道标题）。
  out = replaceOnce(
    out,
    "    const row=settingsRow(job.name,job.enabled?automationClock(job.nextRunAt):t('Paused'),job.scheduleLabel+' · '+last);",
    "    const targetHint=job.target&&job.target.mode==='continueThread'?(t('Continues')+' '+String(job.target.threadId||'').slice(0,8)+' · '):'';\n    const row=settingsRow(job.name,job.enabled?automationClock(job.nextRunAt):t('Paused'),targetHint+job.scheduleLabel+' · '+last);",
    "任务行的 target 提示",
  );

  return out;
});

patch("public/i18n.js", (source) => `${source}

Object.assign(ZH_CN, {
  "An existing conversation": "继续某个会话",
  "Conversation id (manual)": "会话 id（手填）",
  "Loading conversations…": "正在读取会话…",
  "No conversations yet": "还没有会话",
  "No conversations to continue yet — the first one appears here after you chat once.": "还没有可继续的会话；聊过一次之后它就会出现在这里。",
  "Untitled": "未命名",
  "Could not load conversations": "读不到会话列表",
  "— type the conversation id instead.": "—— 改为手填会话 id。",
  "Pick a conversation first": "先选一个会话",
  "Continues": "继续会话",
});
`);

console.log("done — 重建 bundle：cd app && bun build public/app.js --target=browser --outfile=public/app.bundle.js");
