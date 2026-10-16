// Live check for item/tool/requestUserInput.
//
// The model only asks the user a question in default mode when the experimental
// feature `default_mode_request_user_input` is on, so this script:
//   1. enables that feature on the bridge-hosted app-server (runtime only)
//   2. starts a turn that invites a clarifying question
//   3. answers the request through POST /api/codex/respond
//   4. restores the feature to its previous value
//
// Usage: node probe/user-input-e2e.mjs
const BASE = process.env.BRIDGE_URL ?? "http://127.0.0.1:8899";
const CWD = process.env.SCENARIO_CWD ?? "/data/data/com.termux/files/home/codex-gui";
const FEATURE = "default_mode_request_user_input";

let rpcSeq = 500;
async function rpc(method, params = {}) {
  const id = rpcSeq++;
  const res = await fetch(`${BASE}/api/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, method, params }),
  });
  const body = await res.json();
  if (body.type === "rpc/error") throw new Error(`${method}: ${body.error}`);
  return body.result;
}

const events = [];
fetch(`${BASE}/api/events`).then(async (res) => {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      try { events.push({ at: Date.now(), ...JSON.parse(line.slice(6)) }); } catch { /* ignore */ }
    }
  }
}).catch(() => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const requests = () => events.filter((e) => e.type === "codex/request");

await sleep(400);

console.log("== features before ==");
const before = await rpc("experimentalFeature/list", {});
const listed = JSON.stringify(before).slice(0, 200);
console.log(`   experimentalFeature/list -> ${listed}`);

const result = { feature: FEATURE, enabled: false, requestSeen: false };
try {
  await rpc("experimentalFeature/enablement/set", { enablement: { [FEATURE]: true } });
  result.enabled = true;
  console.log(`== enabled ${FEATURE} (runtime only) ==`);

  const start = await rpc("thread/start", { cwd: CWD });
  const threadId = start?.thread?.id;
  const mark = Date.now();
  await rpc("turn/start", {
    threadId,
    input: [{
      type: "text",
      text: "我要做一个手机端的 Codex 界面。在动手前，请先用 request_user_input 工具问我一个必须澄清的问题（给我 2 个选项，并允许我自由输入），然后停下等我的回答。",
    }],
  });
  result.threadId = threadId;
  console.log(`[user-input] thread=${threadId} waiting for the model to ask a question…`);

  const started = Date.now();
  let seen = null;
  while (Date.now() - started < 150000) {
    seen = requests().find((e) => e.at > mark && e.payload?.method === "item/tool/requestUserInput");
    if (seen) break;
    await sleep(250);
  }

  if (!seen) {
    const others = [...new Set(requests().filter((e) => e.at > mark).map((e) => e.payload?.method))];
    result.note = "no requestUserInput observed";
    result.otherRequests = others;
    console.log(`[user-input] no requestUserInput within timeout; other requests: ${others.join(", ") || "(none)"}`);
  } else {
    result.requestSeen = true;
    const req = seen.payload;
    result.paramKeys = Object.keys(req.params ?? {});
    result.questions = (req.params?.questions ?? []).map((q) => ({ id: q.id, header: q.header, options: (q.options ?? []).map((o) => o.label), isOther: q.isOther }));
    console.log(`[user-input] request received; isBlocking=${req.params?.isBlocking}`);
    for (const q of req.params?.questions ?? []) {
      console.log(`   - [${q.id}] ${q.header}: ${q.question} | options=${(q.options ?? []).map((o) => o.label).join("/") || "(free text)"}`);
    }

    // answer the way the UI does: pick an option for the first question, type
    // free text for any question that offers it
    const answers = {};
    for (const q of req.params?.questions ?? []) {
      answers[q.id] = (q.options ?? []).length ? [q.options[0].label] : ["先做能跑通的版本"];
    }
    const response = { answers };
    const res = await fetch(`${BASE}/api/codex/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: req.id, result: response }),
    });
    result.answeredWith = response;
    result.respondStatus = res.status;
    console.log(`[user-input] answered with ${JSON.stringify(response)} -> HTTP ${res.status}`);

    // did the turn pick the answer up and keep going?
    const after = Date.now();
    let settled = false;
    while (Date.now() - after < 120000) {
      const methods = events.filter((e) => e.at > seen.at).map((e) => e.payload?.method);
      if (methods.includes("turn/completed")) { settled = true; break; }
      await sleep(250);
    }
    result.turnCompletedAfterAnswer = settled;
    console.log(`[user-input] turn completed after answering: ${settled}`);

    const thread = await rpc("thread/read", { threadId });
    result.threadStatus = thread?.thread?.status ?? null;
    console.log(`[user-input] thread status now: ${JSON.stringify(result.threadStatus)}`);
  }
} catch (error) {
  result.error = error.message;
  console.log(`[user-input] error: ${error.message}`);
} finally {
  try {
    await rpc("experimentalFeature/enablement/set", { enablement: { [FEATURE]: false } });
    console.log(`== restored ${FEATURE}=false ==`);
  } catch (error) {
    console.log(`[user-input] could not restore feature: ${error.message}`);
  }
}

console.log("\n=== report ===");
console.log(JSON.stringify(result, null, 2));
process.exit(0);
