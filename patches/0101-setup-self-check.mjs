// Patch 0101 — 设置 → 配置页加「启动自检」清单（P9 的首次配置引导，E139）。
//
// 一次成功的启动取决于**两侧**的事实：Android 侧（Termux 装了吗、RUN_COMMAND 授权了吗、通知权限）
// 只有应用知道；Termux 侧（`~/bin/codex-gui-web` 在不在、termux-api 有没有、codex 版本、状态目录能不能写）
// 只有桥知道。桥的 `GET /api/setup` 把两边合成一张清单，这个补丁把它显示出来 ——
// **缺什么就写缺什么，并给具体动作**，不显示"未知"糊过去。
//
// Usage: node patches/0101-setup-self-check.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const MARKERS = {
  "public/app.js": "Startup self-check",
  "public/i18n.js": "\"Startup self-check\"",
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

const ANCHOR = "      rows.append(settingsRow(t('Reasoning effort'),reasoningLabel($('#effortSelect')?.value),''));\n";

const BLOCK = [
  "      // 启动自检（patches/0101，E139）：Android 侧的事实由应用上报，Termux 侧由桥现查。",
  "      // 查不到就说查不到（例如应用还没上报过），缺什么给具体动作——不用'未知'糊过去。",
  "      try{",
  "        const setup=await (await fetch('/api/setup')).json();",
  "        const termux=setup.termux||{};",
  "        const androidFacts=(setup.android&&setup.android.facts)||null;",
  "        const selfCheckTitle=document.createElement('div');selfCheckTitle.className='settings-section-title';selfCheckTitle.textContent=t('Startup self-check');",
  "        rows.append(selfCheckTitle);",
  "        rows.append(settingsRow(t('Bridge start script'),(termux.bridgeScript&&termux.bridgeScript.exists?'✅ ':'⚠️ ')+String((termux.bridgeScript&&termux.bridgeScript.path)||'—'),t('What the app asks Termux to run.')));",
  "        const api=termux.termuxApi||{};",
  "        rows.append(settingsRow('Termux:API',['wake-lock','notification','job-scheduler'].map(function(name){const key=name==='wake-lock'?'wakeLock':name==='notification'?'notification':'jobScheduler';return (api[key]?'✅ ':'⚠️ ')+name}).join(' · '),t('Needed for the wake lock, notifications, and the 15-minute fallback wake-up.')));",
  "        rows.append(settingsRow(t('Codex CLI'),String((termux.codex&&termux.codex.version)||t('not found on PATH')),''));",
  "        rows.append(settingsRow(t('Bridge state directory'),((termux.stateDir&&termux.stateDir.writable)?'✅ ':'⚠️ ')+String((termux.stateDir&&termux.stateDir.path)||'—'),t('Automation records and uploads live here.')));",
  "        rows.append(settingsRow(t('Fallback wake-up job'),(termux.wake&&termux.wake.installed)?('✅ '+t('registered')):('⚠️ '+t('not registered')),String((termux.wake&&termux.wake.lastRun)||'')));",
  "        rows.append(settingsRow(t('App side (last report)'),androidFacts?[androidFacts.termuxInstalled?t('Termux installed'):t('Termux missing'),androidFacts.runCommandGranted?t('run command granted'):t('run command NOT granted'),(androidFacts.notificationsAllowed?t('notifications allowed'):t('notifications blocked')),'v'+String(androidFacts.version||'?')].join(' · '):t('no report yet — open the app once'),''));",
  "        if(termux.bridgeScript&&!termux.bridgeScript.exists)rows.append(settingsNotice(t('~/bin/codex-gui-web is missing — the app cannot start the bridge. Restore it from the project or reinstall the Termux side.'),'warning'));",
  "        if(!api.jobScheduler)rows.append(settingsNotice(t('Termux:API is missing: no wake lock, no notifications from Termux, and no 15-minute fallback wake-up.'),'warning'));",
  "        if(androidFacts&&androidFacts.runCommandGranted===false)rows.append(settingsNotice(t('The run-command permission is not granted: every cold start will briefly switch to Termux.')));",
  "      }catch(error){",
  "        rows.append(settingsNotice(t('Startup self-check failed')+': '+String((error&&error.message)||error),'warning'));",
  "      }",
].join("\n");

patch("public/app.js", (js) => {
  if (!js.includes(ANCHOR)) throw new Error("cannot locate the Configuration page reasoning row");
  return js.replace(ANCHOR, `${ANCHOR}${BLOCK}\n`);
});

patch("public/i18n.js", (source) => `${source}

Object.assign(ZH_CN, {
  "Startup self-check": "启动自检",
  "Bridge start script": "桥的启动脚本",
  "What the app asks Termux to run.": "应用请 Termux 执行的就是它。",
  "Needed for the wake lock, notifications, and the 15-minute fallback wake-up.": "唤醒锁、通知、以及 15 分钟兜底唤醒都靠它。",
  "Codex CLI": "Codex CLI",
  "not found on PATH": "PATH 里找不到",
  "Bridge state directory": "桥的状态目录",
  "Automation records and uploads live here.": "定时任务记录与上传的附件都在这里。",
  "Fallback wake-up job": "兜底唤醒作业",
  "registered": "已注册",
  "not registered": "未注册",
  "App side (last report)": "应用侧（最近一次上报）",
  "Termux installed": "已装 Termux",
  "Termux missing": "未装 Termux",
  "run command granted": "已授权 run command",
  "run command NOT granted": "未授权 run command",
  "notifications allowed": "通知已允许",
  "notifications blocked": "通知被禁止",
  "no report yet — open the app once": "还没有上报过——打开一次应用即可",
  "~/bin/codex-gui-web is missing — the app cannot start the bridge. Restore it from the project or reinstall the Termux side.": "~/bin/codex-gui-web 不存在——应用没法启动桥。把项目里的这个脚本恢复回去，或重装 Termux 侧。",
  "Termux:API is missing: no wake lock, no notifications from Termux, and no 15-minute fallback wake-up.": "没装 Termux:API：不会有唤醒锁、不会有 Termux 通知、也没有 15 分钟兜底唤醒。",
  "The run-command permission is not granted: every cold start will briefly switch to Termux.": "没有授予 run-command 权限：每次冷启动都会短暂切到 Termux。",
  "Startup self-check failed": "启动自检失败",
});
`);

console.log("done — 重建 bundle：cd app && bun build public/app.js --target=browser --outfile=public/app.bundle.js");
