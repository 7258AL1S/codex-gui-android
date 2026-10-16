// Which attachments actually leave with a message? (E94)
//
// Send can be pressed while the bytes are still moving. The composer snapshot then holds
// a placeholder chip, the finished attachment lands in the live state a moment later, and
// a naive implementation sends the placeholder (i.e. nothing) — which is how a PDF
// silently vanished from a new conversation. This pins the merge rules:
// placeholders never ship, finished-later attachments do, duplicates collapse, order holds.
//
// Usage: node probe/attachments-for-send.test.mjs
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(fileURLToPath(new URL("../app", import.meta.url)));
const source = readFileSync(resolve(appDir, "public/app.js"), "utf8");
const from = source.indexOf("function attachmentsForSend(");
const to = source.indexOf("\n}", from);
if (from < 0 || to < 0) throw new Error("cannot locate attachmentsForSend in app.js");
const body = source.slice(from, to + 2);

const state = { composerAttachments: [] };
const attachmentsForSend = new Function("state", `${body}; return attachmentsForSend;`)(state);

const cases = [];
const check = (name, actual, expected) => cases.push({ name, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });
const ids = (list) => list.map((item) => item.id);

const pending = { id: "pending-1", pending: true };
const done = { id: "path-a", path: "/u/a.png" };
const doneLater = { id: "path-b", path: "/u/b.pdf" };

state.composerAttachments = [];
check("a placeholder never ships", ids(attachmentsForSend([pending])), []);

state.composerAttachments = [done];
check("a finished snapshot ships", ids(attachmentsForSend([done])), ["path-a"]);

state.composerAttachments = [doneLater];
check("an upload that finished after send is included", ids(attachmentsForSend([pending])), ["path-b"]);

state.composerAttachments = [done, doneLater];
check("order holds and duplicates collapse", ids(attachmentsForSend([done, done, pending])), ["path-a", "path-b"]);

state.composerAttachments = [doneLater, pending];
check("a still-pending upload is skipped while others ship", ids(attachmentsForSend([done, pending])), ["path-a", "path-b"]);

let failed = 0;
for (const item of cases) {
  console.log(`${item.ok ? "ok  " : "FAIL"}  ${item.name}${item.ok ? "" : ` — got ${JSON.stringify(item.actual)}, expected ${JSON.stringify(item.expected)}`}`);
  if (!item.ok) failed += 1;
}
console.log(failed ? `${failed} failing` : "ALL PASS");
process.exit(failed ? 1 : 0);
