// Patch 0083 — `ready` 必须反映 draining：服务端说"我在排空"时就别再报 ready。
//
// P2 的遗留项：「`ready` 需要反映 draining：请求失败时把 `connected` 置回 false 并重建实例
// （E54 事故的根治）」。
//
// E54 那类事故的长相：老 app-server 收到信号后**端口还在、HTTP 还能答**，但对每个请求回
// "Server is draining"。于是桥的 `/api/health` 一直 `ready:true`，而用户点什么都没反应——
// 从界面看就是"卡住了"，从日志看又"一切正常"。
//
// 修法：在请求错误的分发点集中判断（所有 RPC 都会经过这里）——一旦看到 draining：
//   ① `connected = false` → `/api/health` 立刻说真话、页面进入重连流程；
//   ② 广播 `bridge/status: disconnected`（带 reason），页面状态条跟着变；
//   ③ 把旧实例杀掉并重建（有 10 秒抖动保护，避免连环重启）。
//
// Usage: node patches/0083-ready-reflects-draining.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const file = resolve(appDir, "server.ts");
let source = readFileSync(file, "utf8");

if (source.includes("restartAppServerAfterDrain")) {
  console.log("skip  server.ts (already applied)");
} else {
  const steps = [
    [
      "function terminateCodex(signal: NodeJS.Signals = \"SIGTERM\") {",
      "/**\n"
        + " * 服务端在排空（draining）时，端口与 HTTP 都还在，但每个请求都会被拒。\n"
        + " * 这不是\"能用的连接\"，所以 `ready` 必须变成 false，并把实例重建（E54 的根治）。\n"
        + " */\n"
        + "let drainRestartAt = 0;\n"
        + "function restartAppServerAfterDrain(reason: string) {\n"
        + "  const now = Date.now();\n"
        + "  if (now - drainRestartAt < 10000) return; // 抖动保护：连环 draining 只重启一次\n"
        + "  drainRestartAt = now;\n"
        + "  console.warn(`[codex-webui] app-server is draining (${reason}); marking not-ready and restarting it`);\n"
        + "  connected = false;\n"
        + "  broadcast({ type: \"bridge/status\", status: \"disconnected\", reason: \"draining\" });\n"
        + "  terminateCodex(\"SIGTERM\");\n"
        + "  codex = null;\n"
        + "  setTimeout(() => { try { startCodex(); } catch (error) { console.error(\"[codex-webui] restart after drain failed\", error); } }, 300);\n"
        + "}\n"
        + "\n"
        + "function terminateCodex(signal: NodeJS.Signals = \"SIGTERM\") {",
      "draining handler",
    ],
    [
      "      if (message.error) item.reject(new Error(message.error.message || JSON.stringify(message.error)));",
      "      if (message.error) {\n"
        + "        const text = String(message.error.message || JSON.stringify(message.error));\n"
        + "        if (/draining/i.test(text)) restartAppServerAfterDrain(text.slice(0, 80));\n"
        + "        item.reject(new Error(text));\n"
        + "      }",
      "detect draining in the error path",
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
