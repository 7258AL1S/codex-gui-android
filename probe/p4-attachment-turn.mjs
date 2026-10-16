// P4 attachments, end to end: the file the browser picked must actually reach the
// model — not just land on disk.
//
// Chain under test: POST /api/uploads (bridge writes the bytes, returns a path)
//   → turn/start with UserInput{type:"localImage", path} → the model answers
//   about the picture's content → the turn history keeps the attachment.
//
//   BRIDGE_URL=http://127.0.0.1:8893 node probe/p4-attachment-turn.mjs
import { readFileSync, rmSync } from "node:fs";
import { basename, resolve } from "node:path";

const BASE = process.env.BRIDGE_URL ?? "http://127.0.0.1:8899";
const CWD = process.env.SCENARIO_CWD ?? "/data/data/com.termux/files/home/codex-gui";
const IMAGE = process.env.ATTACH_IMAGE ?? resolve(CWD, "probe/ui-chip.png");
const KEEP = process.env.KEEP_THREAD === "1";

let seq = 2100;
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

let failures = 0;
const step = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const notes = () => events.filter((e) => e.type === "codex/notification").map((e) => e.payload?.method);
const waitFor = async (predicate, ms, label) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (predicate()) return true;
    await sleep(250);
  }
  console.log(`     （等待超时：${label}）`);
  return false;
};

await sleep(400);

// 1) 走真实上传接口，拿一个真实路径
const bytes = readFileSync(IMAGE);
const uploadResponse = await fetch(`${BASE}/api/uploads`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: `附件测试-${basename(IMAGE)}`, dataBase64: bytes.toString("base64") }),
});
const uploaded = await uploadResponse.json();
step("上传接口返回路径", uploadResponse.status === 200 && Boolean(uploaded.path), uploaded.path ?? JSON.stringify(uploaded));
step("被判定为图片", uploaded.kind === "image", String(uploaded.kind));

// 2) 新会话 + 带附件的回合
const start = await rpc("thread/start", { cwd: CWD });
const threadId = start?.thread?.id;
step("新建会话", Boolean(threadId), threadId ?? "");

const mark = Date.now();
const turn = await rpc("turn/start", {
  threadId,
  input: [
    { type: "text", text: "看这张截图，用一句中文描述你看到的主要界面元素。" },
    { type: "localImage", path: uploaded.path },
  ],
});
step("带附件的回合已开始", Boolean(turn?.turn?.id), turn?.turn?.id ?? JSON.stringify(turn));

const done = await waitFor(() => notes().includes("turn/completed"), 180000, "回合完成");
step("回合完成", done);

// 3) 历史里必须留有这条附件（读的人才能看见它，而不是只存在于一次性请求里）
const turns = await rpc("thread/turns/list", { threadId, limit: 3, itemsView: "full" });
const items = (turns?.data ?? []).flatMap((t) => t.items ?? []);
const userItem = items.find((item) => item.type === "userMessage");
const parts = Array.isArray(userItem?.content) ? userItem.content : [];
// Case-insensitive on purpose: the wire type is `localImage`, and the item
// renderer matches it the same way (rendering.js uses /image/i).
const imagePart = parts.find((part) => /image/i.test(String(part?.type ?? "")));
step("历史里的用户消息带着图片附件", imagePart?.path === uploaded.path, imagePart ? String(imagePart.path) : "（没有 image 部分）");

const agentText = items
  .filter((item) => item.type === "agentMessage")
  .map((item) => String(item.text ?? "").trim())
  .filter(Boolean)
  .join("\n");
step("模型给出了回答（不是空回合）", agentText.length > 0, `${agentText.length} 字`);
console.log(`\n模型看到附件后回答：\n${agentText.slice(0, 400) || "(空)"}\n`);

// 4) 收尾：不留测试会话与测试文件（上传目录是缓存，不是存档）
if (!KEEP) {
  try {
    await rpc("thread/delete", { threadId });
    console.log("ok   已删除测试会话");
  } catch (error) {
    console.log(`     删除测试会话失败：${error.message}`);
  }
  try {
    rmSync(uploaded.path);
    console.log("ok   已删除本次上传的测试文件");
  } catch (error) {
    console.log(`     删除上传文件失败：${error.message}`);
  }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
