// Is the upload progress bar actually wired end to end?
//
// Three things have to line up or the bar silently does nothing (patches/0035):
//   1. the chip markup has to create the fill layer and the phase readout;
//   2. style.css has to position the fill layer (otherwise it is an inline span
//      with no width semantics and the user sees no bar at all);
//   3. the transport has to be XMLHttpRequest — fetch cannot report upload progress.
// A negative control proves the check can fail.
//
// Usage: node probe/upload-progress-contract.mjs [appDir]
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(process.argv[2] ?? fileURLToPath(new URL("../app", import.meta.url)));
const js = readFileSync(resolve(appDir, "public/app.js"), "utf8");
const css = readFileSync(resolve(appDir, "public/style.css"), "utf8");

function inspect(script, styles) {
  const problems = [];
  if (!script.includes('class="composer-context-fill"')) problems.push("the chip does not render a .composer-context-fill layer");
  if (!script.includes('class="composer-context-phase"')) problems.push("the chip does not render a .composer-context-phase readout");
  if (!script.includes("function updateAttachmentProgress(")) problems.push("no in-place progress updater");
  if (!script.includes("xhr.upload.onprogress")) problems.push("upload progress is not measured (fetch cannot do it)");
  if (!script.includes("updateAttachmentProgress(placeholderId,fraction")) problems.push("progress events are not wired to the chip");
  if (!/\.composer-context-fill\{[^}]*position:absolute/.test(styles)) problems.push(".composer-context-fill is not positioned in style.css — the bar would be invisible");
  if (!/\.composer-context-chip\{[^}]*overflow:hidden/.test(styles)) problems.push("the chip does not clip the fill layer to its rounded corners");
  return problems;
}

const problems = inspect(js, css);

// Negative control: drop the positioning rule and the check must complain.
const control = inspect(js, css.replace(/\.composer-context-fill\{[^}]*\}/, ".composer-context-fill{width:0}"));
if (control.length === 0) problems.push("self-check failed: the detector does not notice a missing fill rule");

if (problems.length) {
  for (const problem of problems) console.log(`FAIL  ${problem}`);
  process.exit(1);
}
console.log("ok — chip markup + CSS + XHR progress hook are all present");
console.log("ok — self-check: a missing .composer-context-fill rule is detected");
