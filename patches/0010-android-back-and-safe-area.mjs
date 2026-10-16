// Patch 0010 — Android back gesture closes overlays; safe-area top for standalone.
//
// Back handling: the app only routed back through the settings pages, so with the
// mobile drawer open a back press navigated away from the app instead of closing
// the drawer. The guard itself lives in ui-core.js (createOverlayBackGuard) and is
// unit-tested by probe/overlay-back.test.mjs.
//
// Safe area: only the composer used env(safe-area-inset-*). The header had none,
// and the mobile grid reserved 48px while the bar is 46px tall. Both are fixed
// with calc() + env() so the browser case (inset = 0px) stays pixel-identical
// apart from the 2px mismatch that is corrected on purpose.
//
// Usage: node patches/0010-android-back-and-safe-area.mjs [appDir]
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

const BACK_WIRING = `const overlayBack=createOverlayBackGuard({history:globalThis.history,onClose:()=>setSidebarOpen(false)});
addEventListener('popstate',()=>{if(overlayBack.handlePop())return;const page=settingsRoutePage();if(page){showSettings(page,{updateRoute:false});return}hideSettings()});`;

patchFile(resolve(appDir, "public/app.js"), [
  {
    name: "import the overlay back guard",
    from: "filterAppModels, getComposerAutocomplete, resolveComposerPlaceholder, selectModelState } from './ui-core.js';",
    to: "createOverlayBackGuard, filterAppModels, getComposerAutocomplete, resolveComposerPlaceholder, selectModelState } from './ui-core.js';",
    skipIf: "createOverlayBackGuard, filterAppModels",
  },
  {
    name: "wire the guard into popstate",
    from: "addEventListener('popstate',()=>{const page=settingsRoutePage();if(page){showSettings(page,{updateRoute:false});return}hideSettings()});",
    to: BACK_WIRING,
    skipIf: "overlayBack.handlePop()",
  },
  {
    name: "drawer open/close keeps history balanced",
    from: "function setSidebarOpen(open){const sidebar=$('#sidebar'),mobile=mobileSidebarEnabled();document.body.classList.toggle('sidebar-hidden',!mobile&&!open);sidebar.classList.toggle('mobile-open',mobile&&open);",
    to: "function setSidebarOpen(open){const sidebar=$('#sidebar'),mobile=mobileSidebarEnabled(),wasOpen=mobile&&sidebar.classList.contains('mobile-open');document.body.classList.toggle('sidebar-hidden',!mobile&&!open);sidebar.classList.toggle('mobile-open',mobile&&open);const isOpen=mobile&&sidebar.classList.contains('mobile-open');if(isOpen&&!wasOpen)overlayBack.opened();else if(!isOpen&&wasOpen)overlayBack.closed();",
    skipIf: "overlayBack.opened();else if",
  },
]);

const TOPBAR_H = "calc(46px + env(safe-area-inset-top,0px))";

patchFile(resolve(appDir, "public/style.css"), [
  {
    name: "header respects the status-bar inset",
    from: ".topbar{height:46px;grid-template-columns:var(--sidebar-w) minmax(0,1fr) auto;background:rgba(24,24,24,.96)}",
    to: `.topbar{height:${TOPBAR_H};padding-top:env(safe-area-inset-top,0px);grid-template-columns:var(--sidebar-w) minmax(0,1fr) auto;background:rgba(24,24,24,.96)}`,
    skipIf: "env(safe-area-inset-top,0px)",
  },
  {
    name: "mobile grid row matches the real header height",
    from: ".app-shell{grid-template-columns:minmax(0,1fr);grid-template-rows:48px minmax(0,1fr)}",
    to: `.app-shell{grid-template-columns:minmax(0,1fr);grid-template-rows:${TOPBAR_H} minmax(0,1fr)}`,
    skipIf: `grid-template-rows:${TOPBAR_H}`,
  },
  {
    name: "mobile drawer starts below the header + inset",
    from: ".sidebar{position:fixed;z-index:20;left:0;top:48px;",
    to: `.sidebar{position:fixed;z-index:20;left:0;top:${TOPBAR_H};`,
    skipIf: `top:${TOPBAR_H}`,
  },
  {
    name: "mobile review panel starts below the header + inset",
    from: ".changes-panel.mobile-review-open{display:flex!important;position:fixed;z-index:50;inset:48px 0 0;",
    to: `.changes-panel.mobile-review-open{display:flex!important;position:fixed;z-index:50;inset:${TOPBAR_H} 0 0;`,
    skipIf: `inset:${TOPBAR_H} 0 0`,
  },
]);

console.log("\nrebuild the bundle:  bun build public/app.js --target=browser --outfile=public/app.bundle.js");
