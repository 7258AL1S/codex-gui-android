// End-to-end scenario runner against the local bridge (acceptance list #1 and #3).
//
//   node probe/e2e-scenario.mjs            # run every phase
//   node probe/e2e-scenario.mjs stream     # only the streaming phase
//
// Phases:
//   stream  - thread/start -> turn/start -> streamed answer -> turn/completed
//   steer   - long-running turn -> turn/steer (append) -> turn/interrupt (stop)
//   approve - turn requiring a command with approvalPolicy=on-request
//             -> observe the server->client approval request -> decline it
const BASE = process.env.BRIDGE_URL ?? "http://127.0.0.1:8899";
const CWD = process.env.SCENARIO_CWD ?? "/data/data/com.termux/files/home/codex-gui";
const want = new Set(process.argv.slice(2).filter((a) => !a.startsWith("-")));
const runAll = want.size === 0;
const should = (name) => runAll || want.has(name);

let rpcSeq = 100;
const events = [];

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

function startEventStream() {
  const controller = new AbortController();
  fetch(`${BASE}/api/events`, { signal: controller.signal })
    .then(async (res) => {
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
    })
    .catch(() => {});
  return controller;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const notifications = () => events.filter((e) => e.type === "codex/notification");
const requests = () => events.filter((e) => e.type === "codex/request");
const methods = () => notifications().map((e) => e.payload?.method);
const tid = () => `t${Date.now()}`;

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  for (;;) {
    const hit = predicate();
    if (hit) return { hit, ms: Date.now() - started };
    if (Date.now() - started > timeoutMs) return { hit: null, ms: Date.now() - started, timeout: true, label };
    await sleep(120);
  }
}

const stream = startEventStream();
await sleep(400);
const report = {};

// ---------------------------------------------------------------------------
if (should("stream")) {
  const start = await rpc("thread/start", { cwd: CWD });
  const threadId = start?.thread?.id;
  console.log(`[stream] thread/start -> ${threadId}`);
  const mark = Date.now();
  const turn = await rpc("turn/start", {
    threadId,
    input: [{ type: "text", text: "只回答一行：你好，我是 Codex。" }],
  });
  const turnId = turn?.turn?.id ?? turn?.turnId;
  console.log(`[stream] turn/start  -> ${turnId}`);
  const done = await waitFor(
    () => notifications().some((e) => e.payload?.method === "turn/completed" && e.at > mark),
    180000,
    "turn/completed",
  );
  const firstDelta = notifications().find((e) => e.at > mark && /Delta/.test(e.payload?.method ?? ""));
  report.stream = {
    threadId,
    completed: Boolean(done.hit),
    ms: done.ms,
    firstDeltaMs: firstDelta ? firstDelta.at - mark : null,
    methods: [...new Set(methods().slice())].filter((m) => m && m !== "bridge/status"),
  };
  console.log(`[stream] completed=${report.stream.completed} in ${done.ms}ms; first delta at ${report.stream.firstDeltaMs}ms`);
}

// ---------------------------------------------------------------------------
if (should("steer")) {
  const start = await rpc("thread/start", { cwd: CWD });
  const threadId = start?.thread?.id;
  const mark = Date.now();
  const turn = await rpc("turn/start", {
    threadId,
    input: [{ type: "text", text: "请先运行 `sleep 20`，然后只回答 done。" }],
  });
  const turnId = turn?.turn?.id ?? turn?.turnId;
  console.log(`[steer]  thread=${threadId} turn=${turnId}`);
  await waitFor(() => notifications().some((e) => e.at > mark && e.payload?.method === "turn/started"), 20000, "turn/started");
  // turn/steer requires `expectedTurnId` and turn/interrupt requires `turnId`;
  // both must come from the live turn, not be guessed (VERIFICATION.md E29).
  const activeTurnId = turnId
    ?? notifications().find((e) => e.at > mark && e.payload?.method === "turn/started")?.payload?.params?.turnId
    ?? null;
  await sleep(1500);
  let steerOk = false;
  try {
    await rpc("turn/steer", {
      threadId,
      expectedTurnId: activeTurnId,
      input: [{ type: "text", text: "算了，别跑了，直接回答 ok。" }],
    });
    steerOk = true;
  } catch (error) { console.log(`[steer]  steer error: ${error.message}`); }
  await sleep(1200);
  let interruptOk = false;
  try {
    await rpc("turn/interrupt", { threadId, turnId: activeTurnId });
    interruptOk = true;
  } catch (error) { console.log(`[steer]  interrupt error: ${error.message}`); }
  const stopped = await waitFor(
    () => notifications().some((e) => e.at > mark && e.payload?.method === "turn/completed"),
    60000,
    "turn/completed after interrupt",
  );
  report.steer = { threadId, activeTurnId, steerOk, interruptOk, completedAfterInterrupt: Boolean(stopped.hit), ms: stopped.ms };
  console.log(`[steer]  steer=${steerOk} interrupt=${interruptOk} settled=${Boolean(stopped.hit)}`);
}

