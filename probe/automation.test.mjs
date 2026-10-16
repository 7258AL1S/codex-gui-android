// P8 调度器（app/automation-service.js）的离线单测：不连 app-server、不连网络，
// 用假时钟 + 假 request 把"到点触发 / 幂等 / 补跑 / 暂停 / 手动运行 / 重启后不重复 / 并发上限"钉住。
//
//   node probe/automation.test.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeNextRunAt,
  createAutomationService,
  describeSchedule,
  normalizeSchedule,
  parseTimeOfDay,
  slotKey,
} from "../app/automation-service.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : `  <- ${detail}`}`);
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
/** 运行是"启动后异步结束"的（sweep 不再阻塞等待），所以测试要等记录落定。 */
const settled = async (service, count = 1) => {
  for (let attempt = 0; attempt < 300; attempt++) {
    const runs = service.listRuns();
    if (runs.length >= count && runs.slice(0, count).every((run) => run.status !== "running")) return runs;
    await tick();
  }
  throw new Error(`run 没有落定：${JSON.stringify(service.listRuns().map((run) => run.status))}`);
};

const dir = mkdtempSync(join(tmpdir(), "automation-test-"));
const storePath = join(dir, "automation.json");
const quietLog = { log: () => {}, error: () => {} };

// ---- 1. 时间表解析与推进（本地时间；2026-10-16 是周五）----
check("parseTimeOfDay 接受 9:05", JSON.stringify(parseTimeOfDay("9:05")) === JSON.stringify({ hours: 9, minutes: 5 }));
check("parseTimeOfDay 拒绝 25:00", parseTimeOfDay("25:00") === null);
check("normalizeSchedule 把 9:05 补成 09:05", normalizeSchedule({ type: "daily", time: "9:05" }).time === "09:05");
check("normalizeSchedule 拒绝未知类型", (() => { try { normalizeSchedule({ type: "minutely" }); return false; } catch { return true; } })());
check("normalizeSchedule 拒绝 weekly 空 days", (() => { try { normalizeSchedule({ type: "weekly", time: "09:00", days: [] }); return false; } catch { return true; } })());

const friday0900 = new Date(2026, 9, 16, 9, 0, 0);
const dailyNext = computeNextRunAt({ type: "daily", time: "10:30" }, friday0900);
check("daily 10:30 从周五 09:00 推到当天 10:30", dailyNext.getTime() === new Date(2026, 9, 16, 10, 30).getTime(), String(dailyNext));
check("daily 08:00 已过则顺延到次日", computeNextRunAt({ type: "daily", time: "08:00" }, friday0900).getTime() === new Date(2026, 9, 17, 8, 0).getTime());
const weekdaysNext = computeNextRunAt({ type: "weekdays", time: "09:00" }, new Date(2026, 9, 17, 10, 0));
check("weekdays 周五 10:00 → 下一个工作日是周一", weekdaysNext.getDay() === 1 && weekdaysNext.getDate() === 19, String(weekdaysNext));
check("weekly wed 20:00 → 下周三", computeNextRunAt({ type: "weekly", time: "20:00", days: ["wed"] }, friday0900).getDay() === 3);
const hourlyNext = computeNextRunAt({ type: "hourly", intervalHours: 6 }, new Date(2026, 9, 16, 9, 12));
check("hourly 每 6 小时从 09:12 推到 12:00", hourlyNext.getHours() === 12 && hourlyNext.getMinutes() === 0, String(hourlyNext));
check("hourly 12 小时且限定周日 → 落在周日", computeNextRunAt({ type: "hourly", intervalHours: 12, days: ["sun"] }, friday0900).getDay() === 0);
check("describeSchedule 说人话", describeSchedule({ type: "weekdays", time: "09:00" }) === "工作日 09:00");

