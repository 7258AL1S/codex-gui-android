// P2 item 3 — a page that loads late must still be able to answer.
//
// Scenario: an approval is pending, the user reloads (or opens the phone browser
// for the first time). The card was rendered from a live event, so a fresh page
// used to have no way to answer it and the turn waited forever (E32). The bridge
// now keeps the pending requests, and exposes them for exactly this case.
//
// Usage: node probe/p2-pending-requests.mjs
const BASE = process.env.BRIDGE_URL ?? "http://127.0.0.1:8899";
const CWD = process.env.SCENARIO_CWD ?? "/data/data/com.termux/files/home/codex-gui";

let seq = 950;
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
const pendingList = async () => (await (await fetch(`${BASE}/api/requests/pending`)).json()).data;

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
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};

await sleep(400);
check("一开始没有待答请求", (await pendingList()).length, 0);

const start = await rpc("thread/start", { cwd: CWD });
const threadId = start.thread.id;
const mark = Date.now();
await rpc("turn/start", {
  threadId,
  approvalPolicy: "untrusted",
  sandboxPolicy: { type: "readOnly", networkAccess: false },
  input: [{ type: "text", text: "请运行 shell 命令 `echo pending-check`，然后告诉我输出。" }],
});
console.log(`thread=${threadId} 等待审批…`);

let request = null;
const until = Date.now() + 120000;
while (Date.now() < until && !request) {
  const hit = events.find((e) => e.type === "codex/request" && e.at > mark);
  if (hit) request = hit.payload;
  else await sleep(250);
}
if (!request) {
  console.log("没有等到审批请求");
  process.exit(1);
}

// This is what a freshly loaded page would ask for.
const listed = await pendingList();
check("新加载的页面能看到这条待答请求", listed.length, 1);
check("它是同一个 requestId", listed[0]?.id, request.id);
check("并且带着完整参数（够渲染出卡片）", Boolean(listed[0]?.params?.availableDecisions), true);

const offered = (request.params?.availableDecisions ?? []).map((d) => (typeof d === "string" ? d : Object.keys(d)[0]));
const decision = offered.includes("accept") ? "accept" : offered[0];
const answered = await fetch(`${BASE}/api/codex/respond`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ requestId: request.id, result: { decision } }),
});
check("应答被接受", answered.status, 200);

await sleep(800);
check("应答之后待答列表清空", (await pendingList()).length, 0);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