// ---------------------------------------------------------------------------
if (should("approve")) {
  // The user's config is sandbox_mode=danger-full-access + approval_policy=never,
  // so nothing ever needs escalation. Override per turn to force the approval
  // path: a read-only sandbox plus an untrusted approval policy means writing a
  // file has to be granted explicitly.
  const start = await rpc("thread/start", { cwd: CWD });
  const threadId = start?.thread?.id;
  const mark = Date.now();
  await rpc("turn/start", {
    threadId,
    approvalPolicy: "untrusted",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    input: [{ type: "text", text: `请把文本 hello 写入文件 ${CWD}/probe/approval-test.txt，然后确认。` }],
  });
  console.log(`[approve] thread=${threadId} waiting for an approval request…`);
  const seen = await waitFor(() => requests().find((e) => e.at > mark), 120000, "server request");
  if (!seen.hit) {
    report.approve = { threadId, requestSeen: false, note: "no server->client request observed within timeout" };
    console.log("[approve] no approval request observed");
  } else {
    const req = seen.hit.payload;
    console.log(`[approve] request method = ${req.method}`);
    console.log(`[approve] params keys   = ${Object.keys(req.params ?? {}).join(", ")}`);
    console.log(`[approve] full params   =`);
    console.log(JSON.stringify(req.params ?? {}, null, 2).slice(0, 2000));
    // Never invent a decision: only reply with a value the server listed.
    const offered = (req.params?.availableDecisions ?? []).map((d) => (typeof d === "string" ? d : Object.keys(d)[0]));
    const wanted = process.env.DECISION ?? "decline";
    const chosen = offered.includes(wanted) ? wanted : offered.includes("accept") ? "accept" : offered[0];
    const decision = { decision: chosen };
    console.log(`[approve] offered decisions = ${JSON.stringify(offered)} -> choosing ${JSON.stringify(chosen)}`);
    const res = await fetch(`${BASE}/api/codex/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: req.id, result: decision }),
    });
    report.approve = {
      threadId,
      requestSeen: true,
      method: req.method,
      paramKeys: Object.keys(req.params ?? {}),
      availableDecisions: req.params?.availableDecisions ?? null,
      command: req.params?.command ?? null,
      commandActions: req.params?.commandActions ?? null,
      proposedExecpolicyAmendment: req.params?.proposedExecpolicyAmendment ?? null,
      decidedWith: decision,
      respondStatus: res.status,
    };
    console.log(`[approve] responded ${JSON.stringify(decision)} -> HTTP ${res.status}`);
    await sleep(6000);
    const after = notifications().filter((e) => e.at > seen.hit.at).map((e) => e.payload?.method);
    report.approve.eventsAfterDecision = [...new Set(after)];
    report.approve.settled = after.includes("turn/completed");
    console.log(`[approve] after decline: settled=${report.approve.settled}`);
    console.log(`[approve] subsequent methods: ${report.approve.eventsAfterDecision.join(", ")}`);
  }
}

stream.abort();
console.log("\n=== report ===");
console.log(JSON.stringify(report, null, 2));
process.exit(0);
