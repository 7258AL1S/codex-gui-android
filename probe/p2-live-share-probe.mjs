// P1 architecture test, client side.
// Connects to the bridge-hosted app-server over WebSocket and:
//   1) reports whether a second concurrent client sees the same live state
//   2) creates a thread (no model turn -> no token cost)
//
// Usage: WS_TOKEN=... node p2-live-share-probe.mjs [--create]
const URL = process.env.WS_URL ?? "ws://127.0.0.1:8891";
const TOKEN = process.env.WS_TOKEN ?? "";
const create = process.argv.includes("--create");

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const pending = new Map();
    let nextId = 1;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p(msg); }
    };
    ws.onerror = () => reject(new Error("ws error"));
    ws.onopen = async () => {
      const rpc = (method, params, ms = 20000) => new Promise((res) => {
        const id = nextId++;
        const t = setTimeout(() => { pending.delete(id); res({ method, error: "timeout" }); }, ms);
        pending.set(id, (m) => { clearTimeout(t); res({ method, ...m }); });
        ws.send(JSON.stringify({ method, id, params }));
      });
      resolve({ ws, rpc });
    };
  });
}

const label = process.env.CLIENT_LABEL ?? "probe";
const { ws, rpc } = await connect();

const init = await rpc("initialize", {
  clientInfo: { name: `p2-${label}`, title: `P2 ${label}`, version: "0.1.0" },
  capabilities: { experimentalApi: true, requestAttestation: false },
});
console.log(`[${label}] initialize:`, init.result?.userAgent ? "ok" : JSON.stringify(init.error));

if (create) {
  const t = await rpc("thread/start", {
    cwd: "/data/data/com.termux/files/home/codex-gui",
    modelProvider: process.env.MODEL_PROVIDER ?? null,
  });
  console.log(`[${label}] thread/start:`, t.result?.thread?.id ?? JSON.stringify(t.result ?? t.error).slice(0, 300));
}

const loaded = await rpc("thread/loaded/list", {});
console.log(`[${label}] thread/loaded/list:`, JSON.stringify(loaded.result).slice(0, 400));

const list = await rpc("thread/list", { limit: 5 });
const data = list.result?.data ?? [];
console.log(`[${label}] thread/list: ${data.length} threads`);
for (const t of data.slice(0, 5)) {
  console.log(`   - ${t.id} status=${t.status?.type} model=${t.model} preview=${String(t.preview).slice(0, 40)}`);
}

ws.close();
setTimeout(() => process.exit(0), 200);
