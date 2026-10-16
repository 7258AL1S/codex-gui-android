import { accessSync, chmodSync, constants as fsConstants, copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, extname } from "node:path";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { networkInterfaces, tmpdir } from "node:os";
import { WebSocketServer, WebSocket } from "ws";
import { defaultBrowseRoots, isDirectory, listFolders, resolveBrowsePath } from "./folder-service.js";
import { applyReviewPatch } from "./review-service.js";
// Git 没有协议方法：暂存/提交/拉取/推送/worktree 由桥调用 git 实现（见该文件头部的职责边界）。
import { GitError, gitDispatch } from "./git-service.js";
import { ReviewDiffStore, parseReviewPatchRequest } from "./review-state.js";
import { createRequestRegistry } from "./request-registry.js";
// 定时任务/持续跟进：协议里没有任何调度方法，调度、持久化、漏跑补跑都由桥自己实现（P8）。
import { createAutomationService } from "./automation-service.js";
// 交互式终端：app-server 的 `command/exec{tty:true}`（协议里的真 PTY），不再用 node-pty。
import { createProtocolTerminalSession, failAllProtocolTerminals, handleProtocolTerminalDelta } from "./protocol-terminal.js";
import { unifiedDiffFromFileChanges } from "./public/codex-surfaces.js";
import { rpcErrorPayload } from "./public/bridge-errors.js";
import { normalizeTerminalResize, resolveTerminalCwd } from "./terminal-service.js";
import { readWorkspaceContext } from "./workspace-context.js";
import { searchWorkspaceFiles } from "./file-search.js";
import { resolveLocalFile } from "./file-service.js";
import { resolveLocalImage } from "./image-service.js";
import { createUploadPruner, saveUpload, saveUploadStream, UPLOAD_MAX_BYTES } from "./upload-service.js";
import { LiveSessionStore } from "./live-session-service.js";
import {
  createPasswordSession,
  createStoredPassword,
  isAllowedBrowserRpcMethod,
  isAuthorizedHttpRequest,
  isRequestAuthorized,
  passwordSessionCookie,
  resolvePublicAsset,
  resolveSafeRegularFile,
  storedPasswordSessionSecret,
  unauthorizedResponse,
  verifyStoredPassword,
} from "./server-security.js";
import { loadStoredPassword, passwordStorePath, saveStoredPassword, type StoredPassword } from "./password-store.js";
import {
  createAccountIdentityLoader,
  fetchProfileAvatar,
  isLocalAccountRequest,
  resolveAccountIdentity,
  toPublicAccountIdentity,
} from "./profile-service.js";

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8899);
const defaultPort = !process.env.PORT;
const accessToken = process.env.CODEX_WEBUI_ACCESS_TOKEN || null;
const environmentPassword = process.env.CODEX_WEBUI_PASSWORD || null;
const managedPasswordPath = passwordStorePath();
let managedPassword: StoredPassword | null = environmentPassword || accessToken ? null : loadStoredPassword(managedPasswordPath);
let authSecret = environmentPassword || accessToken || storedPasswordSessionSecret(managedPassword);
let passwordSetupInProgress = false;
const localhostOnly = host === "127.0.0.1" || host === "::1" || host === "localhost";
const appRoot = existsSync(resolve(import.meta.dir, "public")) ? import.meta.dir : resolve(import.meta.dir, "..");
const publicDir = resolve(appRoot, "public");
const homeDir = process.env.HOME || process.cwd();
const projectless = process.env.CODEX_WEBUI_PROJECTLESS === "true";
const configuredReviewRoot = process.env.CODEX_WEBUI_REVIEW_ROOT || null;
const ntfyTopic = process.env.CODEX_WEBUI_NTFY_TOPIC || null;
const ntfyUrl = (process.env.CODEX_WEBUI_NTFY_URL || "https://ntfy.sh").replace(/\/+$/, "");
// Shared app-server: the bridge hosts ONE app-server instance over WebSocket so
// that other clients (the CLI TUI via `codex --remote`) can attach to the same
// live state instead of getting a private stdio instance.
const appServerWsPort = Number(process.env.CODEX_WEBUI_WS_PORT || port + 2);
// `--listen` rejects a trailing slash; WebSocket clients are fine with one.
const appServerListenUrl = `ws://127.0.0.1:${appServerWsPort}`;
const appServerWsUrl = `${appServerListenUrl}/`;
const appServerStateDir = resolve(homeDir, ".codex", "codex-webui");
const appServerTokenPath = resolve(appServerStateDir, "ws-token");
const appServerLauncherPath = resolve(homeDir, "bin", "codex-gui");
if (projectless && !configuredReviewRoot) {
  throw new Error("CODEX_WEBUI_REVIEW_ROOT is required when CODEX_WEBUI_PROJECTLESS=true");
}
const defaultCwd = resolve(process.env.CODEX_WEBUI_CWD || (projectless ? homeDir : appRoot));
const browseRoots = defaultBrowseRoots(homeDir);
// 文件面板的额外根（默认空；不动用户任何配置，只是留一个口子）。
const extraFileRoots = (process.env.CODEX_WEBUI_FILE_ROOTS || "").split(":").filter(Boolean).map((entry) => resolve(entry));
// 手机上打开 2 MB 以上的文本没有意义（渲染会卡死），写入同理。
const FILE_READ_MAX_BYTES = 2 * 1024 * 1024;
const FILE_WRITE_MAX_BYTES = 2 * 1024 * 1024;
const imageRoots = [...new Set([...browseRoots, resolve(tmpdir()), resolve("/tmp")])];
const fileRoots = [...new Set([...browseRoots, defaultCwd, resolve(tmpdir()), resolve("/tmp")])];
// 撤销会写文件，所以允许根必须覆盖「用户真实的工作区」——只取 defaultCwd 会让
// 绝大多数项目的撤销以 `outside allowed roots` 失败（真机撞上，见 E122）。
const reviewRoots = [...new Set([resolve(configuredReviewRoot || defaultCwd), ...browseRoots, ...extraFileRoots])];
// Files the browser picked with the system chooser land here. It sits under the
// state dir on purpose: `homeDir` is already an allowed root for /api/images/local,
// so an uploaded screenshot renders in the transcript without widening that list.
const uploadDir = resolve(appServerStateDir, "uploads");
const uploadBodyLimit = Math.ceil((UPLOAD_MAX_BYTES * 4) / 3) + 64 * 1024;
const pruneUploads = createUploadPruner(uploadDir);
const clients = new Set<WebSocket>();
const sseClients = new Set<ServerResponse>();
const terminalSessions = new Map<WebSocket, ReturnType<typeof createTerminalSession>>();
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
const reviewDiffs = new ReviewDiffStore();
// Server → client requests (approvals, elicitations, questions) that are still
// waiting for an answer. Lets a second or late answer be rejected instead of
// being forwarded into a request id the server has already resolved.
const requestRegistry = createRequestRegistry();
const liveSessions = new LiveSessionStore();
const threadPaths = new Map<string, string>();

// P8：定时任务的调度器。存储落在桥自己的状态目录里（和 uploads/ws-token 同一个家），
// 不碰用户的 config.toml / 凭据 / 历史。
const automationStorePath = resolve(appServerStateDir, "automation.json");

// 兜底唤醒（P8）的真实机制：termux-job-scheduler 里挂着一个 15 分钟周期的作业，
// 跑 `~/bin/codex-gui-watchdog`（补唤醒锁 + 桥不在就拉起来）。这不是"计划"，是**已在跑**的东西
// —— 2026-10-16 实测：watchdog.log 每小时 6~8 拍，21:38:26 那次正好在桥被我停掉时把它拉了起来。
// 桥这里只负责"说实话"：读作业列表 + watchdog 日志，必要时补装。
const automationWakeScript = resolve(homeDir, "bin", "codex-gui-watchdog");
const automationWakeLogPath = resolve(appServerStateDir, "watchdog.log");
const AUTOMATION_WAKE_JOB_ID = "4711";
let automationWakeCache: { at: number; value: any } | null = null;

async function automationWakeStatus(force = false) {
  if (!force && automationWakeCache && Date.now() - automationWakeCache.at < 30_000) return automationWakeCache.value;
  const value: any = {
    script: automationWakeScript,
    scriptExists: existsSync(automationWakeScript),
    jobId: AUTOMATION_WAKE_JOB_ID,
    installed: false,
    jobs: [],
    lastRun: null,
  };
  try {
    const output = execFileSync("termux-job-scheduler", ["-p"], { timeout: 6000, encoding: "utf8" });
    value.jobs = output.split("\n").map((line) => line.trim()).filter(Boolean);
    value.installed = value.jobs.some((line) => line.includes(automationWakeScript));
  } catch (error) {
    value.error = error instanceof Error ? error.message : String(error);
  }
  try {
    // 只认带时间戳的作业行：watchdog 会把 `codex-gui-web start` 的输出也写进同一个文件，
    // 直接取最后两行会显示成"已经在跑（pid …）"这种没头没尾的片段。
    const lines = readFileSync(automationWakeLogPath, "utf8").split("\n")
      .map((line) => line.trim())
      .filter((line) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} /.test(line));
    const last = lines.slice(-2);
    value.lastRun = last.length ? last.join(" ／ ") : null;
    value.runCount = lines.length;
  } catch { /* 还没跑过就没有 */ }
  automationWakeCache = { at: Date.now(), value };
  return value;
}

function installAutomationWake() {
  if (!existsSync(automationWakeScript)) throw new Error(`找不到 ${automationWakeScript}`);
  execFileSync("termux-job-scheduler", [
    "--script", automationWakeScript,
    "--job-id", AUTOMATION_WAKE_JOB_ID,
    "--period-ms", "900000",
    "--persisted", "true",
    "--network", "any",
  ], { timeout: 20000 });
}

// ---------------------------------------------------------------------------
// 启动自检（P9 的"首次配置引导"，E139）
//
// 为什么放在桥里：一次成功的启动取决于**两侧**的事实 ——
//   Android 侧（Termux 装了吗、RUN_COMMAND 授权了吗、通知权限、前台服务）只有应用知道；
//   Termux 侧（启动脚本在不在、termux-api 有没有、codex 什么版本、状态目录能不能写）只有桥知道。
// 所以：应用启动时把它那半 POST 过来（内存里存着，带时间戳），桥把自己那半现查，
// `GET /api/setup` 合成一张清单。**查不到就说查不到**（比如应用还没上报过），不猜。
// ---------------------------------------------------------------------------
let androidSelfReport: { at: number; facts: any } | null = null;
const ANDROID_REPORT_TTL_MS = 30 * 60 * 1000;

/**
 * 找命令：直接按 Termux 的两个 bin 目录解析。
 *
 * **不要用 `which`** —— 本机（Termux）根本没有 `which`，`execFileSync("which", …)` 抛错被 catch 吞掉，
 * 结果每一项都变成 null，看上去像"termux-api 全没装"（2026-10-16 实测踩到，第一次跑自检就中招）。
 */
function commandPath(name: string): string | null {
  const prefixBin = resolve(process.env.PREFIX ?? resolve(homeDir, "usr"), "bin");
  for (const candidate of [resolve(homeDir, "bin", name), resolve(prefixBin, name)]) {
    try { if (existsSync(candidate)) return candidate; } catch { /* 读不到就当没有 */ }
  }
  return null;
}

