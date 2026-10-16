// Patch 0078 — app-server 一报 "listening on"，立刻连，不等重连退避。
//
// 现场（0077 的启动打点，一次普通启动）：
//   START +1ms    startCodex: adopting an existing app-server
//   START +1210ms adopt resolved adopted=false          ← adopt 窗口
//   START +1210ms spawning the app-server
//   START +7229ms bridge↔app-server socket open          ← **6 秒空白**
//   START +7232ms connected (ready=true)
// 而 app-server 自己 ~600ms 就能服务（同一台机器上单独起过）。那 6 秒去哪了？
//
// adopt 阶段会先连一次 WebSocket（端口上还没有实例，必然失败）。失败会走重连退避：
// `appServerConnectAttempts` 从 1 开始按 500ms → 1s → 2s → 4s 递增，最多 5 次。
// 等孩子真的起来并打印 "listening on" 时，桥侧的连接尝试**还卡在退避里**——
// 而且 `if (appServerSocket || appServerReconnectTimer) return;` 那条防线也不让它立刻重连。
// 于是"端口通了"和"桥连上"之间白白空转 5–6 秒——用户看到的就是"启动桥很慢"（E124）。
//
// 修法：孩子报 listening 时，重置退避计数、清掉待执行的退避定时器、把还没 OPEN 的旧 socket
// 丢掉，立刻连一次。这是"事件驱动"而不是"等退避"。
//
// Usage: node patches/0078-connect-as-soon-as-listening.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const file = resolve(appDir, "server.ts");
let source = readFileSync(file, "utf8");

if (source.includes("connect immediately, the child is up")) {
  console.log("skip  server.ts (already applied)");
} else {
  const from = [
    "    if (!appServerSocket && text.includes(\"listening on\")) {",
    "      startMark(\"app-server reported listening; connecting the socket\");",
    "      connectAppServerSocket(token);",
    "    }",
  ].join("\n");
  const to = [
    "    if (text.includes(\"listening on\")) {",
    "      // connect immediately, the child is up（不等退避：adopt 那次失败会把退避拉到 2s/4s）",
    "      appServerConnectAttempts = 0;",
    "      if (appServerReconnectTimer) { clearTimeout(appServerReconnectTimer); appServerReconnectTimer = null; }",
    "      try { if (appServerSocket && appServerSocket.readyState !== WebSocket.OPEN) appServerSocket.close(); } catch { /* ignore */ }",
    "      appServerSocket = null;",
    "      startMark(\"app-server reported listening; connecting the socket\");",
    "      connectAppServerSocket(token);",
    "    }",
  ].join("\n");
  const hits = source.split(from).length - 1;
  if (hits !== 1) throw new Error("cannot locate the listening branch exactly once (hits=" + hits + ")");
  writeFileSync(file, source.replace(from, to));
  console.log("apply server.ts: connect as soon as the child is listening");
}

console.log("done — restart the bridge: ~/bin/codex-gui-web restart");
