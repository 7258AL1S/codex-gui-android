// Runtime health check for the bridge's RPC allowlist.
//
// The generated types have disagreed with the running server four times now
// (E29 availableDecisions, E59 thread/section/move, E65 thread/settings/update,
// E66 collaborationMode/*). Rather than discovering each one by accident, ask the
// server which methods it accepts and diff that against what we allow.
//
// The server hands over the full list when it rejects an unknown method.
//
// Usage: node probe/allowlist-audit.mjs
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// NOTE: do not call this `URL` — it shadows the global URL constructor (which cost
// one round of debugging: "URL is not a constructor").
const ENDPOINT = process.env.WS_URL ?? "ws://127.0.0.1:8901/";
const TOKEN = (process.env.WS_TOKEN ?? readFileSync(join(homedir(), ".codex", "codex-webui", "ws-token"), "utf8")).trim();
const appDir = resolve(import.meta.dirname, "..", "app");

// --- what the server accepts ----------------------------------------------
const ws = new WebSocket(ENDPOINT, { headers: { Authorization: `Bearer ${TOKEN}` } });
const pending = new Map();
let nextId = 1;
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error("socket error"));
  setTimeout(() => rej(new Error("timeout")), 6000);
});
ws.onmessage = (raw) => {
  const msg = JSON.parse(String(raw?.data ?? raw));
  if (msg.id != null && pending.has(msg.id)) { const cb = pending.get(msg.id); pending.delete(msg.id); cb(msg); }
};
const rpc = (method, params, ms = 15000) => new Promise((res) => {
  const id = nextId++;
  const t = setTimeout(() => { pending.delete(id); res({ error: "timeout" }); }, ms);
  pending.set(id, (m) => { clearTimeout(t); res(m); });
  ws.send(JSON.stringify({ method, id, params }));
});

await rpc("initialize", {
  clientInfo: { name: "audit", title: "Allowlist Audit", version: "0.1.0" },
  capabilities: { experimentalApi: true, requestAttestation: false },
});
const rejection = await rpc("__definitely_not_a_method__", {});
const message = typeof rejection.error === "string" ? rejection.error : JSON.stringify(rejection.error ?? "");
const accepted = new Set([...message.matchAll(/`([A-Za-z0-9_./-]+)`/g)].map((m) => m[1]));
if (accepted.size === 0) {
  console.log("拿不到服务端方法列表，原文：", message.slice(0, 300));
  process.exit(1);
}
console.log(`服务端接受的方法：${accepted.size} 个\n`);

// --- what the bridge allows ------------------------------------------------
const security = readFileSync(join(appDir, "server-security.js"), "utf8");
const block = security.slice(security.indexOf("const BROWSER_RPC_METHODS = new Set(["));
const body = block.slice(0, block.indexOf("]);"));
const allowed = [...body.matchAll(/"([A-Za-z0-9_./-]+)"/g)].map((m) => m[1]);
console.log(`桥放行的方法：${allowed.length} 个\n`);

const bogus = allowed.filter((method) => !accepted.has(method));
// `host/*` are handled by the bridge itself and never forwarded to the app-server,
// so they can never appear in the server's list — exclude them from the diff.
const realBogus = bogus.filter((method) => !method.startsWith("host/"));
const notAllowed = [...accepted].filter((method) => !allowed.includes(method));

console.log("=== 放行了但服务端不接受（会在运行时失败）===");
console.log(realBogus.length ? realBogus.map((m) => `  ${m}`).join("\n") : "  （无）");
if (bogus.length !== realBogus.length) {
  console.log(`（另有 ${bogus.length - realBogus.length} 个 host/* 是桥内部方法，不算）`);
}
console.log("\n=== 服务端接受但我们没放行（可能是缺口）===");
console.log(notAllowed.length ? notAllowed.slice(0, 40).map((m) => `  ${m}`).join("\n") : "  （无）");
if (notAllowed.length > 40) console.log(`  …另有 ${notAllowed.length - 40} 个`);

