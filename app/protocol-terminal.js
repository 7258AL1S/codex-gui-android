// 交互式终端走 app-server 的 PTY（`command/exec{tty:true}`），不再依赖 node-pty。
//
// 背景（P6）：上游的终端面板是 node-pty 起子进程，而 node-pty 在 Termux aarch64 上装不出来，
// 本项目早就把它从 package.json 移除了——于是"终端"一直是坏的（连上就 1011 关掉）。
// 协议里有真 PTY：`tty:true` 分配 pty、`command/exec/write` 写 stdin（Ctrl+C 就是 \x03，
// 由 pty 的 ISIG 交给前台进程组）、`command/exec/resize` 改窗口、`command/exec/terminate` 结束；
// 输出以 base64 走 `command/exec/outputDelta` 通知，最终响应在进程退出后才回来。
// 行为已用 probe/pty-exec.mjs 对着真 app-server 逐条验过（回显、stty size、resize、Ctrl+C、
// 中文分片、退出码）。
//
// 关键约束（来自协议文档）：这些通知是**连接作用域**的——发起它的连接一断，服务端就杀掉进程。
// 所以终端寄生在桥与 app-server 的那条长连接上；桥断开时下面 failAll() 会让页面看到明确的结束语，
// 而不是永远转圈。
import { randomUUID } from "node:crypto";

const sessions = new Map();
const MAX_SESSIONS = 6;

/** 会话内的流式解码器：一个 base64 分片可能把多字节字符劈成两半。 */
function decodeChunk(state, deltaBase64) {
  try {
    return state.decoder.decode(Buffer.from(deltaBase64, "base64"), { stream: true });
  } catch {
    return "";
  }
}

export function createProtocolTerminalSession({ request, cwd, cols = 100, rows = 24, onData, onExit, shell, env }) {
  if (sessions.size >= MAX_SESSIONS) {
    const error = new Error(`Already running ${MAX_SESSIONS} terminals`);
    queueMicrotask(() => onExit?.({ exitCode: null, signal: null, error }));
    return { processId: null, write: () => false, resize: () => false, kill: () => {} };
  }
  const processId = `term-${randomUUID()}`;
  const state = {
    processId,
    decoder: new TextDecoder("utf-8"),
    onData,
    finish: null,
  };
  let finished = false;
  const finish = (exitCode, signal = null, error = null) => {
    if (finished) return;
    finished = true;
    sessions.delete(processId);
    try { onExit?.({ exitCode: exitCode ?? 0, signal, error }); } catch { /* never fatal */ }
  };
  state.finish = finish;
  sessions.set(processId, state);

  const command = [shell || process.env.SHELL || "/bin/sh", "-l"];
  Promise.resolve()
    // 最终响应要等进程退出：这里**不能**带请求超时（request 的第二个参数 0 = 不超时）。
    .then(() => request("command/exec", {
      command,
      processId,
      tty: true,
      streamStdoutStderr: true,
      disableTimeout: true,
      cwd,
      size: { cols, rows },
      env: { TERM: "xterm-256color", COLORTERM: "truecolor", ...(env || {}) },
    }, 0))
    .then((result) => finish(result?.exitCode ?? 0))
    .catch((error) => finish(null, null, error));

  return {
    processId,
    write: (data) => {
      if (finished || !data) return false;
      void request("command/exec/write", {
        processId,
        deltaBase64: Buffer.from(String(data), "utf8").toString("base64"),
      }).catch(() => {});
      return true;
    },
    resize: (nextCols, nextRows) => {
      if (finished) return false;
      const size = { cols: Number(nextCols), rows: Number(nextRows) };
      if (!Number.isInteger(size.cols) || !Number.isInteger(size.rows)) return false;
      // 失败不致命：窗口尺寸只影响排版，不影响能不能敲命令。
      void request("command/exec/resize", { processId, size }).catch(() => {});
      return true;
    },
    kill: () => {
      if (finished) return;
      void request("command/exec/terminate", { processId }).catch(() => finish(0));
    },
  };
}

/** 把 `command/exec/outputDelta` 交给对应的终端；返回 true 表示这条通知已经被消化。 */
export function handleProtocolTerminalDelta(params) {
  const state = params?.processId ? sessions.get(params.processId) : null;
  if (!state) return false;
  const text = decodeChunk(state, params.deltaBase64);
  if (text) state.onData?.(text);
  return true;
}

/** 桥与 app-server 的连接断了：所有终端都随连接一起死（协议如此），别让页面干等。 */
export function failAllProtocolTerminals(reason = "app-server connection closed") {
  for (const state of [...sessions.values()]) {
    state.finish(null, null, new Error(reason));
  }
  sessions.clear();
}

export function protocolTerminalCount() {
  return sessions.size;
}
