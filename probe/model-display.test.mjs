// Checks the model-label shortening by extracting the REAL function out of the
// built bundle (not a copy of it), then feeding it the names this device's
// provider actually returns. Motivated by the screenshot where the composer
// showed only "DeepS…" (VERIFICATION.md E39).
import { readFileSync } from "node:fs";

const bundle = readFileSync(new URL("../app/public/app.bundle.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/public/style.css", import.meta.url), "utf8");

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in the bundle`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`could not find the end of ${name}`);
}

const state = { selectedModel: "deepseek-flash" };
const modelDisplay = new Function("state", `${extractFunction(bundle, "modelDisplay")}; return modelDisplay;`)(state);

console.log("model chip label (stripPrefix = true)");
check("DeepSeek-Flash -> Flash", modelDisplay({ displayName: "DeepSeek-Flash" }, true), "Flash");
check("DeepSeek-V4-Pro -> V4-Pro", modelDisplay({ displayName: "DeepSeek-V4-Pro" }, true), "V4-Pro");
check("GPT-5-Codex -> 5-Codex (same as before for gpt names)", modelDisplay({ displayName: "GPT-5-Codex" }, true), "5-Codex");
check("never shorten to a single character", modelDisplay({ displayName: "gpt-5" }, true), "gpt-5");
check("leading underscore/space handled", modelDisplay({ displayName: "Vendor Ultra" }, true), "Ultra");

console.log("model menu keeps the full name (stripPrefix = false)");
check("full display name preserved", modelDisplay({ displayName: "DeepSeek-Flash" }, false), "DeepSeek-Flash");
check("falls back to the model id", modelDisplay({ model: "deepseek-v4-pro" }, false), "deepseek-v4-pro");
check("falls back to the remembered selection", modelDisplay(null, false), "deepseek-flash");

console.log("label width budget on phones");
check("wide-phone cap raised to 104px", /\.model-trigger #modelLabel\{max-width:104px\}/.test(css), true);
check("narrow-phone cap raised to 76px", /\.model-trigger #modelLabel\{max-width:76px\}/.test(css), true);

console.log("empty model catalog is explained instead of leaking a server error");
// NOTE: the bundler re-formats the source (adds spaces/newlines), so these must be
// whitespace-tolerant instead of raw substring matches.
check("send is blocked with an explanation", /if\s*\(!state\.selectedModel\)\s*\{\s*toast\(/.test(bundle), true);
check("chip falls back to a real empty state", /hasCatalog\s*=\s*Array\.isArray\(state\.models\)/.test(bundle), true);
check("steer failure falls back to sending", /isNoActiveTurnError/.test(bundle), true);
const i18n = readFileSync(new URL("../app/public/i18n.js", import.meta.url), "utf8");
check("zh-CN string exists for the empty state", i18n.includes('"没有可用模型"'), true);

console.log("command activity label is translated");
// Quote-agnostic: the bundler rewrites ' to " (see E41).
check("collapsed label goes through t()", /t\(interrupted \? ["']Stopped["'] : ["']Ran["']\)/.test(bundle), true);
check('the "Ran" entry exists in zh-CN', /"Ran": "已运行"/.test(i18n), true);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
