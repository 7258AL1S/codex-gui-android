// Patch 0079 — 别再等孩子的 stdout 那句 "listening on"：块缓冲会晚到 6 秒。
//
// 0078 之后启动打点依然显示：
//   START +1215ms spawning the app-server
//   [codex app-server] listening on: ws://127.0.0.1:8901      ← 和下面同一毫秒才出现
//   START +7237ms bridge↔app-server socket open; sending initialize
// 也就是说：孩子早就起来了，但它那行 "listening on" **直到 6 秒后才被桥读到**——
// 因为 `spawn(..., stdio:['ignore','pipe','pipe'])` 下孩子的 stdout 是**块缓冲**（不是行缓冲），
// 那行字一直躺在缓冲区里，直到有足够多的输出把缓冲冲出去。桥却把"读到这行字"当成
// "app-server 起来了"的信号 → 白等 6 秒（E124）。
//
// 修法：不看 stdout，**看端口**。spawn 之后每 200ms 探一次（没连接在飞就发起一次 WS 连接，
// 并忽略退避计数），谁先到算谁的；20 秒还没起来就交给原有的崩溃重试逻辑。
// 这样无论孩子怎么缓冲输出、退避怎么排，桥都能在端口可用的那一瞬间连上。
//
// Usage: node patches/0079-connect-without-waiting-for-stdout.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const file = resolve(appDir, "server.ts");
let source = readFileSync(file, "utf8");

if (source.includes("function watchForAppServer")) {
  console.log("skip  server.ts (already applied)");
} else {
  const helper = [
    "/**",
    " * 端口一可用就连上——**不要**等孩子的 stdout 打印 \"listening on\"：",
    " * 管道下的 stdout 是块缓冲，那行字可能晚 6 秒才到（E124 实测），而端口早就能用了。",
    " */",
    "function watchForAppServer(token: string) {",
    "  const deadline = Date.now() + 20000;",
    "  const tick = () => {",
    "    if (shuttingDown) return;",
    "    if (appServerSocket && (appServerSocket.readyState === WebSocket.OPEN || appServerSocket.readyState === WebSocket.CONNECTING)) {",
    "      return void setTimeout(tick, 200);",
    "    }",
    "    if (Date.now() > deadline) return;",
    "    // 忽略退避：孩子就在本机，端口开了就该连；退避是给\"服务端挂了\"用的。",
    "    appServerConnectAttempts = 0;",
    "    if (appServerReconnectTimer) { clearTimeout(appServerReconnectTimer); appServerReconnectTimer = null; }",
    "    connectAppServerSocket(token);",
    "    setTimeout(tick, 200);",
    "  };",
    "  setTimeout(tick, 120);",
    "}",
    "",
  ].join("\n");

  const steps = [
    [
      "function spawnAppServer(token: string) {\n  startMark(\"spawning the app-server\");",
      helper + "function spawnAppServer(token: string) {\n  startMark(\"spawning the app-server\");",
      "helper",
    ],
    [
      "  codex = child;\n  connected = false;\n  stdoutBuffer = \"\";",
      "  codex = child;\n  connected = false;\n  stdoutBuffer = \"\";\n  // 不等 stdout（块缓冲会晚到），直接探端口。\n  watchForAppServer(token);",
      "start the port watcher",
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
