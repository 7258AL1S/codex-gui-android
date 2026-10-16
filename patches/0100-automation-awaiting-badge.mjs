// Patch 0100 — 运行记录里显示"正在等审批/回答"，并给一个「打开会话」按钮（E138）。
//
// 背景：定时回合在 `default` 权限档下碰到审批时，以前只能干等到 30 分钟超时记成 `timeout`。
// 桥侧已经会在请求到达的那一刻记进运行记录并发带深链的通知（app/automation-service.js 的
// `onServerRequest`）；这个补丁让**页面上看得见**这件事，并且一键跳进那条会话去处理。
//
// Usage: node patches/0100-automation-awaiting-badge.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const MARKERS = {
  "public/app.js": "Waiting for your approval",
  "public/i18n.js": "\"Open conversation\"",
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

const OLD_LOOP = [
  "  for(const run of runs.slice(0,10)){",
  "    const detail=run.summary||run.error||run.slotId||'';",
  "    rows.append(settingsRow((run.jobName||'')+' · '+automationRunLabel(run.status),automationClock(run.finishedAt||run.startedAt),String(detail).slice(0,140)));",
  "  }",
].join("\n");

const NEW_LOOP = [
  "  for(const run of runs.slice(0,10)){",
  "    const detail=run.summary||run.error||run.slotId||'';",
  "    // 正在等审批/回答的运行要一眼看出来——不然用户只会看到'运行中'然后半小时后变成超时。",
  "    const awaiting=run.awaiting?(run.awaiting.kind==='approval'?t('Waiting for your approval'):t('Waiting for your answer'))+' · ':'';",
  "    const row=settingsRow((run.jobName||'')+' · '+automationRunLabel(run.status),automationClock(run.finishedAt||run.startedAt),awaiting+String(detail).slice(0,140));",
  "    if(run.threadId){",
  "      const openRun=document.createElement('button');openRun.type='button';openRun.className='settings-save';openRun.textContent=t('Open conversation');",
  "      openRun.onclick=function(){closeSettings();void openThread(run.threadId)};",
  "      row.append(openRun);",
  "    }",
  "    rows.append(row);",
  "  }",
].join("\n");

patch("public/app.js", (js) => {
  if (!js.includes(OLD_LOOP)) throw new Error("cannot locate the automation run history loop");
  return js.replace(OLD_LOOP, NEW_LOOP);
});

patch("public/i18n.js", (source) => `${source}

Object.assign(ZH_CN, {
  "Waiting for your approval": "等待你审批",
  "Waiting for your answer": "等待你回答",
  "Open conversation": "打开会话",
});
`);

console.log("done — 重建 bundle：cd app && bun build public/app.js --target=browser --outfile=public/app.bundle.js，然后重启桥（server.ts 改了）");
