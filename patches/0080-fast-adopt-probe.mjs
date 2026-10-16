// Patch 0080 — adopt 旧实例改用 HTTP 探活：没有实例就立刻走 spawn，不再白等 1.2 秒。
//
// 0079 之后启动打点长这样：
//   START +2ms    startCodex: adopting an existing app-server
//   START +1210ms adopt resolved adopted=false        ← 1.2 秒
//   START +1210ms spawning the app-server
//   START +1551ms connected (ready=true)
// 也就是"冷启动"里最大的一块只剩这个 adopt 窗口。它的本意是"上一轮桥留下的实例还在监听就复用它，
// 别去抢端口"，但实现是**拿 WebSocket 去等**：端口上什么都没有时也要等满 1.2 秒才认输。
// 用户点开 App 的常见情形恰恰是"桥没在跑"，所以这 1.2 秒每次都得付（E124）。
//
// 修法：先用 HTTP `GET /readyz`（超时 500ms）问一句"这儿有人吗"——没人立刻 spawn；
// 有人再连 WebSocket（最多 1.5 秒），连上就算接管成功。语义不变，快在失败路径上。
//
// Usage: node patches/0080-fast-adopt-probe.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const file = resolve(appDir, "server.ts");
let source = readFileSync(file, "utf8");

if (source.includes("fast adopt probe")) {
  console.log("skip  server.ts (already applied)");
} else {
  const from = [
    "function adoptExistingAppServer(token: string) {",
    "  return new Promise<boolean>((resolvePromise) => {",
    "    let settled = false;",
    "    const finish = (ok: boolean) => {",
    "      if (settled) return;",
    "      settled = true;",
    "      resolvePromise(ok);",
    "    };",
    "    connectAppServerSocket(token);",
    "    const deadline = Date.now() + 1200;",
    "    const poll = () => {",
    "      if (appServerSocket && appServerSocket.readyState === WebSocket.OPEN) return finish(true);",
    "      if (Date.now() > deadline) return finish(false);",
    "      setTimeout(poll, 100);",
    "    };",
    "    poll();",
    "  });",
    "}",
  ].join("\n");
  const to = [
    "function adoptExistingAppServer(token: string) {",
    "  return new Promise<boolean>((resolvePromise) => {",
    "    let settled = false;",
    "    const finish = (ok: boolean) => {",
    "      if (settled) return;",
    "      settled = true;",
    "      resolvePromise(ok);",
    "    };",
    "    // fast adopt probe：先问一句\"端口上有人吗\"。没人就立刻认输去 spawn——",
    "    // 老的实现是拿 WebSocket 干等 1.2 秒，冷启动每次都要付这笔（E124）。",
    "    const readyz = `http://127.0.0.1:${appServerWsPort}/readyz`;",
    "    fetch(readyz, { signal: AbortSignal.timeout(500) })",
    "      .then((response) => {",
    "        if (!response.ok) return finish(false);",
    "        startMark(\"adopt probe: an app-server answers /readyz\");",
    "        appServerConnectAttempts = 0;",
    "        connectAppServerSocket(token);",
    "        const deadline = Date.now() + 1500;",
    "        const poll = () => {",
    "          if (appServerSocket && appServerSocket.readyState === WebSocket.OPEN) return finish(true);",
    "          if (Date.now() > deadline) return finish(false);",
    "          setTimeout(poll, 50);",
    "        };",
    "        poll();",
    "      })",
    "      .catch(() => finish(false));",
    "  });",
    "}",
  ].join("\n");
  const hits = source.split(from).length - 1;
  if (hits !== 1) throw new Error("cannot locate adoptExistingAppServer exactly once (hits=" + hits + ")");
  writeFileSync(file, source.replace(from, to));
  console.log("apply server.ts: fast adopt probe");
}

console.log("done — restart the bridge: ~/bin/codex-gui-web restart");