// ---- 2. 假时钟 + 假 app-server ----
let clock = new Date(2026, 9, 16, 9, 0, 0);
const calls = [];
const events = [];
let turnCounter = 0;
const request = async (method, params) => {
  calls.push({ method, params });
  if (method === "thread/start") return { thread: { id: "th-1" } };
  if (method === "turn/start") return { turn: { id: `tu-${++turnCounter}` } };
  if (method === "turn/interrupt") return {};
  throw new Error(`unexpected rpc ${method}`);
};
const notify = (payload) => events.push(payload);
const newService = (extra = {}) => createAutomationService({
  storePath, request, notify, log: quietLog, now: () => clock.getTime(), tickMs: 60_000, ...extra,
});
const complete = (service, turnId, text = "done") => service.onTurnCompleted({
  threadId: "th-1",
  turn: { id: turnId, status: { type: "completed" }, items: [{ type: "agentMessage", text }] },
});
const writeStore = (mutate) => {
  const raw = JSON.parse(readFileSync(storePath, "utf8"));
  mutate(raw);
  writeFileSync(storePath, JSON.stringify(raw, null, 2));
};

const service = newService();
const job = service.createJob({
  name: "每日构建检查",
  prompt: "跑一遍构建并汇报",
  cwd: "/data/data/com.termux/files/home/codex-gui",
  schedule: { type: "daily", time: "09:05" },
});
check("createJob 返回 nextRunAt", job.nextRunAt === new Date(2026, 9, 16, 9, 5).getTime(), String(job.nextRunAt));
check("createJob 拒绝空提示词", (() => { try { service.createJob({ name: "x", prompt: " ", cwd: "/tmp", schedule: { type: "daily", time: "09:00" } }); return false; } catch { return true; } })());

await service.sweep("tick");
check("到点前不触发", service.listRuns().length === 0 && calls.length === 0);

clock = new Date(2026, 9, 16, 9, 6, 0);
await service.sweep("tick");
await tick();
check("到点触发 turn/start", calls.some((call) => call.method === "turn/start"));
check("turn/start 带上提示词与权限策略", (() => {
  const call = calls.find((entry) => entry.method === "turn/start");
  return call?.params?.input?.[0]?.text === "跑一遍构建并汇报"
    && call?.params?.approvalPolicy === "on-request"
    && call?.params?.sandboxPolicy?.type === "workspaceWrite";
})());
complete(service, "tu-1", "构建通过");
await settled(service);
const firstRun = service.listRuns()[0];
check("回合完成后记录为 ok 并带摘要", firstRun?.status === "ok" && firstRun?.summary === "构建通过", JSON.stringify(firstRun));
check("完成后发了一条通知", events.length === 1 && events[0].title.includes("完成"), JSON.stringify(events[0] ?? null));
check("记录里有 threadId/turnId 与槽标识", firstRun?.threadId === "th-1" && firstRun?.turnId === "tu-1" && firstRun?.slotId === slotKey(job.id, new Date(2026, 9, 16, 9, 5)));

const callsBefore = calls.length;
clock = new Date(2026, 9, 16, 9, 7, 0);
await service.sweep("tick");
check("同一个槽不会重复执行", calls.length === callsBefore && service.listRuns().length === 1, `runs=${service.listRuns().length}`);

// ---- 3. 重启：任务/记录/游标都从磁盘回来，且不重复补跑 ----
const restarted = newService();
check("重启后任务与记录都还在", restarted.listJobs().length === 1 && restarted.listRuns().length === 1);
await restarted.sweep("startup");
check("重启后不会重复执行已跑过的槽", restarted.listRuns().filter((run) => run.status === "ok").length === 1);

// ---- 4. 补跑（默认 runOnce）：离线期间错过 2 个槽，只补最新 1 个 ----
writeStore((raw) => {
  raw.jobs[0].schedule = { type: "hourly", intervalHours: 1, days: null };
  raw.jobs[0].cursorAt = new Date(2026, 9, 16, 9, 0, 0).getTime();
  raw.runs = [];
});
clock = new Date(2026, 9, 16, 12, 30, 0);
const caught = newService();
await caught.sweep("startup");
await tick();
complete(caught, `tu-${turnCounter}`, "补跑完成");
await settled(caught);
const caughtRuns = caught.listRuns();
check("补跑只跑最新一个槽", caughtRuns.filter((run) => run.status === "ok").length === 1, JSON.stringify(caughtRuns.map((run) => [run.slotId, run.status])));
check("错过的 2 个槽记成 skipped 并写明原因", caughtRuns.filter((run) => run.status === "skipped" && /桥当时不在/.test(run.error ?? "")).length === 2, JSON.stringify(caughtRuns.map((run) => run.error)));
check("补跑那次的 trigger 是 catchup", caughtRuns.some((run) => run.trigger === "catchup"));