async function setupStatus() {
  const launcher = appServerLauncherPath;
  let launcherExecutable = false;
  try { accessSync(launcher, fsConstants.X_OK); launcherExecutable = true; } catch { /* 不存在或不可执行 */ }
  let stateWritable = false;
  try { accessSync(appServerStateDir, fsConstants.W_OK); stateWritable = true; } catch { /* 目录还没建或不可写 */ }

  let codexVersion: string | null = null;
  try {
    const probe = spawnSync("codex", ["--version"], { encoding: "utf8", timeout: 8000 });
    if (probe.status === 0 && probe.stdout) codexVersion = probe.stdout.trim().split("\n")[0];
  } catch { /* codex 不在 PATH 上也如实写 null */ }

  const fresh = androidSelfReport && Date.now() - androidSelfReport.at < ANDROID_REPORT_TTL_MS;
  return {
    checkedAt: Date.now(),
    bridge: {
      ready: connected && !shuttingDown,
      port,
      appServer: appServerListenUrl,
      launcher,
      tokenPath: appServerTokenPath,
    },
    termux: {
      os: "termux",
      runtime: { bun: (process.versions as any).bun ?? null, node: process.versions.node },
      // 两个脚本别混：`codex-gui-web` 是应用请 Termux 跑的**启动桥**脚本；
      // `codex-gui` 是把 CLI 接到同一个 app-server 上的启动器。
      bridgeScript: { path: resolve(homeDir, "bin", "codex-gui-web"), exists: existsSync(resolve(homeDir, "bin", "codex-gui-web")) },
      cliLauncher: { path: launcher, exists: existsSync(launcher), executable: launcherExecutable },
      termuxApi: {
        wakeLock: commandPath("termux-wake-lock"),
        notification: commandPath("termux-notification"),
        jobScheduler: commandPath("termux-job-scheduler"),
        toast: commandPath("termux-toast"),
      },
      codex: { version: codexVersion },
      stateDir: { path: appServerStateDir, writable: stateWritable },
      automationStore: { path: automationStorePath, exists: existsSync(automationStorePath) },
      wake: await automationWakeStatus(),
    },
    android: fresh && androidSelfReport
      ? { at: androidSelfReport.at, facts: androidSelfReport.facts }
      : { at: null, facts: null, note: "应用最近没有上报自检信息（打开一次应用就会上报）" },
  };
}

const automation = createAutomationService({
  storePath: automationStorePath,
  request: (method: string, params: any = {}, timeoutMs = 60000) => request(method, params, timeoutMs),
  notify: (payload: { title: string; body: string; tag: string; threadId?: string }) => {
    // 与 /api/notify 同一条出口：应用在跑就发原生通知，否则退回 Termux 通知。
    const native = nativeNotifierCount() > 0;
    if (native) sendNativeNotification(payload);
    else notifyViaTermux(payload);
    console.log(`[codex-webui] automation notify: ${native ? "native(app)" : "termux"} ${payload.title} — ${payload.body.slice(0, 60)}`);
  },
});
let codexSessionsRoot = resolve(homeDir, ".codex", "sessions");
// Containment for "is this rollout ours" must be the whole Codex home, not just
// `sessions/`: archived threads live in `archived_sessions/`, and checking only
// the sessions dir made every archived thread look like an intruder (E68).
let codexHomeRoot = resolve(homeDir, ".codex");
// path -> { size, mtimeMs, buf } for gzipped static assets (see the static handler).
// mtimeMs is load-bearing: two builds can have the exact same byte length (a rebuild that
// only touches two digits), and a size-only check then replays the previous build's bytes
// forever — which looks exactly like "my change never reached the browser" (E120).
const gzipCache = new Map<string, { size: number; mtimeMs: number; buf: Buffer }>();
// Changes on every bridge start. Used to version the entry script and to stamp the
// page so "which build is the browser running?" is never a guess again (E86).
const codexBuildId = String(Date.now());

// Which browser asked for a page? Added after a round where an old tab and a fresh
// load produced interleaved logs and neither side could be told apart (E86).
function shortUa(req: IncomingMessage): string {
  return String(req.headers["user-agent"] || "-").replace(/\s+/g, " ").slice(0, 56);
}

// Inline beacon injected into index.html. It fires before any module is fetched, so
// "the HTML arrived and ran" and "the bundle arrived and ran" become separate facts.
function inlineBootBeacon(): string {
  return `<script>try{window.__codexBootBuild="${codexBuildId}";fetch('/api/client-log',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:'html-boot build=${codexBuildId}',build:'${codexBuildId}'})}).catch(function(){})}catch(error){}</script>`;
}

// index.html is reachable through two branches (the auth wall and the normal static
// path). Both must produce the same document, or "which build is the browser running?"
// gets a different answer depending on how the page was opened (E86).
function stampIndexHtml(body: Buffer): Buffer {
  return Buffer.from(String(body)
    .replace('src="/auth-bootstrap.js"', `src="/auth-bootstrap.js?v=${codexBuildId}"`)
    .replace("</head>", `${inlineBootBeacon()}<meta name="codex-build" content="${codexBuildId}"></head>`), "utf8");
}

// 启动阶段打点（E124）：`START +Nms <阶段>`——「启动慢」时先看这里，别靠事后拼时间线。
const bootStartedAt = Date.now();
function startMark(label: string) {
  console.log(`[codex-webui] START +${Date.now() - bootStartedAt}ms ${label}`);
}
let seq = 1;
let codex: ChildProcess | null = null;
let appServerSocket: WebSocket | null = null;

// The bridge is one event loop: any long synchronous call (gzip, execFileSync, a huge
// JSON.stringify) delays every other request, which from the phone looks like "the
// page is stuck" with no clue in the log. This makes such a stall self-announcing.
// Raised in the 2026-10-14 round after client lines arrived in bursts and neither
// side could be blamed for the delay (E87).
let lastLoopTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const late = now - lastLoopTick - 500;
  if (late > 500) console.error(`[codex-webui] event loop blocked for ~${late}ms`);
  lastLoopTick = now;
}, 500).unref();
let appServerReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let appServerConnectAttempts = 0;
let stdoutBuffer = "";
let connected = false;
let shuttingDown = false;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let httpClosed = false;
const accountLoader = createAccountIdentityLoader(async (refresh) => {
  const account = await request("account/read", { refreshToken: refresh });
  return resolveAccountIdentity(account);
});

function ensureAppServerToken() {
  try {
    mkdirSync(appServerStateDir, { recursive: true, mode: 0o700 });
    const existing = existsSync(appServerTokenPath) ? readFileSync(appServerTokenPath, "utf8").trim() : "";
    if (existing) {
      chmodSync(appServerTokenPath, 0o600);
      return existing;
    }
    const token = randomBytes(32).toString("hex");
    writeFileSync(appServerTokenPath, token + "\n", { mode: 0o600 });
    return token;
  } catch (error) {
    console.error("[codex-webui] cannot prepare app-server token", error);
    throw error;
  }
}

// A launcher so the CLI can attach to the SAME app-server instance without the
// user ever typing the WebSocket URL or the capability token.
function installLauncherScript() {
  // A throwaway instance on another port must not rewrite the launcher the user
  // relies on — that happened once (a test bridge on 8893 left `codex-gui`
  // pointing at 8893/8895). Only the default port owns that filename.
  if (!defaultPort) return;
  const body = `#!/data/data/com.termux/files/usr/bin/sh
# Generated by codex-webui — do not edit the installed copy, edit the generator.
#
# Opens the Codex CLI TUI attached to THIS bridge's app-server instance, so the
# terminal and the browser share one live session instead of two competing ones
# (see VERIFICATION.md E46). Starts the bridge first if it is not running.
#
#   codex-gui                 # new CLI session in the shared instance
#   codex-gui resume <id>     # continue a thread the browser can also see
set -e
HEALTH="http://127.0.0.1:${port}/api/health"
if ! curl -s -m 2 "$HEALTH" | grep -q '"ready":true'; then
  echo "codex-gui: 桥未运行，正在启动…" >&2
  "$HOME/bin/codex-gui-web" start >&2 || {
    echo "codex-gui: 桥启动失败。排查：codex-gui-web status / codex-gui-web log" >&2
    exit 1
  }
fi
if ! curl -s -m 2 "$HEALTH" | grep -q '"ready":true'; then
  echo "codex-gui: 桥起来了但 app-server 还没接上，先不要在这里开工。" >&2
  echo "codex-gui: 若坚持用普通 codex，会是与浏览器互相看不见的另一个实例（E46）。" >&2
  exit 1
fi
TOKEN="$(cat ${appServerTokenPath})"
export CODEX_WEBUI_WS_TOKEN="$TOKEN"
exec codex --remote ${appServerWsUrl} --remote-auth-token-env CODEX_WEBUI_WS_TOKEN "$@"
`;
  try {
    mkdirSync(resolve(homeDir, "bin"), { recursive: true });
    const current = existsSync(appServerLauncherPath) ? readFileSync(appServerLauncherPath, "utf8") : "";
    if (current !== body) writeFileSync(appServerLauncherPath, body, { mode: 0o700 });
    chmodSync(appServerLauncherPath, 0o700);
  } catch (error) {
    console.error("[codex-webui] cannot install launcher", error);
  }
}

function consumeAppServerFrames(chunk: string) {
  stdoutBuffer += chunk;
  for (;;) {
    const pos = stdoutBuffer.indexOf("\n");
    if (pos < 0) break;
    const line = stdoutBuffer.slice(0, pos).trim();
    stdoutBuffer = stdoutBuffer.slice(pos + 1);
    if (!line) continue;
    try { handleCodex(JSON.parse(line)); }
    catch (error) { console.error("[codex-webui] invalid app-server JSON:", line, error); }
  }
  // WebSocket frames usually carry exactly one JSON message; handle the
  // no-trailing-newline case as well.
  const rest = stdoutBuffer.trim();
  if (rest.startsWith("{") && rest.endsWith("}")) {
    try { JSON.parse(rest); } catch { return; }
    stdoutBuffer = "";
    try { handleCodex(JSON.parse(rest)); }
    catch (error) { console.error("[codex-webui] invalid app-server JSON:", rest, error); }
  }
}

function connectAppServerSocket(token: string) {
  if (shuttingDown) return;
  if (appServerSocket && (appServerSocket.readyState === WebSocket.OPEN || appServerSocket.readyState === WebSocket.CONNECTING)) return;
  const socket = new WebSocket(appServerWsUrl, { headers: { Authorization: `Bearer ${token}` } });
  appServerSocket = socket;
  socket.on("open", () => {
    startMark("bridge↔app-server socket open; sending initialize");
    stdoutBuffer = "";
    appServerConnectAttempts = 0;
    appServerSpawnFailures = 0;
    initialize().catch((error) => {
      console.error("[codex-webui] initialize failed", error);
      try { socket.close(); } catch { /* ignore */ }
    });
  });
  socket.on("message", (raw) => consumeAppServerFrames(String(raw)));
  socket.on("error", () => { /* handled by the close handler below */ });
  socket.on("close", () => {
    if (appServerSocket === socket) appServerSocket = null;
    // 终端的 PTY 是连接作用域的：这条连接一断，服务端就把进程杀了。
    // 页面要看到明确的结束语，而不是永远停在最后一帧。
    failAllProtocolTerminals("app-server connection closed");
    if (shuttingDown) return;
    // If we had adopted a pre-existing app-server (no child of our own) and that
    // instance went away, there is nothing to reconnect to — spawn our own
    // instead of sitting there permanently disconnected.
    if (!codex || codex.exitCode !== null) {
      restartTimer = setTimeout(startCodex, 500);
      return;
    }
    if (appServerSocket || appServerReconnectTimer) return;
    if (appServerConnectAttempts >= 5) {
      console.error("[codex-webui] giving up reconnecting to the app-server socket");
      return;
    }
    const delay = 500 * 2 ** appServerConnectAttempts;
    appServerConnectAttempts += 1;
    appServerReconnectTimer = setTimeout(() => {
      appServerReconnectTimer = null;
      try { connectAppServerSocket(token); } catch (error) { console.error("[codex-webui] reconnect failed", error); }
    }, delay);
  });
}

