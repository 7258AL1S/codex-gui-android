// 终端的生命周期：连上、跑命令、断开之后，那个 shell 必须**真的死掉**（P6）。
//
// 起因：在手机上开关终端面板几次之后，`ps` 里留下了多个 `bash -l`（父进程都是 app-server）。
// 协议规定 `command/exec` 的进程是"连接作用域"的：发起它的连接断掉，服务端就杀进程——
// 但那条连接是**桥↔app-server** 的长连接，不是页面的 WebSocket；所以页面断开时，
// 必须由桥显式 `command/exec/terminate`。这个探针就是验证这件事真的发生了。
//
//   node probe/terminal-lifecycle.mjs
import { execFileSync } from "node:child_process";

const PORT = process.env.CODEX_GUI_PORT ?? "8899";
const CWD = process.env.PTY_CWD || process.env.HOME;
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : `  <- ${detail}`}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 桥的 app-server 名下的 `bash -l` 有几个——**必须按父进程数**：
 * 用户自己的交互 shell 也是 `bash -l`，只按名字数会把基线污染成 3。
 */
function shellCount() {
  let output = "";
  try { output = execFileSync("ps", ["-ef"], { encoding: "utf8" }); }
  catch { return -1; }
  const lines = output.split("\n");
  const appServer = lines.find((line) => /codex\.bin app-server --listen ws:\/\/127\.0\.0\.1:/.test(line));
  const pid = appServer ? appServer.trim().split(/\s+/)[1] : null;
  if (!pid) return -1;
  return lines.filter((line) => line.trim().split(/\s+/)[2] === pid && /\bbash -l\b/.test(line)).length;
}

const baseline = shellCount();
console.log(`基线：${baseline} 个 shell`);

const stripAnsi = (value) => String(value)
  .replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, "")
  .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");

async function openTerminal() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/terminal?cwd=${encodeURIComponent(CWD)}`);
  let text = "";
  ws.binaryType = "arraybuffer";
  ws.onmessage = (frame) => {
    const data = frame.data;
    text += typeof data === "string" ? data : Buffer.from(data).toString("utf8");
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("socket error"));
    setTimeout(() => reject(new Error("connect timeout")), 8000);
  });
  return { ws, text: () => text, send: (data) => ws.send(new TextEncoder().encode(data)) };
}

async function waitFor(read, pattern, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(stripAnsi(read()))) return true;
    await sleep(60);
  }
  return false;
}

// 1) 打开 → 有 shell → 断开 → shell 必须消失
const first = await openTerminal();
check("连上后拿到提示符", await waitFor(first.text, /[$#%>] /), JSON.stringify(first.text().slice(-120)));
const afterOpen = shellCount();
check("打开终端会多一个 shell", afterOpen === baseline + 1, `${baseline} -> ${afterOpen}`);
first.ws.close();
let reaped = false;
for (let attempt = 0; attempt < 25 && !reaped; attempt += 1) {
  await sleep(200);
  reaped = shellCount() <= baseline;
}
check("页面断开后桥会终止该 shell（不留残骸）", reaped, `still ${shellCount()} shells`);

// 2) 正常退出：`exit 0` → 页面先收到 [Process exited 0]，随后连接关闭
const second = await openTerminal();
await waitFor(second.text, /[$#%>] /);
second.send("exit 0\r");
const sawExit = await waitFor(second.text, /\[Process exited 0\]/, 6000);
check("退出码以 [Process exited 0] 报给页面", sawExit, JSON.stringify(second.text().slice(-160)));
await sleep(500);
check("退出后连接被关闭", second.ws.readyState === WebSocket.CLOSED || second.ws.readyState === WebSocket.CLOSING, `readyState=${second.ws.readyState}`);

// 3) 终端用的是工作区目录（会话关联）
const third = await openTerminal();
await waitFor(third.text, /[$#%>] /);
third.send("pwd\r");
await waitFor(third.text, new RegExp(CWD.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), 6000);
check("终端的工作目录就是工作区", stripAnsi(third.text()).includes(CWD), JSON.stringify(stripAnsi(third.text()).slice(-200)));
third.ws.close();
await sleep(600);

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