// ---- 5. catchUp=skip：一个都不补，但要记账 ----
writeStore((raw) => {
  raw.jobs[0].catchUp = "skip";
  raw.jobs[0].cursorAt = new Date(2026, 9, 16, 9, 0, 0).getTime();
  raw.runs = [];
});
clock = new Date(2026, 9, 16, 12, 30, 0);
const skipping = newService();
const callsBeforeSkip = calls.length;
await skipping.sweep("startup");
check("catchUp=skip 时不执行", calls.length === callsBeforeSkip);
check("但错过仍被记录（不静默丢失）", skipping.listRuns().length === 3 && skipping.listRuns().every((run) => run.status === "skipped"), String(skipping.listRuns().length));

// ---- 6. 暂停 / 恢复 / 手动运行 ----
writeStore((raw) => {
  raw.jobs[0].catchUp = "runOnce";
  raw.jobs[0].schedule = { type: "hourly", intervalHours: 1, days: null };
  raw.jobs[0].cursorAt = new Date(2026, 9, 16, 14, 30, 0).getTime();
  raw.runs = [];
});
clock = new Date(2026, 9, 16, 14, 29, 0);
const paused = newService();
const pausedJobId = paused.listJobs()[0].id;
paused.updateJob(pausedJobId, { enabled: false });
const callsBeforePause = calls.length;
clock = new Date(2026, 9, 16, 15, 30, 0);
await paused.sweep("tick");
check("暂停后不再触发", calls.length === callsBeforePause);
check("暂停时 nextRunAt 为空", paused.listJobs()[0].nextRunAt === null);
paused.updateJob(pausedJobId, { enabled: true });
check("恢复后重新有 nextRunAt", typeof paused.listJobs()[0].nextRunAt === "number");
const manualPromise = paused.runNow(pausedJobId);
await tick();
complete(paused, `tu-${turnCounter}`, "手动跑完");
const manualRun = await manualPromise;
check("手动运行真的执行并记录 trigger=manual", manualRun.trigger === "manual" && manualRun.status === "ok", JSON.stringify(manualRun));

// ---- 7. 失败路径：执行失败要如实记录原因，并通知成"需要留意" ----
const failingService = createAutomationService({
  storePath: join(dir, "failing.json"),
  request: async (method, params) => {
    if (method === "thread/start") throw new Error("provider 崩了");
    return request(method, params);
  },
  notify, log: quietLog, now: () => clock.getTime(), tickMs: 60_000,
});
const failingRun = await failingService.runNow(failingService.createJob({
  name: "会失败的任务", prompt: "x", cwd: "/tmp", schedule: { type: "daily", time: "09:00" },
}).id);
check("执行失败会如实记录原因", failingRun.status === "failed" && /provider 崩了/.test(failingRun.error ?? ""), JSON.stringify(failingRun));
check("失败通知标成需要留意", events.at(-1)?.title.includes("需要留意"), JSON.stringify(events.at(-1) ?? null));

// ---- 8. 超时路径：注入快定时器，超时要中断并标记 timeout ----
const timeoutService = createAutomationService({
  storePath: join(dir, "timeout.json"),
  request, notify, log: quietLog, now: () => clock.getTime(), tickMs: 60_000,
  // 快定时器：真的 60s 超时没法在单测里等；同时屏蔽 unref（否则事件循环空了，进程提前退出）
  timers: {
    setTimeout: (fn) => { const handle = setTimeout(fn, 5); handle.unref = () => {}; return handle; },
    clearTimeout: (handle) => clearTimeout(handle),
  },
});
const timeoutRun = await timeoutService.runNow(timeoutService.createJob({
  name: "会超时的任务", prompt: "x", cwd: "/tmp", schedule: { type: "daily", time: "09:00" }, turnTimeoutMinutes: 1,
}).id);
check("回合超时会被标记并中断", timeoutRun.status === "timeout" && calls.some((call) => call.method === "turn/interrupt"), JSON.stringify(timeoutRun));

