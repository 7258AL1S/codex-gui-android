// Does a document attachment still show its path, without eating the bubble? (E119, patches/0056)
//
// The bridge turns a document upload into the fixed sentence
//   「附件（本地路径，可直接读取）：<absolute path>」(server.ts:568).
// Rendered as pre-wrap text on a phone that is 7 lines of 8 characters (E119 screenshot),
// so it is now a one-line chip: file name by default, full path on tap.
//
// What must not change: the text the model receives, and the raw path stays readable
// (it is still in the DOM, inside the chip's path span, just collapsed by CSS).
//
// Usage: node probe/user-attachment-chip.test.mjs
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isImageReference, renderImagePreview } from "../app/public/rendering.js";

const appDir = resolve(fileURLToPath(new URL("../app", import.meta.url)));
const source = readFileSync(resolve(appDir, "public/app.js"), "utf8");

function slice(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`cannot locate ${start}`);
  return source.slice(from, to);
}

const escapeHtml = (value = "") => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const t = (value) => value;
const imageCwd = () => "";
const icons = { file: "<svg data-icon=\"file\"></svg>" };
const textFromInput = new Function(`return ${slice("function textFromInput(content=[]){", "\nfunction claimOptimisticUser")}`)();
const helpers = new Function(
  "isImageReference", "renderImagePreview", "escapeHtml", "t", "imageCwd", "textFromInput", "icons",
  `${slice("function userMessageImageSources(", "// Re-rendering on every upsert")}
   return { userMessageImageSources, userMessageHtml };`,
)(isImageReference, renderImagePreview, escapeHtml, t, imageCwd, textFromInput, icons);

const cases = [];
const check = (name, condition, detail = "") => { cases.push({ name, ok: Boolean(condition), detail }); };

// The sentence the bridge really writes, with the file name from the E119 screenshot.
const PREFIX = "附件（本地路径，可直接读取）：";
const LONG_PATH = "/data/data/com.termux/files/home/.codex/codex-webui/uploads/20261015182428-c6806975-e3de59e0c69185f685a04073e622f937_1815965615135601443_m.pdf";
const attachmentOnly = helpers.userMessageHtml({ content: [{ type: "text", text: PREFIX + LONG_PATH }] });

// 1. attachment-only message: exactly one chip, no leftover sentence in the bubble text
check("attachment-only renders a chip", attachmentOnly.includes('class="user-attachment"'), attachmentOnly.slice(0, 120));
// patches/0057: the label is shortened (head…tail), so it fits one line on a phone.
const label = /<span class="user-attachment-name">([^<]*)<\/span>/.exec(attachmentOnly)?.[1] ?? "";
check("chip shows a shortened file name", label === "202610151824…5601443_m.pdf", JSON.stringify(label));
check("the shortened name keeps the extension", label.endsWith(".pdf"));
check("the shortened name fits one line (<= 26 chars)", label.length <= 26, String(label.length));
check("the path is still in the DOM (collapsed)", attachmentOnly.includes(`data-attachment-path="${LONG_PATH}"`) && attachmentOnly.includes(`<span class="user-attachment-path">${LONG_PATH}</span>`));
check("a short name is left alone", (helpers.userMessageHtml({ content: [{ type: "text", text: PREFIX + "/data/x/report.pdf" }] }).includes('class="user-attachment-name">report.pdf<')) === true);
check("the raw sentence is not repeated as text", !attachmentOnly.includes(PREFIX));
// The path appears exactly twice in the markup: the data attribute and the collapsed span.
check("the path is only in the chip", attachmentOnly.split(LONG_PATH).length - 1 === 2, attachmentOnly.split(LONG_PATH).length - 1 + " occurrences");

// 2. a caption plus an attachment keeps both, in order
const mixed = helpers.userMessageHtml({ content: [{ type: "text", text: "这份日程帮我看看\n" + PREFIX + LONG_PATH }] });
check("caption survives", mixed.includes("这份日程帮我看看"));
check("caption comes before the chip", mixed.indexOf("这份日程帮我看看") < mixed.indexOf('class="user-attachment"'));
check("one chip only", mixed.split('class="user-attachment"').length - 1 === 1);

// 3. plain text is untouched (and no empty image grid sneaks in)
check("plain text renders unchanged", helpers.userMessageHtml({ content: [{ type: "text", text: "你好" }] }) === "你好", helpers.userMessageHtml({ content: [{ type: "text", text: "你好" }] }));

// 4. the sentence only becomes a chip on its own line (a mid-line mention stays text)
const quoted = helpers.userMessageHtml({ content: [{ type: "text", text: "它写在 " + PREFIX + LONG_PATH + " 里" }] });
check("a mid-line mention is left alone", quoted.includes(PREFIX) && !quoted.includes('class="user-attachment"'));

// 5. two attachments in one message
const two = helpers.userMessageHtml({ content: [{ type: "text", text: PREFIX + "/a/b.pdf\n" + PREFIX + "/c/d.txt" }] });
check("two attachments render two chips", two.split('class="user-attachment"').length - 1 === 2);

// 6. self-check: the assertions above are about the chip, not about the string being absent
//    everywhere — the old (pre-0056) rendering did put the sentence inline, and that is the
//    markup that overflowed. If this ever stops being true, the test is not testing anything.
const oldRendering = escapeHtml(PREFIX + LONG_PATH);
check("self-check: the old rendering had the sentence inline", oldRendering.includes(PREFIX) && oldRendering.includes(LONG_PATH));
check("self-check: so 'the raw sentence is not repeated as text' is not vacuous", !attachmentOnly.includes(PREFIX));

let failed = 0;
for (const item of cases) {
  if (item.ok) console.log("ok    " + item.name);
  else { failed += 1; console.log("FAIL  " + item.name + (item.detail ? "  <- " + item.detail : "")); }
}
console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
