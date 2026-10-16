// E49 showed the server does not dedupe identical turn/start calls: the second
// submission is merged into the running turn and the user message is recorded
// twice. TurnStartParams carries a `clientUserMessageId` field — is that the
// protocol's idempotency hook?
//
// Usage: node probe/p1-idempotency.mjs
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const URL = process.env.WS_URL ?? "ws://127.0.0.1:8901/";
const TOKEN = (process.env.WS_TOKEN ?? readFileSync(join(homedir(), ".codex", "codex-webui", "ws-token"), "utf8")).trim();
const CWD = process.env.SCENARIO_CWD ?? "/data/data/com.termux/files/home/codex-gui";

async function connect() {
  const ws = new WebSocket(URL, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const pending = new Map();
  let nextId = 1;
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("socket error"));
    setTimeout(() => reject(new Error("connect timeout")), 6000);
  });
  ws.onmessage = (raw) => {
    const msg = JSON.parse(String(raw?.data ?? raw));
    if (msg.id != null && pending.has(msg.id)) {
      const cb = pending.get(msg.id);
      pending.delete(msg.id);
      cb(msg);
    }
  };
  const rpc = (method, params, ms = 60000) => new Promise((resolve) => {
    const id = nextId++;
    const t = setTimeout(() => { pending.delete(id); resolve({ error: "timeout" }); }, ms);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    ws.send(JSON.stringify({ method, id, params }));
  });
  await rpc("initialize", {
    clientInfo: { name: "idem", title: "Idempotency", version: "0.1.0" },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  return { rpc, close: () => { try { ws.close(); } catch { /* ignore */ } } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const client = await connect();

async function countMessages(threadId, needle) {
  const res = await client.rpc("thread/turns/list", { threadId, limit: 10, itemsView: "full" });
  const hits = [];
  for (const turn of res.result?.data ?? []) {
    for (const item of turn.items ?? []) {
      if (item.type !== "userMessage") continue;
      for (const c of item.content ?? []) {
        if (c && c.type === "text" && String(c.text).includes(needle)) hits.push({ turn: turn.id, text: c.text });
      }
    }
  }
  return hits;
}

// --- control: two identical submits, no idempotency key (E49 baseline) -----
const controlText = "只回答一个字：甲";
const t1 = await client.rpc("thread/start", { cwd: CWD });
const controlThread = t1.result?.thread?.id;
await client.rpc("turn/start", { threadId: controlThread, input: [{ type: "text", text: controlText }] });
await client.rpc("turn/start", { threadId: controlThread, input: [{ type: "text", text: controlText }] });
await sleep(15000);
const control = await countMessages(controlThread, "甲");
console.log(`[控制组] 无幂等键，重复提交 -> 用户消息条数 = ${control.length}（E49 观察到 2）`);

// --- experiment: same key on both submits ---------------------------------
const keyText = "只回答一个字：乙";
const messageId = `probe-${Date.now()}`;
const t2 = await client.rpc("thread/start", { cwd: CWD });
const keyedThread = t2.result?.thread?.id;
const first = await client.rpc("turn/start", {
  threadId: keyedThread,
  clientUserMessageId: messageId,
  input: [{ type: "text", text: keyText }],
});
const second = await client.rpc("turn/start", {
  threadId: keyedThread,
  clientUserMessageId: messageId,
  input: [{ type: "text", text: keyText }],
});
console.log(`[实验组] 两次都带同一个 clientUserMessageId=${messageId}`);
console.log(`         第一次: ${first.result?.turn?.id ?? JSON.stringify(first.error)}`);
console.log(`         第二次: ${second.result?.turn?.id ?? JSON.stringify(second.error)}`);
await sleep(15000);
const keyed = await countMessages(keyedThread, "乙");
console.log(`[实验组] 用户消息条数 = ${keyed.length}`);

console.log("\n=== 结论 ===");
console.log(JSON.stringify({
  controlMessagesWithoutKey: control.length,
  keyedMessagesWithSameKey: keyed.length,
  sameTurnIdReturned: Boolean(first.result?.turn?.id && first.result?.turn?.id === second.result?.turn?.id),
  deduped: keyed.length === 1 && control.length > 1,
}, null, 2));

client.close();
process.exit(0);