// ---- 8.5 定时回合遇到审批：立刻记账 + 带深链通知，解决后清掉（E138）----
const approvalService = createAutomationService({
  storePath: join(dir, "approval.json"), request, notify, log: quietLog, now: () => clock.getTime(), tickMs: 60_000,
});
const approvalJob = approvalService.createJob({
  name: "要审批的任务", prompt: "改点东西", cwd: "/tmp",
  schedule: { type: "daily", time: "09:00" }, permissionMode: "default",
});
const approvalPromise = approvalService.runNow(approvalJob.id);
await tick();
const marked = approvalService.onServerRequest({
  id: 77, method: "item/commandExecution/requestApproval", params: { threadId: "th-1", turnId: "t1", itemId: "i1" },
});
check("审批请求会被记到那次运行上", marked?.awaiting?.kind === "approval" && marked.awaiting.requestId === 77, JSON.stringify(marked?.awaiting ?? null));
check("运行状态仍然是 running（没被当成失败）", marked?.status === "running", String(marked?.status));
check("立刻发了一条带会话深链的通知", events.at(-1)?.threadId === "th-1" && /等审批/.test(events.at(-1)?.title ?? ""), JSON.stringify(events.at(-1) ?? null));
check("通知里写着是哪条任务在等", /要审批的任务/.test(events.at(-1)?.body ?? ""), String(events.at(-1)?.body));
check("别的线程的请求不会误挂到定时任务上", approvalService.onServerRequest({ id: 78, method: "item/commandExecution/requestApproval", params: { threadId: "th-other" } }) === null);
approvalService.onRequestResolved(77);
const questionRun = approvalService.onServerRequest({ id: 79, method: "item/tool/requestUserInput", params: { threadId: "th-1" } });
check("提问型请求记成 question", questionRun?.awaiting?.kind === "question", JSON.stringify(approvalService.listRuns()[0].awaiting ?? null));
check("请求解决后会清掉等待标记", approvalService.onRequestResolved(79) === true && !approvalService.listRuns()[0].awaiting);
check("未知 requestId 的解决事件被安全忽略", approvalService.onRequestResolved(4242) === false);
complete(approvalService, `tu-${turnCounter}`, "批了，做完了");
const approvalRun = await approvalPromise;
check("批准之后回合照常跑完", approvalRun.status === "ok" && !approvalRun.awaiting, JSON.stringify(approvalRun));

// ---- 9. 并发上限：满了不假装跑过，而是记 skipped 并退回游标 ----
const serial = createAutomationService({
  storePath: join(dir, "serial.json"),
  request, notify, log: quietLog, now: () => clock.getTime(), tickMs: 60_000, concurrency: 1,
});
clock = new Date(2026, 9, 16, 14, 0, 0);
const serialJobA = serial.createJob({ name: "A", prompt: "a", cwd: "/tmp", schedule: { type: "hourly", intervalHours: 1, days: null } });
const serialJobB = serial.createJob({ name: "B", prompt: "b", cwd: "/tmp", schedule: { type: "hourly", intervalHours: 1, days: null } });
clock = new Date(2026, 9, 16, 15, 5, 0);
await serial.sweep("tick");
await tick();
complete(serial, `tu-${turnCounter}`, "A 完成");
await settled(serial, 2);
const serialRuns = serial.listRuns();
check("并发上限：只跑了一个", serialRuns.filter((run) => run.status === "ok").length === 1, JSON.stringify(serialRuns.map((run) => [run.jobName, run.status, run.error])));
check("并发上限：另一个如实记 skipped 并说明原因", serialRuns.some((run) => run.status === "skipped" && /并发上限/.test(run.error ?? "")), JSON.stringify(serialRuns.map((run) => run.error)));
check("并发上限：被跳过的那个游标退回了（下次还会试）", (() => {
  const raw = JSON.parse(readFileSync(join(dir, "serial.json"), "utf8"));
  const skippedJobId = serialRuns.find((run) => /并发上限/.test(run.error ?? ""))?.jobId;
  const entry = raw.jobs.find((item) => item.id === skippedJobId);
  return entry && entry.cursorAt === new Date(2026, 9, 16, 15, 0, 0).getTime() - 1;
})(), JSON.stringify(serialRuns.map((run) => run.jobId)));
check("两个任务的名字对得上", [serialJobA.name, serialJobB.name].every((name) => serialRuns.some((run) => run.jobName === name)));

rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
