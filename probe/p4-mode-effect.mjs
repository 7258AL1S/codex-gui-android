// Does `collaborationMode` actually change behaviour, or is it accepted and
// ignored? E65 showed "accepted" is not the same as "in effect", so this is a
// behavioural A/B: same request to write a file, with and without plan mode.
//
// Plan mode should make Codex plan first instead of acting, so the file should
// NOT appear in the plan case.
//
// Usage: node probe/p4-mode-effect.mjs
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const URL = process.env.WS_URL ?? "ws://127.0.0.1:8901/";
const TOKEN = (process.env.WS_TOKEN ?? readFileSync(join(homedir(), ".codex", "codex-webui", "ws-token"), "utf8")).trim();
const CWD = process.env.SCENARIO_CWD ?? "/data/data/com.termux/files/home/codex-gui";
const PLAN_FILE = join(CWD, "probe", "mode-plan.txt");
const DEFAULT_FILE = join(CWD, "probe", "mode-default.txt");
// Required to be a string (E67). Overridable for a different provider.
const MODEL = process.env.MODEL_ID ?? "deepseek-flash";

for (const file of [PLAN_FILE, DEFAULT_FILE]) if (existsSync(file)) unlinkSync(file);

const ws = new WebSocket(URL, { headers: { Authorization: `Bearer ${TOKEN}` } });
const pending = new Map();
let nextId = 1;
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
  }
};
const rpc = (method, params, ms = 60000) => new Promise((resolve) => {
  const id = nextId++;
  const t = setTimeout(() => { pending.delete(id); resolve({ error: "timeout" }); }, ms);
  pending.set(id, (m) => { clearTimeout(t); resolve(m); });
  ws.send(JSON.stringify({ method, id, params }));
});
await rpc("initialize", {
  clientInfo: { name: "mode-effect", title: "Mode Effect", version: "0.1.0" },
  capabilities: { experimentalApi: true, requestAttestation: false },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(label, targetFile, mode) {
  const start = await rpc("thread/start", { cwd: CWD });
  const threadId = start.result?.thread?.id;
  // The model inside the mode settings must be a STRING: a null was rejected with
  // "invalid type: null, expected a string" (E67), which is why the first attempt
  // at this experiment never ran.
  const extra = mode ? { collaborationMode: { mode, settings: { model: MODEL, reasoning_effort: null, developer_instructions: null } } } : {};
  const turn = await rpc("turn/start", {
    threadId,
    // Ask for an ACTION, not an answer: with a softer prompt the model simply
    // replied and neither arm touched the filesystem, which made the first A/B
    // inconclusive (E67).
    input: [{ type: "text", text: `请运行 shell 命令 \`echo hello > ${targetFile}\`，然后只回一个字：好` }],
    ...extra,
  });
  const accepted = Boolean(turn.result?.turn?.id);
  const rejected = turn.error ? JSON.stringify(turn.error) : null;
  console.log(`[${label}] thread=${threadId} 回合被接受=${accepted}${rejected ? ` 拒绝原因=${rejected}` : ""}`);
  return { threadId, accepted };
}

const plan = await run("plan", PLAN_FILE, "plan");
const normal = await run("default", DEFAULT_FILE, null);

console.log("\n等待两个回合跑完…");
await sleep(60000);

const planWrote = existsSync(PLAN_FILE);
const defaultWrote = existsSync(DEFAULT_FILE);
console.log(`\nplan 模式是否写了文件: ${planWrote}   (期望 false —— 先规划不动手)`);
console.log(`默认模式是否写了文件: ${defaultWrote}   (期望 true)`);
console.log(plan.accepted && normal.accepted && defaultWrote && !planWrote
  ? "\n结论：collaborationMode 确实改变了行为（A/B 有差异）"
  : "\n结论：无法确认模式生效（可能两端行为相同，或都没动手）");

for (const file of [PLAN_FILE, DEFAULT_FILE]) if (existsSync(file)) unlinkSync(file);
try { ws.close(); } catch { /* ignore */ }
process.exit(0);
