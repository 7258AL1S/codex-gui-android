// Does every outbound turn carry the attachments it claims to carry?
//
// Why this exists (VERIFICATION.md E89): submitPromptInner clears
// state.composerAttachments *before* it builds the RPC payload, so a payload built
// from the live state sends nothing. The bytes stay on the bridge, the chip
// disappears, and the model only ever sees user.text — a silent data loss that
// survived several rounds of "the model did not see my file" because nothing errored.
// The bug is invisible at runtime, so it needs a source-level guard.
//
// Usage: node probe/attachment-payload-audit.mjs [appDir]
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(process.argv[2] ?? fileURLToPath(new URL("../app", import.meta.url)));

// Returns the list of problems for a given source text.
function inspect(source) {
  const problems = [];
  const clearedBeforeUse =
    source.includes("const mentions=state.composerMentions,attachments=state.composerAttachments;")
    && source.includes("state.composerMentions=[];state.composerAttachments=[];");
  if (!clearedBeforeUse) {
    problems.push("cannot find the snapshot/clear sequence in submitPromptInner — re-check this audit against the current code");
    return problems;
  }
  const count = (needle) => source.split(needle).length - 1;
  const withoutSnapshot = count("input:[...textPart(text),...attachmentInputs()]");
  if (withoutSnapshot > 0) {
    problems.push(`${withoutSnapshot} outbound input(s) call attachmentInputs() with no list — they will encode the already-cleared state`);
  }
  // Either the snapshot directly, or the snapshot merged with uploads that finished
  // after send was pressed (patches/0039). Both start from the snapshot.
  const withSnapshot = count("input:[...textPart(text),...attachmentInputs(attachments)]")
    + count("input:[...textPart(text),...attachmentInputs(attachmentsForSend(attachments))]");
  if (withSnapshot !== 4) {
    problems.push(`expected 4 snapshot-carrying outbound inputs (steer×2, turn/start, queue/add), found ${withSnapshot}`);
  }
  const bubble = count("content:[...textPart(text),...attachmentContent(attachments)]")
    + count("content:[...textPart(text),...attachmentContent(attachmentsForSend(attachments))]");
  if (bubble !== 1) problems.push(`expected the optimistic bubble to use the snapshot, found ${bubble}`);

  // Ordering: `const mentions=…,attachments=…` is a TDZ binding. Touching `attachments`
  // earlier in the same function throws "Cannot access 'attachments' before
  // initialization" at run time — which is how a patch that looked correct made every
  // send fail instantly, with the only evidence in the browser console/field log (E96).
  const bodyStart = source.indexOf("async function submitPromptInner(event){");
  const bodyEnd = source.indexOf("\n", bodyStart);
  const body = source.slice(bodyStart, bodyEnd < 0 ? undefined : bodyEnd);
  const declaredAt = body.indexOf("const mentions=state.composerMentions,attachments=state.composerAttachments");
  if (declaredAt < 0) {
    problems.push("cannot find the snapshot declaration inside submitPromptInner");
  } else {
    const firstUse = body.search(/\battachments\.(?:filter|map|some|find|length)|attachment(?:Inputs|Content)\(attachments/);
    if (firstUse >= 0 && firstUse < declaredAt) {
      problems.push("submitPromptInner touches the snapshot before declaring it (TDZ: every send would throw)");
    }
  }

  // Flow order: waiting for in-flight uploads has to happen *before* the "is there
  // anything to send?" decision. When it sat after that guard, pressing send on an
  // empty text box with a pending attachment returned early instead of waiting, so the
  // file was silently not sent and the user had to press send again (E97).
  const waitAt = body.indexOf("const pendingAtSend=");
  const guardAt = body.indexOf("const readyAttachments=");
  if (waitAt < 0 || guardAt < 0 || waitAt > guardAt) {
    problems.push("the pending-upload wait must run before the hasContext guard");
  }
  return problems;
}

const source = readFileSync(resolve(appDir, "public/app.js"), "utf8");
const problems = inspect(source);

// Negative control: the same check must fail on the pre-fix shape.
const regressed = source.split("...attachmentInputs(attachmentsForSend(attachments))]").join("...attachmentInputs()]").split("...attachmentInputs(attachments)]").join("...attachmentInputs()]");
const controlProblems = inspect(regressed);
if (controlProblems.length === 0) {
  problems.push("self-check failed: the detector does not notice the bug it was written for");
}

if (problems.length) {
  for (const problem of problems) console.log(`FAIL  ${problem}`);
  process.exit(1);
}
console.log("ok — every outbound turn encodes the attachment snapshot (4 inputs + optimistic bubble)");
console.log("ok — self-check: the pre-fix shape is detected");
