// P7 里用户点名的硬要求：**Android/Termux 上的沙箱到底有没有真的生效？**
//
// 不看配置字段、不看文档——直接 A/B：拿同一台 app-server，用 `command/exec` 的
// **按请求 sandboxPolicy**（proto-ts/v2/SandboxPolicy.ts）跑同一批命令，看真实结果。
// 这样做的好处：完全不碰用户 `~/.codex/config.toml` 里的 `sandbox_mode`（现在是 danger-full-access），
// 策略只作用于这一次请求。
//
// 三个策略 × 三件事：
//   写入工作区内 / 写入工作区外 / 联网（curl）
// 期望：dangerFullAccess 三件都能；workspaceWrite 只能写"可写根"里的；
//       readOnly 连工作区内的写也不行。
// 说明：本探针只报告**实际行为**（含"策略被忽略"这种结果），不做期望值断言失败——
// 平台不支持沙箱时，如实把证据和结论写进 VERIFICATION。
//
//   node probe/sandbox-enforcement.mjs
import { readFileSync, mkdtempSync, existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const URL = process.env.WS_URL ?? "ws://127.0.0.1:8901/";
const TOKEN = (process.env.WS_TOKEN ?? readFileSync(join(homedir(), ".codex", "codex-webui", "ws-token"), "utf8")).trim();

const workspace = mkdtempSync(join(homedir(), "tmp", "sandbox-ws-"));
const outside = join(homedir(), "tmp", `sandbox-outside-${Date.now()}.txt`);

const ws = new WebSocket(URL, { headers: { Authorization: `Bearer ${TOKEN}` } });
const pending = new Map();
let nextId = 1;
ws.onmessage = (frame) => {
  const message = JSON.parse(String(frame.data));
  if (message.id != null && pending.has(message.id)) {
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    resolve(message);
  }
};
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error("socket error"));
  setTimeout(() => reject(new Error("connect timeout")), 6000);
});
const call = (method, params, timeoutMs = 30000) => new Promise((resolve) => {
  const id = nextId++;
  const timer = setTimeout(() => { pending.delete(id); resolve({ error: { message: "timeout" } }); }, timeoutMs);
  pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
  ws.send(JSON.stringify({ id, method, params }));
});
await call("initialize", { clientInfo: { name: "sandbox-probe", title: "sandbox", version: "0.1" }, capabilities: { experimentalApi: true } });

async function exec(label, command, sandboxPolicy) {
  const result = await call("command/exec", { command, cwd: workspace, sandboxPolicy, disableTimeout: true });
  if (result.error) return { label, ok: false, detail: String(result.error.message || JSON.stringify(result.error)).slice(0, 120) };
  const exitCode = result.result?.exitCode;
  const stderr = String(result.result?.stderr || "").trim().split("\n")[0] || "";
  return { label, ok: exitCode === 0, detail: `exit=${exitCode}${stderr ? " " + stderr.slice(0, 110) : ""}` };
}

const policies = [
  ["dangerFullAccess（用户当前默认）", { type: "dangerFullAccess" }],
  ["workspaceWrite（只许写可写根）", { type: "workspaceWrite", writableRoots: [workspace], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }],
  ["readOnly（连工作区都不许写）", { type: "readOnly", networkAccess: false }],
];

const rows = [];
for (const [name, sandboxPolicy] of policies) {
  rmSync(join(workspace, "inside.txt"), { force: true });
  rmSync(outside, { force: true });
  const inside = await exec("写工作区内", ["sh", "-c", `echo inside > ${join(workspace, "inside.txt")}`], sandboxPolicy);
  const outsideWrite = await exec("写工作区外", ["sh", "-c", `echo outside > ${outside}`], sandboxPolicy);
  const network = await exec("联网", ["curl", "-sS", "--max-time", "8", "-o", "/dev/null", "-w", "%{http_code}", "https://example.com"], sandboxPolicy);
  rows.push({
    policy: name,
    inside: inside.ok,
    insideDetail: inside.detail,
    outsideFileExists: existsSync(outside),
    outsideDetail: outsideWrite.detail,
    networkDetail: network.ok ? `ok(${String(network.detail).replace("exit=0", "").trim() || "200"})` : network.detail,
    networkOk: network.ok,
  });
}

console.log("策略".padEnd(34) + "写工作区内   写工作区外（文件真的出现？）   联网");
for (const row of rows) {
  console.log(
    row.policy.padEnd(30)
    + (row.inside ? "成功  " : "失败  ")
    + (row.outsideFileExists ? "**出现**  " : "未出现  ")
    + (row.networkOk ? "通" : "不通"),
  );
}
console.log("\n细节：");
for (const row of rows) {
  console.log(`- ${row.policy}`);
  console.log(`    工作区内：${row.insideDetail}`);
  console.log(`    工作区外：${row.outsideDetail}（文件存在=${row.outsideFileExists}）`);
  console.log(`    联网：${row.networkDetail}`);
}

console.log(`\n工作区: ${workspace}`);
rmSync(workspace, { recursive: true, force: true });
rmSync(outside, { force: true });
ws.close();
