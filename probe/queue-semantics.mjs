// P4 遗留项：排队到底"挂不挂得住"——运行中排队的消息，是**等回合结束才跑**，还是被立刻塞进去？
//
// PLAN P4 原文：「『回合运行中排队 → 真的挂住、等结束才跑』这条路径**仍未实测**」。
// 这里用一次真实回合验三件事：
//   1. 回合运行中 `thread/queue/add` → `thread/queue/list` 里能看到它（排队成立）；
//   2. 运行期间**不会**多出第二个回合（没被立刻当新回合跑掉）；
//   3. 回合结束后它自己变成一个新回合（顺序对、内容对），队列清空。
//
// 会花掉两个短回合。测试会话结束后删除。
//
//   node probe/queue-semantics.mjs
let seq = 1;
const rpc = async (method, params) => {
  const response = await fetch("http://127.0.0.1:8899/api/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: seq++, method, params }),
  });
  const data = await response.json();
  if (data.type !== "rpc/result") throw new Error(`${method}: ${JSON.stringify(data).slice(0, 160)}`);
  return data.result;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : `  <- ${detail}`}`);
};
const MARK = `QUEUED-${Date.now().toString(36).toUpperCase()}`;

const start = await rpc("thread/start", { cwd: process.env.HOME });
const threadId = start?.thread?.id;
console.log("测试会话:", threadId, "排队标记:", MARK);

const turnOf = async () => {
  const listed = await rpc("thread/turns/list", { threadId });
  return listed?.data || [];
};

await rpc("turn/start", {
  threadId,
  input: [{ type: "text", text: "先运行 shell 命令 `sleep 20`（必须等它跑完），然后只回复：第一回合完成" }],
});
await sleep(6000);
const during = await turnOf();
check("回合确实在跑（此刻只有 1 个回合）", during.length === 1, `turns=${during.length}`);
check("回合状态是进行中", during[0]?.status === "inProgress", String(during[0]?.status));

// 协议要求 clientUserMessageId（E73 踩过：少了它直接 "missing field"）
const queued = await rpc("thread/queue/add", { threadId, clientUserMessageId: `probe-${MARK}`, input: [{ type: "text", text: `请只回复这一行：${MARK}` }] });
check("queue/add 被接受", Boolean(queued), JSON.stringify(queued).slice(0, 120));
const queue = await rpc("thread/queue/list", { threadId });
const queueItems = queue?.data || queue?.items || [];
check("排队出现在 queue/list 里", queueItems.length === 1, JSON.stringify(queueItems).slice(0, 160));

await sleep(4000);
const stillOne = await turnOf();
check("运行期间没有立刻变成新回合（还是 1 个）", stillOne.length === 1, `turns=${stillOne.length}`);

// 等第一个回合结束 + 排队项跑完
let turns = [];
for (let attempt = 0; attempt < 60; attempt += 1) {
  await sleep(2000);
  turns = await turnOf();
  const done = turns.length >= 2 && turns.every((turn) => turn.status === "completed");
  if (done) break;
}
check("回合结束后排队项变成了第 2 个回合", turns.length >= 2, `turns=${turns.length}`);

const detail = await rpc("thread/read", { threadId, includeTurns: true });
const items = (detail?.thread?.turns || []).flatMap((turn) => turn.items || []);
const queuedMessage = items.find((item) => item.type === "userMessage" && JSON.stringify(item).includes(MARK));
check("第 2 个回合的内容就是排队那一条", Boolean(queuedMessage), JSON.stringify(items.filter((i) => i.type === "userMessage").map((i) => JSON.stringify(i.content).slice(0, 60))));
const order = items.filter((item) => item.type === "userMessage").map((item) => JSON.stringify(item.content));
check("顺序正确（先第一回合的任务，再排队项）", order.length >= 2 && order[0].includes("sleep 20") && order[1].includes(MARK), JSON.stringify(order.map((o) => o.slice(0, 40))));

const queueAfter = await rpc("thread/queue/list", { threadId });
check("跑完后队列已清空", (queueAfter?.data || queueAfter?.items || []).length === 0, JSON.stringify(queueAfter).slice(0, 120));

console.log(`\n清理：删除测试会话 ${threadId}`);
await rpc("thread/delete", { threadId });
console.log(failures ? `${failures} FAILED` : "ALL PASS");
process.exit(failures ? 1 : 0);
