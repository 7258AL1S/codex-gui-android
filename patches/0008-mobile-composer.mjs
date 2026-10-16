// Patch 0008 — mobile composer: readable model chip, and a real steer fallback.
//
// Two problems observed on the phone (screenshots + bridge log):
//
// 1. The model chip rendered as "DeepS…" because modelDisplay() only stripped a
//    literal "GPT-" prefix, while the CSS caps the label at 54–78px on narrow
//    screens. With a non-OpenAI provider the full "DeepSeek-Flash" never fits.
// 2. The upstream steer path has no recovery: when the UI still thinks a turn is
//    active (it missed turn/completed) but the server has already finished,
//    `turn/steer` fails with "no active turn to steer" — the client only restored
//    the text and showed a toast. The bridge log caught six of these in a row.
//
// Usage: node patches/0008-mobile-composer.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const appFile = resolve(appDir, "public/app.js");
const cssFile = resolve(appDir, "public/style.css");

function patchFile(file, rules, { append = null } = {}) {
  let source = readFileSync(file, "utf8");
  let changed = 0;
  for (const rule of rules) {
    // `to` often has to re-include `from` (it is the tail of the block being
    // wrapped), so an "already applied" test on `to` is not enough on its own —
    // support an explicit skip marker, otherwise re-running duplicates the edit.
    if (rule.skipIf && source.includes(rule.skipIf)) { console.log(`skip  ${rule.name} (marker present)`); continue; }
    const hits = source.split(rule.from).length - 1;
    if (hits === 0) {
      if (source.includes(rule.to)) { console.log(`skip  ${rule.name} (already applied)`); continue; }
      throw new Error(`cannot apply "${rule.name}" in ${file}: anchor not found`);
    }
    if (hits > 1) throw new Error(`cannot apply "${rule.name}" in ${file}: anchor matched ${hits} times`);
    source = source.replace(rule.from, rule.to);
    changed += 1;
    console.log(`apply ${rule.name}`);
  }
  if (append && !source.includes(append.marker)) {
    source += append.text;
    changed += 1;
    console.log(`apply ${append.name}`);
  }
  if (changed > 0) writeFileSync(file, source);
  return changed;
}

// --- 1. readable model label ------------------------------------------------
// Strip a leading vendor segment generically ("DeepSeek-Flash" -> "Flash",
// "DeepSeek-V4-Pro" -> "V4-Pro", "GPT-5-Codex" -> "5-Codex"), but never shorten
// to a single character, and keep the original if stripping would lose it.
const STEER_FALLBACK = "if(isNoActiveTurnError(failure)){setActiveTurnId('');restoreInput();submitPrompt({preventDefault(){}});return}";

const appChanged = patchFile(appFile, [
  {
    name: "modelDisplay strips any vendor prefix, keeps a usable tail",
    from: "function modelDisplay(model,stripPrefix=false){const value=String(model?.displayName||model?.model||state.selectedModel||'Select model').trim();if(!stripPrefix)return value;return value.replace(/^GPT-/i,'').trim()||value}",
    to: "function modelDisplay(model,stripPrefix=false){const value=String(model?.displayName||model?.model||state.selectedModel||'Select model').trim();if(!stripPrefix)return value;const stripped=value.replace(/^[^-_/\\s]+[-_\\s]/,'').trim();return stripped.length>=2?stripped:value}",
    skipIf: "replace(/^[^-_/\\s]+[-_\\s]/,'')",
  },
  {
    // Repair an earlier non-idempotent run of this same patch (it inserted the
    // fallback twice because the anchor was part of the replacement).
    name: "dedupe the steer fallback",
    from: `${STEER_FALLBACK}${STEER_FALLBACK}`,
    to: STEER_FALLBACK,
  },
  {
    name: "steer falls back to sending when the turn already ended",
    from: "restoreInput();if(!failure?.silentTransportSwitch)toast(t(threadInputErrorMessage(failure)),5200)}return}",
    to: `${STEER_FALLBACK}restoreInput();if(!failure?.silentTransportSwitch)toast(t(threadInputErrorMessage(failure)),5200)}return}`,
    skipIf: "isNoActiveTurnError(failure)",
  },
], {
  append: {
    name: "isNoActiveTurnError helper",
    marker: "function isNoActiveTurnError(",
    text: `

// The UI tracks the active turn from DOM state (send button dataset). If it
// misses turn/completed, the composer stays in "steer" mode while the server has
// no active turn, and turn/steer fails. Treat that specific failure as "the turn
// is over": clear the state and send as a normal new turn instead of erroring.
function isNoActiveTurnError(error){const message=String(error?.message||'').toLowerCase();return message.includes('no active turn')}
`,
  },
});

// --- 2. give the label room on narrow screens -------------------------------
const cssChanged = patchFile(cssFile, [
  { name: "wide-phone label 78px -> 104px", from: ".model-trigger #modelLabel{max-width:78px}", to: ".model-trigger #modelLabel{max-width:104px}" },
  { name: "narrow-phone label 54px -> 76px", from: ".model-trigger #modelLabel{max-width:54px}", to: ".model-trigger #modelLabel{max-width:76px}" },
  { name: "narrow-phone trigger 118px -> 136px", from: ".model-trigger{max-width:118px;padding-inline:5px}", to: ".model-trigger{max-width:136px;padding-inline:5px}" },
]);

console.log(`\napp.js: ${appChanged} change(s), style.css: ${cssChanged} change(s)`);
console.log("rebuild the bundle:  bun build public/app.js --target=browser --outfile=public/app.bundle.js");
