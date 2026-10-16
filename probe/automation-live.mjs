// P8 真机端到端：在**真桥**上建一个两分钟后的定时任务，等它自己到点触发，检查：
//   到点真的起了一个回合 → 回合结束后运行记录落定 → 通知发出去 → 清理现场。
// 这不是"手动运行"的替代：手动运行走的是 runNow，这里走的是调度器的 tick。
//
//   node probe/automation-live.mjs            # 真机全流程（约 3 分钟）
//
// 前置：桥在跑（~/bin/codex-gui-web status）。
const BASE = process.env.BRIDGE_URL ?? "http://127.0.0.1:8899";
const JOB_NAME = "自动化冒烟（probe，跑完自动删）";
const CWD = "/data/data/com.termux/files/home/codex-gui";
const LEAD_MINUTES = 2;
const WAIT_MS = 6 * 60 * 1000;

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : `  <- ${detail}`}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(method, body) {
  const res = await fetch(`${BASE}/api/automation`, method === "GET"
    ? { method }
    : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* 原样报错 */ }
  if (!res.ok) throw new Error(`${method} ${res.status}: ${parsed?.error ?? text.slice(0, 200)}`);
  return parsed;
}

const snapshot = await api("GET");
check("GET /api/automation 返回调度器快照", Array.isArray(snapshot?.jobs) && Boolean(snapshot?.limits));
check("调度器如实声明后台边界", /冻结|回收/.test(snapshot?.limits?.background ?? ""), snapshot?.limits?.background);
console.log(`   tick=${snapshot.limits.tickMs}ms  并发=${snapshot.limits.concurrency}  上次扫描=${snapshot.lastSweepReason}`);

const at = new Date(Date.now() + LEAD_MINUTES * 60_000);
const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
const created = await api("POST", {
  action: "create",
  job: {
    name: JOB_NAME,
    prompt: "只回复这几个字：自动化冒烟 ok。不要运行任何命令，不要读写文件。",
    cwd: CWD,
    schedule: { type: "daily", time },
    // 无人值守的回合不能卡在审批上：这里显式用"完全访问"档（本平台沙箱不生效，见 E126/E131）。
    permissionMode: "full-access",
    turnTimeoutMinutes: 5,
  },
});
const jobId = created?.id;
check("任务创建成功", Boolean(jobId), JSON.stringify(created)?.slice(0, 200));
check("返回的下次运行时间就是刚设的那个点", created?.nextRunAt === new Date(at.getFullYear(), at.getMonth(), at.getDate(), at.getHours(), at.getMinutes(), 0, 0).getTime(), `${new Date(created?.nextRunAt).toString()} vs ${time}`);
console.log(`   任务 ${jobId} 计划 ${time}（现在 ${new Date().toTimeString().slice(0, 5)}），等它自己到点…`);

let run = null;
const deadline = Date.now() + WAIT_MS;
while (Date.now() < deadline) {
  await sleep(10_000);
  const state = await api("GET");
  const candidate = state.runs.find((entry) => entry.jobId === jobId);
  if (!candidate) { continue; }
  if (!run) console.log(`   ${new Date().toTimeString().slice(0, 8)} 运行记录出现：status=${candidate.status} slot=${candidate.slotId}`);
  run = candidate;
  if (run.status !== "running") break;
}

check("到点真的触发了一个回合（有运行记录）", Boolean(run), "等到超时也没有运行记录");
if (run) {
  check("运行记录带 threadId/turnId（真起了回合）", Boolean(run.threadId) && Boolean(run.turnId), JSON.stringify(run).slice(0, 240));
  check("trigger 是 schedule（不是手动）", run.trigger === "schedule" || run.trigger === "catchup", run.trigger);
  check("回合结束状态是 ok", run.status === "ok", `${run.status} ${run.error ?? ""}`);
  check("摘要里能看到模型回复", typeof run.summary === "string" && run.summary.includes("ok"), String(run.summary));
  check("槽标识就是计划的那一分钟", String(run.slotId).endsWith(time), String(run.slotId));
  console.log(`   摘要：${run.summary}`);
}

const before = (await api("GET")).runs.filter((entry) => entry.jobId === jobId).length;
const removed = await api("POST", { action: "remove", id: jobId });
const cleared = await api("POST", { action: "clearRuns", id: jobId });
check("测试任务已删除", removed?.removed === jobId, JSON.stringify(removed));
check("测试记录已清理（留下一份干净的状态）", cleared?.removed === before, `${JSON.stringify(cleared)} vs ${before}`);

const after = await api("GET");
check("清理后没有残留任务", !after.jobs.some((job) => job.id === jobId));
check("清理后没有残留记录", !after.runs.some((entry) => entry.jobId === jobId));

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
