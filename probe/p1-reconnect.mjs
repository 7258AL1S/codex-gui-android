// P1 acceptance, third item: after a disconnect the client must be able to
// re-read the REAL state — and must NOT resend side-effecting requests.
//
// The dangerous behaviour this guards against: a client that drops mid-turn and
// reconnects, sees no local turn state, and helpfully sends `turn/start` again.
// E49 showed the server does not dedupe, so that would duplicate the user message
// and run the work twice.
//
// What is checked:
//   1. the turn keeps running on the server while we are gone
//   2. after reconnecting we can subscribe and learn it is still running
//   3. we receive the rest of that turn's stream (we did not miss the ending)
//   4. the completed content can be re-read from history
//
// Usage: node probe/p1-reconnect.mjs
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const URL = process.env.WS_URL ?? "ws://127.0.0.1:8901/";
const TOKEN = (process.env.WS_TOKEN ?? readFileSync(join(homedir(), ".codex", "codex-webui", "ws-token"), "utf8")).trim();
const CWD = process.env.SCENARIO_CWD ?? "/data/data/com.termux/files/home/codex-gui";

async function connect(label) {
  const ws = new WebSocket(URL, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const pending = new Map();
  const events = [];
  let nextId = 1;
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error(`${label}: socket error`));
    setTimeout(() => reject(new Error(`${label}: connect timeout`)), 6000);
  });
  ws.onmessage = (raw) => {
    const msg = JSON.parse(String(raw?.data ?? raw));
    if (msg.id != null && pending.has(msg.id)) {
      const cb = pending.get(msg.id);
      pending.delete(msg.id);
      cb(msg);
      return;
    }
    if (msg.method) events.push({ at: Date.now(), method: msg.method, params: msg.params ?? {} });
  };
  const rpc = (method, params, ms = 60000) => new Promise((resolve) => {
    const id = nextId++;
    const t = setTimeout(() => { pending.delete(id); resolve({ error: "timeout" }); }, ms);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    ws.send(JSON.stringify({ method, id, params }));
  });
  const init = await rpc("initialize", {
    clientInfo: { name: `recon-${label}`, title: `Reconnect ${label}`, version: "0.1.0" },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  if (!init.result) throw new Error(`${label}: initialize failed`);
  return { ws, rpc, events, close: () => { try { ws.close(); } catch { /* ignore */ } } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};

// --- 1. start a turn that takes long enough to be interrupted by a drop ----
const A = await connect("A");
const start = await A.rpc("thread/start", { cwd: CWD });
const threadId = start.result?.thread?.id;
const prompt = "请先运行 shell 命令 `sleep 15`，然后只回答两个字：收到";
const startedRes = await A.rpc("turn/start", { threadId, input: [{ type: "text", text: prompt }] });
const turnId = startedRes.result?.turn?.id;
console.log(`thread=${threadId}\nturn=${turnId}（服务端要跑约 15 秒）`);

await sleep(3000);
const runningBefore = A.events.some((e) => e.method === "turn/started");
check("turn had started before the drop", runningBefore, true);

// --- 2. drop the connection hard while the turn is still running -----------
A.close();
console.log("\n--- 连接已断开（回合仍在服务端跑）---");
await sleep(4000);

// --- 3. reconnect and re-read the REAL state ------------------------------
const B = await connect("B");
const resumed = await B.rpc("thread/resume", { threadId });
const thread = resumed.result?.thread ?? null;
const status = thread?.status?.type;
console.log(`重连后 thread/resume -> status=${JSON.stringify(status)}`);
check("reconnect can reopen the thread", Boolean(thread?.id), true);
check("the turn is still running (so a client MUST NOT resend turn/start)", status === "active", true);

// re-reading the turns tells us how far it got
const turns = await B.rpc("thread/turns/list", { threadId, limit: 5, itemsView: "summary" });
const list = turns.result?.data ?? [];
const thisTurn = list.find((t) => t.id === turnId);
check("the in-flight turn is visible in history", Boolean(thisTurn), true);
check("and it is reported as in progress, not finished", thisTurn?.status, "inProgress");
check("still exactly one turn (nothing was duplicated by the reconnect)", list.length, 1);

// --- 4. subscribing again gives us the REST of the stream ------------------
B.events.length = 0;
const until = Date.now() + 90000;
while (Date.now() < until && !B.events.some((e) => e.method === "turn/completed")) await sleep(250);
const seen = [...new Set(B.events.map((e) => e.method))];
console.log(`\n重连后收到的事件: ${seen.join(", ") || "(无)"}`);
check("we still receive the ending of the turn we dropped out of", seen.includes("turn/completed"), true);
check("we still receive streamed assistant text", seen.some((m) => /agentMessage\/delta/.test(m)), true);

// --- 5. the finished content is re-readable --------------------------------
const finalTurns = await B.rpc("thread/turns/list", { threadId, limit: 5, itemsView: "full" });
const finished = (finalTurns.result?.data ?? []).find((t) => t.id === turnId);
const messages = (finished?.items ?? []).filter((i) => i.type === "agentMessage").map((i) => i.text ?? "");
check("the turn finished on the server", finished?.status, "completed");
check("its answer is readable after the fact", messages.join(" ").includes("收到"), true);
check("still exactly one turn at the end (no duplicate work)", (finalTurns.result?.data ?? []).length, 1);

B.close();
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
