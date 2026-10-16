// Patch 0015 — finish the thread-actions menu: correct icon, styling, zh-CN.
//
// Usage: node patches/0015-thread-actions-css-i18n.mjs [appDir]
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

// The icon set uses "ellipsis"; "moreHorizontal" does not exist and would render
// nothing (the button would look empty).
patchFile(resolve(appDir, "public/app.js"), [
  {
    name: "use the icon that actually exists",
    from: "trigger.innerHTML=codexIcon('moreHorizontal');",
    to: "trigger.innerHTML=codexIcon('ellipsis');",
    skipIf: "codexIcon('ellipsis')",
  },
]);

patchFile(resolve(appDir, "public/style.css"), [], `

/* Thread row actions (patch 0014/0015) — a "⋯" that opens a small popover. */
.thread-actions{position:relative;display:inline-flex;align-items:center}
.thread-actions-trigger{opacity:.55}
.thread-row:hover .thread-actions-trigger,.thread-actions-trigger[aria-expanded="true"]{opacity:1}
.thread-actions-menu{position:absolute;right:0;top:calc(100% + 4px);z-index:30;min-width:132px;padding:4px;border:1px solid var(--border-strong);border-radius:10px;background:#292929;box-shadow:0 14px 34px rgba(0,0,0,.45);display:flex;flex-direction:column}
.thread-actions-menu[hidden]{display:none}
.thread-actions-item{width:100%;padding:9px 10px;border-radius:8px;text-align:left;font-size:12px;color:var(--text)}
.thread-actions-item:hover{background:#353535}
`, "/* Thread row actions (patch 0014/0015)");

patchFile(resolve(appDir, "public/i18n.js"), [], `
Object.assign(ZH_CN, {
  "Thread actions": "会话操作",
  "Rename": "重命名",
  "Rename thread": "重命名会话",
  "Fork": "分叉",
  "Archive": "归档",
  "Restore": "恢复",
  "Thread renamed": "已重命名",
  "Thread forked": "已分叉",
  "Thread archived": "已归档",
  "Thread restored": "已恢复",
  "Could not rename thread": "重命名失败",
  "Could not fork thread": "分叉失败",
  "Could not archive thread": "归档失败",
  "Could not restore thread": "恢复失败",
});
`, '"Thread actions": "会话操作"');

console.log("\nrebuild the bundle:  bun build public/app.js --target=browser --outfile=public/app.bundle.js");
