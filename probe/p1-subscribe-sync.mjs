// Does a second client see another client's turn — and does it need to subscribe?
//
// probe/p1-event-sync.mjs showed client B receiving only 2 events while A ran a
// turn, which suggests the app-server only streams a thread's events to clients
// that have that thread open. Here B calls thread/resume (what the web UI does
// when you open a thread) and then watches.
//
// Usage: node probe/p1-subscribe-sync.mjs
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
  const rpc = (method, params, ms = 30000) => new Promise((resolve) => {
    const id = nextId++;
    const t = setTimeout(() => { pending.delete(id); resolve({ error: "timeout" }); }, ms);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    ws.send(JSON.stringify({ method, id, params }));
  });
  const init = await rpc("initialize", {
    clientInfo: { name: `sub-${label}`, title: `Sub ${label}`, version: "0.1.0" },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  if (!init.result) throw new Error(`${label}: initialize failed: ${JSON.stringify(init.error)}`);
  return { rpc, events, close: () => { try { ws.close(); } catch { /* ignore */ } } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};

const A = await connect("A");
const B = await connect("B");

const start = await A.rpc("thread/start", { cwd: CWD });
const threadId = start.result?.thread?.id;
console.log(`thread = ${threadId}`);

// A brand-new thread is not persisted yet, and resuming it by id fails
// ("thread not found") — the same thing that bit us in E36. So let turn 1 finish
// first (that is what persists the rollout), then have B open the thread and
// watch turn 2.
await A.rpc("turn/start", { threadId, input: [{ type: "text", text: "只回答两个字：收到" }] });
{
  const until = Date.now() + 150000;
  while (Date.now() < until && !A.events.some((e) => e.method === "turn/completed" && e.params?.threadId === threadId)) {
    await sleep(250);
  }
}
console.log("turn 1 finished (thread is now persisted)");

// B "opens" the thread the way the UI does before it can watch it.
const resumed = await B.rpc("thread/resume", { threadId });
if (!resumed.result?.thread?.id) console.log("resume error:", JSON.stringify(resumed.error));
check("B can open the thread", Boolean(resumed.result?.thread?.id), true);

B.events.length = 0; // only judge what B sees after subscribing
await A.rpc("turn/start", { threadId, input: [{ type: "text", text: "再回两个字：收到" }] });

const deadline = Date.now() + 150000;
while (Date.now() < deadline && !B.events.some((e) => e.method === "turn/completed" && e.params?.threadId === threadId)) {
  await sleep(250);
}

const seen = [...new Set(B.events.map((e) => e.method))];
console.log(`\nB observed for that thread: ${seen.join(", ") || "(nothing)"}`);
check("B saw the turn start", seen.includes("turn/started"), true);
check("B saw streamed agent text", seen.some((m) => /agentMessage\/delta|item\/agentMessage/.test(m)), true);
check("B saw the turn finish", seen.includes("turn/completed"), true);

A.close();
B.close();
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