// 单飞闸门：adopt 有 1.2 秒等待窗口，这期间 `codex` 仍是 null；而页面重连时会不断发 RPC
// （`sendRaw` 发现未连接就会调 startCodex）——不加闸门就会并发开出多轮 adopt→spawn，
// 几个 app-server 抢同一个端口，桥的兜底逻辑还会把**自己正在用的**那个杀掉再重起。
// 用户点开 App 的那一刻正是这种状态，表现得就是"启动桥很慢，一直等待"（E124）。
let bridgeStartInFlight = false;
function startCodex() {
  if (shuttingDown) return;
  if (codex && codex.exitCode === null) {
    if (!appServerSocket) connectAppServerSocket(ensureAppServerToken());
    return;
  }
  if (bridgeStartInFlight) return;
  bridgeStartInFlight = true;
  const token = ensureAppServerToken();
  installLauncherScript();
  // Uploads are a cache, not an archive (see upload-service.js).
  pruneUploads(true);
  // If an app-server from an earlier bridge run is still listening (the child is
  // detached, so it can outlive the bridge), adopt it instead of failing to bind
  // the port. Verified on this machine: a stale instance kept 8901 occupied and
  // the naive spawn loop crash-cycled with "Address already in use".
  startMark("startCodex: adopting an existing app-server");
  void adoptExistingAppServer(token)
    .then((adopted) => {
      startMark(`adopt resolved adopted=${adopted}`);
      if (adopted || shuttingDown) return;
      spawnAppServer(token);
    })
    .finally(() => { bridgeStartInFlight = false; });
}

function adoptExistingAppServer(token: string) {
  return new Promise<boolean>((resolvePromise) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolvePromise(ok);
    };
    // fast adopt probe：先问一句"端口上有人吗"。没人就立刻认输去 spawn——
    // 老的实现是拿 WebSocket 干等 1.2 秒，冷启动每次都要付这笔（E124）。
    const readyz = `http://127.0.0.1:${appServerWsPort}/readyz`;
    fetch(readyz, { signal: AbortSignal.timeout(500) })
      .then((response) => {
        if (!response.ok) return finish(false);
        startMark("adopt probe: an app-server answers /readyz");
        appServerConnectAttempts = 0;
        connectAppServerSocket(token);
        const deadline = Date.now() + 1500;
        const poll = () => {
          if (appServerSocket && appServerSocket.readyState === WebSocket.OPEN) return finish(true);
          if (Date.now() > deadline) return finish(false);
          setTimeout(poll, 50);
        };
        poll();
      })
      .catch(() => finish(false));
  });
}

let appServerSpawnFailures = 0;

/**
 * A previous bridge can leave its app-server behind: it keeps the WebSocket port
 * and (once it has received a signal) answers every request with
 * "Server is draining", so the next bridge can neither adopt nor bind it.
 * Only kills processes that are unmistakably ours — same port AND same token
 * file — so an unrelated server on the same port is left alone.
 */
function killStaleAppServerOnOurPort(): number {
  try {
    const pattern = `app-server --listen ws://127.0.0.1:${appServerWsPort} --ws-auth capability-token --ws-token-file ${appServerTokenPath}`;
    const out = execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" });
    let killed = 0;
    for (const line of out.split("\n")) {
      const pid = Number(line.trim());
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) continue;
      if (codex && pid === codex.pid) continue;
      try { process.kill(pid, "SIGKILL"); killed += 1; } catch { /* already gone */ }
    }
    return killed;
  } catch {
    return 0; // pgrep exits non-zero when nothing matches
  }
}

/**
 * 端口一可用就连上——**不要**等孩子的 stdout 打印 "listening on"：
 * 管道下的 stdout 是块缓冲，那行字可能晚 6 秒才到（E124 实测），而端口早就能用了。
 */
