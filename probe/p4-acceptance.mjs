// P4 acceptance: the exact chain PLAN.md asks for —
// 新建任务 → 流式 → 运行中追加 → 停止 → 继续.
//
// Driven through the bridge API (the same path the browser uses), so this is
// evidence about the real product surface, not about a private harness.
//
// Usage: node probe/p4-acceptance.mjs
const BASE = process.env.BRIDGE_URL ?? "http://127.0.0.1:8899";
const CWD = process.env.SCENARIO_CWD ?? "/data/data/com.termux/files/home/codex-gui";

let seq = 1100;
async function rpc(method, params = {}) {
  const id = seq++;
  const res = await fetch(`${BASE}/api/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, method, params }),
  });
  const body = await res.json();
  if (body.type === "rpc/error") throw new Error(`${method}: ${body.error}`);
  return body.result;
}

const events = [];
fetch(`${BASE}/api/events`).then(async (res) => {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      try { events.push({ at: Date.now(), ...JSON.parse(line.slice(6)) }); } catch { /* ignore */ }
    }
  }
}).catch(() => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const step = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const notes = () => events.filter((e) => e.type === "codex/notification").map((e) => e.payload?.method);
const waitFor = async (predicate, ms, label) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (predicate()) return true;
    await sleep(200);
  }
  console.log(`     （等待超时：${label}）`);
  return false;
};

await sleep(400);

// 1) 新建任务
const start = await rpc("thread/start", { cwd: CWD });
const threadId = start?.thread?.id;
step("新建任务", Boolean(threadId), threadId ?? "");

// 2) 流式（要一个会先思考再作答的回合，好观察逐字输出）
const mark = Date.now();
const turn = await rpc("turn/start", {
  threadId,
  input: [{ type: "text", text: "请先运行 shell 命令 `sleep 10`，然后只回答两个字：收到" }],
});
const turnId = turn?.turn?.id;
step("回合已开始", Boolean(turnId), turnId ?? "");
const streamed = await waitFor(
  () => notes().some((m) => m === "item/agentMessage/delta" || m === "item/reasoning/textDelta"),
  60000,
  "流式增量",
);
step("流式输出", streamed);

// 3) 运行中追加指令
await sleep(1200);
let steered = false;
try {
  await rpc("turn/steer", { threadId, expectedTurnId: turnId, input: [{ type: "text", text: "改成只回答一个字：好" }] });
  steered = true;
} catch (error) {
  console.log(`     steer 失败：${error.message}`);
}
step("运行中追加指令", steered);

// 4) 停止
let interrupted = false;
try {
  await rpc("turn/interrupt", { threadId, turnId });
  interrupted = true;
} catch (error) {
  console.log(`     interrupt 失败：${error.message}`);
}
const settled = await waitFor(() => notes().includes("turn/completed"), 60000, "停止后回合结束");
step("停止", interrupted && settled);

// 5) 继续（在同一会话里再发一个回合，验证停完之后还能接着干）
const mark2 = Date.now();
let continued = false;
try {
  await rpc("turn/start", { threadId, input: [{ type: "text", text: "只回答两个字：继续" }] });
  continued = true;
} catch (error) {
  console.log(`     继续失败：${error.message}`);
}
const finished = await waitFor(
  () => events.some((e) => e.at > mark2 && e.type === "codex/notification" && e.payload?.method === "turn/completed"),
  120000,
  "继续后的回合完成",
);
step("继续", continued && finished);

// 回合历史里应当有两条用户消息 + 该会话仍可读
const turns = await rpc("thread/turns/list", { threadId, limit: 5, itemsView: "summary" });
const list = turns?.data ?? [];
step("会话历史可读且包含两个回合", list.length >= 2, `turns=${list.length}`);

const seen = [...new Set(notes())];
console.log(`\n期间观察到的通知类型: ${seen.filter((m) => m && m !== "bridge/status").slice(0, 12).join(", ")}`);
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
