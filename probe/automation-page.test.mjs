// 定时任务页（patches/0096）的 DOM 级验证：不连桥、不连模型，用 jsdom + 假 fetch 把
// "真实数据渲染成什么"和"每个按钮真的发什么请求"钉住（用户明确禁止空按钮）。
//
//   node probe/automation-page.test.mjs
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "../app/node_modules/jsdom/lib/api.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : `  <- ${detail}`}`);
};

const appDir = resolve(fileURLToPath(new URL("../app", import.meta.url)));
const source = readFileSync(resolve(appDir, "public/app.js"), "utf8");

function slice(start, end) {
  const from = source.indexOf(start);
  const to = end === null ? source.length : source.indexOf(end, from);
  if (from < 0 || (to < 0 && end !== null)) throw new Error(`cannot locate ${start}`);
  return end === null ? source.slice(from) : source.slice(from, to);
}

const dom = new JSDOM(`<!doctype html><body>
  <strong id="settingsPlaceholderTitle"></strong>
  <small id="settingsPlaceholderDescription"></small>
  <div id="settingsPlaceholderRows"></div>
</body>`);
const { window } = dom;
const { document } = window;

const requests = [];
const toasts = [];
let confirmAnswer = true;

// 把 app.js 里那段自动化页面代码切出来，用 jsdom + 假 fetch/rpc 跑真代码。
const automationSlice = slice("function settingsRow(", "async function renderSettingsLive(");
const openedThreads = [];
let settingsClosed = 0;
/** 默认的 thread/list 桩：两条会话，名字/标题/预览三种字段各覆盖一种。 */
const defaultThreadList = async (method) => {
  if (method !== "thread/list") throw new Error("unexpected rpc " + method);
  return { data: [
    { id: "01a144af-6ae7-7623-8f95-7529eb0e0732", name: "每日构建检查" },
    { id: "01a144cb-fdf8-7592-88fa-de8570bdbb76", preview: "示例会话" },
  ] };
};
function withRealHelpers(payload, rpcImpl = defaultThreadList) {
  const fakeFetch = async (url, options = {}) => {
    requests.push({ url, method: options.method ?? "GET", body: options.body ? JSON.parse(String(options.body)) : null });
    if (!options.method || options.method === "GET") return { ok: true, status: 200, json: async () => payload };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const factory = new Function(
    "window", "document", "t", "state", "toast", "gitConfirm", "fetch", "rpc", "openThread", "closeSettings",
    `
    const $ = (selector) => document.querySelector(selector);
    ${automationSlice}
    return { renderAutomationSettings };
    `,
  );
  return factory(
    window, document, (value) => value,
    { workspaceContext: { cwd: "/data/data/com.termux/files/home/codex-gui" }, config: { defaultCwd: "/tmp" } },
    (message) => toasts.push(message),
    async () => confirmAnswer,
    fakeFetch,
    rpcImpl,
    async (threadId) => { openedThreads.push(threadId); },
    () => { settingsClosed += 1; },
  );
}

const rows = document.getElementById("settingsPlaceholderRows");
const rowsText = () => rows.textContent;
const buttons = () => [...rows.querySelectorAll("button")];

// ---- 1. 空状态：要有说明、要有创建表单、不能是一片空白 ----
requests.length = 0; toasts.length = 0;
let page = withRealHelpers({ now: Date.now(), lastSweepAt: null, lastSweepReason: "startup", jobs: [], runs: [], limits: { concurrency: 2, historyLimit: 200, tickMs: 30000, catchUpDefault: "runOnce", scheduleTypes: ["hourly", "daily", "weekdays", "weekly"], background: "桥不在（Termux 进程被冻结/回收）时到点不会触发；桥回来后会按 catchUp 规则补账，不重复执行同一个槽" } });
check("空状态渲染成功", await page.renderAutomationSettings(rows) === true);
check("空状态写明后台边界（不承诺到点一定执行）", /冻结|回收/.test(rowsText()), rowsText().slice(0, 120));
check("空状态给出调度器参数（扫描间隔/并发）", /Bridge tick|扫描间隔/.test(rowsText()) && rowsText().includes("30000ms") === false, rowsText().slice(0, 200));
check("空状态不是空白而是明确说明", /No scheduled tasks yet|还没有定时任务/.test(rowsText()), rowsText().slice(0, 200));
check("保活说明：三种机制分别写清（wake-lock / 前台服务 / JobScheduler）", /termux-wake-lock/.test(rowsText()) && /Foreground service|前台服务/.test(rowsText()) && /JobScheduler|job-scheduler/.test(rowsText()), rowsText().slice(0, 400));
check("保活说明里不承诺「永不被杀」", /not a promise that it never will be|不是「永不被杀」/.test(rowsText()), rowsText().slice(0, 500));
check("兜底唤醒不再写成「未接入」（它真在跑，见 E136）", !/Not wired up in this project|尚未接入/.test(rowsText()), rowsText().slice(0, 600));
check("有创建表单：任务名输入框", Boolean(rows.querySelector('input[placeholder="Task name"]')));
check("有创建表单：时间表选择器", rows.querySelectorAll("select").length >= 3);
check("有创建表单：time 输入", Boolean(rows.querySelector('input[type=time]')));
check("有创建表单：星期多选（7 个）", rows.querySelectorAll(".settings-day-toggle input[type=checkbox]").length === 7);
check("默认（daily）时星期多选与间隔都藏起来", rows.querySelectorAll(".settings-day-toggle")[0]?.parentElement.hidden === true && [...rows.querySelectorAll("select")].some((select) => [...select.options].some((option) => option.value === "1") && select.parentElement.hidden === true));
check("有创建按钮", buttons().some((button) => /Create task/.test(button.textContent)));

// ---- 2. 有任务 + 有记录：数据与按钮都要真 ----
const jobId = "11111111-2222-3333-4444-555555555555";
const payload = {
  now: Date.now(),
  lastSweepAt: Date.now() - 5000,
  lastSweepReason: "tick",
  jobs: [{
    id: jobId, name: "每日构建检查", prompt: "跑构建", cwd: "/data/data/com.termux/files/home/codex-gui",
    schedule: { type: "daily", time: "09:05" }, scheduleLabel: "每天 09:05", target: { mode: "newThread", threadId: null },
    permissionMode: "default", enabled: true, catchUp: "runOnce", turnTimeoutMinutes: 30,
    nextRunAt: Date.now() + 3600_000, running: false,
    lastRun: { status: "ok", startedAt: Date.now() - 7200_000, finishedAt: Date.now() - 7100_000, error: null, summary: "构建通过" },
  }],
  runs: [
    { id: "r1", jobId, jobName: "每日构建检查", slotId: `${jobId}@2026-10-16T09:05`, trigger: "schedule", status: "ok", startedAt: Date.now() - 7200_000, finishedAt: Date.now() - 7100_000, summary: "构建通过", error: null, threadId: "01a144af-6ae7-7623-8f95-7529eb0e0732" },
    { id: "r2", jobId, jobName: "每日构建检查", slotId: `${jobId}@2026-10-16T08:05`, trigger: "missed", status: "skipped", startedAt: Date.now() - 8000_000, finishedAt: Date.now(), summary: null, error: "桥当时不在，只有最新的槽会补跑", threadId: null },
  ],
  limits: { concurrency: 2, historyLimit: 200, tickMs: 30000, catchUpDefault: "runOnce", scheduleTypes: ["hourly", "daily", "weekdays", "weekly"], background: "桥不在时到点不会触发；桥回来后会补账，不重复执行同一个槽" },
};
requests.length = 0; toasts.length = 0;
rows.replaceChildren();
page = withRealHelpers(payload);
await page.renderAutomationSettings(rows);
check("任务名出现在页面上", rowsText().includes("每日构建检查"));
check("显示时间表说人话", rowsText().includes("每天 09:05"));
check("显示下次运行时间", /\d{2}:\d{2}/.test(rowsText()));
check("显示上次运行结果", /Last run: (Completed|ok)/.test(rowsText()), rowsText().slice(0, 300));
check("运行记录里有 skipped 的原因", rowsText().includes("桥当时不在"), rowsText().slice(-300));
check("三个操作按钮都在", ["Run now", "Pause", "Delete"].every((label) => buttons().some((button) => button.textContent === label)), buttons().map((button) => button.textContent).join(","));

// 运行一次 → 真的发 runNow
const runButton = buttons().find((button) => button.textContent === "Run now");
await runButton.onclick();
check("「运行一次」发出 runNow", requests.some((entry) => entry.method === "POST" && entry.body?.action === "runNow" && entry.body?.id === jobId), JSON.stringify(requests.at(-1)));
check("「运行一次」给了回执提示", toasts.length >= 1, JSON.stringify(toasts));

// 暂停 → 真的发 disable
const pauseButton = buttons().find((button) => button.textContent === "Pause");
await pauseButton.onclick();
check("「暂停」发出 disable", requests.some((entry) => entry.body?.action === "disable" && entry.body?.id === jobId), JSON.stringify(requests.at(-1)));

// 删除 → 先确认再发 remove
const deleteButton = buttons().find((button) => button.textContent === "Delete");
confirmAnswer = false;
await deleteButton.onclick();
check("取消确认后不会删任务", !requests.some((entry) => entry.body?.action === "remove"));
confirmAnswer = true;
await deleteButton.onclick();
check("确认后真的发 remove", requests.some((entry) => entry.body?.action === "remove" && entry.body?.id === jobId), JSON.stringify(requests.at(-1)));

// ---- 3. 创建表单真的提交 ----
requests.length = 0;
rows.replaceChildren();
page = withRealHelpers(payload);
await page.renderAutomationSettings(rows);
const nameInput = rows.querySelector('input[placeholder="Task name"]');
const promptInput = rows.querySelector('input[placeholder="Prompt to send each run"]');
nameInput.value = "每周巡检";
promptInput.value = "检查依赖并汇报";
const scheduleSelect = [...rows.querySelectorAll("select")].find((select) => [...select.options].some((option) => option.value === "weekly"));
scheduleSelect.value = "weekly";
scheduleSelect.dispatchEvent(new window.Event("change"));
check("切到 weekly 后星期多选出现", rows.querySelectorAll(".settings-day-toggle")[0]?.parentElement.hidden === false);
const boxes = [...rows.querySelectorAll(".settings-day-toggle input[type=checkbox]")];
boxes[0].checked = true; boxes[2].checked = true; // mon, wed
const submit = buttons().find((button) => /Create task/.test(button.textContent));
await submit.onclick();
const created = requests.find((entry) => entry.body?.action === "create");
check("创建请求发出去了", Boolean(created), JSON.stringify(requests.at(-1)));
check("创建请求带上了名字/提示词/目录", created?.body?.job?.name === "每周巡检" && created?.body?.job?.prompt === "检查依赖并汇报" && created?.body?.job?.cwd === "/data/data/com.termux/files/home/codex-gui", JSON.stringify(created?.body?.job ?? null));
check("weekly 的 days 是勾选的两天", JSON.stringify(created?.body?.job?.schedule) === JSON.stringify({ type: "weekly", time: "09:00", days: ["mon", "wed"] }), JSON.stringify(created?.body?.job?.schedule));
check("默认是新建会话", created?.body?.job?.target?.mode === "newThread");
check("默认不补跑策略是 runOnce", created?.body?.job?.catchUp === "runOnce");

// ---- 3.6 会话选择器（patches/0099）：threadId 不再要用户手抄 ----
const pickModeSelect = (scope) => [...scope.querySelectorAll("select")].find((select) => [...select.options].some((option) => option.value === "continueThread"));

requests.length = 0; toasts.length = 0;
rows.replaceChildren();
page = withRealHelpers(payload);
await page.renderAutomationSettings(rows);
const modeSelect = pickModeSelect(rows);
check("表单里有「继续某个会话」这个选项", Boolean(modeSelect));
modeSelect.value = "continueThread";
modeSelect.dispatchEvent(new window.Event("change"));
await new Promise((resolve) => setTimeout(resolve, 30));
const threadSelect = [...rows.querySelectorAll("select")].find((select) => [...select.options].some((option) => String(option.value).startsWith("01a144af")));
check("切过去之后弹出会话选择器，选项来自 thread/list", Boolean(threadSelect) && threadSelect.options.length === 2, String(threadSelect?.options?.length));
check("选项是「标题/预览 · id 前 8 位」", /每日构建检查 · 01a144af/.test(threadSelect?.options?.[0]?.textContent ?? ""), threadSelect?.options?.[0]?.textContent);
check("选项也覆盖只有预览的会话（无标题时不显示未命名）", /示例会话 · 01a144cb/.test(threadSelect?.options?.[1]?.textContent ?? ""), threadSelect?.options?.[1]?.textContent);
check("选择器可见", threadSelect.closest(".settings-write-row")?.hidden === false);
check("拉得到列表时手填框是隐藏的", rows.querySelector('input[placeholder="Conversation id"]')?.closest(".settings-write-row")?.hidden === true);

requests.length = 0;
rows.querySelector('input[placeholder="Task name"]').value = "跟进会话";
rows.querySelector('input[placeholder="Prompt to send each run"]').value = "继续汇报";
threadSelect.value = "01a144cb-fdf8-7592-88fa-de8570bdbb76";
await buttons().find((button) => /Create task/.test(button.textContent)).onclick();
const createdWithThread = requests.find((entry) => entry.body?.action === "create");
check("创建请求带上选中的会话 id", createdWithThread?.body?.job?.target?.mode === "continueThread"
  && createdWithThread?.body?.job?.target?.threadId === "01a144cb-fdf8-7592-88fa-de8570bdbb76",
  JSON.stringify(createdWithThread?.body?.job?.target ?? null));

// 拉不到会话列表：退回手填，并且说明真实原因（不能给一个空下拉框让人以为"没有会话"）
requests.length = 0; toasts.length = 0;
rows.replaceChildren();
page = withRealHelpers(payload, async () => { throw new Error("bridge said no"); });
await page.renderAutomationSettings(rows);
const failingMode = pickModeSelect(rows);
failingMode.value = "continueThread";
failingMode.dispatchEvent(new window.Event("change"));
await new Promise((resolve) => setTimeout(resolve, 30));
const manualInput = rows.querySelector('input[placeholder="Conversation id"]');
check("拉不到列表时退回手填", manualInput?.closest(".settings-write-row")?.hidden === false);
check("并把真实原因写出来", /bridge said no/.test(rowsText()), rowsText().slice(-260));

rows.querySelector('input[placeholder="Task name"]').value = "手填会话";
rows.querySelector('input[placeholder="Prompt to send each run"]').value = "继续汇报";
manualInput.value = "";
await buttons().find((button) => /Create task/.test(button.textContent)).onclick();
check("没选会话就提交会被拦下（并提示先选）", toasts.some((message) => /Pick a conversation first|先选一个会话/.test(message)) && !requests.some((entry) => entry.body?.action === "create"), JSON.stringify(toasts));
manualInput.value = "01a144af-6ae7-7623-8f95-7529eb0e0732";
await buttons().find((button) => /Create task/.test(button.textContent)).onclick();
check("手填的 id 也能提交", requests.some((entry) => entry.body?.job?.target?.threadId === "01a144af-6ae7-7623-8f95-7529eb0e0732"), JSON.stringify(requests.at(-1)?.body?.job?.target ?? null));

// 任务行把"继续哪个会话"标出来（只显示 id 前 8 位，不假装知道标题）
rows.replaceChildren();
page = withRealHelpers({ ...payload, jobs: [{ ...payload.jobs[0], target: { mode: "continueThread", threadId: "01a144af-6ae7-7623-8f95-7529eb0e0732" } }] });
await page.renderAutomationSettings(rows);
check("任务行标出「继续会话 <id8>」", /Continues 01a144af|继续会话 01a144af/.test(rowsText()), rowsText().slice(0, 320));

// ---- 3.5 兜底唤醒：状态来自 /api/automation 的 wake 字段，缺了要能一键补装 ----
requests.length = 0;
rows.replaceChildren();
page = withRealHelpers({ ...payload, wake: { installed: true, scriptExists: true, jobId: "4711", jobs: ["Pending Job 4711: /…/codex-gui-watchdog (periodic: 900000ms)"], lastRun: "2026-10-16 21:38:26 wake-lock ok", runCount: 136 } });
await page.renderAutomationSettings(rows);
check("兜底唤醒显示为已注册（真值）", /Registered|已注册/.test(rowsText()), rowsText().slice(0, 400));
check("兜底唤醒显示最近一次运行时间", /2026-10-16 21:38:26/.test(rowsText()), rowsText().slice(0, 500));
check("如实写出 15 分钟这个下限（不假装能调）", /15 minutes|15 分钟/.test(rowsText()), rowsText().slice(0, 700));

requests.length = 0;
rows.replaceChildren();
page = withRealHelpers({ ...payload, wake: { installed: false, scriptExists: true, jobId: "4711", jobs: [], lastRun: null } });
await page.renderAutomationSettings(rows);
const register = buttons().find((button) => /Register now|立即注册/.test(button.textContent));
check("没注册时给出补装按钮", Boolean(register), buttons().map((b) => b.textContent).join(","));
await register.onclick();
check("补装按钮真的发 wakeInstall", requests.some((entry) => entry.body?.action === "wakeInstall"), JSON.stringify(requests.at(-1)));

requests.length = 0;
rows.replaceChildren();
page = withRealHelpers({ ...payload, wake: { installed: false, scriptExists: false, jobId: "4711", jobs: [], lastRun: null } });
await page.renderAutomationSettings(rows);
check("连脚本都没有时不显示补装按钮（不假装能装）", !buttons().some((button) => /Register now|立即注册/.test(button.textContent)) && /Wake script missing|唤醒脚本不存在/.test(rowsText()), rowsText().slice(0, 400));

// ---- 3.7 等审批的运行要看得出来，并且能一键跳进那条会话（patches/0100）----
openedThreads.length = 0; settingsClosed = 0;
rows.replaceChildren();
page = withRealHelpers({ ...payload, runs: [
  { ...payload.runs[0], status: "running", finishedAt: null, summary: null, awaiting: { kind: "approval", method: "item/commandExecution/requestApproval", requestId: 77, at: Date.now() } },
  payload.runs[1],
] });
await page.renderAutomationSettings(rows);
check("运行记录里标出「等待你审批」", /Waiting for your approval|等待你审批/.test(rowsText()), rowsText().slice(-400));
const openButton = buttons().find((button) => /Open conversation|打开会话/.test(button.textContent));
check("带 threadId 的运行有「打开会话」按钮", Boolean(openButton), buttons().map((b) => b.textContent).join(","));
await openButton.onclick();
check("点它会先关掉设置、再打开那条会话", settingsClosed === 1 && openedThreads[0] === payload.runs[0].threadId, JSON.stringify({ settingsClosed, openedThreads }));

// ---- 4. 桥读不到时要有明确的错误，而不是空白 ----
requests.length = 0;
rows.replaceChildren();
const failing = (() => {
  const factory = new Function(
    "window", "document", "t", "state", "toast", "gitConfirm", "fetch",
    `const $ = (selector) => document.querySelector(selector);\n${automationSlice}\nreturn { renderAutomationSettings };`,
  );
  return factory(window, document, (value) => value, { workspaceContext: {}, config: {} }, () => {}, async () => true,
    async () => ({ ok: false, status: 500, json: async () => ({ error: "bridge is down" }) }));
})();
check("桥出问题时渲染仍算处理过", await failing.renderAutomationSettings(rows) === true);
check("桥出问题时给出真实原因", /bridge is down/.test(rowsText()) || /Could not read|读不到/.test(rowsText()), rowsText().slice(0, 200));

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
