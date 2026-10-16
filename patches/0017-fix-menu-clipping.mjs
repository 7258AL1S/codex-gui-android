// Patch 0017 — the thread-actions menu was clipped by its ancestors.
//
// Screenshot 2026-10-14 04:48: the popover showed only "重命名"; 分叉/归档 were cut
// off and the next row drew over them. Cause: the menu was absolutely positioned
// inside the row, and the sidebar's scroll/row containers clip their overflow, so
// a popover taller than the row is cut.
//
// Fix: keep the menu out of that clipping context entirely — append it to
// document.body when opened and position it with getBoundingClientRect(), clamped
// to the viewport. This also survives any future overflow change in the sidebar.
//
// Usage: node patches/0017-fix-menu-clipping.mjs [appDir]
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

patchFile(resolve(appDir, "public/app.js"), [
  {
    name: "menu lives outside the row (no clipping ancestor)",
    from: "  wrap.append(menu,trigger);\n  return wrap;",
    to: "  wrap.append(trigger);\n  return wrap;",
    skipIf: "wrap.append(trigger);",
  },
  {
    name: "close also detaches the menu",
    from: "  const close=()=>{menu.hidden=true;trigger.setAttribute('aria-expanded','false');document.removeEventListener('click',onOutside,true);document.removeEventListener('keydown',onKey,true)};",
    to: "  const close=()=>{menu.hidden=true;trigger.setAttribute('aria-expanded','false');if(menu.parentNode)menu.parentNode.removeChild(menu);document.removeEventListener('click',onOutside,true);document.removeEventListener('keydown',onKey,true)};",
    skipIf: "if(menu.parentNode)menu.parentNode.removeChild(menu)",
  },
  {
    name: "outside clicks on the detached menu must not close it",
    from: "  const onOutside=(event)=>{if(!wrap.contains(event.target))close()};",
    to: "  const onOutside=(event)=>{if(!wrap.contains(event.target)&&!menu.contains(event.target))close()};",
    skipIf: "&&!menu.contains(event.target)&&close",
  },
  {
    name: "open: attach to body and position against the viewport",
    from: "  trigger.onclick=(event)=>{\n    event.stopPropagation();\n    const open=menu.hidden;\n    menu.hidden=!open;\n    trigger.setAttribute('aria-expanded',String(open));\n    if(open){document.addEventListener('click',onOutside,true);document.addEventListener('keydown',onKey,true)}else close();\n  };",
    to: "  const position=()=>{\n    const rect=trigger.getBoundingClientRect();\n    const maxTop=window.innerHeight-menu.offsetHeight-8;\n    menu.style.top=Math.max(8,Math.min(rect.bottom+4,maxTop))+'px';\n    menu.style.left=Math.max(8,rect.right-menu.offsetWidth)+'px';\n  };\n  trigger.onclick=(event)=>{\n    event.stopPropagation();\n    const open=menu.hidden;\n    if(open){\n      document.body.append(menu);\n      menu.hidden=false;\n      position();\n      document.addEventListener('click',onOutside,true);\n      document.addEventListener('keydown',onKey,true);\n    }else close();\n    trigger.setAttribute('aria-expanded',String(open));\n  };",
    skipIf: "document.body.append(menu)",
  },
]);

patchFile(resolve(appDir, "public/style.css"), [
  {
    // The popover is now a body-level overlay, so it must not be positioned
    // relative to the row any more.
    name: "menu CSS becomes a fixed overlay",
    from: ".thread-actions-menu{position:absolute;right:0;top:calc(100% + 4px);z-index:30;min-width:132px;",
    to: ".thread-actions-menu{position:fixed;z-index:60;min-width:150px;",
    skipIf: ".thread-actions-menu{position:fixed",
  },
]);

console.log("\nrebuild the bundle:  bun build public/app.js --target=browser --outfile=public/app.bundle.js");