function watchForAppServer(token: string) {
  const deadline = Date.now() + 20000;
  const tick = () => {
    if (shuttingDown) return;
    if (appServerSocket && (appServerSocket.readyState === WebSocket.OPEN || appServerSocket.readyState === WebSocket.CONNECTING)) {
      return void setTimeout(tick, 200);
    }
    if (Date.now() > deadline) return;
    // 忽略退避：孩子就在本机，端口开了就该连；退避是给"服务端挂了"用的。
    appServerConnectAttempts = 0;
    if (appServerReconnectTimer) { clearTimeout(appServerReconnectTimer); appServerReconnectTimer = null; }
    connectAppServerSocket(token);
    setTimeout(tick, 200);
  };
  setTimeout(tick, 120);
}
function spawnAppServer(token: string) {
  startMark("spawning the app-server");
  if (shuttingDown) return;
  const child = spawn("codex", [
    "app-server",
    "--listen", appServerListenUrl,
    "--ws-auth", "capability-token",
    "--ws-token-file", appServerTokenPath,
  ], {
    cwd: defaultCwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  codex = child;
  connected = false;
  stdoutBuffer = "";
  // 不等 stdout（块缓冲会晚到），直接探端口。
  watchForAppServer(token);
  appServerConnectAttempts = 0;
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (data) => {
    const text = String(data);
    console.log("[codex app-server]", text.trimEnd());
    // Connect only once the listener is actually up (avoids reconnect storms).
    if (text.includes("listening on")) {
      // connect immediately, the child is up（不等退避：adopt 那次失败会把退避拉到 2s/4s）
      appServerConnectAttempts = 0;
      if (appServerReconnectTimer) { clearTimeout(appServerReconnectTimer); appServerReconnectTimer = null; }
      try { if (appServerSocket && appServerSocket.readyState !== WebSocket.OPEN) appServerSocket.close(); } catch { /* ignore */ }
      appServerSocket = null;
      startMark("app-server reported listening; connecting the socket");
      connectAppServerSocket(token);
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (data) => {
    const text = String(data);
    console.error("[codex app-server]", text.trimEnd());
    if (text.includes("Address already in use")) {
      console.error(
        `[codex-webui] port ${appServerWsPort} is held by another app-server that this bridge could not adopt `
        + "(different token?). Find it with: pgrep -f 'listen ws://127.0.0.1:" + appServerWsPort + "'",
      );
      const killed = killStaleAppServerOnOurPort();
      if (killed > 0) {
        console.error(`[codex-webui] killed ${killed} stale app-server(s) holding port ${appServerWsPort}; will retry`);
      }
    }
  });
  child.on("exit", (code, signal) => {
    connected = false;
    if (appServerReconnectTimer) { clearTimeout(appServerReconnectTimer); appServerReconnectTimer = null; }
    try { appServerSocket?.close(); } catch { /* ignore */ }
    appServerSocket = null;
    accountLoader.invalidate();
    reviewDiffs.clear();
    broadcast({ type: "bridge/status", status: "disconnected", code, signal });
    for (const item of pending.values()) item.reject(new Error("Codex app-server exited"));
    pending.clear();
    if (codex === child) codex = null;
    if (shuttingDown) maybeFinishShutdown();
    else {
      // Back off when the child keeps dying immediately (e.g. port conflict),
      // otherwise the restart loop floods the log.
      appServerSpawnFailures += 1;
      const delay = Math.min(1000 * 2 ** Math.min(appServerSpawnFailures - 1, 5), 30000);
      if (appServerSpawnFailures === 5) {
        console.error(`[codex-webui] app-server keeps exiting; slowing restarts to ${delay}ms`);
      }
      restartTimer = setTimeout(startCodex, delay);
    }
  });
  // Safety net in case the readiness banner never shows up.
  appServerReconnectTimer = setTimeout(() => {
    appServerReconnectTimer = null;
    if (!appServerSocket) connectAppServerSocket(token);
  }, 6000);
}

/**
 * 服务端在排空（draining）时，端口与 HTTP 都还在，但每个请求都会被拒。
 * 这不是"能用的连接"，所以 `ready` 必须变成 false，并把实例重建（E54 的根治）。
 */
let drainRestartAt = 0;
function restartAppServerAfterDrain(reason: string) {
  const now = Date.now();
  if (now - drainRestartAt < 10000) return; // 抖动保护：连环 draining 只重启一次
  drainRestartAt = now;
  console.warn(`[codex-webui] app-server is draining (${reason}); marking not-ready and restarting it`);
  connected = false;
  broadcast({ type: "bridge/status", status: "disconnected", reason: "draining" });
  terminateCodex("SIGTERM");
  codex = null;
  setTimeout(() => { try { startCodex(); } catch (error) { console.error("[codex-webui] restart after drain failed", error); } }, 300);
}

function terminateCodex(signal: NodeJS.Signals = "SIGTERM") {
  const child = codex;
  try { appServerSocket?.close(); } catch { /* ignore */ }
  appServerSocket = null;
  if (!child || child.exitCode !== null) return;
  if (process.platform !== "win32" && child.pid) {
    try { process.kill(-child.pid, signal); }
    catch { child.kill(signal); }
  } else {
    child.kill(signal);
  }
  // Escalate if it only half-dies: a draining app-server keeps the port and
  // answers "Server is draining", which stops the next bridge from adopting or
  // binding it and leaves the UI useless while /api/health still says ready.
  // That happened for real — see VERIFICATION.md E54.
  const pid = child.pid;
  if (!pid) return;
  const escalation = setTimeout(() => {
    if (child.exitCode !== null) return;
    console.error(`[codex-webui] app-server ${pid} did not exit after ${signal}; sending SIGKILL`);
    try { process.kill(-pid, "SIGKILL"); }
    catch { try { child.kill("SIGKILL"); } catch { /* ignore */ } }
  }, 3000);
  escalation.unref?.();
}

function maybeFinishShutdown() {
  if (shuttingDown && httpClosed && !codex) process.exit(0);
}

function sendRaw(message: any) {
  if (shuttingDown) throw new Error("Codex WebUI is shutting down");
  if (!appServerSocket || appServerSocket.readyState !== WebSocket.OPEN) {
    startCodex();
    throw new Error("Codex app-server is not connected");
  }
  appServerSocket.send(JSON.stringify(message));
}

// timeoutMs = 0 表示不设超时：`command/exec` 的最终响应要等进程退出才回来，
// 交互式 shell 可能活很久，套 30 秒超时会把刚开的终端直接判死。
function request(method: string, params: any = {}, timeoutMs = 30000) {
  const id = seq++;
  sendRaw({ id, method, params });
  return new Promise<any>((resolvePromise, reject) => {
    const timer = timeoutMs > 0 ? setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Codex request timed out: ${method}`));
    }, timeoutMs) : null;
    pending.set(id, {
      resolve: (value) => { if (timer) clearTimeout(timer); resolvePromise(value); },
      reject: (error) => { if (timer) clearTimeout(timer); reject(error); },
    });
  });
}

async function initialize() {
  const result = await request("initialize", {
    clientInfo: { name: "codex-webui", title: "Codex WebUI", version: "0.2.0" },
    capabilities: { experimentalApi: true },
  });
  sendRaw({ method: "initialized", params: {} });
  if (typeof result?.codexHome === "string") codexSessionsRoot = resolve(result.codexHome, "sessions");
  if (typeof result?.codexHome === "string") codexHomeRoot = resolve(result.codexHome);
  connected = true;
  startMark("connected (ready=true)");
  broadcast({ type: "bridge/status", status: "connected", info: result });
  // P8：桥刚起来时先按"重启/离线期间错过的槽"结一次账。这一步只记账、不重复执行已跑过的槽。
  const automationSweep = automation.sweep("startup");
  if (automationSweep?.then) {
    automationSweep
      .then((summary: any) => console.log(`[codex-webui] automation startup sweep: ${JSON.stringify(summary)}`))
      .catch((error: unknown) => console.error("[codex-webui] automation startup sweep failed:", error instanceof Error ? error.message : error));
  }
}

function handleCodex(message: any) {
  if (message.id !== undefined && ("result" in message || "error" in message)) {
    const item = pending.get(Number(message.id));
    if (item) {
      pending.delete(Number(message.id));
      if (message.error) {
        const text = String(message.error.message || JSON.stringify(message.error));
        if (/draining/i.test(text)) restartAppServerAfterDrain(text.slice(0, 80));
        item.reject(new Error(text));
      }
      else item.resolve(message.result);
      return;
    }
  }
  if (message.id !== undefined && message.method) {
    requestRegistry.register(message);
    // 定时回合在等审批/回答时：记进运行记录 + 立刻发一条带会话深链的通知，别让它白等到超时（E138）。
    automation.onServerRequest(message);
    broadcast({ type: "codex/request", payload: message });
    return;
  }
  if (message.method) {
    if (message.method === "account/updated") accountLoader.invalidate();
    // Keep the pending-request bookkeeping honest: the server tells us when it is
    // done with a request, and a finished turn cannot still have one waiting.
    if (message.method === "serverRequest/resolved") {
      requestRegistry.resolve(message.params?.requestId);
      automation.onRequestResolved(message.params?.requestId);
    }
    if (message.method === "turn/completed") requestRegistry.clearTurn(message.params?.threadId, message.params?.turn?.id);
    // 定时任务在等这个回合的结果（哪个线程/回合由通知自己带过来）。
    if (message.method === "turn/completed") automation.onTurnCompleted(message.params || {});
    if (message.method === "turn/diff/updated") reviewDiffs.record(message.params || {});
    if (message.method === "item/fileChange/patchUpdated") void recordFileChangeDiff(message.params || {});
    if (message.method === "item/completed" && message.params?.item?.type === "fileChange") {
      void recordFileChangeDiff({ ...message.params, changes: message.params.item.changes });
    }
    if (message.method === "turn/completed") notifyNtfyTurnCompleted(message.params || {});
    // 终端输出量很大，而且只对开着终端的那个连接有意义：交给 /terminal 那条 WebSocket，
    // 不能像其它通知那样广播给所有页面（否则每次 ls 都往每个页面灌一坨）。
    if (message.method === "command/exec/outputDelta" && handleProtocolTerminalDelta(message.params)) return;
    broadcast({ type: "codex/notification", payload: message });
  }
}

async function notifyNtfyTurnCompleted(params: any) {
  if (!ntfyTopic) return;
  const turnId = typeof params?.turn?.id === "string" ? params.turn.id : "";
  const threadId = typeof params?.threadId === "string" ? params.threadId : "";
  const body = `Codex task completed${threadId ? ` (thread ${threadId.slice(0, 8)})` : ""}`;
  try {
    await fetch(`${ntfyUrl}/${encodeURIComponent(ntfyTopic)}`, {
      method: "POST",
      headers: { Title: "Codex task completed", Tags: "white_check_mark", ...(turnId ? { "X-Turn-Id": turnId } : {}) },
      body,
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    console.error("ntfy notification failed:", error instanceof Error ? error.message : error);
  }
}

// fileChange 的 path 是绝对路径（本机 app-server 实测），git apply 只认仓库内相对路径。
// 每个 thread 的仓库根只查一次（cwd 基本不变），避免每个 item 都往返一趟。
const repoRootCache = new Map<string, string | null>();

async function repositoryRootFor(threadId: string, cwdHint?: string | null) {
  if (repoRootCache.has(threadId)) return repoRootCache.get(threadId)!;
  let base = cwdHint || null;
  if (!base) {
    try {
      const thread = await request("thread/read", { threadId, includeTurns: false });
      base = thread?.thread?.environments?.[0]?.cwd || thread?.thread?.cwd || null;
    } catch { /* 拿不到就当没有 */ }
  }
  let root: string | null = null;
  if (base) {
    try {
      root = execFileSync("git", ["-C", base, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
    } catch { root = null; }
  }
  repoRootCache.set(threadId, root);
  return root;
}

async function reviewDiffFromChanges(threadId: string, changes: any[], cwdHint?: string | null) {
  if (!Array.isArray(changes) || !changes.length) return "";
  const needsRoot = changes.some((change: any) => String(change?.path || "").startsWith("/"));
  const root = needsRoot ? await repositoryRootFor(threadId, cwdHint) : null;
  const relative = changes.map((change: any) => {
    const path = String(change?.path || "");
    if (root && path.startsWith(`${root}/`)) return { ...change, path: path.slice(root.length + 1) };
    return change;
  });
  return unifiedDiffFromFileChanges(relative);
}
async function recordFileChangeDiff({ threadId, turnId, changes }: any) {
  if (typeof threadId !== "string" || typeof turnId !== "string") return;
  const diff = await reviewDiffFromChanges(threadId, Array.isArray(changes) ? changes : []);
  if (diff) reviewDiffs.record({ threadId, turnId, diff });
}

// 桥重启过之后内存里就没有那一轮的 diff 了，但回源能重建：`thread/read{includeTurns}`
// 里的 fileChange item 带着 changes（path/kind/diff），合成逻辑与实时通知完全相同。
async function recoverReviewDiff(threadId: string, turnId: string) {
  try {
    const result = await request("thread/read", { threadId, includeTurns: true });
    const turns = result?.thread?.turns || [];
    for (const turn of turns) {
      if (turn?.id !== turnId) continue;
      const changes = (turn.items || []).flatMap((item: any) => item?.type === "fileChange" && Array.isArray(item.changes) ? item.changes : []);
      const cwd = result?.thread?.environments?.[0]?.cwd || result?.thread?.cwd || null;
      const diff = await reviewDiffFromChanges(threadId, changes, cwd);
      if (!diff) continue;
      reviewDiffs.record({ threadId, turnId, diff });
      console.log(`[codex-webui] recovered review diff for turn ${turnId} (${changes.length} file(s))`);
      return true;
    }
  } catch (error) {
    console.error("[codex-webui] review diff recovery failed", error);
  }
  return false;
}

// 注意：这个钩子是在**读会话**时补录 diff（page 打开旧会话也能撤销），所以它也必须走
// 相对路径那套合成——否则记录下来的补丁带绝对路径，撤销时被安全校验拒之门外（E122 真机）。
async function recordReviewDiffsFromRpc(method: string, params: any, result: any) {
  if (!["thread/read", "thread/resume", "thread/turns/list"].includes(method)) return;
  const threadId = result?.thread?.id || params?.threadId;
  const turns = result?.thread?.turns || result?.data || [];
  if (typeof threadId !== "string" || !Array.isArray(turns)) return;
  for (const turn of turns) {
    const changes = (turn?.items || []).flatMap((item: any) => item?.type === "fileChange" && Array.isArray(item.changes) ? item.changes : []);
    const diff = await reviewDiffFromChanges(threadId, changes, result?.thread?.environments?.[0]?.cwd || null);
    if (typeof turn?.id === "string" && diff) reviewDiffs.record({ threadId, turnId: turn.id, diff });
  }
}

function recordThreadPathsFromRpc(result: any) {
  const threads = [result?.thread, ...(Array.isArray(result?.data) ? result.data : [])].filter(Boolean);
  for (const thread of threads) {
    if (typeof thread?.id === "string" && typeof thread?.path === "string") threadPaths.set(thread.id, thread.path);
  }
}

/**
 * `mention` 是这套 app-server 接受的 UserInput 变体之一，但**它到不了模型**：
 * 实测（E103）`turn/start {input:[{type:"mention",name,path}]}` 返回成功，
 * 而该回合在 rollout 里的用户消息是 `[]`——模型只看到环境上下文，于是回答
 * "这一轮没有收到具体任务"。`localImage` 则会正常变成 `input_image`（E88）。
 *
 * 所以非图片附件在这里改写成一行文本，把本地路径直接告诉模型——它有文件读取工具，
 * 拿到路径就能干活；用户在会话记录里也能看到实际发出去的是什么（不偷偷改）。
 * 这是对当前后端能力的显式兼容层，而不是"协议兼容"的声称：一旦该 build 真的支持
 * mention，这层就该删掉。
 */
function rewriteMentionsForModel(params: any) {
  if (!params || !Array.isArray(params.input)) return params;
  let changed = false;
  const input = params.input.map((part: any) => {
    if (part && part.type === "mention" && typeof part.path === "string") {
      changed = true;
      return { type: "text", text: `附件（本地路径，可直接读取）：${part.path}` };
    }
    return part;
  });
  return changed ? { ...params, input } : params;
}

async function readLiveThread(threadId: unknown) {
  if (typeof threadId !== "string" || !threadId) throw new Error("Invalid thread id");
  let path = threadPaths.get(threadId);
  if (!path) {
    const result = await request("thread/read", { threadId, includeTurns: false });
    recordThreadPathsFromRpc(result);
    path = threadPaths.get(threadId);
  }
  if (!path) return { active: false, turn: null, lastEventAt: null };
  const withinHome = relative(codexHomeRoot, resolve(path));
  const safePath = withinHome && !withinHome.startsWith("..")
    ? resolveSafeRegularFile(codexHomeRoot, withinHome)
    : null;
  if (!safePath) {
    // A thread's rollout can legitimately live outside this Codex home (e.g. a
    // session created under a different CODEX_HOME). "Live state unknown" is the
    // honest answer — throwing made the UI report an error every time such a
    // thread was opened, which reads as "the app is broken" (E68).
    console.error(`[codex-webui] no live state: rollout for ${threadId} is outside ${codexSessionsRoot}`);
    return { active: false, turn: null, lastEventAt: null };
  }
  return liveSessions.read(safePath);
}

function broadcast(data: any) {
  const text = JSON.stringify(data);
  for (const client of clients) if (client.readyState === WebSocket.OPEN) client.send(text);
  for (const client of sseClients) if (!client.writableEnded) client.write(`data: ${text}\n\n`);
}

async function dispatchBrowserMessage(message: any) {
  const id = message?.id;
  if (message?.type === "rpc") {
    const method = message.method;
    // 必须在 try 之外声明：它在 catch 里也要用。第一版写在 try 里面，
    // 结果是"任何浏览器 RPC 失败"都会变成 `rpcStartedAt is not defined`，
    // 真实原因被顶掉（E116 实测撞上）。
    const rpcStartedAt = Date.now();
    try {
      if (!isAllowedBrowserRpcMethod(method)) throw new Error("RPC method is not available to browser clients");
      const params = message.params || {};
      // Observability: when the UI "does nothing", the answer is either in this
      // log (the RPC arrived, and how long it took) or the request never left the
      // browser. A missing arrival line for an action the user performed is itself
      // the finding — that is what a half-open WebSocket looks like from here (E87).
      const detail = method === "turn/start" || method === "thread/start"
        ? ` thread=${params.threadId ?? "(new)"} model=${params.model ?? "(default)"}`
        : "";
      console.log(`[codex-webui] browser rpc >> ${method}${detail}`);
      const result = method === "host/thread/live"
        ? await readLiveThread(params.threadId)
        : await request(method, rewriteMentionsForModel(params));
      recordThreadPathsFromRpc(result);
      await recordReviewDiffsFromRpc(method, params, result);
      console.log(`[codex-webui] browser rpc << ${method} ${Date.now() - rpcStartedAt}ms`);
      return { type: "rpc/result", id, result };
    } catch (error) {
      console.error(`[codex-webui] browser rpc failed: ${method} after ${Date.now() - rpcStartedAt}ms -> ${error instanceof Error ? error.message : String(error)}`);
      return rpcErrorPayload(id, error);
    }
  }
  if (message?.type === "codex/response") {
    if (!Number.isSafeInteger(message.requestId)) throw new Error("Invalid Codex request id");
    const claimed = requestRegistry.claim(message.requestId);
    if (!claimed.ok) {
      throw new Error(
        claimed.reason === "invalid-request-id"
          ? "Invalid Codex request id"
          : "这个请求已经被处理或已失效（可能由另一个客户端回答过）",
      );
    }
    sendRaw({ id: message.requestId, result: message.result });
    return { type: "ack" };
  }
  if (message?.type === "codex/error") {
    if (!Number.isSafeInteger(message.requestId)) throw new Error("Invalid Codex request id");
    const claimed = requestRegistry.claim(message.requestId);
    if (!claimed.ok) {
      throw new Error(
        claimed.reason === "invalid-request-id"
          ? "Invalid Codex request id"
          : "这个请求已经被处理或已失效（可能由另一个客户端回答过）",
      );
    }
    sendRaw({ id: message.requestId, error: message.error });
    return { type: "ack" };
  }
  if (message?.type === "ping") return { type: "pong" };
  throw new Error("Unsupported browser bridge message");
}

async function handleClient(client: WebSocket, message: any) {
  try { client.send(JSON.stringify(await dispatchBrowserMessage(message))); }
  catch (error) { client.send(JSON.stringify(rpcErrorPayload(message?.id, error))); }
}

function readJsonBody(req: IncomingMessage, maxBytes = 256_000) {
  return new Promise<any>((resolvePromise, reject) => {
    let body = "", tooLarge = false;
    req.setEncoding("utf8");
    req.on("data", chunk => {
      if (tooLarge) return;
      if (Buffer.byteLength(body) + Buffer.byteLength(chunk) > maxBytes) { tooLarge = true; return; }
      body += chunk;
    });
    req.on("error", reject);
    req.on("end", () => {
      if (tooLarge) return reject(new Error("Bridge payload too large"));
      try { resolvePromise(JSON.parse(body || "{}")); }
      catch { reject(new Error("Invalid JSON payload")); }
    });
  });
}

function passwordSetupRequired() {
  return !localhostOnly && !authSecret;
}

function browserPasswordConfigured() {
  return Boolean(environmentPassword || managedPassword || accessToken);
}

function requestMatchesSecret(req: IncomingMessage, submittedPassword: string, expectedSecret: string | null) {
  if (!submittedPassword || !expectedSecret) return false;
  return isRequestAuthorized({
    remoteAddress: req.socket.remoteAddress,
    hostHeader: req.headers.host,
    authorization: `Bearer ${submittedPassword}`,
    accessToken: expectedSecret,
    origin: req.headers.origin,
    fetchSite: req.headers["sec-fetch-site"],
    forwardedFor: req.headers["x-forwarded-for"],
    forwarded: req.headers.forwarded,
    realIp: req.headers["x-real-ip"],
    allowLoopback: false,
  });
}

function validBrowserPassword(req: IncomingMessage, submittedPassword: string) {
  if (environmentPassword) return requestMatchesSecret(req, submittedPassword, environmentPassword);
  if (managedPassword) {
    if (!requestMatchesSecret(req, submittedPassword, submittedPassword)) return false;
    return verifyStoredPassword(submittedPassword, managedPassword);
  }
  return requestMatchesSecret(req, submittedPassword, accessToken);
}

function sendAuthError(res: ServerResponse, status: number, error: string, extraHeaders: Record<string, string> = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  res.end(JSON.stringify({ error }));
}

function issueBrowserSession(req: IncomingMessage, res: ServerResponse) {
  if (!authSecret) throw new Error("Authentication is not configured");
  const session = createPasswordSession(authSecret);
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "set-cookie": passwordSessionCookie(session.token, { secure: Boolean((req.socket as any).encrypted) }),
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify({ ok: true }));
}

function encodeContentDispositionFilename(filename: string) {
  return encodeURIComponent(filename).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
};

const server = createServer(async (req, res) => {
  let url: URL;
  try { url = new URL(req.url || "/", "http://localhost"); }
  catch {
    res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify({ error: "Invalid request URL" }));
    return;
  }
  const appRoute = req.method === "GET" && (url.pathname === "/" || /^\/settings(?:\/[^/]+)?\/?$/.test(url.pathname));
  const loginAssets = new Set(["/", "/index.html", "/style.css", "/favicon.svg", "/auth-bootstrap.js", "/i18n.js", "/codex-brand.js"]);
  // Document-level access log. The general static log only runs for authorized
  // requests; a document served to an unauthenticated client takes a different
  // branch that used to log nothing at all, which hid the whole picture (E86).
  if (req.method === "GET" && (url.pathname === "/" || url.pathname.endsWith(".html"))) {
    console.log(`[codex-webui] doc ${url.pathname}${url.search} authorized=${isAuthorizedHttpRequest(req, authSecret)} dest=${req.headers["sec-fetch-dest"] || "-"} site=${req.headers["sec-fetch-site"] || "-"} ua=${shortUa(req)}`);
  }
  if (url.pathname === "/api/auth/status") {
    const authenticated = isAuthorizedHttpRequest(req, authSecret);
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify({
      setupRequired: passwordSetupRequired() && !authenticated,
      passwordRequired: browserPasswordConfigured(),
      authenticated,
    }));
    return;
  }
  if (url.pathname === "/api/auth/setup") {
    if (req.method !== "POST") {
      sendAuthError(res, 405, "Method not allowed", { allow: "POST" });
      return;
    }
    let payload: any;
    try { payload = await readJsonBody(req, 4096); }
    catch (error) {
      sendAuthError(res, 400, error instanceof Error ? error.message : "Invalid setup request");
      return;
    }
    const submittedPassword = typeof payload?.password === "string" ? payload.password : "";
    if (submittedPassword.length < 12 || submittedPassword.length > 256) {
      sendAuthError(res, 400, "Password must be between 12 and 256 characters");
      return;
    }
    if (!requestMatchesSecret(req, submittedPassword, submittedPassword)) {
      sendAuthError(res, 403, "Password setup request was rejected");
      return;
    }
    if (!passwordSetupRequired() || passwordSetupInProgress) {
      sendAuthError(res, 409, "Password setup is no longer available");
      return;
    }
    passwordSetupInProgress = true;
    try {
      const credential = createStoredPassword(submittedPassword) as StoredPassword;
      saveStoredPassword(managedPasswordPath, credential);
      managedPassword = credential;
      authSecret = storedPasswordSessionSecret(credential);
      issueBrowserSession(req, res);
    } catch (error: any) {
      if (error?.code === "EEXIST") {
        try {
          managedPassword = loadStoredPassword(managedPasswordPath);
          authSecret = storedPasswordSessionSecret(managedPassword);
        } catch { /* Keep the original exclusive-create failure as the response. */ }
        sendAuthError(res, 409, "Password setup is no longer available");
      } else {
        console.error("[codex-webui] password setup failed", error);
        sendAuthError(res, 500, "Unable to save the password");
      }
    } finally {
      passwordSetupInProgress = false;
    }
    return;
  }
  if (url.pathname === "/api/auth/login") {
    if (req.method !== "POST") {
      sendAuthError(res, 405, "Method not allowed", { allow: "POST" });
      return;
    }
    let payload: any;
    try { payload = await readJsonBody(req, 4096); }
    catch {
      sendAuthError(res, 401, "Incorrect password");
      return;
    }
    const submittedPassword = typeof payload?.password === "string" ? payload.password : "";
    if (!validBrowserPassword(req, submittedPassword)) {
      sendAuthError(res, 401, "Incorrect password");
      return;
    }
    issueBrowserSession(req, res);
    return;
  }
  if (!isAuthorizedHttpRequest(req, authSecret)) {
    if (appRoute || loginAssets.has(url.pathname)) {
      const file = resolvePublicAsset(appRoute ? "/" : url.pathname, publicDir);
      if (file) {
        const isDocument = file.endsWith("index.html");
        const raw = readFileSync(file);
        const body = isDocument ? stampIndexHtml(raw) : raw;
        console.log(`[codex-webui] auth-wall ${url.pathname} ${body.length}B${isDocument ? " stamped" : " raw"}`);
        res.writeHead(200, { "content-type": mime[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
        res.end(body);
        return;
      }
    }
    unauthorizedResponse(res);
    return;
  }
  if (url.pathname === "/api/events") {
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "GET" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    });
    res.flushHeaders?.();
    res.write("retry: 1000\n\n");
    sseClients.add(res);
    res.write(`data: ${JSON.stringify({ type: "bridge/status", status: connected ? "connected" : "connecting" })}\n\n`);
    req.on("close", () => sseClients.delete(res));
    return;
  }
  if (url.pathname === "/api/rpc" || url.pathname === "/api/codex/respond") {
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "POST" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const payload = await readJsonBody(req);
      const message = url.pathname === "/api/rpc"
        ? { type: "rpc", id: payload.id, method: payload.method, params: payload.params || {} }
        : { type: payload.error ? "codex/error" : "codex/response", requestId: payload.requestId, result: payload.result, error: payload.error };
      const reply = await dispatchBrowserMessage(message);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(JSON.stringify(reply));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }
  if (url.pathname === "/api/health") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({
      ok: true,
      codex: connected,
      ready: connected && !shuttingDown,
      version: "0.2.0",
      // 桥自己的启动时间。页面在"等待桥响应"时会读它，从而区分
      // "桥刚被我重启过"（几秒内自愈）和"设备把 Termux 挂起了"（几十秒到几分钟）。
      // 这两种等待的处置完全不同，日志上却长得一样（E117）。
      startedAt: bridgeStartedAt,
      uptimeMs: Date.now() - bridgeStartedAt,
    }));
    return;
  }
  // Development-only diagnostic sink: the frontend's own errors and branch
  // outcomes are otherwise invisible from here (that blind spot is why E77 took
  // so long). Same auth as every other endpoint; nothing is stored.
  // 页面检测到原生接口后注册一次；断开时减一（App 里页面被销毁 = 不能发原生通知）。
  if (url.pathname === "/api/notify/register" && req.method === "POST") {
    let payload: { clientId?: unknown } = {};
    try { payload = await readJsonBody(req, 1024); } catch { payload = {}; }
    const clientId = String(payload.clientId || "anonymous").slice(0, 40);
    nativeNotifierLeases.set(clientId, Date.now());
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: true, clients: nativeNotifierCount() }));
    return;
  }
  // CLI / agent 侧的入口：`~/bin/codex-notify` 打到这里。
  if (url.pathname === "/api/notify" && req.method === "POST") {
    if (!isAuthorizedHttpRequest(req, authSecret)) { unauthorizedResponse(res); return; }
    let payload: { title?: unknown; body?: unknown; tag?: unknown } = {};
    try { payload = await readJsonBody(req, 4096); } catch { payload = {}; }
    const title = String(payload.title || "Codex");
    const body = String(payload.body || "");
    const tag = String(payload.tag || "codex-status");
    // 深链（P7）：调用方可以带上会话 id，点通知就直接打开那条会话。
    const threadId = typeof (payload as any).threadId === "string" && (payload as any).threadId ? String((payload as any).threadId) : undefined;
    const native = nativeNotifierCount() > 0;
    if (native) sendNativeNotification({ title, body, tag, threadId });
    else notifyViaTermux({ title, body, tag });
    console.log(`[codex-webui] notify: ${native ? "native(app)" : "termux"} ${title} — ${body.slice(0, 80)}`);
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: true, channel: native ? "native" : "termux" }));
    return;
  }
  if (url.pathname === "/api/client-log" && req.method === "POST") {
    if (!isAuthorizedHttpRequest(req, authSecret)) {
      // A diagnostics POST that is rejected looks exactly like a page that never ran,
      // which is how a stale-cache theory survived several rounds (E86).
      console.error(`[codex-webui] client log UNAUTHORIZED ua=${shortUa(req)}`);
      unauthorizedResponse(res);
      return;
    }
    try {
      const body = await readJsonBody(req, 8000);
      const claimed = body?.build ? ` claimed-build=${String(body.build)}` : "";
      // `at` is the browser's own clock — the same device, so the delta is the time
      // the message spent in the browser before it reached this loop (E87).
      const sentAt = Number(body?.at);
      const lag = Number.isFinite(sentAt) && sentAt > 0 ? `+${Date.now() - sentAt}ms ` : "";
      const origin = `${body?.pid ? `${String(body.pid).slice(0, 8)} ` : ""}${body?.vis ? `vis=${String(body.vis).slice(0, 7)} ` : ""}${body?.transport ? `t=${String(body.transport).slice(0, 6)} ` : ""}`;
      console.error(`[codex-webui] client: ${lag}${String(body?.message ?? "").slice(0, 600)}${claimed}${origin ? ` [${origin.trim()}]` : ""}`);
    } catch (error) {
      console.error("[codex-webui] client log rejected:", error instanceof Error ? error.message : error);
    }
    res.writeHead(204, { "cache-control": "no-store" });
    res.end();
    return;
  }
  // How to attach a CLI TUI to this bridge's app-server instance.
  // The capability token is deliberately NOT returned; the launcher reads it
  // from a 0600 file so it never lands in the page, a URL, or a screenshot.
  if (url.pathname === "/api/appserver/attach") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({
      wsUrl: appServerWsUrl,
      port: appServerWsPort,
      launcher: appServerLauncherPath,
      tokenPath: appServerTokenPath,
      tokenIncluded: false,
      hint: "codex-gui            # 打开 CLI 并接入同一个 app-server\ncodex-gui resume <threadId>",
    }));
    return;
  }
  // Requests still waiting for an answer. A page that was reloaded (or opened
  // later) can restore the approval / question cards from this, instead of
  // leaving the turn parked with no way to answer it (E32).
  if (url.pathname === "/api/requests/pending") {
    const pendingRequests = requestRegistry.list().map((entry) => entry.request).filter(Boolean);
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ data: pendingRequests }));
    return;
  }
  if (url.pathname === "/api/plugins") {
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "POST" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    let pluginBody = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { pluginBody += chunk; if (pluginBody.length > 32_000) req.destroy(new Error("Payload too large")); });
    req.on("end", async () => {
      let status = 200;
      let payload: any;
      try {
        const body = JSON.parse(pluginBody || "{}");
        const action = String(body.action ?? "");
        if (action === "marketplaceAdd") {
          const source = String(body.source || "").trim();
          if (!source) throw new Error("A marketplace source is required (a local directory or an https:// URL)");
          // 本地来源必须在允许根内且真实存在；远程只放行 https。
          if (/^https:\/\//i.test(source)) {
            payload = await request("marketplace/add", { source }, 120000);
          } else {
            const directory = resolveBrowsePath(source, browseRoots, homeDir);
            if (!isDirectory(directory)) throw new Error(`Not a directory: ${directory}`);
            payload = await request("marketplace/add", { source: directory }, 120000);
          }
          console.log(`[codex-webui] marketplace added: ${payload?.marketplaceName || source}`);
        } else if (action === "marketplaceRemove") {
          const name = String(body.name || "").trim();
          if (!name) throw new Error("A marketplace name is required");
          payload = await request("marketplace/remove", { marketplaceName: name }, 60000);
        } else if (action === "install") {
          const pluginName = String(body.pluginName || "").trim();
          if (!pluginName) throw new Error("A plugin name is required");
          const params: any = { pluginName, installAttemptId: `bridge-${Date.now()}` };
          if (body.marketplacePath) params.marketplacePath = resolveBrowsePath(String(body.marketplacePath), browseRoots, homeDir);
          else if (body.remoteMarketplaceName) params.remoteMarketplaceName = String(body.remoteMarketplaceName);
          payload = await request("plugin/install", params, 120000);
        } else if (action === "uninstall") {
          const pluginId = String(body.pluginId || "").trim();
          if (!pluginId) throw new Error("A plugin id is required");
          payload = await request("plugin/uninstall", { pluginId }, 60000);
        } else {
          throw new Error(`Unsupported plugin action: ${action || "(empty)"}`);
        }
      } catch (error) {
        status = 400;
        payload = { error: error instanceof Error ? error.message : String(error) };
      }
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-store": "no-store", "cache-control": "no-store" });
      res.end(JSON.stringify(payload));
    });
    return;
  }
  if (url.pathname === "/api/config/write") {
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "POST" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    let configBody = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { configBody += chunk; if (configBody.length > 64_000) req.destroy(new Error("Config payload too large")); });
    req.on("end", async () => {
      let status = 200;
      let payload: any;
      try {
        const body = JSON.parse(configBody || "{}");
        const keyPath = String(body.keyPath ?? "");
        // 只允许这两个键：它们直接决定"模型能不能在没批准的情况下动你的文件"。
        // 其它键（model/provider/凭据路径等）一律不从这里改——那是用户自己的配置。
        const WRITABLE: Record<string, string[]> = {
          approval_policy: ["untrusted", "on-request", "on-failure", "never"],
          sandbox_mode: ["read-only", "workspace-write", "danger-full-access"],
        };
        if (!Object.hasOwn(WRITABLE, keyPath)) {
          throw new Error(`This build only writes ${Object.keys(WRITABLE).join(" / ")} from the app (asked for ${keyPath || "nothing"})`);
        }
        const value = String(body.value ?? "");
        if (!WRITABLE[keyPath].includes(value)) {
          throw new Error(`Invalid value for ${keyPath}: ${value || "(empty)"}`);
        }
        const result = await request("config/value/write", { keyPath, value, mergeStrategy: "replace" });
        console.log(`[codex-webui] config write ${keyPath}=${value} -> ${result?.status || "?"}`);
        payload = { ok: true, keyPath, value, status: result?.status || null, filePath: result?.filePath || null };
      } catch (error) {
        status = 400;
        payload = { error: error instanceof Error ? error.message : String(error) };
      }
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(payload));
    });
    return;
  }
  // 启动自检（E139）：两侧事实合成一张清单。POST 是应用上报它那半（Termux 装没装、
  // RUN_COMMAND 权限、通知权限、前台服务/唤醒锁），GET 是页面读完整清单。
  if (url.pathname === "/api/setup") {
    if (req.method === "POST") {
      try {
        const body = await readJsonBody(req, 16_000);
        androidSelfReport = { at: Date.now(), facts: body?.facts ?? null };
        console.log(`[codex-webui] android self-report: ${JSON.stringify(androidSelfReport.facts).slice(0, 300)}`);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: true }));
      } catch (error) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "GET, POST" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(await setupStatus()));
    return;
  }
  if (url.pathname === "/api/config") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ home: homeDir, defaultCwd, reviewRoot: reviewRoots[0], projectless }));
    return;
  }
  // P8 定时任务：这些不是 app-server 方法（协议里没有调度面），所以是桥自己的受控出口。
  // 有副作用（会起回合、会写桥自己的状态文件），因此和 /api/plugins、/api/config/write 一样
  // 只接受本会话已认证的 POST。
  if (url.pathname === "/api/automation") {
    if (req.method === "GET") {
      const wake = await automationWakeStatus();
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ ...automation.snapshot(), wake }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "GET, POST" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    let status = 200;
    let payload: any;
    try {
      const body = await readJsonBody(req, 64_000);
      const action = String(body?.action ?? "");
      if (action === "create") payload = automation.createJob(body?.job ?? {});
      else if (action === "update") payload = automation.updateJob(String(body?.id ?? ""), body?.patch ?? {});
      else if (action === "remove") payload = automation.removeJob(String(body?.id ?? ""));
      else if (action === "enable") payload = automation.updateJob(String(body?.id ?? ""), { enabled: true });
      else if (action === "disable") payload = automation.updateJob(String(body?.id ?? ""), { enabled: false });
      else if (action === "runNow") payload = automation.startNow(String(body?.id ?? ""));
      else if (action === "clearRuns") payload = automation.clearRuns(body?.id ? String(body.id) : null);
      else if (action === "sweep") payload = await automation.sweep("manual");
      else if (action === "wakeInstall") { installAutomationWake(); payload = await automationWakeStatus(true); }
      else throw new Error(`不支持的 action：${action || "(空)"}`);
      console.log(`[codex-webui] automation ${action} ok`);
    } catch (error) {
      status = 400;
      payload = { error: error instanceof Error ? error.message : String(error) };
      console.error(`[codex-webui] automation failed: ${payload.error}`);
    }
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(payload));
    return;
  }
  if (url.pathname === "/api/workspace/context") {
    try {
      const context = readWorkspaceContext(url.searchParams.get("cwd") || defaultCwd, browseRoots);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(context));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }
  if (url.pathname === "/api/files/search") {
    try {
      const cwd = url.searchParams.get("cwd") || defaultCwd;
      const query = url.searchParams.get("query") || "";
      const items = await searchWorkspaceFiles(cwd, query, { allowedRoots: browseRoots, limit: 30 });
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ cwd, query, items }));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }
  if (url.pathname === "/api/files/action") {
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "POST" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    let actionBody = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { actionBody += chunk; if (actionBody.length > 16_000) req.destroy(new Error("Payload too large")); });
    req.on("end", () => {
      let status = 200;
      let payload: any;
      try {
        const body = JSON.parse(actionBody || "{}");
        const action = String(body.action ?? "");
        const file = resolveLocalFile(String(body.path || ""), { cwd: defaultCwd, home: homeDir, allowedRoots: fileRoots });
        if (action === "open" || action === "share") {
          // Termux:API 的 termux-open：open=默认应用查看，share=走分享面板（--send）。
          const args = action === "share" ? ["--send", file.path] : ["--view", file.path];
          const result = spawnSync("termux-open", args, { encoding: "utf8" });
          if (result.error) throw new Error(`termux-open is unavailable: ${result.error.message}`);
          if (result.status !== 0) throw new Error((result.stderr || "termux-open failed").trim().slice(0, 200));
          payload = { ok: true, action, path: file.path };
        } else if (action === "saveToDownloads") {
          const targetDir = "/sdcard/Download/codex-gui";
          mkdirSync(targetDir, { recursive: true });
          const target = resolve(targetDir, file.filename);
          copyFileSync(file.path, target);
          payload = { ok: true, action, path: target, size: file.size };
        } else {
          throw new Error(`Unsupported file action: ${action || "(empty)"}`);
        }
      } catch (error) {
        status = 400;
        payload = { error: error instanceof Error ? error.message : String(error) };
      }
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(payload));
    });
    return;
  }
// 预览只对这些类型开放（其余让用户用 open/share 交给系统应用）。
function previewContentType(extension: string): string | null {
  const map: Record<string, string> = {
    ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
    ".svg": "image/svg+xml", ".md": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8",
    ".json": "application/json; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  };
  return map[extension] || null;
}

  if (url.pathname === "/api/files/preview") {
    try {
      const file = resolveLocalFile(url.searchParams.get("path"), { cwd: defaultCwd, home: homeDir, allowedRoots: fileRoots });
      const extension = extname(file.path).toLowerCase();
      const type = previewContentType(extension);
      if (!type) throw new Error(`No preview for ${extension || "this file type"}; use open/share instead`);
      res.writeHead(200, {
        "content-type": type,
        "content-length": String(file.size),
        "content-disposition": "inline",
        // 关键：给被预览的本地页面一个不透明源，它就摸不到桥的同源数据（P7 安全前提）。
        "content-security-policy": "sandbox",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      const stream = createReadStream(file.path);
      stream.on("error", () => res.destroy());
      req.on("aborted", () => stream.destroy());
      stream.pipe(res);
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }
  if (url.pathname === "/api/files/download") {
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "GET", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const file = resolveLocalFile(url.searchParams.get("path"), {
        cwd: url.searchParams.get("cwd") || defaultCwd,
        home: homeDir,
        allowedRoots: fileRoots,
      });
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(file.size),
        "content-disposition": `attachment; filename="download"; filename*=UTF-8''${encodeContentDispositionFilename(file.filename)}`,
        "cache-control": "no-store",
        "cross-origin-resource-policy": "same-origin",
        "x-content-type-options": "nosniff",
      });
      const stream = createReadStream(file.path);
      stream.on("error", () => res.destroy());
      req.on("aborted", () => stream.destroy());
      stream.pipe(res);
    } catch {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(JSON.stringify({ error: "File unavailable" }));
    }
    return;
  }
  // Attachments picked with the system file chooser. The browser holds the bytes
  // but never a path; the app-server needs a path. Termux is where the two can
  // meet, so the bytes are written once under the bridge's state dir and the page
  // gets a real path back for `UserInput.localImage` / `UserInput.mention`.
  if (url.pathname === "/api/uploads" && req.method === "POST") {
    if (!isAuthorizedHttpRequest(req, authSecret)) { unauthorizedResponse(res); return; }
    try {
      // 两条入口：
      //   1) 原始字节（页面现在走这条）：`content-type` 是文件自己的 MIME，文件名在
      //      `x-upload-name` 里（URL 编码）—— 体积不膨胀、边收边写盘；
      //   2) base64+JSON（保留兼容：旧页面、以及只认这套的探针）。
      const contentType = String(req.headers["content-type"] || "");
      const rawName = req.headers["x-upload-name"];
      const saved = /application\/json/i.test(contentType) || !rawName
        ? saveUpload(await readJsonBody(req, uploadBodyLimit), { dir: uploadDir })
        : await saveUploadStream(req, {
            dir: uploadDir,
            name: (() => { try { return decodeURIComponent(String(rawName)); } catch { return String(rawName); } })(),
          });
      pruneUploads();
      console.error(`[codex-webui] upload: ${saved.name} (${saved.bytes} bytes, ${saved.kind}) -> ${saved.path}`);
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(JSON.stringify({ ok: true, ...saved }));
    } catch (error) {
      // A body past the read limit is the same user problem as a file past the
      // size cap, so it gets the same sentence instead of "payload too large".
      const message = error instanceof Error ? error.message : "Upload failed";
      const readable = message === "Bridge payload too large" ? `File is larger than ${Math.floor(UPLOAD_MAX_BYTES / (1024 * 1024))} MB` : message;
      console.error(`[codex-webui] upload rejected: ${readable}`);
      sendAuthError(res, 400, readable);
    }
    return;
  }
  if (url.pathname === "/api/images/local") {
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "GET", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    try {
      const image = resolveLocalImage(url.searchParams.get("path"), {
        cwd: url.searchParams.get("cwd") || defaultCwd,
        home: homeDir,
        allowedRoots: imageRoots,
      });
      res.writeHead(200, {
        "content-type": image.contentType,
        "content-length": String(image.size),
        "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(image.filename)}`,
        "cache-control": "private, max-age=60",
        "cross-origin-resource-policy": "same-origin",
        "x-content-type-options": "nosniff",
      });
      res.end(readFileSync(image.path));
    } catch {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(JSON.stringify({ error: "Image unavailable" }));
    }
    return;
  }
  if (url.pathname === "/api/account" || url.pathname === "/api/account/avatar") {
    const proxied = Boolean(req.headers["x-forwarded-for"] || req.headers.forwarded || req.headers["x-real-ip"]);
    if (proxied || !isLocalAccountRequest(req.socket.remoteAddress, req.headers.host, req.headers["sec-fetch-site"] as string | undefined)) {
      res.writeHead(403, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "Account identity is available only on localhost" }));
      return;
    }
    try {
      const account = await accountLoader.get(url.searchParams.get("refresh") === "1");
      if (url.pathname === "/api/account") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
        res.end(JSON.stringify(toPublicAccountIdentity(account)));
        return;
      }
      if (!account.imageUrl) {
        res.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "No profile avatar" }));
        return;
      }
      const avatar = await fetchProfileAvatar(account.imageUrl);
      res.writeHead(200, {
        "content-type": avatar.contentType,
        "content-length": String(avatar.body.byteLength),
        "cache-control": "private, max-age=300",
        "x-content-type-options": "nosniff",
      });
      res.end(avatar.body);
    } catch (error) {
      console.warn("[codex-webui] account request failed:", error instanceof Error ? error.message : String(error));
      if (url.pathname === "/api/account/avatar") {
        res.writeHead(502, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "Profile avatar unavailable" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(toPublicAccountIdentity(await resolveAccountIdentity({ account: null, requiresOpenaiAuth: true }))));
    }
    return;
  }
  if (url.pathname === "/api/folders") {
    try {
      const path = resolveBrowsePath(url.searchParams.get("path") || "~", browseRoots, homeDir);
      if (!isDirectory(path)) throw new Error("Directory not found");
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(listFolders(path, browseRoots)));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
    return;
  }
  if (url.pathname === "/api/fs") {
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "POST" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    let fsBody = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      fsBody += chunk;
      if (fsBody.length > 8_000_000) req.destroy(new Error("File payload too large"));
    });
    req.on("end", async () => {
      let status = 200;
      let payload: any;
      try {
        const body = JSON.parse(fsBody || "{}");
        const action = String(body.action ?? "");
        const allowedRoots = [...browseRoots, ...extraFileRoots];
        if (action === "list") {
          const dir = resolveBrowsePath(String(body.path || "~"), allowedRoots, homeDir);
          // 形状：{entries:[{fileName,isDirectory,isFile}]}（FsReadDirectoryResponse）。
          const listing = await request("fs/readDirectory", { path: dir });
          const entries = Array.isArray(listing?.entries) ? listing.entries : [];
          payload = {
            ok: true,
            path: dir,
            parent: dir === resolve("/") ? null : resolve(dir, ".."),
            entries: (entries || []).map((entry: any) => ({
              name: entry.fileName,
              directory: Boolean(entry.isDirectory),
              file: Boolean(entry.isFile),
              path: resolve(dir, entry.fileName),
            })).sort((a: any, b: any) => (a.directory === b.directory ? a.name.localeCompare(b.name) : a.directory ? -1 : 1)),
          };
        } else if (action === "read") {
          const target = resolveBrowsePath(String(body.path || ""), allowedRoots, homeDir);
          const metadata = await request("fs/getMetadata", { path: target });
          if (metadata?.isDirectory) throw new Error("That path is a directory");
          // 协议 getMetadata **不返回大小**（只有 isDirectory/isFile/isSymlink/时间戳），
          // 所以大小上限用本地 stat 预检（桥和 app-server 在同一台机器上），读完再按真实长度复核一次。
          const stat = statSync(target);
          if (stat.size > FILE_READ_MAX_BYTES) throw new Error(`File is too large to open here (${Math.round(stat.size / 1024)} KB)`);
          const result = await request("fs/readFile", { path: target });
          const data = Buffer.from(String(result?.dataBase64 || ""), "base64");
          if (data.length > FILE_READ_MAX_BYTES) throw new Error("File is too large to open here");
          const binary = data.includes(0);
          payload = {
            ok: true,
            path: target,
            size: data.length,
            binary,
            text: binary ? "" : data.toString("utf8"),
          };
        } else if (action === "write") {
          const target = resolveBrowsePath(String(body.path || ""), allowedRoots, homeDir);
          const data = Buffer.from(String(body.dataBase64 || ""), "base64");
          if (data.length > FILE_WRITE_MAX_BYTES) throw new Error("File is too large to write from here");
          await request("fs/writeFile", { path: target, dataBase64: data.toString("base64") });
          payload = { ok: true, path: target, size: data.length };
        } else if (action === "search") {
          const cwd = String(body.cwd || defaultCwd);
          const items = await searchWorkspaceFiles(cwd, String(body.query || ""), { allowedRoots, limit: 30 });
          payload = { ok: true, cwd, items };
        } else {
          throw new Error(`Unsupported file action: ${action}`);
        }
      } catch (error) {
        status = 400;
        payload = { error: error instanceof Error ? error.message : String(error) };
      }
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(payload));
    });
    return;
  }
  if (url.pathname === "/api/git") {
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "POST" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    let gitBody = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      gitBody += chunk;
      if (gitBody.length > 5_000_000) req.destroy(new Error("Git payload too large"));
    });
    req.on("end", () => {
      // 同步执行：git 本身是短的，只有 pull/push 会慢（各自的 timeout 在 git-service 里）。
      // 这里放在事件循环上是有意的——改前端后"看不出来是哪一步卡住"比慢更难查。
      let status = 200;
      let payload: any;
      try {
        const body = JSON.parse(gitBody || "{}");
        const { action, ...rest } = body;
        payload = gitDispatch(String(action ?? ""), rest, browseRoots);
      } catch (error) {
        status = 400;
        const detail = error instanceof GitError ? { command: error.command, stderr: error.stderr } : {};
        payload = { error: error instanceof Error ? error.message : String(error), ...detail };
      }
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(payload));
    });
    return;
  }
  if (url.pathname === "/api/review/patch") {
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "POST" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 2_000_000) req.destroy(new Error("Review patch payload too large"));
    });
    req.on("end", async () => {
      let requestPayload: ReturnType<typeof parseReviewPatchRequest> | null = null;
      let operationStarted = false;
      let success = false;
      try {
        const payload = JSON.parse(body || "{}");
        requestPayload = parseReviewPatchRequest(payload);
        let stored;
        try {
          stored = reviewDiffs.begin(requestPayload.threadId, requestPayload.turnId, requestPayload.action);
        } catch (error) {
          // 内存里没有（桥重启过、或这一轮是在别处跑的）：先回源重建再重试一次。
          if (!await recoverReviewDiff(requestPayload.threadId, requestPayload.turnId)) throw error;
          stored = reviewDiffs.begin(requestPayload.threadId, requestPayload.turnId, requestPayload.action);
        }
        operationStarted = true;
        const threadResult = await request("thread/read", { threadId: requestPayload.threadId, includeTurns: false });
        const cwd = threadResult?.thread?.cwd;
        if (typeof cwd !== "string" || !cwd) throw new Error("Thread working directory is unavailable");
        const result = await applyReviewPatch({ cwd, diff: stored.diff, action: requestPayload.action }, reviewRoots);
        success = true;
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      } finally {
        if (operationStarted && requestPayload) reviewDiffs.finish(requestPayload.threadId, requestPayload.turnId, requestPayload.action, success);
      }
    });
    return;
  }
  if (url.pathname.startsWith("/vendor/katex/")) {
    let relative;
    try { relative = decodeURIComponent(url.pathname.slice("/vendor/katex/".length)); }
    catch { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("Not found"); return; }
    const katexDir = resolve(appRoot, "node_modules/katex/dist");
    const file = resolveSafeRegularFile(katexDir, relative);
    if (!file) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("Not found"); return;
    }
    res.writeHead(200, { "content-type": mime[extname(file)] || "application/octet-stream", "cache-control": "public, max-age=86400" });
    res.end(readFileSync(file));
    return;
  }
  if (url.pathname === "/vendor/xterm/xterm.css") {
    const xtermDir = resolve(appRoot, "node_modules/@xterm/xterm/css");
    const file = resolveSafeRegularFile(xtermDir, "xterm.css");
    if (!file) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("Not found"); return;
    }
    res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=86400" });
    res.end(readFileSync(file));
    return;
  }
  const file = resolvePublicAsset(appRoute ? "/" : url.pathname, publicDir);
  if (!file) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("Not found"); return;
  }
  // Static assets are served uncompressed and un-cached, so every reload re-sends
  // the whole 1.5 MB bundle and the phone re-parses it — the server was never the
  // bottleneck (per-endpoint timings are 2–30 ms; the bundle transfer is 4 ms).
  // Gzip here is only about the phone's download+parse cost. The compressed buffer
  // is cached by (path, mtime, size) so repeat loads stay cheap.
  let body = readFileSync(file);
  const type = mime[extname(file)] || "application/octet-stream";
  if (type.startsWith("text/html")) {
    // Version the entry script and stamp the build id for the page to report.
    body = stampIndexHtml(body);
  }
  const gzippable = /^(text\/|application\/(javascript|json)|image\/svg)/.test(type);
  const wantsGzip = gzippable && /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""));
  // Temporary access log: proves whether the browser actually re-fetched a file
  // and with which encoding (the frontend's own requests are already visible, but
  // static assets were not — which is why "did my change reach the browser?" was
  // unanswerable from here).
  const fileMtimeMs = statSync(file).mtimeMs;
  const uaTag = url.pathname === "/" || url.pathname === "/app.bundle.js" ? ` ua=${shortUa(req)}` : "";
  // mt= is what makes "did the browser get the file I just built?" answerable without a rebuild:
  // compare it with `stat -c %Y app/public/app.bundle.js`.
  console.log(`[codex-webui] static ${url.pathname} ${body.length}B mt=${Math.round(fileMtimeMs)} enc=${wantsGzip ? "gzip" : "identity"}${uaTag}`);
  if (!wantsGzip) {
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
    return;
  }
  let compressed = gzipCache.get(file);
  if (!compressed || compressed.size !== body.length || compressed.mtimeMs !== fileMtimeMs) {
    compressed = { size: body.length, mtimeMs: fileMtimeMs, buf: gzipSync(body) };
    gzipCache.set(file, compressed);
    if (gzipCache.size > 16) gzipCache.delete(gzipCache.keys().next().value!);
  }
  res.writeHead(200, {
    "content-type": type,
    "content-encoding": "gzip",
    "content-length": String(compressed.buf.length),
    "cache-control": "no-store",
    vary: "accept-encoding",
  });
  res.end(compressed.buf);
});

