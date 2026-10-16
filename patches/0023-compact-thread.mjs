// Patch 0023 — compact a thread from the row menu (the last P3 gap).
//
// Verified first (E61): thread/compact/start returns a normal result for a thread
// that has run a turn, with or without an explicit resume beforehand.
//
// Usage: node patches/0023-compact-thread.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);

function patchFile(file, rules, appendText, appendMarker) {
  let source = readFileSync(file, "utf8");
  let changed = 0;
  for (const rule of rules) {
    if (rule.skipIf && source.includes(rule.skipIf)) { console.log(`skip  ${rule.name} (marker present)`); continue; }
    const hits = source.split(rule.from).length - 1;
    if (hits === 0) throw new Error(`cannot apply "${rule.name}" in ${file}: anchor not found`);
    if (hits > 1) throw new Error(`cannot apply "${rule.name}" in ${file}: anchor matched ${hits} times`);
    source = source.replace(rule.from, rule.to);
    changed += 1;
    console.log(`apply ${rule.name}`);
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
    name: "menu gets Compact",
    from: "  add(isPinned?t('Unpin'):t('Pin'),()=>togglePinThread(thread));",
    to: "  add(isPinned?t('Unpin'):t('Pin'),()=>togglePinThread(thread));\n  add(t('Compact'),()=>compactThread(thread));",
    skipIf: "()=>compactThread(thread)",
  },
], `

// Compacting summarises a long thread. It needs the thread to be loadable, so a
// non-active thread is resumed first (same rule as turn/start, E36/E47).
async function compactThread(thread){
  if(!thread?.id)return;
  try{
    if(state.active?.id!==thread.id)await rpc('thread/resume',{threadId:thread.id});
    await rpc('thread/compact/start',{threadId:thread.id});
    toast(t('Thread compaction started'));
  }catch(error){console.error('Could not compact thread',error);toast(t('Could not compact thread'))}
}
`, "async function compactThread(");

patchFile(resolve(appDir, "public/i18n.js"), [], `
Object.assign(ZH_CN, {
  "Compact": "压缩上下文",
  "Thread compaction started": "已开始压缩上下文",
  "Could not compact thread": "压缩失败",
});
`, '"Compact": "压缩上下文"');

console.log("\nrebuild the bundle:  bun build public/app.js --target=browser --outfile=public/app.bundle.js");
