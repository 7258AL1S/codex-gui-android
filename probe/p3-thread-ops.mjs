// P3 acceptance at the protocol level: the thread operations the UI does not
// use yet — rename, archive/unarchive, fork, compact. Verified before wiring
// anything into the interface.
//
// Usage: node probe/p3-thread-ops.mjs
const BASE = process.env.BRIDGE_URL ?? "http://127.0.0.1:8899";
const CWD = process.env.SCENARIO_CWD ?? "/data/data/com.termux/files/home/codex-gui";

let seq = 990;
async function rpc(method, params = {}) {
  const id = seq++;
  const res = await fetch(`${BASE}/api/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, method, params }),
  });
  const body = await res.json();
  return body.type === "rpc/error" ? { error: body.error } : { result: body.result };
}

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};
const note = (label, value) => console.log(`     ${label}: ${JSON.stringify(value)}`);

// A thread needs one completed turn before other clients can resume it / before
// fork has history to copy (see E36, E47).
const start = await rpc("thread/start", { cwd: CWD });
const threadId = start.result?.thread?.id;
if (!threadId) { console.log("thread/start 失败：", JSON.stringify(start)); process.exit(1); }
await rpc("turn/start", { threadId, input: [{ type: "text", text: "只回答一个字：甲" }] });
const settle = Date.now() + 120000;
while (Date.now() < settle) {
  const turns = await rpc("thread/turns/list", { threadId, limit: 5, itemsView: "summary" });
  if ((turns.result?.data ?? []).some((t) => t.status === "completed")) break;
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`thread=${threadId}\n`);

// --- rename ----------------------------------------------------------------
const renamed = await rpc("thread/name/set", { threadId, name: "P3 重命名测试" });
check("thread/name/set 被接受", Boolean(renamed.result !== undefined || renamed.error === undefined), true);
if (renamed.error) note("rename error", renamed.error);
const afterRename = await rpc("thread/list", { limit: 5 });
note("列表里该线程的名称", (afterRename.result?.data ?? []).find((t) => t.id === threadId)?.name ?? "(未返回 name 字段)");

// --- archive / unarchive ---------------------------------------------------
const archived = await rpc("thread/archive", { threadId });
check("thread/archive 成功", archived.error, undefined);
if (archived.error) note("archive error", archived.error);
const defaultList = await rpc("thread/list", { limit: 20 });
check("归档后默认列表里不再出现", (defaultList.result?.data ?? []).some((t) => t.id === threadId), false);
const archivedList = await rpc("thread/list", { limit: 20, archived: true });
check("archived:true 能查到它", (archivedList.result?.data ?? []).some((t) => t.id === threadId), true);
const unarchived = await rpc("thread/unarchive", { threadId });
check("thread/unarchive 成功", unarchived.error, undefined);
const backList = await rpc("thread/list", { limit: 20 });
check("恢复后重新出现", (backList.result?.data ?? []).some((t) => t.id === threadId), true);

// --- fork ------------------------------------------------------------------
const forked = await rpc("thread/fork", { threadId });
const forkId = forked.result?.thread?.id ?? forked.result?.id;
check("thread/fork 返回新线程", Boolean(forkId), true);
if (forked.error) note("fork error", forked.error);
if (forkId) {
  const forkTurns = await rpc("thread/turns/list", { threadId: forkId, limit: 5, itemsView: "summary" });
  note("分叉继承的回合数", (forkTurns.result?.data ?? []).length);
  check("原线程仍在", (await rpc("thread/read", { threadId })).result?.thread?.id, threadId);
  await rpc("thread/delete", { threadId: forkId });
}

// --- compact ---------------------------------------------------------------
const compacted = await rpc("thread/compact/start", { threadId });
note("thread/compact/start", compacted.error ? `error: ${compacted.error}` : "accepted");

// --- search ----------------------------------------------------------------
const searched = await rpc("thread/list", { limit: 10, searchTerm: "P3 重命名测试" });
check("searchTerm 能命中刚重命名的线程", (searched.result?.data ?? []).some((t) => t.id === threadId), true);
if (searched.error) note("search error", searched.error);

// --- sections --------------------------------------------------------------
const sections = await rpc("threadSection/list", {});
note("threadSection/list", sections.error ? `error: ${sections.error}` : JSON.stringify(sections.result).slice(0, 120));

// tidy up
await rpc("thread/delete", { threadId });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