const sseKeepalive = setInterval(() => {
  for (const client of sseClients) if (!client.writableEnded) client.write(": keepalive\n\n");
}, 25_000);
sseKeepalive.unref();

const wss = new WebSocketServer({ noServer: true });
const terminalWss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  let pathname = "";
  try { pathname = new URL(req.url || "/", "http://localhost").pathname; }
  catch { socket.destroy(); return; }
  if ((pathname !== "/ws" && pathname !== "/terminal") || !isAuthorizedHttpRequest(req, authSecret)) {
    const body = JSON.stringify({ error: "Authentication required" });
    socket.end([
      "HTTP/1.1 401 Unauthorized",
      "Connection: close",
      'WWW-Authenticate: Basic realm="Codex WebUI", charset="UTF-8"',
      "Content-Type: application/json; charset=utf-8",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "X-Content-Type-Options: nosniff",
      "",
      body,
    ].join("\r\n"));
    return;
  }
  const target = pathname === "/terminal" ? terminalWss : wss;
  target.handleUpgrade(req, socket, head, client => target.emit("connection", client, req));
});
wss.on("connection", (client) => {
  clients.add(client);
  client.send(JSON.stringify({ type: "bridge/status", status: connected ? "connected" : "connecting" }));
  client.on("message", (raw) => {
    try { handleClient(client, JSON.parse(String(raw))); }
    catch (error) { client.send(JSON.stringify({ type: "rpc/error", error: String(error) })); }
  });
  client.on("close", () => clients.delete(client));
});
terminalWss.on("connection", (client, req) => {
  let terminal: ReturnType<typeof createProtocolTerminalSession> | null = null;
  try {
    const url = new URL(req.url || "/terminal", "http://localhost");
    const cwd = resolveTerminalCwd(url.searchParams.get("cwd"), browseRoots, defaultCwd);
    terminal = createProtocolTerminalSession({
      request,
      cwd,
      cols: 100,
      rows: 24,
      onData: data => { if (client.readyState === WebSocket.OPEN) client.send(data); },
      onExit: event => {
        if (client.readyState === WebSocket.OPEN) {
          const reason = event.error
            ? `[Terminal failed: ${event.error.message}]`
            : `[Process exited ${event.exitCode}]`;
          client.send(`\r\n${reason}\r\n`);
          client.close(1000, "Terminal exited");
        }
      },
    });
    terminalSessions.set(client, terminal);
  } catch (error) {
    console.error("[codex-webui] terminal failed", error);
    client.close(1011, "Terminal unavailable");
    return;
  }
  client.on("message", (raw, isBinary) => {
    if (!terminal || raw.byteLength > 1_000_000) return;
    if (isBinary) {
      terminal.write(Buffer.from(raw as Buffer).toString("utf8"));
      return;
    }
    try {
      const resize = normalizeTerminalResize(JSON.parse(String(raw)));
      if (resize) {
        // 打一行：手机旋转/键盘弹出都会走这里，出问题时"尺寸到底变没变"要能直接看到（P6 旋转验收）。
        console.log(`[codex-webui] terminal resize -> ${resize.cols}x${resize.rows}`);
        terminal.resize(resize.cols, resize.rows);
      }
    } catch { /* Terminal input is sent as binary; ignore malformed control frames. */ }
  });
  client.on("close", () => {
    terminalSessions.delete(client);
    terminal?.kill();
    terminal = null;
  });
  client.on("error", () => client.close());
});

