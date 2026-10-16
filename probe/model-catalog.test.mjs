// Regression test for the empty model catalog that made the browser composer
// unusable: "No models are available. Set `model` explicitly or check your model
// catalog configuration." (VERIFICATION.md E37)
//
// The fixture is the real `model/list` payload from this device.
import { filterAppModels, selectModelState } from "../app/public/ui-core.js";

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};

const DEVICE_CATALOG = [
  { model: "deepseek-flash", displayName: "DeepSeek-Flash", hidden: false, isDefault: true,
    defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }, { reasoningEffort: "max" }] },
  { model: "deepseek-v4-pro", displayName: "DeepSeek-V4-Pro", hidden: false, isDefault: false,
    defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }, { reasoningEffort: "max" }] },
];

console.log("device catalog (third-party provider, no gpt models)");
check("catalog is no longer emptied", filterAppModels(DEVICE_CATALOG).map((m) => m.model), ["deepseek-flash", "deepseek-v4-pro"]);
check("default model resolves to a real id, not an empty string", selectModelState(filterAppModels(DEVICE_CATALOG), null).model, "deepseek-flash");
check("efforts come from the model's real capabilities", selectModelState(filterAppModels(DEVICE_CATALOG), null).efforts, ["low", "high", "max"]);
check("remembered model is honoured", selectModelState(filterAppModels(DEVICE_CATALOG), "deepseek-v4-pro").model, "deepseek-v4-pro");
check("an unknown remembered model falls back to a real one", selectModelState(filterAppModels(DEVICE_CATALOG), "gpt-5-codex").model, "deepseek-flash");

console.log("edge cases");
check("hidden models are still excluded", filterAppModels([...DEVICE_CATALOG, { model: "secret", hidden: true }]).map((m) => m.model), ["deepseek-flash", "deepseek-v4-pro"]);
check("entries without an id are excluded", filterAppModels([{ displayName: "No id" }]), []);
check("a genuinely empty catalog stays empty (UI must show a real empty state)",
  selectModelState(filterAppModels([]), null).model, "");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
