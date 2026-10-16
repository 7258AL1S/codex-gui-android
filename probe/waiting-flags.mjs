// P2 遗留项的证据：模型卡在"等用户"时，`thread/list` 里到底有没有可用的状态标志？
//
// `ThreadStatus` 的形状是 {"type":"active","activeFlags":["waitingOnApproval"|"waitingOnUserInput"]}
// （proto-ts/v2/ThreadStatus.ts），侧栏徽章就靠它（patches/0082）。这里用一次**真实的提问回合**
// 把标志逼出来：Plan 模式下让模型调用 `request_user_input`（E114 验过这条路），
// 然后轮询 thread/list，断言 activeFlags 里出现 waitingOnUserInput；答完题再断言标志消失。
//
// 会真的花掉一个模型回合（很短）。创建的会话在结束时删除。
//
//   node probe/waiting-flags.mjs
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

async function findThread(threadId) {
  const list = await rpc("thread/list", {});
  const threads = list?.data || list?.threads || [];
  return threads.find((thread) => thread.id === threadId) || null;
}

const models = await rpc("model/list", {});
const model = (models?.data || models?.models || [])[0]?.id || models?.data?.[0]?.model;
const start = await rpc("thread/start", { cwd: process.env.HOME });
const threadId = start?.thread?.id;
console.log("测试会话:", threadId, "model:", model);

const turnParams = {
  threadId,
  input: [{ type: "text", text: "请使用 request_user_input 工具问我一个问题（问我今天想做什么），拿到回答后只回复 done。" }],
};
if (model) turnParams.collaborationMode = { mode: "plan", settings: { model } };
await rpc("turn/start", turnParams);

let flags = null;
for (let attempt = 0; attempt < 40; attempt += 1) {
  await sleep(1500);
  const thread = await findThread(threadId);
  flags = thread?.status?.type === "active" ? thread.status.activeFlags : [];
  if (Array.isArray(flags) && flags.includes("waitingOnUserInput")) break;
}
check("模型提问时 activeFlags 出现 waitingOnUserInput", Array.isArray(flags) && flags.includes("waitingOnUserInput"), JSON.stringify(flags));
console.log("（此刻侧栏应该在那一行显示「等你回答」——徽章数据就是它）");

// 顺便看一眼审批标志的形状（本机 approval_policy=never，拿不到 waitingOnApproval，这里只确认字段语义）
console.log("waitingOnApproval 是否出现（本机预期 false）:", Array.isArray(flags) && flags.includes("waitingOnApproval"));

// 自收尾：测试会话用完就删（多次跑不该在侧栏堆会话）。
await rpc("thread/delete", { threadId });
console.log("\n测试会话已删除:", threadId);
process.exit(failures ? 1 : 0);
