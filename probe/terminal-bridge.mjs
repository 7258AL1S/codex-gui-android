// 桥上的 `/terminal` WebSocket：页面用的那条路（P6）。
//
// 页面侧契约（app.js 的 connectTerminal）：连上 `ws://host/terminal?cwd=…` 后，
// **二进制帧 = 键盘输入**，**JSON 文本帧 = resize**（{type:'resize',cols,rows}），
// 服务端把原始终端输出当字符串/二进制推回来，进程结束时先来一句 `[Process exited N]` 再关连接。
//
// 上游这条路由是 node-pty 支撑的（在 Termux 上装不出来 → 连上就 1011）。
// 这个探针就是用来证明"换成协议 PTY 之后，页面这条契约原样可用"。
//
//   node probe/terminal-bridge.mjs
import { homedir } from "node:os";

const PORT = process.env.CODEX_GUI_PORT ?? "8899";
const CWD = process.env.PTY_CWD || homedir();
const url = `ws://127.0.0.1:${PORT}/terminal?cwd=${encodeURIComponent(CWD)}`;

const cases = [];
const check = (name, ok, detail = "") => {
  cases.push({ name, ok: Boolean(ok) });
  console.log((ok ? "ok    " : "FAIL  ") + name + (ok || !detail ? "" : "  <- " + detail));
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let raw = "";
let text = "";
let closed = null;
const stripAnsi = (value) => value
  .replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, "")
  .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
  .replace(/\r/g, "");

const ws = new WebSocket(url);
ws.binaryType = "arraybuffer";
ws.onmessage = (frame) => {
  const data = frame.data;
  const chunk = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
  raw += chunk;
  text += stripAnsi(chunk);
};
ws.onclose = (event) => { closed = event; };

async function waitFor(pattern, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(text)) return true;
    if (closed) return false;
    await sleep(50);
  }
  return false;
}

const send = (data) => ws.send(new TextEncoder().encode(data));
const resize = (cols, rows) => ws.send(JSON.stringify({ type: "resize", cols, rows }));

await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error("socket error: " + url));
  setTimeout(() => reject(new Error("connect timeout: " + url)), 8000);
}).catch((error) => {
  check("连上 /terminal", false, error.message);
  console.log("\n1 FAILED");
  process.exit(1);
});

check("连上 /terminal", true);
check("拿到提示符（说明桥真的起了 PTY）", await waitFor(/[$#%>] /), JSON.stringify(text.slice(-200)));
check("输出里有 ANSI 控制序列（终端而不是管道）", /\u001b\[/.test(raw));

send("echo BRIDGE-PTY-OK\r");
check("二进制帧 = 键盘输入，命令被执行", await waitFor(/BRIDGE-PTY-OK/), JSON.stringify(text.slice(-200)));

resize(120, 40);
await sleep(300);
send("stty size\r");
check("JSON 文本帧 = resize，pty 尺寸跟着变（40 120）", await waitFor(/40 120/), JSON.stringify(text.slice(-200)));

send("sleep 30\r");
await sleep(700);
const startedAt = Date.now();
send("\u0003");
check("Ctrl+C（\\x03）中断前台进程", await waitFor(/code=|[$#%>] /, 6000) && Date.now() - startedAt < 6000);
send("echo interrupted=$?\r");
check("被中断的命令退出码 130", await waitFor(/interrupted=130/), JSON.stringify(text.slice(-200)));

send("exit 3\r");
const sawExit = await waitFor(/\[Process exited 3\]/, 8000);
await sleep(300);
check("退出码以 [Process exited 3] 报给页面", sawExit, JSON.stringify(text.slice(-200)));
check("随后关闭连接（页面会显示为终端结束）", Boolean(closed), JSON.stringify(closed && { code: closed.code, reason: closed.reason }));

const failed = cases.filter((item) => !item.ok).length;
console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
