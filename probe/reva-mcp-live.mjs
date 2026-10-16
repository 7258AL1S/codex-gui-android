// 真机验证：把本机跑着的 ReVa（Ghidra MCP server，streamable HTTP）接进 app-server。
// 不重启用户正在用的 daemon，只用协议里的 config/mcpServer/reload + mcpServerStatus/list
// （daemon 0.160.0 的字段是 runtimeStatus / httpOrigin / serverInfo / tools:map）。
//
//   node probe/reva-mcp-live.mjs              # reload + 列状态
//   node probe/reva-mcp-live.mjs --tool-call  # 再开一个 thread，走 app-server 调 ReVa 的只读工具
//
// 依赖：app-server 监听 ws://127.0.0.1:8901，token 在 ~/.codex/codex-webui/ws-token；
//      ReVa server 监听 127.0.0.1:8080（~/bin/reva-server start）。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const WS_URL = process.env.WS_URL ?? "ws://127.0.0.1:8901";
const TOKEN_FILE = process.env.WS_TOKEN_FILE ?? resolve(homedir(), ".codex/codex-webui/ws-token");
const TOKEN = (process.env.WS_TOKEN ?? readFileSync(TOKEN_FILE, "utf8")).trim();
const wantToolCall = process.argv.includes("--tool-call");

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : `  <- ${detail}`}`);
};

const { ws, rpc } = await new Promise((res, rej) => {
  const ws = new WebSocket(WS_URL, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const pending = new Map();
  let nextId = 1;
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); p(msg); }
  };
  ws.onerror = () => rej(new Error("ws error"));
  ws.onopen = () => res({
    ws,
    rpc: (method, params, ms = 60000) => new Promise((done) => {
      const id = nextId++;
      const t = setTimeout(() => { pending.delete(id); done({ method, error: "timeout" }); }, ms);
      pending.set(id, (m) => { clearTimeout(t); done({ method, ...m }); });
      ws.send(JSON.stringify({ method, id, params }));
    }),
  });
});

const init = await rpc("initialize", {
  clientInfo: { name: "reva-mcp-live", title: "ReVa MCP live probe", version: "0.1.0" },
  capabilities: { experimentalApi: true, requestAttestation: false },
});
check("initialize", Boolean(init.result), JSON.stringify(init.error ?? "").slice(0, 200));

const reload = await rpc("config/mcpServer/reload", undefined);
check("config/mcpServer/reload 被服务端接受", !reload.error, JSON.stringify(reload.error ?? "").slice(0, 200));

// reload 之后状态是异步变的：轮询到 reva 出现且带 serverInfo 为止。
let statuses = [];
for (let attempt = 0; attempt < 20; attempt++) {
  const list = await rpc("mcpServerStatus/list", { threadId: null, detail: "full" });
  statuses = list.result?.data ?? [];
  if (statuses.some((s) => s.name === "reva" && s.serverInfo)) break;
  await new Promise((r) => setTimeout(r, 1000));
}

console.log(`mcpServerStatus/list -> ${statuses.length} 个服务器`);
for (const s of statuses) {
  const toolCount = s.tools ? Object.keys(s.tools).length : "?";
  console.log(`   - ${s.name} runtimeStatus=${s.runtimeStatus} origin=${s.httpOrigin} serverInfo=${s.serverInfo?.name} tools=${toolCount} toolsError=${s.toolsError ?? "none"}`);
}

const reva = statuses.find((s) => s.name === "reva");
check("app-server 看得到 reva 这个 MCP server", Boolean(reva));
if (reva) {
  check("MCP 握手成功（serverInfo.name = ReVa）", reva.serverInfo?.name === "ReVa", JSON.stringify(reva.serverInfo ?? null));
  check("工具目录没有报错", !reva.toolsError, String(reva.toolsError));
  const toolNames = Object.keys(reva.tools ?? {});
  check("reva 暴露了工具（>20）", toolNames.length > 20, `count=${toolNames.length}`);
  console.log("   tools:", toolNames.slice(0, 8).join(", "), toolNames.length > 8 ? ", ..." : "");
}

if (wantToolCall && reva) {
  const thread = await rpc("thread/start", { cwd: "/data/data/com.termux/files/home/codex-gui" });
  const threadId = thread.result?.thread?.id;
  check("thread/start", Boolean(threadId), JSON.stringify(thread.error ?? thread.result ?? {}).slice(0, 200));

  if (threadId) {
    const perThread = await rpc("mcpServerStatus/list", { threadId, detail: "full" });
    const t = (perThread.result?.data ?? []).find((s) => s.name === "reva");
    check("thread 维度能看到 reva", Boolean(t), JSON.stringify(perThread.result ?? perThread.error ?? {}).slice(0, 200));
    console.log(`   thread 维度 runtimeStatus=${t?.runtimeStatus} origin=${t?.httpOrigin}`);

    // 只读工具：列 Ghidra 项目里的文件（还没导入程序时也应正常返回，而不是崩）。
    const call = await rpc("mcpServer/tool/call", { threadId, server: "reva", tool: "list-project-files", arguments: { folderPath: "/" } }, 120000);
    const text = JSON.stringify(call.result ?? call.error ?? {});
    check("mcpServer/tool/call list-project-files 返回结果", !call.error && text.length > 2, text.slice(0, 300));
    console.log("   result:", text.slice(0, 300));
  }
}

ws.close();
console.log(failures === 0 ? "ALL OK" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
