// Patch 0046 — 审批卡片说中文。
//
// 真机验收时发现的（E113）：界面整体是中文，但审批卡片上写的是
//
//   >_ 终端
//   Allow ChatGPT to run this command?
//   Reason: 沙箱内网络受限…
//   [ 取消 ]  [ Allow once ▾ ]
//
// 也就是说 model 里的标签/标题是硬编码英文，渲染时没有过 t()。
// 这里在渲染处包一层 t()，并补齐词条；模型里那些**带变量**的标题
// （例如 `Allow ChatGPT to connect to <host>?`）保持英文——i18n 是精确匹配，
// 插值串硬套会变成"翻译了等于没翻译"，这条如实记在限制里。
//
// Usage: node patches/0046-approval-labels-in-chinese.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);

function patchFile(file, rules) {
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
  if (changed > 0) writeFileSync(file, source);
  return changed;
}

patchFile(resolve(appDir, "public/app.js"), [
  {
    // 卡片头部：身份（Terminal / Edit files）、标题、Reason
    name: "card header goes through the translator",
    from: "${approvalIcon(model.kind)}<span>${escapeHtml(model.identity)}</span></div><div class=\"approval-title\">${escapeHtml(model.title)}</div>",
    to: "${approvalIcon(model.kind)}<span>${escapeHtml(t(model.identity))}</span></div><div class=\"approval-title\">${escapeHtml(t(model.title))}</div>",
    skipIf: "escapeHtml(t(model.identity))",
  },
  {
    name: "the Reason label too",
    from: "${model.reason?`<div class=\"approval-reason\"><span>Reason</span>",
    to: "${model.reason?`<div class=\"approval-reason\"><span>${escapeHtml(t('Reason'))}</span>",
    skipIf: "escapeHtml(t('Reason'))",
  },
  {
    name: "every button label goes through the translator",
    from: "escapeHtml(model.leading.label)",
    to: "escapeHtml(t(model.leading.label))",
    skipIf: "escapeHtml(t(model.leading.label))",
    expect: 1,
  },
  {
    name: "deny button",
    from: "escapeHtml(model.deny.label)",
    to: "escapeHtml(t(model.deny.label))",
    skipIf: "escapeHtml(t(model.deny.label))",
    expect: 1,
  },
  {
    name: "cancel button",
    from: "escapeHtml(model.cancel.label)",
    to: "escapeHtml(t(model.cancel.label))",
    skipIf: "escapeHtml(t(model.cancel.label))",
    expect: 1,
  },
  {
    name: "primary button",
    from: "escapeHtml(model.primary.label)",
    to: "escapeHtml(t(model.primary.label))",
    skipIf: "escapeHtml(t(model.primary.label))",
    expect: 2,
  },
  {
    name: "scoped button",
    from: "escapeHtml(model.scoped.label)",
    to: "escapeHtml(t(model.scoped.label))",
    skipIf: "escapeHtml(t(model.scoped.label))",
    expect: 1,
  },
]);

patchFile(resolve(appDir, "public/i18n.js"), [
  {
    name: "Chinese for the approval card",
    from: '"Answered elsewhere": "已在别处处理",',
    to: '"Answered elsewhere": "已在别处处理",\n'
      + '  "Allow once": "允许一次",\n'
      + '  "Allow this conversation": "允许本次会话",\n'
      + '  "Allow all edits": "允许全部修改",\n'
      + '  "Deny": "拒绝",\n'
      + '  "Terminal": "终端",\n'
      + '  "Edit files": "修改文件",\n'
      + '  "Internet access": "网络访问",\n'
      + '  "Reason": "原因",\n'
      + '  "Allow ChatGPT to run this command?": "允许运行这条命令？",\n'
      + '  "Allow ChatGPT to edit the following file?": "允许修改以下文件？",\n'
      + '  "Allow ChatGPT to edit the following files?": "允许修改以下文件？",',
    skipIf: '"Allow once": "允许一次"',
  },
]);

console.log("done — rebuild the bundle: bun build public/app.js --target=browser --outfile=public/app.bundle.js");
