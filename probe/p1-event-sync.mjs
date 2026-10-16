// P1 acceptance: does a second client see another client's turn live?
//
// Two independent WebSocket clients attach to the SAME app-server instance the
// bridge hosts. Client A drives turns; client B watches. This is the event-level
// counterpart of E24 (which only proved the in-memory thread list is shared).
//
// Usage: node probe/p1-event-sync.mjs
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
    // Node's built-in WebSocket hands the handler a MessageEvent, not the payload.
    const msg = JSON.parse(String(raw?.data ?? raw));
    if (msg.id != null && pending.has(msg.id)) {
      const cb = pending.get(msg.id);
      pending.delete(msg.id);
      cb(msg);
      return;
    }
    if (msg.method) events.push({ at: Date.now(), method: msg.method, params: msg.params ?? {}, id: msg.id });
  };
  const rpc = (method, params, ms = 30000) => new Promise((resolve) => {
    const id = nextId++;
    const t = setTimeout(() => { pending.delete(id); resolve({ error: "timeout" }); }, ms);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    ws.send(JSON.stringify({ method, id, params }));
  });
  const init = await rpc("initialize", {
    clientInfo: { name: `p1-${label}`, title: `P1 ${label}`, version: "0.1.0" },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  if (!init.result) throw new Error(`${label}: initialize failed: ${JSON.stringify(init.error)}`);
  return { ws, rpc, events, label, close: () => { try { ws.close(); } catch { /* ignore */ } } };
}

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const A = await connect("A");
const B = await connect("B");
console.log("two clients attached to the same instance\n");

async function runTurn(client, prompt, label) {
  const start = await client.rpc("thread/start", { cwd: CWD });
  const threadId = start.result?.thread?.id;
  if (!threadId) throw new Error(`${label}: thread/start failed`);
  const mark = Date.now();
  await client.rpc("turn/start", { threadId, input: [{ type: "text", text: prompt }] });
  return { threadId, mark };
}

// --- 1. the other client must see the turn happen ---------------------------
const first = await runTurn(A, "只回答两个字：收到", "A");
const deadline = Date.now() + 180000;
while (Date.now() < deadline) {
  if (B.events.some((e) => e.method === "turn/completed" && e.params?.threadId === first.threadId)) break;
  await sleep(250);
}
const seenByB = B.events.filter((e) => e.params?.threadId === first.threadId).map((e) => e.method);
const unique = [...new Set(seenByB)];
console.log(`client B observed ${seenByB.length} events for A's turn`);
check("B saw the turn start", unique.includes("turn/started"), true);
check("B saw streamed assistant text", unique.some((m) => m.includes("agentMessage") && m.includes("delta")), true);
check("B saw the turn finish", unique.includes("turn/completed"), true);
check("B saw item lifecycle", unique.includes("item/started") && unique.includes("item/completed"), true);

// --- 2. concurrent threads must not cross-talk ------------------------------
const bEventsBefore = B.events.length;
const [t2, t3] = await Promise.all([
  runTurn(A, "只回答一个字：甲", "A2"),
  runTurn(B, "只回答一个字：乙", "B2"),
]);
const deadline2 = Date.now() + 180000;
while (Date.now() < deadline2) {
  const done = B.events.filter((e) => e.method === "turn/completed").map((e) => e.params?.threadId);
  if (done.includes(t2.threadId) && done.includes(t3.threadId)) break;
  await sleep(250);
}
const after = B.events.slice(bEventsBefore);
const threadIds = [...new Set(after.map((e) => e.params?.threadId).filter(Boolean))];
check("every event carries a thread id", threadIds.every((id) => typeof id === "string" && id.length > 0), true);
check("only the two concurrent threads appear", threadIds.filter((id) => id === t2.threadId || id === t3.threadId).length, threadIds.length);
check("both concurrent turns completed and were seen by B",
  [t2.threadId, t3.threadId].every((id) => after.some((e) => e.method === "turn/completed" && e.params?.threadId === id)), true);

// --- 3. reconnect must re-read real state ----------------------------------
A.close();
B.close();
await sleep(500);
const C = await connect("C");
const list = await C.rpc("thread/list", { limit: 5 });
const ids = (list.result?.data ?? []).map((t) => t.id);
check("a fresh client sees the threads created by the others",
  [first.threadId, t2.threadId, t3.threadId].every((id) => ids.includes(id)), true);
C.close();

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
