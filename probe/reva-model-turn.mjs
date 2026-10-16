// 真机验证：模型能不能真的用上 ReVa（不是"特性开关开着"就算数，见 E130 的教训）。
// 走桥的 /api/rpc 起一个回合，要求模型用 mcp__reva__* 导入一个 ELF 并反编译，然后
// 把回合里出现的工具调用与最终回答打出来。
//
//   node probe/reva-model-turn.mjs [目标二进制] [cwd]
//
// 前置：~/bin/reva-server start 且 app-server 已 reload（见 probe/reva-mcp-live.mjs）。
const BASE = process.env.BRIDGE_URL ?? "http://127.0.0.1:8899";
const TARGET = process.argv[2] ?? "/data/data/com.termux/files/home/tools/reva-test/target";
const CWD = process.argv[3] ?? "/data/data/com.termux/files/home/tools/reva-test";

let seq = 900;
async function rpc(method, params = {}) {
  const res = await fetch(`${BASE}/api/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, id: seq++, params }),
  });
  const body = await res.json();
  if (body.type === "rpc/error") throw new Error(`${method}: ${JSON.stringify(body.error).slice(0, 300)}`);
  return body.result;
}

const prompt = [
  `请用 ReVa 的 MCP 工具（工具名前缀 mcp__reva__）分析本地文件 ${TARGET}`,
  "步骤：(1) import-file 把它导进 Ghidra 项目；(2) analyze-program 分析；(3) get-decompilation 取 add 函数的反编译结果。",
  "最后只回：导入结果、add 的反编译 C 代码片段、以及你实际调用过的工具名列表。不要修改任何文件。",
].join("\n");

const thread = await rpc("thread/start", { cwd: CWD });
const threadId = thread?.thread?.id;
console.log("thread:", threadId);

const turn = await rpc("turn/start", {
  threadId,
  input: [{ type: "text", text: prompt }],
  approvalPolicy: "never",
  sandboxPolicy: { type: "dangerFullAccess" },
});
console.log("turn:", turn?.turn?.id ?? JSON.stringify(turn).slice(0, 200));

const seen = new Set();
const interesting = new Set();
let answer = "";
let status = "unknown";

for (let i = 0; i < 100; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const read = await rpc("thread/read", { threadId, includeTurns: true });
  const turns = read?.thread?.turns ?? [];
  const last = turns[turns.length - 1];
  if (!last) continue;
  status = last.status?.type ?? last.status ?? "unknown";

  for (const item of last.items ?? []) {
    const key = `${item.type}:${item.id ?? JSON.stringify(item).length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = item.type ?? "?";
    if (/mcp/i.test(kind)) {
      const name = item.tool ?? item.name ?? item.server ?? "?";
      interesting.add(String(name));
      console.log(`  [item] ${kind} server=${item.server ?? "?"} tool=${name}`);
    } else if (/agentMessage|reasoning/i.test(kind)) {
      const text = item.text ?? item.content ?? "";
      if (typeof text === "string" && text.trim()) answer = text;
    }
  }
  if (/completed|failed|interrupted/.test(String(status))) break;
}

console.log("turn status:", status);
console.log("MCP 工具调用:", interesting.size ? [...interesting].join(", ") : "（无）");
console.log("最终回答:\n" + (answer || "(空)").slice(0, 2000));
process.exit(interesting.size > 0 ? 0 : 1);
