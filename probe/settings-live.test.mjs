// P7：设置页的"真数据"渲染用 jsdom 跑一遍（不依赖真机、不依赖模型）。
//
// 要钉住的几件事：
//   1. Configuration 页必须**在显眼处**写出"本平台沙箱不生效"（E126 的实测结论）——
//      用户明确要求"不能用配置字段冒充隔离"；
//   2. 真值来自 `config/read` / `permissionProfile/list`（model / provider / approval / sandbox / 档位）；
//   3. 第三方 provider 的账户页要给出真实原因，而不是转圈或"None"；
//   4. 平台不可用的页（浏览器自动化/电脑操作/云任务…）要给出**具体原因与替代路径**。
//
//   node probe/settings-live.test.mjs
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "../app/node_modules/jsdom/lib/api.js";

const appDir = resolve(fileURLToPath(new URL("../app", import.meta.url)));
const source = readFileSync(resolve(appDir, "public/app.js"), "utf8");

function slice(start, end) {
  const from = source.indexOf(start);
  const to = end === null ? source.length : source.indexOf(end, from);
  if (from < 0 || (to < 0 && end !== null)) throw new Error(`cannot locate ${start}`);
  return end === null ? source.slice(from) : source.slice(from, to);
}

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : `  <- ${detail}`}`);
};

const dom = new JSDOM(`<!doctype html><body>
  <strong id="settingsPlaceholderTitle"></strong>
  <small id="settingsPlaceholderDescription"></small>
  <div id="settingsPlaceholderRows"></div>
