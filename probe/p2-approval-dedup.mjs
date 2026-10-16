// P2 item 2, end to end: a real approval request, answered twice.
//
// The bridge fans one request out to every client, so two browser tabs (or the
// same tab double-clicked, or a late answer) can both try to decide it. The
// second answer must be refused at the bridge rather than forwarded into a
// request id the server has already resolved.
//
// Usage: node probe/p2-approval-dedup.mjs
const BASE = process.env.BRIDGE_URL ?? "http://127.0.0.1:8899";
const CWD = process.env.SCENARIO_CWD ?? "/data/data/com.termux/files/home/codex-gui";

let seq = 900;
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

async function respond(requestId, result) {
  const res = await fetch(`${BASE}/api/codex/respond`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId, result }),
  });
  let body = null;
  try { body = await res.json(); } catch { /* empty */ }
  return { status: res.status, body };
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
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};

await sleep(400);

// Force an approval: read-only sandbox + untrusted policy means a command has to
// be granted explicitly (the user's own config is danger-full-access + never).
const start = await rpc("thread/start", { cwd: CWD });
const threadId = start.thread.id;
const mark = Date.now();
await rpc("turn/start", {
  threadId,
  approvalPolicy: "untrusted",
  sandboxPolicy: { type: "readOnly", networkAccess: false },
  input: [{ type: "text", text: "请运行 shell 命令 `echo hello-dedup`，然后把输出告诉我。" }],
});
console.log(`thread=${threadId} 等待审批请求…`);

let request = null;
const until = Date.now() + 120000;
while (Date.now() < until && !request) {
  const hit = events.find((e) => e.type === "codex/request" && e.at > mark);
  if (hit) request = hit.payload;
  else await sleep(250);
}
if (!request) {
  console.log("没有等到审批请求（可能模型没执行命令）");
  process.exit(1);
}
console.log(`收到 ${request.method}（requestId=${request.id}）`);
const offered = (request.params?.availableDecisions ?? []).map((d) => (typeof d === "string" ? d : Object.keys(d)[0]));
const decision = offered.includes("accept") ? "accept" : offered[0];

const first = await respond(request.id, { decision });
console.log(`\n第一个客户端应答 ${JSON.stringify({ decision })} -> HTTP ${first.status} ${JSON.stringify(first.body)}`);
check("第一个应答被接受", first.status, 200);

const second = await respond(request.id, { decision });
console.log(`第二个客户端应答同一 requestId -> HTTP ${second.status} ${JSON.stringify(second.body)}`);
check("第二个应答被拒绝", second.status >= 400, true);
check("错误信息说明原因", /已被处理|已失效|already/i.test(JSON.stringify(second.body ?? "")), true);

// A late answer after the server resolved the request must be refused too.
await sleep(1500);
const third = await respond(request.id, { decision });
check("服务端已 resolved 之后的迟到应答同样被拒", third.status >= 400, true);

const resolvedSeen = events.some((e) => e.type === "codex/notification" && e.payload?.method === "serverRequest/resolved");
console.log(`\nSSE 里观察到 serverRequest/resolved: ${resolvedSeen}`);
check("服务端确实发出了 resolved 通知", resolvedSeen, true);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
