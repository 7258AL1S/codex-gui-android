// 交互式终端到底走不走得通：直连 app-server 的 `command/exec{tty:true}`（P6/E11）。
//
// 上游的终端是 node-pty 起子进程，而 node-pty 在 Termux aarch64 上装不了（本项目已从
// package.json 移除）——所以"终端面板"一直是坏的。协议里有 PTY：`command/exec` 的 `tty`
// 会分配真 pty，`command/exec/write` 写 stdin，`command/exec/resize` 改窗口，
// `command/exec/terminate` 结束，输出以 base64 走 `command/exec/outputDelta` 通知，
// 最终响应在进程退出后才回来。
//
// 这个探针不断言"接口存在"，而是断言终端该有的行为：回显、`stty size` 反映真实尺寸、
// resize 立刻生效、Ctrl+C 真的中断前台进程（$? = 130 且 shell 自己活着）、退出码能带回来。
//
//   node probe/pty-exec.mjs
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const URL = process.env.WS_URL ?? "ws://127.0.0.1:8901/";
const TOKEN = (process.env.WS_TOKEN ?? readFileSync(join(homedir(), ".codex", "codex-webui", "ws-token"), "utf8")).trim();
const SHELL = process.env.SHELL || "/bin/sh";
const CWD = process.env.PTY_CWD || homedir();

const cases = [];
const check = (name, ok, detail = "") => {
  cases.push({ name, ok: Boolean(ok), detail });
  console.log((ok ? "ok    " : "FAIL  ") + name + (ok || !detail ? "" : "  <- " + detail));
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ws = new WebSocket(URL, { headers: { Authorization: `Bearer ${TOKEN}` } });
const pending = new Map();
let nextId = 1;
// 终端输出里全是 ANSI 转义（彩色提示符、光标控制），断言要对着"剥掉转义"的文本做；
// 原始流另存一份，用来证明这确实是终端而不是管道。
let raw = "";
let output = "";
const stripAnsi = (value) => value
  .replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, "")
  .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
  .replace(/\r/g, "");
const decoder = new TextDecoder("utf-8");
const boundaries = [];
const rpc = (method, params, timeoutMs = 15000) => new Promise((resolve, reject) => {
  const id = nextId++;
  const timer = timeoutMs > 0 ? setTimeout(() => {
    pending.delete(id);
    reject(new Error(`timeout: ${method}`));
  }, timeoutMs) : null;
  pending.set(id, (message) => {
    if (timer) clearTimeout(timer);
    if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
    else resolve(message.result);
  });
  ws.send(JSON.stringify({ id, method, params }));
});

ws.onmessage = (frame) => {
  const message = JSON.parse(String(frame?.data ?? frame));
  if (message.id != null && pending.has(message.id)) {
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    resolve(message);
    return;
  }
  if (message.method === "command/exec/outputDelta") {
    // 一个 base64 分片可能把多字节字符劈成两半：必须用流式解码器，否则中文/emoji 变乱码。
    const chunk = decoder.decode(Buffer.from(message.params.deltaBase64, "base64"), { stream: true });
    raw += chunk;
    output += stripAnsi(chunk);
  }
};

async function waitFor(pattern, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rest = output.slice(boundaries.at(-1) ?? 0);
    if (pattern.test(rest)) return rest;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${pattern} — got: ${JSON.stringify(output.slice(-400))}`);
}

const mark = () => boundaries.push(output.length);

await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error("socket error"));
  setTimeout(() => reject(new Error("connect timeout")), 6000);
});
await rpc("initialize", {
  clientInfo: { name: "pty-probe", title: "PTY probe", version: "0.1.0" },
  capabilities: { experimentalApi: true, requestAttestation: false },
});

const processId = `pty-probe-${randomUUID()}`;
const write = (data) => rpc("command/exec/write", { processId, deltaBase64: Buffer.from(data, "utf8").toString("base64") });
const resize = (cols, rows) => rpc("command/exec/resize", { processId, size: { cols, rows } });

// 最终响应要等进程退出才回来：不能带 15 秒的超时，否则长命 shell 一开就被判超时。
const exitPromise = rpc("command/exec", {
  command: [SHELL, "-l"],
  processId,
  tty: true,
  streamStdoutStderr: true,
  disableTimeout: true,
  cwd: CWD,
  size: { cols: 100, rows: 24 },
  env: { TERM: "xterm-256color", COLORTERM: "truecolor" },
}, 0);

try {
  await waitFor(/[$#%>] /, 10000); // 登录 shell 的提示符
  check("PTY 起来并给出提示符", true);

  mark();
  await write("echo PTY-OK-$((6*7))\r");
  const echoed = await waitFor(/PTY-OK-42/);
  check("命令执行 + 回显走 PTY", /echo PTY-OK-\$\(\(6\*7\)\)/.test(echoed), JSON.stringify(echoed.slice(0, 120)));
  check("PTY 是终端而不是管道（原始流里有 ANSI 控制序列）", /\u001b\[/.test(raw), JSON.stringify(raw.slice(0, 60)));

  mark();
  await write("stty size\r");
  const size = await waitFor(/\d+ \d+/);
  check("初始尺寸 = 24 行 100 列", /24 100/.test(size), JSON.stringify(size.slice(0, 80)));

  mark();
  await resize(120, 40);
  await sleep(200);
  await write("stty size\r");
  const resized = await waitFor(/40 120/);
  check("resize 立刻生效（40 行 120 列）", /40 120/.test(resized), JSON.stringify(resized.slice(0, 80)));
  await resize(100, 24);

  mark();
  const startedAt = Date.now();
  await write("sleep 30\r");
  await sleep(800);
  await write("\u0003"); // Ctrl+C：走 pty 的 ISIG，由内核送给前台进程组
  const interrupted = await waitFor(/[$#%>] /, 6000);
  const elapsed = Date.now() - startedAt;
  check("Ctrl+C 中断前台进程（<6s 回到提示符）", elapsed < 6000, `elapsed=${elapsed}ms`);
  mark();
  await write("echo code=$?\r");
  const code = await waitFor(/code=\d+/);
  check("被中断的命令退出码是 130（SIGINT）", /code=130/.test(code), JSON.stringify(code.slice(0, 80)));
  check("Ctrl+C 没有把 shell 自己打死", /[$#%>] /.test(interrupted));

  mark();
  await write("printf '中文-%s\\n' OK\r");
  const utf8 = await waitFor(/中文/);
  check("多字节字符没有被分片劈坏", /中文/.test(utf8), JSON.stringify(utf8.slice(0, 80)));

  mark();
  await write("exit 7\r");
  const exit = await exitPromise;
  check("退出码经最终响应带回", exit?.exitCode === 7, JSON.stringify(exit));
} catch (error) {
  check("探针跑到底", false, error.message);
} finally {
  try { ws.close(); } catch { /* ignore */ }
}

const failed = cases.filter((item) => !item.ok).length;
console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
