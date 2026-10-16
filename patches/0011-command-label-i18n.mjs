// Patch 0011 — translate the collapsed command-activity label.
//
// Seen in the user's screenshot: the same kind of tool card rendered once as
// "已运行 /bin/sh -lc '…'" and once as "Ran /bin/sh -lc '…'".
//
// Cause: the collapsed label is built by string concatenation
//     `${interrupted ? 'Stopped' : 'Ran'}${command ? ` ${command}` : ' command'}`
// so it never goes through t(). Worse, there is no "Ran" entry in the zh-CN map
// at all (only "Ran command" / "Ran commands"), so even a t() wrapper would have
// fallen back to English for that word — which is exactly the inconsistency seen.
//
// Usage: node patches/0011-command-label-i18n.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);

function patchFile(file, rules) {
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
  if (changed > 0) writeFileSync(file, source);
  return changed;
}

patchFile(resolve(appDir, "public/i18n.js"), [
  {
    name: 'add the missing "Ran" entry',
    from: '  "Ran command": "已运行命令",',
    to: '  "Ran": "已运行",\n  "Ran command": "已运行命令",',
    skipIf: '"Ran": "已运行"',
  },
]);

patchFile(resolve(appDir, "public/app.js"), [
  {
    name: "route the collapsed command label through t()",
    from: "if(expanded)return interrupted?'Stopped command':'Ran command';return`${interrupted?'Stopped':'Ran'}${command?` ${command}`:' command'}`}",
    to: "if(expanded)return t(interrupted?'Stopped command':'Ran command');return command?`${t(interrupted?'Stopped':'Ran')} ${command}`:t(interrupted?'Stopped command':'Ran command')}",
    skipIf: "t(interrupted?'Stopped':'Ran')",
  },
]);

console.log("\nrebuild the bundle:  bun build public/app.js --target=browser --outfile=public/app.bundle.js");
