// 定时任务 / 持续跟进（PLAN 的 P8，FEATURES 第 7 节）。
//
// 为什么是"自建"：把 `proto-ts/ClientRequest.ts` 从头到尾搜一遍，**没有任何 schedul\* 方法**；
// `ScheduledTaskSummary` / `ScheduledTaskSchedule` 只出现在 `PluginDetail.scheduledTasks` 里，
// 那是"插件声明了自己希望被调度的任务"的**发现面**，不是"谁去按点执行"的执行面。
// 所以：调度、持久化、漏跑补跑、运行记录、暂停恢复，全部由桥自己实现；
// schedule 的四种形态跟桌面端/协议里的那套保持一致（hourly / daily / weekdays / weekly）。
//
// 三个刻意的设计：
//   1. **slot（时间槽）是幂等键**：`<jobId>@<本地时间 YYYY-MM-DDTHH:MM>`。一个槽只会被执行一次，
//      运行记录先落盘再执行，所以"桥被杀→重启"不会重复执行，也不会静默丢掉——错过的会被记成 skipped。
//   2. **补跑只补最新一个槽**（catchUp=runOnce，默认）：离线八小时不该一口气补八个回合。
//      更早的槽全部记成 skipped 并写明原因，界面上看得见。
//   3. **不承诺"到点一定执行"**：Android 会冻结/回收 Termux 进程（E62/E87），桥不在时没人能触发。
//      桥能做到的是"回来之后不漏账、不重复"，这一点要写进界面的限制说明。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const WEEKDAY_TO_JS = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0 };
const JS_TO_WEEKDAY = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export const SCHEDULE_TYPES = ["hourly", "daily", "weekdays", "weekly"];

const MINUTE_MS = 60_000;
const DEFAULT_TURN_TIMEOUT_MINUTES = 30;
const DEFAULT_CATCH_UP = "runOnce";
const MISSED_RUN_AGGREGATE_LIMIT = 24;

/** `HH:MM` → {hours,minutes}；非法返回 null。 */
export function parseTimeOfDay(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return { hours, minutes };
}

/** 校验并规范化 schedule；形态与桌面端一致。抛错即"不合法"。 */
export function normalizeSchedule(input) {
  const type = String(input?.type ?? "");
  if (!SCHEDULE_TYPES.includes(type)) throw new Error(`schedule.type 必须是 ${SCHEDULE_TYPES.join(" / ")}`);
  if (type === "hourly") {
    const intervalHours = Number(input.intervalHours ?? 1);
    if (!Number.isInteger(intervalHours) || intervalHours < 1 || intervalHours > 24) {
      throw new Error("hourly 的 intervalHours 必须是 1..24 的整数");
    }
    let days = null;
    if (Array.isArray(input.days) && input.days.length) {
      days = [...new Set(input.days.map((day) => String(day).toLowerCase()))];
      for (const day of days) if (!(day in WEEKDAY_TO_JS)) throw new Error(`未知的星期：${day}`);
      days.sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b));
    }
    return { type, intervalHours, days };
  }
  const time = String(input.time ?? "").trim();
  const parsed = parseTimeOfDay(time);
  if (!parsed) throw new Error("time 必须是 HH:MM（24 小时制）");
  const padded = `${String(parsed.hours).padStart(2, "0")}:${String(parsed.minutes).padStart(2, "0")}`;
  if (type === "daily") return { type, time: padded };
  if (type === "weekdays") return { type, time: padded };
  const days = Array.isArray(input.days) ? input.days.map((day) => String(day).toLowerCase()) : [];
  if (!days.length) throw new Error("weekly 至少要选一天");
  for (const day of days) if (!(day in WEEKDAY_TO_JS)) throw new Error(`未知的星期：${day}`);
  const unique = [...new Set(days)].sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b));
  return { type, time: padded, days: unique };
}

function atTimeOfDay(date, hours, minutes) {
  const copy = new Date(date.getTime());
  copy.setHours(hours, minutes, 0, 0);
  return copy;
}

function addDays(date, days) {
  const copy = new Date(date.getTime());
  copy.setDate(copy.getDate() + days);
  return copy;
}

function weekdayOf(date) {
  return JS_TO_WEEKDAY[date.getDay()];
}

