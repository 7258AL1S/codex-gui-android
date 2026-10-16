// P1 acceptance: two clients on one instance, overlapping writes, repeated
// submissions. Does the server keep them apart, or do we get duplicated turns?
//
// Precondition learned from E47: a client only receives a thread's events after
// it has opened (resumed) that thread, so both clients subscribe first.
//
// Usage: node probe/p1-concurrency.mjs
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
    clientInfo: { name: `conc-${label}`, title: `Concurrency ${label}`, version: "0.1.0" },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  if (!init.result) throw new Error(`${label}: initialize failed`);
  return { rpc, events, close: () => { try { ws.close(); } catch { /* ignore */ } } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const A = await connect("A");
const B = await connect("B");

const text = (turn) => (turn.items ?? []).flatMap((it) => it.content ?? [])
  .filter((c) => c && c.type === "text").map((c) => c.text).join(" ");

async function turnsOf(threadId) {
  const res = await A.rpc("thread/turns/list", { threadId, limit: 20, itemsView: "summary" });
  return res.result?.data ?? [];
}

// --- set up a persisted thread both clients can subscribe to ---------------
const start = await A.rpc("thread/start", { cwd: CWD });
const threadId = start.result?.thread?.id;
await A.rpc("turn/start", { threadId, input: [{ type: "text", text: "只回答一个字：一" }] });
{
  const until = Date.now() + 150000;
  while (Date.now() < until && !A.events.some((e) => e.method === "turn/completed")) await sleep(250);
}
const bResume = await B.rpc("thread/resume", { threadId });
console.log(`thread=${threadId}  A subscribed=yes  B subscribed=${Boolean(bResume.result?.thread?.id)}`);

const baseline = (await turnsOf(threadId)).length;
console.log(`baseline turns: ${baseline}`);

// --- 1. two clients submit into the SAME thread at the same moment ---------
const both = "只回答一个字：二";
const [ra, rb] = await Promise.all([
  A.rpc("turn/start", { threadId, input: [{ type: "text", text: both }] }),
  B.rpc("turn/start", { threadId, input: [{ type: "text", text: both }] }),
]);
const accepted = [ra, rb].filter((r) => r.result?.turn?.id).length;
const rejected = [ra, rb].filter((r) => r.error).map((r) => r.error);
console.log(`\n[1] simultaneous turn/start from A and B: accepted=${accepted} rejected=${JSON.stringify(rejected)}`);
await sleep(12000);
const afterBoth = await turnsOf(threadId);
const dupTurns = afterBoth.filter((t) => text(t).includes(both)).length;
console.log(`    turns carrying that text afterwards: ${dupTurns} (turns total ${afterBoth.length})`);

// --- 2. one client fires the same turn/start twice without waiting ---------
const mark = afterBoth.length;
const twice = "只回答一个字：三";
const p1 = A.rpc("turn/start", { threadId, input: [{ type: "text", text: twice }] });
const p2 = A.rpc("turn/start", { threadId, input: [{ type: "text", text: twice }] });
const [r1, r2] = await Promise.all([p1, p2]);
const okTwice = [r1, r2].filter((r) => r.result?.turn?.id).length;
console.log(`\n[2] duplicate submit from one client: accepted=${okTwice} errors=${JSON.stringify([r1, r2].filter((r) => r.error).map((r) => r.error))}`);
await sleep(12000);
const afterDup = await turnsOf(threadId);
const dupCount = afterDup.filter((t) => text(t).includes(twice)).length;
console.log(`    turns carrying that text: ${dupCount} (expected 1 if the server dedupes)`);

console.log("\n=== summary ===");
console.log(JSON.stringify({
  threadId,
  simultaneousAccepted: accepted,
  simultaneousRejected: rejected,
  turnsForSimultaneousText: dupTurns,
  duplicateSubmitAccepted: okTwice,
  turnsForDuplicateText: dupCount,
  turnsBefore: baseline,
  turnsAfter: afterDup.length,
  note: "accepted>1 或 turns>1 表示服务端不做去重，客户端必须自己防重复提交",
}, null, 2));

A.close();
B.close();
process.exit(0);