try { ws.close(); } catch { /* ignore */ }
console.log(realBogus.length === 0 ? "\n[1/4] 白名单里的方法运行时都存在 ✅" : `\n[1/4] ${realBogus.length} 个方法运行时不存在 ❌`);

// --- third check: does the frontend call anything the allowlist forbids? -----
// This is the check whose absence let `collaborationMode/list` slip through: the
// mode chip called a method the bridge never allowed, so it silently never
// appeared (E75). Neither of the other two diffs can see that.
const frontendFiles = ["app.js", "codex-surfaces.js", "ui-core.js", "rendering.js"];
const called = new Map();
for (const name of frontendFiles) {
  let text;
  try { text = readFileSync(join(appDir, "public", name), "utf8"); } catch { continue; }
  for (const match of text.matchAll(/rpc\(\s*['"]([A-Za-z0-9_./-]+)['"]/g)) {
    called.set(match[1], name);
  }
}
const calledNotAllowed = [...called.entries()].filter(([method]) => !allowed.includes(method));
console.log(`\n=== 前端调用但白名单没放行（会静默失败）===\n（前端共调用 ${called.size} 个方法）`);
console.log(calledNotAllowed.length
  ? calledNotAllowed.map(([method, file]) => `  ${method}   (${file})`).join("\n")
  : "  （无）");

try { ws.close(); } catch { /* ignore */ }
const clean = realBogus.length === 0 && calledNotAllowed.length === 0;

// --- fourth check: bridge HTTP endpoints the frontend calls -------------------
// Same failure mode as the third check, one layer down: the attachment feature
// posts to /api/uploads, and if that route were missing (or misspelled) the button
// would just toast an error. RPC methods have an allowlist; HTTP routes do not.
const serverSource = readFileSync(join(appDir, "server.ts"), "utf8");
const routes = new Set([...serverSource.matchAll(/url\.pathname === "([^"]+)"/g)].map((m) => m[1]));

function endpointsUsed(frontendText) {
  return [...new Set([...frontendText.matchAll(/["'`](\/api\/[A-Za-z0-9_/-]+)/g)].map((m) => m[1]))];
}

// A check nobody has seen fail is not a check: prove it catches a missing route.
let selfTestOk = false;
{
  const phantom = ['fetch("/api/uploads")', 'fetch("/api/definitely-not-a-route")'].join("\n");
  const missed = endpointsUsed(phantom).filter((pathname) => !routes.has(pathname));
  selfTestOk = missed.length === 1 && missed[0] === "/api/definitely-not-a-route";
  console.log(`\n[4/4] 自检：这个检查能抓到不存在的端点 ${selfTestOk ? "✅" : `❌（漏了：${JSON.stringify(missed)}）`}`);
}

const frontendEndpoints = new Set();
for (const name of [...frontendFiles, "index.html"]) {
  let text;
  try { text = readFileSync(join(appDir, "public", name), "utf8"); } catch { continue; }
  for (const pathname of endpointsUsed(text)) frontendEndpoints.add(pathname);
}
const missingEndpoints = [...frontendEndpoints].filter((pathname) => !routes.has(pathname));
console.log(`\n=== 前端调用但桥没有对应路由 ===\n（前端共引用 ${frontendEndpoints.size} 个 /api 路径）`);
console.log(missingEndpoints.length ? missingEndpoints.map((p) => `  ${p}`).join("\n") : "  （无）");

const allClean = selfTestOk && realBogus.length === 0 && calledNotAllowed.length === 0 && missingEndpoints.length === 0;
console.log(allClean
  ? "\n体检结论：白名单与服务端一致，覆盖了前端所有调用，且引用的 /api 路由都存在 ✅"
  : `\n体检结论：假条目 ${realBogus.length} 个，前端调用缺白名单 ${calledNotAllowed.length} 个，缺失路由 ${missingEndpoints.length} 个 ❌`);
process.exit(allClean ? 0 : 1);