/** 严格晚于 after 的第一个 `HH:MM`。 */
function nextTimeOfDay(time, after) {
  const parsed = parseTimeOfDay(time);
  if (!parsed) return null;
  const today = atTimeOfDay(after, parsed.hours, parsed.minutes);
  if (today.getTime() > after.getTime()) return today;
  return atTimeOfDay(addDays(after, 1), parsed.hours, parsed.minutes);
}

/** 下一次该跑的时刻（本地时间）；算不出来时返回 null。 */
export function computeNextRunAt(schedule, after) {
  const normalized = normalizeSchedule(schedule);
  const base = after instanceof Date ? after : new Date(after);
  if (normalized.type === "hourly") {
    const from = new Date(base.getTime());
    // 从"当前小时的整点"开始按小时步进（不是按分钟）：intervalHours>1 时，
    // 48 分钟的窗口根本走不到下一个对齐点，会算出 null。
    from.setMinutes(0, 0, 0);
    for (let step = 0; step <= 48; step++) {
      const candidate = new Date(from.getTime() + step * 60 * MINUTE_MS);
      if (candidate.getTime() <= base.getTime()) continue;
      if (candidate.getHours() % normalized.intervalHours !== 0) continue;
      if (normalized.days && !normalized.days.includes(weekdayOf(candidate))) continue;
      return candidate;
    }
    return null;
  }
  if (normalized.type === "daily") return nextTimeOfDay(normalized.time, base);
  const allowed = normalized.type === "weekdays"
    ? new Set(["mon", "tue", "wed", "thu", "fri"])
    : new Set(normalized.days);
  let candidate = nextTimeOfDay(normalized.time, base);
  for (let step = 0; step < 8 && candidate; step++) {
    if (allowed.has(weekdayOf(candidate))) return candidate;
    candidate = nextTimeOfDay(normalized.time, new Date(candidate.getTime() + 1000));
  }
  return null;
}

/** 本地时间的槽标识：`YYYY-MM-DDTHH:MM`（不带时区，同一台设备前后一致）。 */
export function localSlotStamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function slotKey(jobId, date) {
  return `${jobId}@${localSlotStamp(date)}`;
}

export function describeSchedule(schedule) {
  const normalized = normalizeSchedule(schedule);
  if (normalized.type === "hourly") {
    const every = normalized.intervalHours === 1 ? "每小时" : `每 ${normalized.intervalHours} 小时`;
    return normalized.days?.length ? `${every}（${normalized.days.join("/")}）` : every;
  }
  if (normalized.type === "daily") return `每天 ${normalized.time}`;
  if (normalized.type === "weekdays") return `工作日 ${normalized.time}`;
  return `${normalized.days.join("/")} ${normalized.time}`;
}

