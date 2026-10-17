// Patch 0104 — 打开长会话不再"永远 Loading conversation"。
//
// 用户报："应用一直在 loading conversation"。
// 现场：那条会话 `thread/read` 返回 **13.4 MB / 143 轮 / 893 条消息**（实测），
// 而 `openThread()` 拿到历史后**把全部轮次一次性 renderTurn** —— 每轮里还有工具卡片、diff、图片……
// 手机 WebView 渲染几百个卡片要几十秒，这段时间界面上就一行 "Loading conversation…"，没进度也没出路。
//
// 更要命的是：代码里**本来就有分页渲染器** `renderThread()`（每页 20 轮 + "Load earlier messages" 按钮），
// 只是 `openThread()` 没用它。这个补丁让它用上，并顺手堵住"加载失败后仍停在 Loading"的分支。
//
// Usage: node patches/0104-open-thread-paged-render.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const file = resolve(appDir, "public/app.js");
const js = readFileSync(file, "utf8");

if (js.includes("paged-open-thread")) {
  console.log("skip  public/app.js (already applied)");
  process.exit(0);
}

// 1) 打开会话时走分页渲染（只画最近一页），而不是把 143 轮全画一遍
const OLD_RENDER = "if((thread.turns||[]).length){for(const turn of thread.turns)renderTurn(turn)}else{$('#conversation').innerHTML='<div class=\"list-state conversation-loading\">No conversation history loaded. Send a message to continue.</div>'}scrollOpenedThreadToBottom();";
if (!js.includes(OLD_RENDER)) throw new Error("cannot locate the openThread render loop");
const NEW_RENDER = [
  "if((thread.turns||[]).length){",
  "    // paged-open-thread（patches/0104）：长会话只画最近 DEFAULT_TURN_PAGE_SIZE 轮。",
  "    // 之前这里把全部轮次一次性 renderTurn —— 实测那条 143 轮 / 13.4 MB 的会话会卡几十秒，",
  "    // 而 renderThread() 本来就带分页与「Load earlier messages」按钮，只是没被用上。",
  "    renderThread(thread)",
  "  }else{$('#conversation').innerHTML='<div class=\"list-state conversation-loading\">No conversation history loaded. Send a message to continue.</div>'}",
  "  scrollOpenedThreadToBottom();",
"",
].join("\n");

let out = js.replace(OLD_RENDER, NEW_RENDER);

// 2) 加载失败时不许把界面留在 "Loading conversation…" 里：给出原因 + 重试
const OLD_CATCH = "catch(e){clientLog('history load FAILED for '+id+': '+((e&&e.message)||e));if(deferTransition){toast(e?.message||'Could not load side task');return false}if(!summary||state.active?.id!==id)return false;$('#conversation').innerHTML='<div class=\"list-state conversation-loading\">Could not load history. Send a message to start fresh.</div>';return false}";
if (!out.includes(OLD_CATCH)) throw new Error("cannot locate the openThread catch block");
const NEW_CATCH = [
  "catch(e){",
  "    const detail=(e&&e.message)||String(e);",
  "    clientLog('history load FAILED for '+id+': '+detail);",
  "    if(deferTransition){toast(detail||'Could not load side task');return false}",
  "    // 失败必须**离开** Loading 状态：写明原因 + 给重试按钮（patches/0104）。",
  "    // 原来的分支在 state.active.id !== id 时直接 return，占位文字就永远留在那儿了。",
  "    if(summary&&state.active?.id===id){",
  "      const box=document.createElement('div');box.className='list-state conversation-loading';",
  "      box.append(document.createTextNode('Could not load history: '+detail+' '));",
  "      const retry=document.createElement('button');retry.type='button';retry.className='settings-save';retry.textContent='Retry';",
  "      retry.onclick=function(){void openThread(id,summary)};",
  "      box.append(retry);",
  "      $('#conversation').replaceChildren(box);",
  "      toast(t('Could not load this conversation')+': '+detail,9000);",
  "      return false",
  "    }",
  "    toast(t('Could not load this conversation')+': '+detail,9000);",
  "    return false",
  "  }",
"",
].join("\n");

out = out.replace(OLD_CATCH, NEW_CATCH);
writeFileSync(file, out);
console.log("apply public/app.js: openThread 走分页渲染 + 失败不再卡在 Loading");
console.log("done — 重建 bundle：cd app && bun build public/app.js --target=browser --outfile=public/app.bundle.js");
