// Patch 0077 — 启动阶段打点：`启动慢` 这类问题必须能在日志里自己回答。
//
// 用户两次问过"启动桥为什么这么慢"，两次都得靠事后拼时间线（App 上报 `ready after 14s/23s`、
// 再手动去数日志行）。桥的启动路径有好几段（bun 载入 → HTTP 监听 → adopt 旧实例 → spawn
// app-server → WS 连接 → initialize），任何一段变慢都长得一样。
//
// 这批打点在启动路径上各加一行 `START +Nms <阶段>`（相对进程启动的毫秒数），正常启动一眼可读；
// 不影响稳态运行。
//
// Usage: node patches/0077-startup-phase-trace.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const file = resolve(appDir, "server.ts");
let source = readFileSync(file, "utf8");

if (source.includes("START +")) {
  console.log("skip  server.ts (already applied)");
} else {
  const helper = [
    "// 启动阶段打点（E124）：`START +Nms <阶段>`——「启动慢」时先看这里，别靠事后拼时间线。",
    "const bootStartedAt = Date.now();",
    "function startMark(label: string) {",
    "  console.log(`[codex-webui] START +${Date.now() - bootStartedAt}ms ${label}`);",
    "}",
    "",
  ].join("\n");

  const steps = [
    [
      "let seq = 1;\nlet codex: ChildProcess | null = null;",
      helper + "let seq = 1;\nlet codex: ChildProcess | null = null;",
      "helper",
    ],
    [
      "  void adoptExistingAppServer(token)",
      "  startMark(\"startCodex: adopting an existing app-server\");\n  void adoptExistingAppServer(token)",
      "mark adopt",
    ],
    [
      "      if (adopted || shuttingDown) return;\n      spawnAppServer(token);",
      "      startMark(`adopt resolved adopted=${adopted}`);\n      if (adopted || shuttingDown) return;\n      spawnAppServer(token);",
      "mark adopt result",
    ],
    [
      "function spawnAppServer(token: string) {\n  if (shuttingDown) return;",
      "function spawnAppServer(token: string) {\n  startMark(\"spawning the app-server\");\n  if (shuttingDown) return;",
      "mark spawn",
    ],
    [
      "    if (!appServerSocket && text.includes(\"listening on\")) connectAppServerSocket(token);",
      "    if (!appServerSocket && text.includes(\"listening on\")) {\n"
        + "      startMark(\"app-server reported listening; connecting the socket\");\n"
        + "      connectAppServerSocket(token);\n"
        + "    }",
      "mark child listening",
    ],
    [
      "  socket.on(\"open\", () => {\n    stdoutBuffer = \"\";",
      "  socket.on(\"open\", () => {\n    startMark(\"bridge↔app-server socket open; sending initialize\");\n    stdoutBuffer = \"\";",
      "mark socket open",
    ],
    [
      "  connected = true;\n  broadcast({ type: \"bridge/status\", status: \"connected\", info: result });",
      "  connected = true;\n"
        + "  startMark(\"connected (ready=true)\");\n"
        + "  broadcast({ type: \"bridge/status\", status: \"connected\", info: result });",
      "mark ready",
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

console.log("done — restart the bridge: ~/bin/codex-gui-web restart");
