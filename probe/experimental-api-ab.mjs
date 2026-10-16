// P0 收尾：`initialize.capabilities.experimentalApi` 开/关，到底看得见哪些方法？
//
// PLAN P0 里唯一没做的一条。做法：同一条 app-server 上开两条连接（一条 experimentalApi:true、
// 一条 false），对**同一批候选方法**发请求，比较返回：成功 / 明确的"不支持"。
//
// 注意：这里比较的是"方法是否可调用"，不是"调用是否成功"——很多方法会因为参数不对而报别的错，
// 那不影响可见性判定。判定标准：错误信息里出现 unknown variant / method not found / not supported
// 这类"方法本身不可见"的信号，才算不可见。
//
//   node probe/experimental-api-ab.mjs
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const URL = process.env.WS_URL ?? "ws://127.0.0.1:8901/";
const TOKEN = (process.env.WS_TOKEN ?? readFileSync(join(homedir(), ".codex", "codex-webui", "ws-token"), "utf8")).trim();

// 候选：协议里明确标着 experimental 的、以及老客户端常被拒的那些。
const CANDIDATES = [
  "experimentalFeature/list",
  "experimentalFeature/enablement/set",
  "thread/queue/add",
  "thread/queue/list",
  "gitDiffToRemote",
  "getConversationSummary",
  "host/thread/live",
  "command/exec",
  "review/start",
  "thread/realtime/listVoices",
  "marketplace/add",
  "plugin/list",
  "memory/status",
  "thread/backgroundTerminals/list",
  "thread/search",
];

const INVISIBLE = /unknown variant|unknown method|method not found|not supported|unrecognized|invalid request.*method/i;

async function withConnection(experimentalApi, run) {
  const ws = new WebSocket(URL, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const pending = new Map();
  let id = 1;
  ws.onmessage = (frame) => {
    const message = JSON.parse(String(frame.data));
    const entry = message.id != null ? pending.get(message.id) : null;
    if (entry) {
      pending.delete(message.id);
      entry(message);
    }
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("socket error"));
    setTimeout(() => reject(new Error("connect timeout")), 6000);
  });
  const call = (method, params = {}, timeoutMs = 6000) => new Promise((resolve) => {
    const requestId = id++;
    const timer = setTimeout(() => { pending.delete(requestId); resolve({ timedOut: true }); }, timeoutMs);
    pending.set(requestId, (message) => { clearTimeout(timer); resolve(message); });
    ws.send(JSON.stringify({ id: requestId, method, params }));
  });
  await call("initialize", {
    clientInfo: { name: "ab-probe", title: "AB probe", version: "0.1.0" },
    capabilities: { experimentalApi, requestAttestation: false },
  });
  const result = await run(call);
  ws.close();
  return result;

}

function verdict(message) {
  if (!message) return "no-response";
  if (message.timedOut) return "timeout";
  if (!message.error) return "ok";
  const text = String(message.error.message ?? JSON.stringify(message.error));
  return INVISIBLE.test(text) ? `invisible: ${text.slice(0, 60)}` : `visible-but-arg-error: ${text.slice(0, 60)}`;
}

const on = await withConnection(true, async (call) => {
  const out = {};
  for (const method of CANDIDATES) out[method] = verdict(await call(method, {}));
  return out;
});
const off = await withConnection(false, async (call) => {
  const out = {};
  for (const method of CANDIDATES) out[method] = verdict(await call(method, {}));
  return out;
});

let differences = 0;
console.log("方法".padEnd(38) + "experimentalApi:true".padEnd(30) + "false");
for (const method of CANDIDATES) {
  const same = on[method] === off[method];
  if (!same) differences += 1;
  const short = (value) => (value.length > 28 ? value.slice(0, 27) + "…" : value);
  console.log(method.padEnd(38) + short(on[method]).padEnd(30) + short(off[method]) + (same ? "" : "   ← 不同"));
}
console.log(`\n差异条目：${differences}`);
if (differences) {
  console.log("\n（下面把差异项的完整错误打出来，便于判断是「能力门」还是「参数问题」）");
  for (const method of CANDIDATES) {
    if (on[method] !== off[method]) console.log(`- ${method}\n    true : ${on[method]}\n    false: ${off[method]}`);
  }
}
