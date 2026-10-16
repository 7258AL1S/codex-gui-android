// Read-only probe: connect to the ALREADY RUNNING shared app-server daemon
// through `codex app-server proxy --sock <control.sock>` and inspect real state.
//
// Safety: this script only sends read-only methods. It never starts a turn,
// never approves anything, and never stops the daemon.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const SOCK = process.env.CODEX_CONTROL_SOCK
  ?? join(homedir(), ".codex", "app-server-control-termux", "app-server-control.sock");

const child = spawn("codex", ["app-server", "proxy", "--sock", SOCK], {
  stdio: ["pipe", "pipe", "pipe"],
});

const pending = new Map();
const notifications = [];
let buf = "";
let nextId = 1;

child.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { console.error("[non-json]", line.slice(0, 200)); continue; }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    } else if (msg.method) {
      notifications.push(msg.method);
    }
  }
});
child.stderr.on("data", (d) => console.error("[proxy stderr]", String(d).trimEnd().slice(0, 300)));

function rpc(method, params, timeoutMs = 20000) {
  const id = nextId++;
  return new Promise((resolve) => {
    const t = setTimeout(() => { pending.delete(id); resolve({ method, error: "timeout" }); }, timeoutMs);
    pending.set(id, { resolve: (m) => { clearTimeout(t); resolve({ method, ...m }); } });
    child.stdin.write(JSON.stringify({ method, id, params }) + "\n");
  });
}

const brief = (v, n = 500) => JSON.stringify(v)?.slice(0, n);

const init = await rpc("initialize", {
  clientInfo: { name: "shared-probe", title: "Shared Daemon Probe", version: "0.0.1" },
  capabilities: { experimentalApi: true, requestAttestation: false },
});
console.log("== initialize (via shared daemon) ==");
console.log(brief(init.result ?? init.error, 700));

const threads = await rpc("thread/list", { limit: 5, sortKey: "updated_at", sortDirection: "desc" });
const list = threads.result?.data ?? [];
console.log(`\n== thread/list -> ${list.length} threads ==`);
for (const t of list) {
  console.log(`- ${t.id} | model=${t.model} | provider=${t.modelProvider} | status=${t.status?.type} | cwd=${t.cwd}`);
  console.log(`  preview: ${String(t.preview).slice(0, 70)}`);
}

// Deep-read the most recent thread: turns + item kinds. Read-only.
const target = list[0];
if (target) {
  const turns = await rpc("thread/turns/list", { threadId: target.id, limit: 3 });
  const turnList = turns.result?.data ?? turns.result?.turns ?? [];
  console.log(`\n== thread/turns/list (${target.id}) -> ${turnList.length} turns ==`);
  for (const tn of turnList.slice(-2)) {
    const items = tn.items ?? [];
    console.log(`- turn ${tn.id} status=${tn.status?.type ?? tn.status} items=${items.length}`);
    for (const it of items.slice(0, 8)) {
      console.log(`    item ${it.id} type=${it.type} ${String(it.command ?? it.text ?? it.status ?? "").slice(0, 60)}`);
    }
  }
}

console.log("\n== notifications observed during probe ==");
console.log(notifications.length ? [...new Set(notifications)].join(", ") : "(none)");

child.stdin.end();
setTimeout(() => { child.kill("SIGTERM"); process.exit(0); }, 800);
