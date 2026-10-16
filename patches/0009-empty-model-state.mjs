// Patch 0009 — a real empty state when the provider returns no models.
//
// Before this, an empty catalog left the composer showing "Select model" (with
// nothing to select) and the first send surfaced the raw server error:
//   "No models are available. Set `model` explicitly or check your model
//    catalog configuration."
// The user should instead learn what is actually wrong, in their own language,
// before anything is sent.
//
// Usage: node patches/0009-empty-model-state.mjs [appDir]
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

const HINT = "This provider returned no models. Check the Codex model catalog configuration.";

patchFile(resolve(appDir, "public/i18n.js"), [
  {
    name: "zh-CN strings for the empty model state",
    from: '  "Image unavailable": "图片不可用",',
    to: `  "Image unavailable": "图片不可用",\n  "No models are available": "没有可用模型",\n  "${HINT}": "当前 provider 没有返回任何模型，请检查 Codex 的模型目录配置。",`,
    skipIf: HINT,
  },
]);

patchFile(resolve(appDir, "public/app.js"), [
  {
    // Refuse the send before anything is cleared, and say why.
    name: "block sending without a model, with an explanation",
    from: "if(!text)return;const mentions=state.composerMentions;",
    to: `if(!text)return;if(!state.selectedModel){toast(t('${HINT}'),6000);syncModelLabel();return}const mentions=state.composerMentions;`,
    skipIf: "if(!state.selectedModel){toast(",
  },
  {
    // The chip should not invite the user to "Select model" when the catalog is empty.
    name: "model chip shows the empty state",
    from: "function syncModelLabel(){const model=selectedModel();$('#modelLabel').textContent=modelDisplay(model,true);",
    to: "function syncModelLabel(){const model=selectedModel(),hasCatalog=Array.isArray(state.models)&&state.models.length>0;$('#modelLabel').textContent=model?modelDisplay(model,true):(hasCatalog?modelDisplay(null,true):t('No models are available'));",
    skipIf: "hasCatalog=Array.isArray(state.models)",
  },
]);

console.log("\nrebuild the bundle:  bun build public/app.js --target=browser --outfile=public/app.bundle.js");
