// Patch 0095 — 设置 → 插件页的 MCP 行按 daemon 真实字段渲染。
//
// 来源：E131 真接了一个 MCP server（ReVa / Ghidra）之后才发现——
// `mcpServerStatus/list` 在 daemon 0.160.0 上返回的字段跟 `proto-ts` 里的类型不一样：
//   { name, runtimeStatus, pluginId, httpOrigin, serverInfo, serverCapabilities, tools: {name: Tool}, toolsError, … }
// 原来那行只读 `item.status || item.state`，于是真接上以后显示成 `reva·?`：
// 既看不出连没连上，也看不出有多少工具，属于"有数据但渲染成问号"。
//
// 修法（纯前端渲染）：
//   - 状态优先 `runtimeStatus`（thread 维度才是 connected；不带 threadId 时它是 null），
//     退回 `status`/`state`，再退回"配置已加载"；
//   - `tools` 在 0.160.0 是 **map**（不是数组），按 map/array 两种形态数个数；
//   - 附带 serverInfo.name（MCP 握手回来的服务端自称），跟配置名不一致时显示出来；
//   - 有服务器但 runtimeStatus 为空时，加一行说明：配置已加载、还没有 thread 连上它。
//
// Usage: node patches/0095-mcp-server-row-real-fields.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const file = resolve(appDir, "public/app.js");
let js = readFileSync(file, "utf8");

const marker = "realdFields"; // 幂等标记（不能撞上游已有的字符串）
if (js.includes(marker)) {
  console.log("skip  public/app.js (already applied)");
} else {
  const old = "      rows.append(settingsRow(t('MCP servers'),servers?.__error?servers.__error:String(mcp.length),servers?.__error?'':mcp.map(function(item){return (item.name||item.id)+'·'+(item.status||item.state||'?')}).slice(0,6).join(', ')),reload);";
  if (!js.includes(old)) throw new Error("cannot locate the MCP servers settingsRow");
  const news = [
    "      /* mcp-server-row-real-fields（patches/0095）：daemon 0.160.0 的 mcpServerStatus/list",
    "         返回 runtimeStatus / httpOrigin / serverInfo / tools(map)，原来的 item.status 永远是 undefined。 */",
    "      const mcpDescribe=function(item){",
    "        const name=item.name||item.id||'?';",
    "        const state=item.runtimeStatus||item.status||item.state||t('configured');",
    "        const tools=item.tools?(Array.isArray(item.tools)?item.tools.length:Object.keys(item.tools).length):null;",
    "        const serverName=item.serverInfo&&item.serverInfo.name?item.serverInfo.name:null;",
    "        return name+'·'+state+(tools===null?'':'·'+tools+' '+t('tools'))+(serverName&&serverName!==name?' ('+serverName+')':'');",
    "      };",
    "      rows.append(settingsRow(t('MCP servers'),servers?.__error?servers.__error:String(mcp.length),servers?.__error?'':mcp.map(mcpDescribe).slice(0,6).join(', ')),reload);",
    "      if(!servers?.__error&&mcp.some(function(item){return !item.runtimeStatus})){",
    "        rows.append(settingsNotice(t('A server without a runtime status is loaded from config but no thread has connected to it yet (runtime status is per-thread).')));",
    "      }",
  ].join("\n");
  js = js.replace(old, news);
  writeFileSync(file, js);
  console.log("apply public/app.js: MCP server row uses runtimeStatus/serverInfo/tools-map");
}

console.log("done — rebuild the bundle: cd app && bun build public/app.js --target=browser --outfile=public/app.bundle.js");
