// Patch 0001 — only offer approval decisions the server actually listed.
//
// Upstream codex-webui (MIT) renders a hard-coded "Deny" button and does not
// gate the primary button on `availableDecisions`. On this machine the server
// offered ["accept", {acceptWithExecpolicyAmendment}, "cancel"] for a command
// approval — no "decline" at all — so the upstream UI could send a decision the
// server never offered (see VERIFICATION.md E29/E31).
//
// The edited line in public/app.js is a single very long line, which the patch
// tool cannot address, so the edits are applied by exact string replacement with
// an assert-exactly-once guard. Re-running this script is a no-op once applied.
//
// Usage: node patches/0001-approval-decisions.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const file = resolve(appDir, "public/app.js");

const RULES = [
  {
    name: "gate deny button + add cancel button",
    from: '<div class="approval-actions-main"><button type="button" class="approval-deny">${escapeHtml(model.deny.label)}</button>',
    to: '<div class="approval-actions-main">${model.deny?`<button type="button" class="approval-deny">${escapeHtml(model.deny.label)}</button>`:\'\'}${model.cancel?`<button type="button" class="approval-cancel">${escapeHtml(model.cancel.label)}</button>`:\'\'}',
  },
  {
    name: "gate primary button (plain branch)",
    from: '`:`<button type="submit" class="approval-primary" autofocus>${escapeHtml(model.primary.label)}</button>`}',
    to: '`:model.primary?`<button type="submit" class="approval-primary" autofocus>${escapeHtml(model.primary.label)}</button>`:\'\'}',
  },
  {
    name: "gate primary button (split branch)",
    from: '<div class="approval-split"><button type="submit" class="approval-primary" autofocus>${escapeHtml(model.primary.label)}</button>',
    to: '<div class="approval-split">${model.primary?`<button type="submit" class="approval-primary" autofocus>${escapeHtml(model.primary.label)}</button>`:\'\'}',
  },
  {
    name: "waiting flag must not depend on a deny button existing",
    from: "setApprovalWaiting(group,p.itemId,decision!==model.deny.decision);",
    to: "setApprovalWaiting(group,p.itemId,decision!=='decline'&&decision!=='cancel');",
  },
  {
    name: "bind deny/cancel handlers safely",
    from: "card.querySelector('.approval-deny').onclick=()=>answer(model.deny.decision);",
    to: "card.querySelector('.approval-deny')?.addEventListener('click',()=>answer(model.deny.decision));card.querySelector('.approval-cancel')?.addEventListener('click',()=>answer(model.cancel.decision));",
  },
  {
    name: "submit only when a primary decision exists",
    from: "card.querySelector('form').onsubmit=e=>{e.preventDefault();answer(model.primary.decision)};",
    to: "card.querySelector('form').onsubmit=e=>{e.preventDefault();if(model.primary)answer(model.primary.decision)};",
  },
];

let source = readFileSync(file, "utf8");
let changed = 0;

for (const rule of RULES) {
  const hits = source.split(rule.from).length - 1;
  if (hits === 0) {
    if (source.includes(rule.to)) { console.log(`skip  ${rule.name} (already applied)`); continue; }
    throw new Error(`cannot apply "${rule.name}": anchor not found`);
  }
  if (hits > 1) throw new Error(`cannot apply "${rule.name}": anchor matched ${hits} times`);
  source = source.replace(rule.from, rule.to);
  changed += 1;
  console.log(`apply ${rule.name}`);
}

if (changed > 0) {
  writeFileSync(file, source);
  console.log(`\nwrote ${changed} change(s) to ${file}`);
  console.log("rebuild the bundle:  bun build public/app.js --target=browser --outfile=public/app.bundle.js");
} else {
  console.log("\nnothing to do");
}
