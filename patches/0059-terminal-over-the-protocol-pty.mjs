// Patch 0059 — 交互式终端改用 app-server 的 PTY（去掉 node-pty 依赖）。
//
// 现场：终端面板连上就断（`client.close(1011, "Terminal unavailable")`），因为
// terminal-service.js → terminal-worker.js → `import pty from 'node-pty'`，而 node-pty
// 在 Termux aarch64 上装不出来（本项目已把它从 package.json 移除）。
//
// 协议里有真 PTY，且已用 probe/pty-exec.mjs 对着真 app-server 逐条验过：
// 提示符/回显、`stty size` 24x100、resize 立刻生效、Ctrl+C 中断前台进程（$?=130 且 shell 活着）、
// 中文分片不乱码、退出码 7 原样带回。
//
// 本补丁只动桥（server.ts）+ 新增 protocol-terminal.js；页面侧完全不动：
// `/terminal` WebSocket 的契约（连接后收原始输出、二进制帧=输入、JSON=resize）保持不变。
//
// Usage: node patches/0059-terminal-over-the-protocol-pty.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const file = resolve(appDir, "server.ts");
let source = readFileSync(file, "utf8");

if (source.includes("createProtocolTerminalSession")) {
  console.log("skip  server.ts (already applied)");
} else {
  const steps = [
    [
      'import { createRequestRegistry } from "./request-registry.js";',
      'import { createRequestRegistry } from "./request-registry.js";\n'
        + '// 交互式终端：app-server 的 `command/exec{tty:true}`（协议里的真 PTY），不再用 node-pty。\n'
        + 'import { createProtocolTerminalSession, failAllProtocolTerminals, handleProtocolTerminalDelta } from "./protocol-terminal.js";',
      "import protocol terminal",
    ],
    [
      'import { createTerminalSession, normalizeTerminalResize, resolveTerminalCwd } from "./terminal-service.js";',
      'import { normalizeTerminalResize, resolveTerminalCwd } from "./terminal-service.js";',
      "drop the node-pty session import",
    ],
    [
      "function request(method: string, params: any = {}) {\n"
        + "  const id = seq++;\n"
        + "  sendRaw({ id, method, params });\n"
        + "  return new Promise<any>((resolvePromise, reject) => {\n"
        + "    const timer = setTimeout(() => {\n"
        + "      pending.delete(id);\n"
        + "      reject(new Error(`Codex request timed out: ${method}`));\n"
        + "    }, 30000);\n"
        + "    pending.set(id, {\n"
        + "      resolve: (value) => { clearTimeout(timer); resolvePromise(value); },\n"
        + "      reject: (error) => { clearTimeout(timer); reject(error); },\n"
        + "    });\n"
        + "  });\n"
        + "}",
      "// timeoutMs = 0 表示不设超时：`command/exec` 的最终响应要等进程退出才回来，\n"
        + "// 交互式 shell 可能活很久，套 30 秒超时会把刚开的终端直接判死。\n"
        + "function request(method: string, params: any = {}, timeoutMs = 30000) {\n"
        + "  const id = seq++;\n"
        + "  sendRaw({ id, method, params });\n"
        + "  return new Promise<any>((resolvePromise, reject) => {\n"
        + "    const timer = timeoutMs > 0 ? setTimeout(() => {\n"
        + "      pending.delete(id);\n"
        + "      reject(new Error(`Codex request timed out: ${method}`));\n"
        + "    }, timeoutMs) : null;\n"
        + "    pending.set(id, {\n"
        + "      resolve: (value) => { if (timer) clearTimeout(timer); resolvePromise(value); },\n"
        + "      reject: (error) => { if (timer) clearTimeout(timer); reject(error); },\n"
        + "    });\n"
        + "  });\n"
        + "}",
      "optional request timeout",
    ],
    [
      "    if (message.method === \"turn/completed\") notifyNtfyTurnCompleted(message.params || {});\n    broadcast({ type: \"codex/notification\", payload: message });",
      "    if (message.method === \"turn/completed\") notifyNtfyTurnCompleted(message.params || {});\n"
        + "    // 终端输出量很大，而且只对开着终端的那个连接有意义：交给 /terminal 那条 WebSocket，\n"
        + "    // 不能像其它通知那样广播给所有页面（否则每次 ls 都往每个页面灌一坨）。\n"
        + "    if (message.method === \"command/exec/outputDelta\" && handleProtocolTerminalDelta(message.params)) return;\n"
        + "    broadcast({ type: \"codex/notification\", payload: message });",
      "route terminal deltas",
    ],
    [
      "  socket.on(\"close\", () => {\n    if (appServerSocket === socket) appServerSocket = null;\n    if (shuttingDown) return;",
      "  socket.on(\"close\", () => {\n"
        + "    if (appServerSocket === socket) appServerSocket = null;\n"
        + "    // 终端的 PTY 是连接作用域的：这条连接一断，服务端就把进程杀了。\n"
        + "    // 页面要看到明确的结束语，而不是永远停在最后一帧。\n"
        + "    failAllProtocolTerminals(\"app-server connection closed\");\n"
        + "    if (shuttingDown) return;",
      "fail terminals when the socket dies",
    ],
    [
      "terminalWss.on(\"connection\", (client, req) => {\n  let terminal: ReturnType<typeof createTerminalSession> | null = null;",
      "terminalWss.on(\"connection\", (client, req) => {\n  let terminal: ReturnType<typeof createProtocolTerminalSession> | null = null;",
      "terminal session type",
    ],
    [
      "    terminal = createTerminalSession({\n"
        + "      cwd,\n"
        + "      cols: 100,\n"
        + "      rows: 24,\n"
        + "      onData: data => { if (client.readyState === WebSocket.OPEN) client.send(data); },\n"
        + "      onExit: event => {\n"
        + "        if (client.readyState === WebSocket.OPEN) {\n"
        + "          client.send(`\\r\\n[Process exited ${event.exitCode}]\\r\\n`);\n"
        + "          client.close(1000, \"Terminal exited\");\n"
        + "        }\n"
        + "      },\n"
        + "    });",
      "    terminal = createProtocolTerminalSession({\n"
        + "      request,\n"
        + "      cwd,\n"
        + "      cols: 100,\n"
        + "      rows: 24,\n"
        + "      onData: data => { if (client.readyState === WebSocket.OPEN) client.send(data); },\n"
        + "      onExit: event => {\n"
        + "        if (client.readyState === WebSocket.OPEN) {\n"
        + "          const reason = event.error\n"
        + "            ? `[Terminal failed: ${event.error.message}]`\n"
        + "            : `[Process exited ${event.exitCode}]`;\n"
        + "          client.send(`\\r\\n${reason}\\r\\n`);\n"
        + "          client.close(1000, \"Terminal exited\");\n"
        + "        }\n"
        + "      },\n"
        + "    });",
      "use the protocol session",
    ],
  ];
  for (const [from, to, label] of steps) {
    const hits = source.split(from).length - 1;
    if (hits !== 1) throw new Error("cannot locate " + label + " exactly once (hits=" + hits + ")");
    source = source.replace(from, to);
    console.log("apply server.ts: " + label);
  }
  writeFileSync(file, source);
}

// terminal-service.js 留着 normalizeTerminalResize / resolveTerminalCwd（这两条仍在用），
// 但它的 createTerminalSession 已经不会再被调用：在文件头写明，免得下一个接手的人又去装 node-pty。
{
  const path = resolve(appDir, "terminal-service.js");
  let text = readFileSync(path, "utf8");
  const marker = "// 2026-10-16 (patches/0059)";
  if (text.includes(marker)) {
    console.log("skip  terminal-service.js (already noted)");
  } else {
    const note = marker + "：`createTerminalSession`（node-pty 版）已废弃——\n"
      + "// node-pty 在 Termux aarch64 上装不出来，终端改走协议 PTY（app/protocol-terminal.js，\n"
      + "// 见 patches/0059）。本文件只剩 `normalizeTerminalResize` 与 `resolveTerminalCwd` 还在用。\n"
      + "// 不要再走回装 node-pty 这条路。\n";
    writeFileSync(path, note + text);
    console.log("apply terminal-service.js: deprecated note");
  }
}

console.log("done — restart the bridge: ~/bin/codex-gui-web restart");
