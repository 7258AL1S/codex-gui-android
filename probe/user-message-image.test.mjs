// Does a picture the user sent end up in their own bubble? (E93)
//
// The renderer was `textContent = textFromInput(content)`: image parts were ignored
// and the echoed shape speaks `input_text`, so an image message rendered as an empty
// bubble while the model could see the photo perfectly well. This runs the real
// helpers out of app.js against the real rendering.js helpers, on the shapes that
// actually appear (optimistic localImage, echoed input_text marker + input_image data
// URL, a non-image mention, plain text).
//
// Usage: node probe/user-message-image.test.mjs
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
const textFromInput = new Function(`return ${slice("function textFromInput(content=[]){", "\nfunction claimOptimisticUser")}`)();
const helpers = new Function(
  "isImageReference", "renderImagePreview", "escapeHtml", "t", "imageCwd", "textFromInput",
  `${slice("function userMessageImageSources(", "// Re-rendering on every upsert")}
   return { userMessageImageSources, userMessageHtml };`,
)(isImageReference, renderImagePreview, escapeHtml, t, imageCwd, textFromInput);

const cases = [];
const check = (name, condition, detail = "") => { cases.push({ name, ok: Boolean(condition), detail }); };

// 1. optimistic bubble: localImage{path} + text
const optimistic = helpers.userMessageHtml({ content: [{ type: "localImage", path: "/data/x/photo.jpg" }, { type: "text", text: "看这张" }] });
check("optimistic image renders a thumbnail", optimistic.includes("message-image-button") && optimistic.includes("/api/images/local"), optimistic);
check("optimistic image keeps the caption", optimistic.includes("看这张"), optimistic);

// 2. echoed shape: input_text marker + input_image data URL (what the app-server writes)
const marker = '<image name=[Image #1] path="/data/x/photo.jpg">';
const echoed = helpers.userMessageHtml({ content: [{ type: "input_text", text: marker }, { type: "input_image", image_url: `data:image/jpeg;base64,${"A".repeat(200)}` }] });
check("echoed image renders from the path, not the base64", echoed.includes("/api/images/local") && !echoed.includes("AAAA"), echoed.slice(0, 200));
check("the raw marker never leaks into the bubble", !echoed.includes("&lt;image") && !echoed.includes("<image"), echoed.slice(0, 200));

// 3. a PDF mention is not a picture
const pdf = helpers.userMessageHtml({ content: [{ type: "mention", name: "a.pdf", path: "/data/x/a.pdf" }, { type: "text", text: "帮我看看" }] });
check("a non-image attachment is not rendered as an image", !pdf.includes("message-image-button"), pdf);

// 4. text only, and an attachment with no caption at all
check("plain text still renders", helpers.userMessageHtml({ content: [{ type: "text", text: "hello" }] }).includes("hello"));
check("an attachment without a caption still shows something", helpers.userMessageHtml({ content: [{ type: "localImage", path: "/data/x/a.png" }] }).includes("message-image-button"));

// 5. self-check: the assertions are sensitive to the image check
const blind = new Function(
  "isImageReference", "renderImagePreview", "escapeHtml", "t", "imageCwd", "textFromInput",
  `${slice("function userMessageImageSources(", "// Re-rendering on every upsert")}
   return { userMessageHtml };`,
)(() => false, renderImagePreview, escapeHtml, t, imageCwd, textFromInput);
check("self-check: with no image detection the thumbnail disappears", !blind.userMessageHtml({ content: [{ type: "localImage", path: "/data/x/photo.jpg" }] }).includes("message-image-button"));

let failed = 0;
for (const item of cases) {
  console.log(`${item.ok ? "ok  " : "FAIL"}  ${item.name}${item.ok ? "" : ` — ${item.detail}`}`);
  if (!item.ok) failed += 1;
}
console.log(failed ? `${failed} failing` : "ALL PASS");
process.exit(failed ? 1 : 0);