// The bundle is rebuilt on every start, and that build is synchronous: the stall
// detector measured ~8.3s of blocked startup, with server.listen() still not called,
// so the first page load of a fresh bridge raced a port nobody was listening on.
// The artefact only needs regenerating when an input is newer than it.
function frontendBundleIsCurrent(): boolean {
  const bundle = resolve(publicDir, "app.bundle.js");
  if (!existsSync(bundle)) return false;
  const builtAt = statSync(bundle).mtimeMs;
  return readdirSync(publicDir)
    .filter((name) => name.endsWith(".js") && name !== "app.bundle.js")
    .every((name) => statSync(resolve(publicDir, name)).mtimeMs <= builtAt);
}
if (frontendBundleIsCurrent()) {
  console.log("[codex-webui] frontend bundle is up to date (skipping bun build)");
} else {
  const frontendBuild = await Bun.build({
    entrypoints: [resolve(publicDir, "app.js")],
    outdir: publicDir,
    naming: "app.bundle.js",
    target: "browser",
    minify: false,
  });
  if (!frontendBuild.success) throw new Error(`Frontend build failed: ${frontendBuild.logs.join("\n")}`);
}

startCodex();
server.listen(port, host, () => {
  console.log(`Codex WebUI listening on http://${host}:${port}`);
  if (passwordSetupRequired()) console.warn(`[codex-webui] LAN password setup is required; the first LAN visitor will create it in ${managedPasswordPath}`);
  if (!localhostOnly) {
    const addresses = Object.values(networkInterfaces()).flat().filter((entry): entry is NonNullable<typeof entry> => !!entry && entry.family === "IPv4" && !entry.internal);
    for (const entry of addresses) console.log(`LAN: http://${entry.address}:${port} (authentication required)`);
  }
});

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  connected = false;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = null;
  clearInterval(sseKeepalive);
  for (const item of pending.values()) item.reject(new Error("Codex WebUI is shutting down"));
  pending.clear();
  for (const client of clients) client.terminate();
  clients.clear();
  for (const client of sseClients) client.end();
  sseClients.clear();
  wss.close();
  for (const [client, terminal] of terminalSessions) { terminal.kill(); client.terminate(); }
  terminalSessions.clear();
  terminalWss.close();
  terminateCodex();
  server.close(() => { httpClosed = true; maybeFinishShutdown(); });
  server.closeAllConnections?.();
  const forceExit = setTimeout(() => {
    terminateCodex("SIGKILL");
    process.exit(0);
  }, 5000);
  forceExit.unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// 原生通知出口（E116）。