/** 与页面的权限档位一一对应（E126：本平台沙箱不生效，真正起作用的是审批策略）。 */
export function permissionPolicy(mode, cwd) {
  if (mode === "full-access") {
    return {
      permissions: null,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" },
    };
  }
  return {
    permissions: null,
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: cwd ? [cwd] : [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
  };
}

/**
 * 调度器本体。所有副作用都通过注入的 `request`（app-server RPC）与 `notify` 出去，
 * 所以单测可以完全离线跑（见 probe/automation.test.mjs）。
 */
export function createAutomationService({
  storePath,
  request,
  notify = () => {},
  log = console,
  now = () => Date.now(),
  concurrency = 2,
  historyLimit = 200,
  tickMs = 30_000,
  // 注入以便单测能控制超时（真实运行时就是全局定时器）。
  timers = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout },
} = {}) {
  if (!storePath) throw new Error("storePath is required");
  if (typeof request !== "function") throw new Error("request is required");

  const state = { version: 1, jobs: [], runs: [], lastSweepAt: null, lastSweepReason: null };
  const runningJobs = new Set();
  const turnWaiters = new Map();
  let timer = null;
  let sweeping = false;
  let activeRuns = 0;

  function save() {
    try {
      mkdirSync(dirname(storePath), { recursive: true });
      const tmp = `${storePath}.tmp`;
      writeFileSync(tmp, JSON.stringify({
        version: state.version,
        jobs: state.jobs,
        runs: state.runs.slice(0, historyLimit),
        lastSweepAt: state.lastSweepAt,
        lastSweepReason: state.lastSweepReason,
      }, null, 2));
      renameSync(tmp, storePath);
    } catch (error) {
      log.error("[automation] 写入失败:", error instanceof Error ? error.message : error);
    }
  }

  function readStore() {
    try {
      if (!existsSync(storePath)) return;
      const parsed = JSON.parse(readFileSync(storePath, "utf8"));
      state.jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
      state.runs = Array.isArray(parsed.runs) ? parsed.runs.slice(0, historyLimit) : [];
      state.lastSweepAt = Number.isFinite(parsed.lastSweepAt) ? parsed.lastSweepAt : null;
      state.lastSweepReason = typeof parsed.lastSweepReason === "string" ? parsed.lastSweepReason : null;
    } catch (error) {
      // 坏文件不静默丢：改名留档，然后从空状态继续（日志里能看到）。
      const broken = `${storePath}.broken-${Date.now()}`;
      try { renameSync(storePath, broken); } catch { /* 尽力而为 */ }
      log.error(`[automation] 存储解析失败，已留档到 ${broken}:`, error instanceof Error ? error.message : error);
      state.jobs = [];
      state.runs = [];
    }
  }

  function record(run) {
    state.runs.unshift(run);
    if (state.runs.length > historyLimit) state.runs.length = historyLimit;
    save();
    return run;
  }

  function jobById(jobId) {
    return state.jobs.find((job) => job.id === jobId) ?? null;
  }

  function normalizeTarget(target) {
    if (target && String(target.mode) === "continueThread") {
      const threadId = String(target.threadId ?? "").trim();
      if (!threadId) throw new Error("「继续某个会话」必须给出 threadId");
      return { mode: "continueThread", threadId };
    }
    return { mode: "newThread", threadId: null };
  }

  function cursorOf(job) {
    const cursor = Number.isFinite(job.cursorAt) ? job.cursorAt : Date.parse(job.createdAt);
    return Number.isFinite(cursor) ? cursor : now();
  }

  function publicJob(job) {
    const next = job.enabled ? computeNextRunAt(job.schedule, new Date(cursorOf(job))) : null;
    const lastRun = state.runs.find((run) => run.jobId === job.id) ?? null;
    return {
      ...job,
      scheduleLabel: describeSchedule(job.schedule),
      nextRunAt: next ? next.getTime() : null,
      running: runningJobs.has(job.id),
      lastRun: lastRun
        ? { status: lastRun.status, startedAt: lastRun.startedAt, finishedAt: lastRun.finishedAt, error: lastRun.error ?? null, summary: lastRun.summary ?? null }
        : null,
    };
  }

  function listJobs() {
    return state.jobs.map(publicJob);
  }

  function createJob(input) {
    const name = String(input?.name ?? "").trim();
    const prompt = String(input?.prompt ?? "").trim();
    const cwd = String(input?.cwd ?? "").trim();
    if (!name) throw new Error("任务名不能为空");
    if (!prompt) throw new Error("提示词不能为空");
    if (!cwd) throw new Error("工作目录不能为空");
    const job = {
      id: randomUUID(),
      name,
      prompt,
      cwd,
      schedule: normalizeSchedule(input?.schedule),
      target: normalizeTarget(input?.target),
      permissionMode: input?.permissionMode === "full-access" ? "full-access" : "default",
      enabled: input?.enabled !== false,
      catchUp: input?.catchUp === "skip" ? "skip" : DEFAULT_CATCH_UP,
      turnTimeoutMinutes: Number.isFinite(Number(input?.turnTimeoutMinutes))
        ? Math.max(1, Math.min(240, Number(input.turnTimeoutMinutes)))
        : DEFAULT_TURN_TIMEOUT_MINUTES,
      createdAt: new Date(now()).toISOString(),
      updatedAt: new Date(now()).toISOString(),
      cursorAt: now(),
    };
    state.jobs.push(job);
    save();
    log.log(`[automation] 新建任务 ${job.name}（${describeSchedule(job.schedule)}）`);
    return publicJob(job);
  }

  function updateJob(jobId, patch) {
    const job = jobById(jobId);
    if (!job) throw new Error("找不到这个任务");
    if (patch?.name !== undefined) {
      const name = String(patch.name).trim();
      if (!name) throw new Error("任务名不能为空");
      job.name = name;
    }
    if (patch?.prompt !== undefined) {
      const prompt = String(patch.prompt).trim();
      if (!prompt) throw new Error("提示词不能为空");
      job.prompt = prompt;
    }
    if (patch?.cwd !== undefined) {
      const cwd = String(patch.cwd).trim();
      if (!cwd) throw new Error("工作目录不能为空");
      job.cwd = cwd;
    }
    if (patch?.schedule !== undefined) {
      job.schedule = normalizeSchedule(patch.schedule);
      // 改了时间表就从现在重新算游标，不要拿旧游标去补一堆过去的槽。
      job.cursorAt = now();
    }
    if (patch?.target !== undefined) job.target = normalizeTarget(patch.target);
    if (patch?.permissionMode !== undefined) job.permissionMode = patch.permissionMode === "full-access" ? "full-access" : "default";
    if (patch?.catchUp !== undefined) job.catchUp = patch.catchUp === "skip" ? "skip" : DEFAULT_CATCH_UP;
    if (patch?.turnTimeoutMinutes !== undefined) {
      job.turnTimeoutMinutes = Math.max(1, Math.min(240, Number(patch.turnTimeoutMinutes) || DEFAULT_TURN_TIMEOUT_MINUTES));
    }
    if (patch?.enabled !== undefined) {
      job.enabled = Boolean(patch.enabled);
      // 重新启用时从现在起算：不要把停用期间的时间都当成"错过的槽"。
      if (job.enabled) job.cursorAt = now();
    }
    job.updatedAt = new Date(now()).toISOString();
    save();
    return publicJob(job);
  }

  function removeJob(jobId) {
    const index = state.jobs.findIndex((job) => job.id === jobId);
    if (index < 0) throw new Error("找不到这个任务");
    const [removed] = state.jobs.splice(index, 1);
    save();
    log.log(`[automation] 删除任务 ${removed.name}（历史记录保留）`);
    return { removed: removed.id, runsKept: state.runs.filter((run) => run.jobId === removed.id).length };
  }

  function listRuns(jobId = null, limit = 50) {
    return state.runs.filter((run) => !jobId || run.jobId === jobId).slice(0, limit);
  }

  function clearRuns(jobId = null) {
    const before = state.runs.length;
    state.runs = jobId ? state.runs.filter((run) => run.jobId !== jobId) : [];
    save();
    return { removed: before - state.runs.length };
  }

  function waitForTurn(threadId, turnId, timeoutMs) {
    return new Promise((resolvePromise) => {
      const key = `${threadId}:${turnId ?? ""}`;
      const timerId = timers.setTimeout(() => {
        turnWaiters.delete(key);
        resolvePromise({ status: "timeout", error: `回合超过 ${Math.round(timeoutMs / 60000)} 分钟没有结束` });
      }, timeoutMs);
      if (typeof timerId.unref === "function") timerId.unref();
      turnWaiters.set(key, (outcome) => {
        timers.clearTimeout(timerId);
        turnWaiters.delete(key);
        resolvePromise(outcome);
      });
    });
  }

  function summarizeTurn(turn) {
    const items = Array.isArray(turn?.items) ? turn.items : [];
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index];
      if (item?.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
        return item.text.trim().replace(/\s+/g, " ").slice(0, 240);
      }
    }
    return null;
  }

  function runningRunForThread(threadId) {
    return state.runs.find((run) => run.threadId === threadId && run.status === "running") ?? null;
  }

  /**
   * 桥收到 server→client 请求（审批 / 提问 / MCP 表单）时调用。
   *
   * 为什么要有它：定时回合在 `default` 权限档下碰到审批时，原本只能**干等到 30 分钟超时**然后被
   * 记成 timeout —— 用户根本不知道有东西在等他。现在这一刻就记进运行记录并立刻发一条**带会话深链**
   * 的通知：点开就能批，回合照常继续（E138）。请求参数里都带 `threadId`（协议已核实），所以能对上。
   */
  function onServerRequest(request = {}) {
    const method = String(request?.method ?? "");
    const threadId = String(request?.params?.threadId ?? "");
    if (!method || !threadId) return null;
    const run = runningRunForThread(threadId);
    if (!run) return null;
    const kind = /requestApproval$/.test(method) ? "approval" : /requestUserInput$/.test(method) ? "question" : "input";
    const requestId = Number.isFinite(Number(request.id)) ? Number(request.id) : null;
    run.awaiting = { kind, method, requestId, at: now() };
    save();
    log.log(`[automation] ${run.jobName} 在等 ${kind}（${method}，thread=${threadId.slice(0, 8)}）`);
    try {
      notify({
        title: kind === "approval" ? "Codex ⚠️ 定时任务在等审批" : "Codex ⚠️ 定时任务在等你回答",
        body: `${run.jobName}：点开这条会话就能处理，否则它会一直等到超时`,
        tag: "codex-status",
        threadId,
      });
    } catch (error) {
      log.error("[automation] 等审批通知失败:", error instanceof Error ? error.message : error);
    }
    return run;
  }

  /** 桥收到 `serverRequest/resolved` 时调用：这条请求已经被（任何客户端）处理掉了。 */
  function onRequestResolved(requestId) {
    const id = Number(requestId);
    if (!Number.isFinite(id)) return false;
    const run = state.runs.find((item) => item.status === "running" && item.awaiting && item.awaiting.requestId === id);
    if (!run) return false;
    delete run.awaiting;
    save();
    log.log(`[automation] ${run.jobName} 的等待已解决（request ${id}）`);
    return true;
  }

  /** 桥收到 `turn/completed` 时调用；等这个回合的任务从此拿到结果。 */
  function onTurnCompleted(params = {}) {
    const threadId = String(params.threadId ?? "");
    if (!threadId) return false;
    const turn = params.turn ?? null;
    const turnId = String(turn?.id ?? "");
    const statusType = String(turn?.status?.type ?? turn?.status ?? "completed");
    const outcome = statusType === "failed" || statusType === "error"
      ? { status: "failed", error: String(turn?.status?.message ?? turn?.status?.error ?? "回合失败"), summary: summarizeTurn(turn) }
      : statusType === "interrupted"
        ? { status: "interrupted", error: "回合被中断", summary: summarizeTurn(turn) }
        : { status: "ok", summary: summarizeTurn(turn) };
    const exact = turnWaiters.get(`${threadId}:${turnId}`);
    if (exact) { exact(outcome); return true; }
    // 有些通知不带 turn id（或带的是子代理的回合）：退化成"这个线程的下一个等待者"。
    for (const [key, waiter] of turnWaiters) {
      if (key.startsWith(`${threadId}:`)) { waiter(outcome); return true; }
    }
    return false;
  }

  async function execute(job, { slotId, trigger }) {
    const run = {
      id: randomUUID(),
      jobId: job.id,
      jobName: job.name,
      slotId,
      trigger,
      startedAt: now(),
      finishedAt: null,
      status: "running",
      threadId: null,
      turnId: null,
      summary: null,
      error: null,
    };
    // 先落盘再执行：这样"执行到一半桥被杀"也会在历史里留下一条 running，
    // 重启后能看出"那一轮的石沉大海不是错觉"。
    record(run);
    runningJobs.add(job.id);
    activeRuns += 1;
    log.log(`[automation] 运行 ${job.name} trigger=${trigger} slot=${slotId}`);
    try {
      const policy = permissionPolicy(job.permissionMode, job.cwd);
      let threadId = job.target?.mode === "continueThread" ? job.target.threadId : null;
      if (!threadId) {
        const started = await request("thread/start", { cwd: job.cwd });
        threadId = started?.thread?.id ?? null;
      }
      if (!threadId) throw new Error("thread/start 没有返回 thread id");
      const startedTurn = await request("turn/start", {
        threadId,
        input: [{ type: "text", text: job.prompt }],
        ...policy,
      });
      run.threadId = threadId;
      run.turnId = startedTurn?.turn?.id ?? null;
      save();
      const outcome = await waitForTurn(threadId, run.turnId, job.turnTimeoutMinutes * MINUTE_MS);
      if (outcome.status === "timeout") {
        try { await request("turn/interrupt", { threadId, turnId: run.turnId }, 20000); }
        catch (error) { log.error("[automation] 超时后中断失败:", error instanceof Error ? error.message : error); }
      }
      run.status = outcome.status;
      run.summary = outcome.summary ?? null;
      run.error = outcome.error ?? null;
    } catch (error) {
      run.status = "failed";
      run.error = error instanceof Error ? error.message : String(error);
    } finally {
      run.finishedAt = now();
      delete run.awaiting;
      runningJobs.delete(job.id);
      activeRuns -= 1;
      save();
      log.log(`[automation] ${job.name} → ${run.status}${run.error ? ` (${String(run.error).slice(0, 120)})` : ""}`);
      try {
        const ok = run.status === "ok";
        notify({
          title: ok ? "Codex ✅ 定时任务完成" : "Codex ⚠️ 定时任务需要留意",
          body: `${job.name}：${run.status}${run.summary ? ` — ${String(run.summary).slice(0, 100)}` : run.error ? ` — ${String(run.error).slice(0, 100)}` : ""}`,
          tag: "codex-status",
          threadId: run.threadId ?? undefined,
        });
      } catch (error) {
        log.error("[automation] 通知失败:", error instanceof Error ? error.message : error);
      }
    }
    return run;
  }

  function alreadyRan(jobId, slotId) {
    return state.runs.some((run) => run.jobId === jobId && run.slotId === slotId && run.status !== "skipped");
  }

  function skippedRun(job, slotId, error, extra = {}) {
    return record({
      id: randomUUID(),
      jobId: job.id,
      jobName: job.name,
      slotId,
      trigger: extra.trigger ?? "schedule",
      startedAt: extra.startedAt ?? now(),
      finishedAt: now(),
      status: "skipped",
      threadId: null,
      turnId: null,
      summary: null,
      error,
    });
  }

  async function runSlot(job, slotDate, trigger) {
    const slotId = slotKey(job.id, slotDate);
    if (alreadyRan(job.id, slotId)) {
      log.log(`[automation] 跳过重复槽 ${slotId}`);
      return null;
    }
    if (runningJobs.has(job.id)) {
      skippedRun(job, slotId, "上一次运行还没结束，这个槽被跳过", { trigger });
      return null;
    }
    return execute(job, { slotId, trigger });
  }

  /**
   * 扫一遍所有任务，把 (cursorAt, now] 之间的槽算清楚：
   * - 正常的槽：执行；
   * - 错过的槽（桥当时不在）：catchUp=runOnce 只补最新那个，其余记 skipped；catchUp=skip 全记 skipped；
   * - 并发满：这条槽记 skipped 并把游标退回一格，下次扫描再试（不假装跑过）。
   */
  async function sweep(reason = "tick") {
    if (sweeping) return { skipped: "sweep-in-progress" };
    sweeping = true;
    const current = new Date(now());
    let executed = 0;
    let missed = 0;
    try {
      for (const job of state.jobs) {
        if (!job.enabled) continue;
        let cursor = cursorOf(job);
        const slots = [];
        for (let guard = 0; guard < 400; guard++) {
          const next = computeNextRunAt(job.schedule, new Date(cursor));
          if (!next || next.getTime() > current.getTime()) break;
          slots.push(next);
          cursor = next.getTime();
        }
        if (!slots.length) {
          if (cursor !== job.cursorAt) { job.cursorAt = cursor; save(); }
          continue;
        }
        job.cursorAt = cursor;
        save();
        const stale = slots.slice(0, Math.max(0, slots.length - 1));
        const newest = slots[slots.length - 1];
        const canCatchUp = job.catchUp !== "skip";
        // "刚好到点"和"离线期间错过"要分开：扫描最多晚一个 tick（30s），
        // 再加一点余量判断这个槽还算不算"按时"。
        const graceMs = 2 * MINUTE_MS;
        const dueNow = current.getTime() - newest.getTime() <= graceMs;
        if (stale.length) {
          missed += stale.length;
          const limit = Math.min(stale.length, MISSED_RUN_AGGREGATE_LIMIT);
          for (const slot of stale.slice(stale.length - limit)) {
            skippedRun(job, slotKey(job.id, slot), canCatchUp ? "桥当时不在，只有最新的槽会补跑" : "桥当时不在，按任务设置不补跑", {
              trigger: "missed",
              startedAt: slot.getTime(),
            });
          }
          if (stale.length > limit) {
            skippedRun(
              job,
              `${job.id}@${localSlotStamp(stale[0])}..${localSlotStamp(stale[stale.length - 1])}`,
              `另有 ${stale.length - limit} 个更早的槽被折叠进这一条记录`,
              { trigger: "missed", startedAt: stale[0].getTime() },
            );
          }
        }
        // 不补跑（catchUp=skip）时，连最新那个错过也要记一笔——"不执行"不等于"不记账"。
        if (!dueNow && !canCatchUp) {
          skippedRun(job, slotKey(job.id, newest), "桥当时不在，按任务设置不补跑", { trigger: "missed", startedAt: newest.getTime() });
          continue;
        }
        const trigger = dueNow ? "schedule" : "catchup";
        if (activeRuns >= concurrency) {
          skippedRun(job, slotKey(job.id, newest), `并发上限 ${concurrency} 已满，本槽下次扫描再试`, { trigger });
          job.cursorAt = newest.getTime() - 1;
          save();
          continue;
        }
        executed += 1;
        // 不在这里 await：同一轮里有多个任务到点时，它们应该**并行**开始（FEATURES：
        // "并行任务互不阻塞"）。并发上限在 execute() 里同步占位，所以下一个任务立刻能看见。
        // 若某个任务跑很久，下一轮扫描也不会被它拖住（否则别的任务的槽会被误记成错过）。
        const launched = runSlot(job, newest, trigger);
        launched.catch((error) => log.error("[automation] 运行异常:", error instanceof Error ? error.message : error));
      }
      state.lastSweepAt = now();
      state.lastSweepReason = reason;
      save();
      return { executed, missed };
    } finally {
      sweeping = false;
    }
  }

  async function runNow(jobId) {
    const job = jobById(jobId);
    if (!job) throw new Error("找不到这个任务");
    const stamp = new Date(now());
    return execute(job, {
      slotId: `${job.id}@manual-${localSlotStamp(stamp)}-${String(stamp.getSeconds()).padStart(2, "0")}`,
      trigger: "manual",
    });
  }

  /**
   * 界面用：立刻回执，不等这个回合跑完（跑完可能要好几分钟）。
   * `execute()` 是同步先把 running 记录落盘再开始干活的，所以这里能拿到它的 id。
   */
  function startNow(jobId) {
    const job = jobById(jobId);
    if (!job) throw new Error("找不到这个任务");
    const stamp = new Date(now());
    const promise = execute(job, {
      slotId: `${job.id}@manual-${localSlotStamp(stamp)}-${String(stamp.getSeconds()).padStart(2, "0")}`,
      trigger: "manual",
    });
    promise.catch((error) => log.error("[automation] 手动运行异常:", error instanceof Error ? error.message : error));
    const latest = state.runs.find((run) => run.jobId === job.id && run.status === "running") ?? null;
    return { runId: latest?.id ?? null, slotId: latest?.slotId ?? null, status: latest?.status ?? null };
  }

  function startTimer() {
    if (timer) return;
    timer = setInterval(() => { void sweep("tick"); }, tickMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  function stopTimer() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  readStore();
  startTimer();

  return {
    startTimer,
    stopTimer,
    sweep,
    runNow,
    startNow,
    onTurnCompleted,
    onServerRequest,
    onRequestResolved,
    listJobs,
    createJob,
    updateJob,
    removeJob,
    listRuns,
    clearRuns,
    /** 界面用：调度器的真实边界与状态。 */
    snapshot() {
      return {
        now: now(),
        lastSweepAt: state.lastSweepAt,
        lastSweepReason: state.lastSweepReason,
        jobs: listJobs(),
        runs: listRuns(null, 100),
        limits: {
          concurrency,
          historyLimit,
          tickMs,
          catchUpDefault: DEFAULT_CATCH_UP,
          scheduleTypes: SCHEDULE_TYPES,
          background: "桥不在（Termux 进程被冻结/回收）时到点不会触发；桥回来后会按 catchUp 规则补账，不重复执行同一个槽",
        },
      };
    },
  };
}
