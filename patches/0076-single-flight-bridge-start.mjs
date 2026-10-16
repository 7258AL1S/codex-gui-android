// Patch 0076 — `startCodex()` 单飞：并发启动路径一次只能有一个"飞行中"。
//
// 现场（用户报"启动桥又变得很慢，一直等待"，App 自己记录 `ready after 14s / 23s`）：
// 桥的 HTTP 端口早就开了，但 `/api/health` 一直 `ready:false`。日志里同一个桥的启动过程中：
//   [codex app-server] listening on: ws://127.0.0.1:8901     ← 第一个子进程起来了
//   [codex app-server] Error: Address already in use (os error 98)
//   [codex-webui] killed 2 stale app-server(s) holding port 8901; will retry   ← 把自己的孩子杀了
//   [codex app-server] listening on: ws://127.0.0.1:8901     ← 再起一个
// 加上临时堆栈日志后真相很清楚：**三次 spawn 的调用栈完全一样**，都来自 `startCodex()` 里
// `adoptExistingAppServer(token).then(...)` 那一行。也就是 `startCodex()` 被并发调用了三次。
//
// 为什么会被并发调用：adopt 有 1.2 秒的等待窗口，这期间 `codex` 还是 null，
// 而**页面**正在重连并不断发 RPC（`sendRaw` 发现没连上就调 `startCodex()`）——
// 于是每个 RPC 都开一轮"adopt → spawn"。用户点开 App 的那一刻正好就是这种状态，所以"启动很慢"。
//
// 修法：模块级 `bridgeStartInFlight` 单飞闸门。并发的调用直接返回（RPC 本来就会
// 因为"未连接"失败并由页面重试），只有第一次真正走 adopt → spawn。
// 顺带：`pruneUploads()`（扫上传目录）与 `installLauncherScript()` 也从"每次调用都跑"变成"一次"。
//
// Usage: node patches/0076-single-flight-bridge-start.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const file = resolve(appDir, "server.ts");
let source = readFileSync(file, "utf8");

if (source.includes("bridgeStartInFlight")) {
  console.log("skip  server.ts (already applied)");
} else {
  const steps = [
    [
      "function startCodex() {\n  if (shuttingDown) return;\n  if (codex && codex.exitCode === null) {\n    if (!appServerSocket) connectAppServerSocket(ensureAppServerToken());\n    return;\n  }\n  const token = ensureAppServerToken();\n  installLauncherScript();\n  // Uploads are a cache, not an archive (see upload-service.js).\n  pruneUploads(true);",
      "// 单飞闸门：adopt 有 1.2 秒等待窗口，这期间 `codex` 仍是 null；而页面重连时会不断发 RPC\n"
        + "// （`sendRaw` 发现未连接就会调 startCodex）——不加闸门就会并发开出多轮 adopt→spawn，\n"
        + "// 几个 app-server 抢同一个端口，桥的兜底逻辑还会把**自己正在用的**那个杀掉再重起。\n"
        + "// 用户点开 App 的那一刻正是这种状态，表现得就是\"启动桥很慢，一直等待\"（E124）。\n"
        + "let bridgeStartInFlight = false;\n"
        + "function startCodex() {\n"
        + "  if (shuttingDown) return;\n"
        + "  if (codex && codex.exitCode === null) {\n"
        + "    if (!appServerSocket) connectAppServerSocket(ensureAppServerToken());\n"
        + "    return;\n"
        + "  }\n"
        + "  if (bridgeStartInFlight) return;\n"
        + "  bridgeStartInFlight = true;\n"
        + "  const token = ensureAppServerToken();\n"
        + "  installLauncherScript();\n"
        + "  // Uploads are a cache, not an archive (see upload-service.js).\n"
        + "  pruneUploads(true);",
      "single-flight guard",
    ],
    [
      "  void adoptExistingAppServer(token).then((adopted) => {\n    if (adopted || shuttingDown) return;\n    spawnAppServer(token);\n  });\n}",
      "  void adoptExistingAppServer(token)\n"
        + "    .then((adopted) => {\n"
        + "      if (adopted || shuttingDown) return;\n"
        + "      spawnAppServer(token);\n"
        + "    })\n"
        + "    .finally(() => { bridgeStartInFlight = false; });\n"
        + "}",
      "clear the guard when the attempt settles",
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
