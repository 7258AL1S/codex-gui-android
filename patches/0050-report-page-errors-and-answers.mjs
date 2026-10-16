// Patch 0050 — 让"点了没反应"能说话。
//
// 现场（E115）：elicitation 卡片渲染正常、按钮也在可访问性树里（bounds 正确），
// 但点「提交」之后请求仍然 pending。既没有 toast、也没有日志——前端 JS 里的异常
// 默认只进浏览器控制台，而我从 Termux 这边看不见，只能猜。
//
// 三处补齐（都只写诊断，不改行为）：
//   1) window 的 error / unhandledrejection → clientLog（页面级异常首次可见）；
//   2) interactionAnswer() 打印 requestId 与将要发出的载荷，以及 respondToCodex 的失败原因；
//   3) elicitation 的 accept 分支打印构造出的响应体。
//
// Usage: node patches/0050-report-page-errors-and-answers.mjs [appDir]
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

patchFile(resolve(appDir, "public/app.js"), [
  {
    name: "every interaction answer is logged with its payload",
    from: "function interactionAnswer(card,req,respond){\n  card.querySelectorAll('button,input,select,textarea').forEach(node=>{node.disabled=true});\n  respondToCodex(req.id,respond).catch(error=>{if(!error?.silentTransportSwitch)toast(error.message)});",
    to: "function interactionAnswer(card,req,respond){\n  card.querySelectorAll('button,input,select,textarea').forEach(node=>{node.disabled=true});\n  clientLog('interaction answer: id='+req.id+' method='+req.method+' payload='+JSON.stringify(respond).slice(0,300));\n  respondToCodex(req.id,respond).catch(error=>{clientLog('interaction answer FAILED: id='+req.id+' -> '+((error&&error.message)||error));if(!error?.silentTransportSwitch)toast(error.message)});",
    skipIf: "interaction answer: id=",
  },
  {
    name: "and the elicitation accept branch says what it built",
    from: "accept.addEventListener('click',()=>interactionAnswer(card,req,buildElicitationResponse(model,collect(),'accept')));",
    to: "accept.addEventListener('click',()=>{const response=buildElicitationResponse(model,collect(),'accept');clientLog('elicitation accept: '+JSON.stringify(response).slice(0,300));interactionAnswer(card,req,response)});",
    skipIf: "elicitation accept: ",
  },
], `

// --- 页面级异常上报（patches/0050）-----------------------------------------
// 前端抛在事件处理器里的异常默认只进浏览器控制台，而查问题的人（我）在 Termux 这边。
// 这两条把它送进桥日志；和 Android 侧的崩溃上报是同一个思路（E106）。
try{
  addEventListener('error',(event)=>{
    try{
      const where=(event&&event.filename?event.filename:'')+':'+(event&&event.lineno||0);
      clientLog('page error: '+((event&&event.message)||'?')+' @ '+where);
    }catch(inner){}
  });
  addEventListener('unhandledrejection',(event)=>{
    try{
      const reason=event&&event.reason;
      clientLog('page unhandled rejection: '+((reason&&reason.message)||String(reason)).slice(0,200));
    }catch(inner){}
  });
}catch(error){/* diagnostics must never break the app */}
`, "addEventListener('unhandledrejection'");

console.log("done — rebuild the bundle: bun build public/app.js --target=browser --outfile=public/app.bundle.js");