//
// 背景：在 APK 里，页面的 Web Notification API 根本不存在（`Notification is undefined`），
// 所以"任务完成"这类提醒此前只能靠 agent 自己调 `termux-notification`——通知的来源是 Termux，
// 而不是应用本身。这里改成：**通知交给应用发**。
//
// 通道（按优先级）：
//   1. 应用注册过（`POST /api/notify/register`，由页面检测到 `window.CodexNative.notify` 时调用）
//      → 通过既有的 WS/SSE 广播 `notification/native`，页面转给 JS 接口 → 原生通知；
//   2. 没有应用在跑 → 退回 `termux-notification`（CLI-only 场景仍然有提醒，行为不退步）。
//
// 为什么不用轮询：页面本来就有一条长连接（WS/SSE），广播是现成的。
// 哪个应用还在跑？用**租约**而不是计数器：页面每 30 秒续一次，90 秒没续就当作不在了。
// 第一版是内存计数（+1 就完事），桥重启后归零、同一个页面注册三次就虚高，
// 最坏情形是"应用已经关掉，桥还以为它在，于是通知发给空气、Termux 兜底也不触发"。
const nativeNotifierLeases = new Map<string, number>();
const NATIVE_NOTIFIER_TTL_MS = 90_000;

/** 桥进程的启动时间（用来区分"刚重启"与"被系统挂起"，见 E117）。 */
const bridgeStartedAt = Date.now();

function nativeNotifierCount(): number {
  const now = Date.now();
  for (const [id, seenAt] of nativeNotifierLeases) {
    if (now - seenAt > NATIVE_NOTIFIER_TTL_MS) nativeNotifierLeases.delete(id);
  }
  return nativeNotifierLeases.size;
}

function sendNativeNotification(payload: { title: string; body: string; tag: string; threadId?: string }) {
  // 必须走 `codex/notification` 这个信封：页面是按 `payload.method` 分派的
  // （`onNotification(payload.method, payload.params)`）。第一版直接广播
  // `{type:"notification/native"}`，页面不认识这个 type，于是通知静默丢掉（E116 实测抓出）。
  broadcast({ type: "codex/notification", payload: { method: "notification/native", params: payload } });
}

/** 退回 Termux 通知：APK 没在跑（或页面还没注册）时用，避免"没人提醒"。 */
function notifyViaTermux(payload: { title: string; body: string; tag: string }) {
  try {
    spawn("termux-notification", ["-t", payload.title, "-c", payload.body, "-i", payload.tag], {
      stdio: "ignore",
    }).on("error", () => { /* termux-api 没装就当静默失败 */ });
  } catch { /* ignore */ }
}

