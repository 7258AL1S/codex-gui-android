// Patch 0019 — the two archived-view strings that never landed.
//
// patches/0018 used the marker `"Archived": "已归档"` to make its i18n append
// idempotent — but upstream already ships that exact entry (line ~117), so the
// append was skipped and "Showing archived threads" / "Showing active threads"
// were never added. Correctness check: instantiate the i18n and translate them.
//
// Usage: node patches/0019-archived-i18n-fix.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const file = resolve(appDir, "public/i18n.js");
let source = readFileSync(file, "utf8");

const MARKER = '"Showing archived threads": "正在显示已归档会话"';
if (source.includes(MARKER)) {
  console.log("skip  archived-view strings (already present)");
} else {
  source += `
Object.assign(ZH_CN, {
  "Showing archived threads": "正在显示已归档会话",
  "Showing active threads": "正在显示进行中的会话",
});
`;
  writeFileSync(file, source);
  console.log("apply archived-view strings");
}
