// Talk straight to the app-server, bypassing the bridge's browser allowlist.
//
// Useful for discovering methods the generated types do not describe — the
// runtime is the authority (E29, E59), and a serde error usually names the field
// it wanted. Requires the capability token file.
//
//   node probe/raw-rpc.mjs <method> ['<json params>']
//   node probe/raw-rpc.mjs thread/settings/update '{}'
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const URL = process.env.WS_URL ?? "ws://127.0.0.1:8901/";
const TOKEN = (process.env.WS_TOKEN ?? readFileSync(join(homedir(), ".codex", "codex-webui", "ws-token"), "utf8")).trim();
const [method, rawParams] = process.argv.slice(2);
if (!method) {
  console.error("用法: node probe/raw-rpc.mjs <method> ['<json params>']");
  process.exit(2);
}
const params = rawParams ? JSON.parse(rawParams) : {};

const ws = new WebSocket(URL, { headers: { Authorization: `Bearer ${TOKEN}` } });
const pending = new Map();
let nextId = 1;
const notifications = [];

await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error("socket error"));
  setTimeout(() => reject(new Error("timeout")), 6000);
});

ws.onmessage = (raw) => {
  const msg = JSON.parse(String(raw?.data ?? raw));
  if (msg.id != null && pending.has(msg.id)) {
    const cb = pending.get(msg.id);
    pending.delete(msg.id);
    cb(msg);
    return;
  }
  if (msg.method) notifications.push(msg);
};

const rpc = (name, args, ms = 15000) => new Promise((resolve) => {
  const id = nextId++;
  const t = setTimeout(() => { pending.delete(id); resolve({ error: "timeout" }); }, ms);
  pending.set(id, (m) => { clearTimeout(t); resolve(m); });
  ws.send(JSON.stringify({ method: name, id, params: args }));
});

await rpc("initialize", {
  clientInfo: { name: "raw-rpc", title: "Raw RPC", version: "0.1.0" },
  capabilities: { experimentalApi: true, requestAttestation: false },
});

// RAW_CHAIN='[["thread/resume",{"threadId":"x"}],["turn/start",{...}]]' runs several
// calls on ONE connection. This matters: the app-server unloads a thread once no
// client holds it, so "resume here, act there" fails with `thread not found`.
const chain = process.env.RAW_CHAIN ? JSON.parse(process.env.RAW_CHAIN) : null;
if (chain) {
  for (const [name, args] of chain) {
    const res = await rpc(name, args);
    console.log(`--- ${name}: ${res.error ? `ERROR ${JSON.stringify(res.error)}` : (JSON.stringify(res.result) ?? "null").slice(0, 500)}`);
  }
} else {
  const answer = await rpc(method, params);
  if (answer.error) {
    console.log(`ERROR: ${typeof answer.error === "string" ? answer.error : JSON.stringify(answer.error)}`);
  } else {
    // RAW_LIMIT=0 prints everything (handy when hunting for one field).
    const limit = Number(process.env.RAW_LIMIT ?? 1500);
    const text = JSON.stringify(answer.result, null, 1) ?? "";
    console.log(limit > 0 ? text.slice(0, limit) : text);
  }
}
if (notifications.length) {
  console.log(`\n(期间收到 ${notifications.length} 条通知: ${[...new Set(notifications.map((n) => n.method))].join(", ")})`);
}
try { ws.close(); } catch { /* ignore */ }
process.exit(0);
