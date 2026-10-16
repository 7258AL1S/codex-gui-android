// Does enabling the request_user_input tool via config make the model ask a
// question? Runs against a THROWAWAY app-server on its own port so the running
// bridge (and any CLI sessions attached to it) is untouched.
// Usage: node probe/user-input-config-probe.mjs
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PORT = 8907;
const CWD = process.env.SCENARIO_CWD ?? "/data/data/com.termux/files/home/codex-gui";
const tokenPath = join(tmpdir(), `ui-probe-token-${process.pid}`);
const token = `probe-${process.pid}-${Date.now()}`;
writeFileSync(tokenPath, token + "\n", { mode: 0o600 });

const child = spawn("codex", [
  "app-server",
  "--listen", `ws://127.0.0.1:${PORT}`,
  "--ws-auth", "capability-token",
  "--ws-token-file", tokenPath,
  "-c", "tools.experimental_request_user_input=true",
], { stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", (d) => process.stdout.write("[server] " + String(d)));
child.stderr.on("data", (d) => process.stdout.write("[server:err] " + String(d)));

const cleanup = (code = 0) => { try { child.kill("SIGTERM"); } catch {} setTimeout(() => process.exit(code), 400); };

await new Promise((r) => setTimeout(r, 3500));

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`, { headers: { Authorization: `Bearer ${token}` } });
const pending = new Map();
const seen = [];
let nextId = 1;

const rpc = (method, params, ms = 30000) => new Promise((resolve) => {
  const id = nextId++;
  const t = setTimeout(() => { pending.delete(id); resolve({ error: "timeout" }); }, ms);
  pending.set(id, (m) => { clearTimeout(t); resolve(m); });
  ws.send(JSON.stringify({ method, id, params }));
});

ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.id != null && pending.has(msg.id)) { const cb = pending.get(msg.id); pending.delete(msg.id); cb(msg); return; }
  if (msg.method) seen.push({ method: msg.method, params: msg.params });
  if (msg.method === "item/tool/requestUserInput") {
    console.log("*** requestUserInput RECEIVED ***");
    console.log(JSON.stringify(msg.params, null, 2).slice(0, 1200));
    const answers = {};
    for (const q of msg.params?.questions ?? []) {
      answers[q.id] = (q.options ?? []).length ? [q.options[0].label] : ["先做能跑通的版本"];
    }
    ws.send(JSON.stringify({ id: msg.id, result: { answers } }));
    console.log("answered:", JSON.stringify({ answers }));
  }
};

await new Promise((resolve) => { ws.onopen = resolve; setTimeout(resolve, 5000); });

const init = await rpc("initialize", {
  clientInfo: { name: "ui-probe", title: "UI Probe", version: "0.1.0" },
  capabilities: { experimentalApi: true, requestAttestation: false },
});
console.log("initialize:", init.result ? "ok" : JSON.stringify(init.error).slice(0, 200));

const start = await rpc("thread/start", { cwd: CWD });
const threadId = start.result?.thread?.id;
console.log("thread/start:", threadId ?? JSON.stringify(start.error).slice(0, 200));

await rpc("turn/start", {
  threadId,
  input: [{
    type: "text",
    text: "我想做一个手机端界面。动手前请先用 request_user_input 工具问我一个必须澄清的问题（给 2 个选项，并允许自由输入），然后停下等我的回答。",
  }],
});

const deadline = Date.now() + 120000;
while (Date.now() < deadline && !seen.some((e) => e.method === "item/tool/requestUserInput")) {
  await new Promise((r) => setTimeout(r, 500));
}

const methods = [...new Set(seen.map((e) => e.method))];
console.log("\nobserved methods:", methods.join(", "));
console.log("requestUserInput seen:", seen.some((e) => e.method === "item/tool/requestUserInput"));

// what did the model say?
const turns = await rpc("thread/turns/list", { threadId, limit: 1, itemsView: "full" });
for (const turn of turns.result?.data ?? []) {
  for (const item of turn.items ?? []) {
    if (item.type === "agentMessage") console.log("model said:", String(item.text).slice(0, 400));
  }
}

try { ws.close(); } catch { /* ignore */ }
cleanup(0);
