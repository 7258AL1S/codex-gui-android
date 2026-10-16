// Patch 0027 — thread/queue/add also requires `clientUserMessageId`.
//
// Discovered by calling it: "missing field `clientUserMessageId`". So the shape is
//   { threadId, input, clientUserMessageId }
// and that id is what comes back as `queuedSubmissionId` for queue/delete.
// E51 showed this field does NOT dedupe turn/start; here it is simply required as
// the identity of the queued submission.
//
// Usage: node patches/0027-queue-requires-message-id.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const file = resolve(appDir, "public/app.js");
let source = readFileSync(file, "utf8");

const FROM = "await rpc('thread/queue/add',{threadId:state.active.id,input:[{type:'text',text}]});";
const TO = "await rpc('thread/queue/add',{threadId:state.active.id,input:[{type:'text',text}],clientUserMessageId:(crypto.randomUUID?crypto.randomUUID():(Date.now()+'-'+Math.random().toString(16).slice(2)))});";

if (source.includes("clientUserMessageId:(crypto.randomUUID")) {
  console.log("skip  queue message id (already applied)");
} else if (source.includes(FROM)) {
  source = source.replace(FROM, TO);
  writeFileSync(file, source);
  console.log("apply queue message id");
} else {
  throw new Error("anchor not found");
}

console.log("rebuild the bundle:  bun build public/app.js --target=browser --outfile=public/app.bundle.js");