</body>`);
const { window } = dom;

const settingsPages = {
  agent: { title: "Configuration" },
  profile: { title: "Profile" },
  "plugins-settings": { title: "Plugins" },
  "skills-settings": { title: "Skills" },
  "hooks-settings": { title: "Hooks" },
  "browser-use": { title: "Browser" },
  "experimental-settings": { title: "Experimental" },
  "cloud-settings": { title: "Cloud preferences" },
};

const calls = [];
const rpc = async (method) => {
  calls.push(method);
  if (method === "config/read") return { config: { approval_policy: "never", sandbox_mode: "danger-full-access", model_provider: "deepseek" } };
  if (method === "permissionProfile/list") return { data: [{ id: ":read-only" }, { id: ":workspace" }, { id: ":danger-full-access" }] };
  if (method === "account/read") return { account: null };
  if (method === "account/usage/read") throw new Error("no usage for this provider");
  if (method === "account/rateLimits/read") throw new Error("no rate limits for this provider");
  if (method === "plugin/installed") return { marketplaces: [{ name: "local-test", path: "/home/tmp/mk/market/.agents/plugins/marketplace.json", plugins: [{ id: "hello-plugin@local-test", name: "hello-plugin", version: "0.0.1", installed: true, description: "本地测试插件" }] }], marketplaceLoadErrors: [] };
  if (method === "mcpServerStatus/list") return { data: [{ name: "filesystem", status: "ready" }] };
  if (method === "skills/list") return { data: [{ name: "imagegen" }, { name: "openai-docs" }] };
  if (method === "hooks/list") return { data: [] };
  if (method === "experimentalFeature/list") return { data: [{ name: "analytics_plan_history", stage: "beta", enabled: false, defaultEnabled: false }, { name: "shell_tool", stage: "stable", enabled: true, defaultEnabled: true }] };
  throw new Error("unexpected rpc " + method);
};

const helpers = new Function(
  "window", "rpc", "settingsPages", "t", "escapeHtml", "modelDisplay", "selectedModel", "reasoningLabel", "fetch",
  `
  const { document } = window;
  const $ = (selector) => document.querySelector(selector);
  ${slice("const SETTINGS_PLATFORM_NOTES=", "function settingsRow(")}
  ${slice("function settingsRow(", "async function renderSettingsLive(")}
  ${slice("async function renderSettingsLive(", null)}
  return { renderSettingsLive, settingsRow };
  `,
)(
  window,
  rpc,
  settingsPages,
  (value) => value,
  (value = "") => String(value),
  (model) => String(model),
  () => "deepseek-flash",
  (value) => `effort:${value}`,
  // 启动自检要用桥的 /api/setup；这里给一个真形状的桩（E139）
  async () => ({ ok: true, json: async () => ({
    bridge: { ready: true, port: 8899 },
    termux: {
      bridgeScript: { path: "/data/data/com.termux/files/home/bin/codex-gui-web", exists: true },
      termuxApi: { wakeLock: "/usr/bin/termux-wake-lock", notification: "/usr/bin/termux-notification", jobScheduler: "/usr/bin/termux-job-scheduler" },
      codex: { version: "codex-cli 0.162.1" },
      stateDir: { path: "/data/data/com.termux/files/home/.codex/codex-webui", writable: true },
      wake: { installed: true, lastRun: "2026-10-16 21:38:26 wake-lock ok" },
    },
    android: { at: null, facts: null, note: "应用最近没有上报自检信息" },
  }) }),
);

const rowsText = () => window.document.getElementById("settingsPlaceholderRows").textContent;

check("Configuration 页渲染成功", await helpers.renderSettingsLive("agent") === true);
const configText = rowsText();
check("Configuration 页写出「沙箱在本平台不生效」", /Sandbox is NOT enforced on this platform/.test(configText), configText.slice(0, 120));
check("Configuration 页给出真实 approval_policy", configText.includes("never"), configText.slice(0, 200));
check("Configuration 页给出真实 provider", configText.includes("deepseek"), configText.slice(0, 240));
check("Configuration 页列出权限档位（permissionProfile/list）", configText.includes(":read-only") && configText.includes(":workspace"), configText.slice(0, 300));
check("Configuration 页有审批策略写入控件", Boolean(window.document.querySelector(".settings-write-row select")), "no select");
check("写入控件默认选中当前值", window.document.querySelector(".settings-write-row select")?.value === "never");

check("Configuration 页有「启动自检」这一段", /Startup self-check/.test(configText), configText.slice(0, 400));
check("自检列出桥的启动脚本真路径", configText.includes("/home/bin/codex-gui-web"), configText.slice(0, 600));
check("自检列出 Termux:API 三项（含 job-scheduler）", /job-scheduler/.test(configText) && /wake-lock/.test(configText), configText.slice(0, 700));
check("自检给出 Codex CLI 版本", /codex-cli 0\.162\.1/.test(configText), configText.slice(0, 700));
check("自检显示兜底唤醒已注册与最近运行", /registered/.test(configText) && /21:38:26 wake-lock ok/.test(configText), configText.slice(0, 800));
check("应用侧还没上报时如实写「打开一次应用」而不是猜", /no report yet/.test(configText), configText.slice(-300));

check("Profile 页渲染成功", await helpers.renderSettingsLive("profile") === true);
const profileText = rowsText();
check("Profile 页说明第三方 provider 不提供账户", /third-party provider/.test(profileText), profileText.slice(0, 160));
check("Profile 页把 usage 的真实错误显示出来（不是转圈）", profileText.includes("no usage for this provider"), profileText.slice(0, 240));

check("Plugins 页渲染成功", await helpers.renderSettingsLive("plugins-settings") === true);
check("Plugins 页列出插件与 MCP 服务器", rowsText().includes("hello-plugin") && rowsText().includes("filesystem"), rowsText().slice(0, 200));
check("Plugins 页显示市场名与已安装状态", rowsText().includes("local-test") && rowsText().includes("installed"), rowsText().slice(0, 240));
check("Plugins 页给出安装/卸载按钮", window.document.querySelectorAll(".settings-plugin-list .settings-save").length >= 1, String(window.document.querySelectorAll(".settings-plugin-list .settings-save").length));
check("Plugins 页有添加市场的输入框", Boolean(window.document.querySelector(".settings-write-row input[type=text]")), "no input");
// 没有市场时要给明确说明，而不是一片空白（换一份"空数据"的 rpc 重跑同一个渲染函数）。
{
  const domEmpty = new JSDOM(`<!doctype html><body>
    <strong id="settingsPlaceholderTitle"></strong><small id="settingsPlaceholderDescription"></small>
    <div id="settingsPlaceholderRows"></div></body>`);
  const rpcEmpty = async (method) => {
    if (method === "plugin/installed") return { marketplaces: [], marketplaceLoadErrors: [] };
    if (method === "mcpServerStatus/list") return { data: [] };
    throw new Error("unexpected rpc " + method);
  };
  const helperFactory = new Function(
    "window", "rpc", "settingsPages", "t", "escapeHtml", "modelDisplay", "selectedModel", "reasoningLabel",
    `
    const { document } = window;
    const $ = (selector) => document.querySelector(selector);
    ${slice("const SETTINGS_PLATFORM_NOTES=", "function settingsRow(")}
    ${slice("function settingsRow(", "async function renderSettingsLive(")}
    ${slice("async function renderSettingsLive(", null)}
    return { renderSettingsLive };
    `,
  );
  const emptyHelpers = helperFactory(domEmpty.window, rpcEmpty, settingsPages, (v) => v, (v = "") => String(v), (m) => String(m), () => "m", (v) => String(v));
  await emptyHelpers.renderSettingsLive("plugins-settings");
  const emptyText = domEmpty.window.document.getElementById("settingsPlaceholderRows").textContent;
  check("没有市场时给出明确说明（不是空列表）", /No plugin marketplace is configured/.test(emptyText), emptyText.slice(0, 160));
}
check("Skills 页列出真实技能", await helpers.renderSettingsLive("skills-settings") === true && rowsText().includes("imagegen"));
check("Hooks 页空状态是 0 而不是编造内容", await helpers.renderSettingsLive("hooks-settings") === true && rowsText().includes("0"), rowsText().slice(0, 120));

check("平台受限页给出原因与替代（browser-use）", await helpers.renderSettingsLive("browser-use") === true && /browser_use/.test(rowsText()), rowsText().slice(0, 160));
check("平台受限页给出原因与替代（cloud-settings）", await helpers.renderSettingsLive("cloud-settings") === true && /Codex Cloud/.test(rowsText()), rowsText().slice(0, 160));
check("未覆盖的页返回 false（走原有占位逻辑）", await helpers.renderSettingsLive("appearance") === false);

// 实验特性页：列真实开关，但**不提供点了没用的开关**（实测 enablement/set 是空操作）
check("实验特性页渲染成功", await helpers.renderSettingsLive("experimental-settings") === true);
const experimentalText = rowsText();
check("实验特性页列出真实特性名", experimentalText.includes("analytics_plan_history"), experimentalText.slice(0, 160));
check("实验特性页如实说明本构建忽略 enablement/set", /ignores experimentalFeature\/enablement\/set/.test(experimentalText), experimentalText.slice(0, 200));
check("实验特性页没有提供开关按钮", window.document.querySelectorAll(".settings-write-row button").length === 0, String(window.document.querySelectorAll(".settings-write-row button").length));
check("实验特性页显示当前状态与默认", experimentalText.includes("Off") && experimentalText.includes("(default)"), experimentalText.slice(0, 240));

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
