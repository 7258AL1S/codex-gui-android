// Patch 0093 — P7：插件市场与插件的受控操作（安装/卸载/添加/移除）。
//
// 为什么走桥而不是让页面直连：`marketplace/*` 三个方法**不在浏览器白名单**里
// （实测报 "RPC method is not available to browser clients"）。这也符合本项目的口径——
// 能让页面"添加任意来源、装任意插件"的入口必须是受控的、由用户明确点的。
// 于是新增 `POST /api/plugins {action, …}`，动作白名单：
//   marketplaceAdd {source}     —— 只接受「允许根内的本地目录」或 `https://` 来源
//   marketplaceRemove {name}
//   install {pluginName, marketplacePath?|remoteMarketplaceName?}
//   uninstall {pluginId}
// 其余（`plugin/list`、`plugin/installed`、`plugin/read`）本来就在白名单里，页面直接调。
//
// 清单格式（从二进制里读出来的约定，实测确认过）：
//   市场：目录里的 `marketplace.json`
//   插件：`<plugin>/.codex-plugin/plugin.json`，且 **必须带 `$schema`**
//         （`https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`）
//
// Usage: node patches/0093-plugins-and-marketplaces.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);

function edit(file, marker, steps) {
  const path = resolve(appDir, file);
  let source = readFileSync(path, "utf8");
  if (source.includes(marker)) {
    console.log("skip  " + file + " (already applied)");
    return;
  }
  for (const [from, to, label] of steps) {
    const hits = source.split(from).length - 1;
    if (hits !== 1) throw new Error(file + ": cannot locate " + label + " exactly once (hits=" + hits + ")");
    source = source.replace(from, to);
    console.log("apply " + file + ": " + label);
  }
  writeFileSync(path, source);
}

// --- 桥：/api/plugins ---------------------------------------------------------
edit("server.ts", '"/api/plugins"', [
  [
    '  if (url.pathname === "/api/config/write") {',
    '  if (url.pathname === "/api/plugins") {\n'
      + '    if (req.method !== "POST") {\n'
      + '      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "POST" });\n'
      + '      res.end(JSON.stringify({ error: "Method not allowed" }));\n'
      + '      return;\n'
      + '    }\n'
      + '    let pluginBody = "";\n'
      + '    req.setEncoding("utf8");\n'
      + '    req.on("data", (chunk) => { pluginBody += chunk; if (pluginBody.length > 32_000) req.destroy(new Error("Payload too large")); });\n'
      + '    req.on("end", async () => {\n'
      + '      let status = 200;\n'
      + '      let payload: any;\n'
      + '      try {\n'
      + '        const body = JSON.parse(pluginBody || "{}");\n'
      + '        const action = String(body.action ?? "");\n'
      + '        if (action === "marketplaceAdd") {\n'
      + '          const source = String(body.source || "").trim();\n'
      + '          if (!source) throw new Error("A marketplace source is required (a local directory or an https:// URL)");\n'
      + '          // 本地来源必须在允许根内且真实存在；远程只放行 https。\n'
      + '          if (/^https:\\/\\//i.test(source)) {\n'
      + '            payload = await request("marketplace/add", { source }, 120000);\n'
      + '          } else {\n'
      + '            const directory = resolveBrowsePath(source, browseRoots, homeDir);\n'
      + '            if (!isDirectory(directory)) throw new Error(`Not a directory: ${directory}`);\n'
      + '            payload = await request("marketplace/add", { source: directory }, 120000);\n'
      + '          }\n'
      + '          console.log(`[codex-webui] marketplace added: ${payload?.marketplaceName || source}`);\n'
      + '        } else if (action === "marketplaceRemove") {\n'
      + '          const name = String(body.name || "").trim();\n'
      + '          if (!name) throw new Error("A marketplace name is required");\n'
      + '          payload = await request("marketplace/remove", { marketplaceName: name }, 60000);\n'
      + '        } else if (action === "install") {\n'
      + '          const pluginName = String(body.pluginName || "").trim();\n'
      + '          if (!pluginName) throw new Error("A plugin name is required");\n'
      + '          const params: any = { pluginName, installAttemptId: `bridge-${Date.now()}` };\n'
      + '          if (body.marketplacePath) params.marketplacePath = resolveBrowsePath(String(body.marketplacePath), browseRoots, homeDir);\n'
      + '          else if (body.remoteMarketplaceName) params.remoteMarketplaceName = String(body.remoteMarketplaceName);\n'
      + '          payload = await request("plugin/install", params, 120000);\n'
      + '        } else if (action === "uninstall") {\n'
      + '          const pluginId = String(body.pluginId || "").trim();\n'
      + '          if (!pluginId) throw new Error("A plugin id is required");\n'
      + '          payload = await request("plugin/uninstall", { pluginId }, 60000);\n'
      + '        } else {\n'
      + '          throw new Error(`Unsupported plugin action: ${action || "(empty)"}`);\n'
      + '        }\n'
      + '      } catch (error) {\n'
      + '        status = 400;\n'
      + '        payload = { error: error instanceof Error ? error.message : String(error) };\n'
      + '      }\n'
      + '      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-store": "no-store", "cache-control": "no-store" });\n'
      + '      res.end(JSON.stringify(payload));\n'
      + '    });\n'
      + '    return;\n'
      + '  }\n'
      + '  if (url.pathname === "/api/config/write") {',
    "plugins route",
  ],
]);

// --- 前端：插件页的动作 -------------------------------------------------------
edit("public/app.js", "markets.flatMap(function(market)", [
  [
    "      const list=installed?.data||installed?.plugins||[];",
    "      // plugin/list 与 plugin/installed 的返回结构是 {marketplaces:[{name,plugins:[…]}], marketplaceLoadErrors:[]}。\n"
      + "      const markets=installed?.marketplaces||[];\n"
      + "      const list=markets.flatMap(function(market){return (market.plugins||[]).map(function(plugin){return Object.assign({},plugin,{marketplaceName:market.marketplaceName||market.name,marketplacePath:market.path||market.marketplacePath||null})})});\n"
      + "      if(!markets.length){rows.append(settingsNotice(t('No plugin marketplace is configured. Add one below (a local directory containing marketplace.json, or an https URL).')))}",
    "markets summary",
  ],
  [
    "      return true;\n    }\n    if(page==='skills-settings'){",
    "      const form=document.createElement('div');\n"
      + "      form.className='settings-write-row';\n"
      + "      const label2=document.createElement('span');\n"
      + "      label2.append(Object.assign(document.createElement('strong'),{textContent:t('Add a marketplace')}));\n"
      + "      const input=document.createElement('input');\n"
      + "      input.type='text';input.placeholder=t('local directory or https URL');input.autocomplete='off';input.spellcheck=false;\n"
      + "      const add=document.createElement('button');\n"
      + "      add.type='button';add.className='settings-save';add.textContent=t('Add');\n"
      + "      add.onclick=async function(){\n"
      + "        const source=input.value.trim();\n"
      + "        if(!source){toast(t('A marketplace source is required'));return}\n"
      + "        const ok=await gitConfirm({title:t('Add a plugin marketplace?'),message:source,confirmLabel:t('Add')});\n"
      + "        if(!ok)return;\n"
      + "        try{\n"
      + "          const data=await pluginsCall('marketplaceAdd',{source});\n"
      + "          toast(t('Marketplace added')+': '+(data.marketplaceName||source));\n"
      + "          void renderSettingsLive('plugins-settings');\n"
      + "        }catch(error){toast(error.message)}\n"
      + "      };\n"
      + "      form.append(label2,input,add);\n"
      + "      rows.append(form);\n"
      + "      const marketList=document.createElement('div');\n"
      + "      marketList.className='settings-plugin-list';\n"
      + "      for(const market of markets){\n"
      + "        const name=market.marketplaceName||market.name;\n"
      + "        const row=settingsRow(name,String((market.plugins||[]).length)+' '+t('plugins'),'');\n"
      + "        const remove=document.createElement('button');\n"
      + "        remove.type='button';remove.className='settings-save';remove.textContent=t('Remove');\n"
      + "        remove.onclick=async function(){\n"
      + "          const ok=await gitConfirm({title:t('Remove this marketplace?'),message:name,danger:true,confirmLabel:t('Remove')});\n"
      + "          if(!ok)return;\n"
      + "          try{await pluginsCall('marketplaceRemove',{name});toast(t('Marketplace removed'));void renderSettingsLive('plugins-settings')}catch(error){toast(error.message)}\n"
      + "        };\n"
      + "        row.append(remove);\n"
      + "        marketList.append(row);\n"
      + "      }\n"
      + "      for(const plugin of list){\n"
      + "        const row=settingsRow(plugin.name||plugin.id,plugin.installed?t('installed'):t('not installed'),plugin.description||'');\n"
      + "        const action=document.createElement('button');\n"
      + "        action.type='button';action.className='settings-save';\n"
      + "        action.textContent=plugin.installed?t('Uninstall'):t('Install');\n"
      + "        action.onclick=async function(){\n"
      + "          try{\n"
      + "            if(plugin.installed)await pluginsCall('uninstall',{pluginId:plugin.id||plugin.name});\n"
      + "            else await pluginsCall('install',{pluginName:plugin.name,marketplacePath:plugin.marketplacePath});\n"
      + "            toast((plugin.name||plugin.id)+': '+(plugin.installed?t('uninstalled'):t('installed')));\n"
      + "            void renderSettingsLive('plugins-settings');\n"
      + "          }catch(error){toast(error.message)}\n"
      + "        };\n"
      + "        row.append(action);\n"
      + "        marketList.append(row);\n"
      + "      }\n"
      + "      rows.append(marketList);\n"
      + "      return true;\n    }\n    if(page==='skills-settings'){",
    "marketplace + plugin actions",
  ],
]);

const JS = [
  "",
  "// --- 插件动作的桥出口（patches/0093）----------------------------------------",
  "// marketplace/* 不在浏览器白名单里（实测被拒），所以安装/卸载/加市场都走这个受控出口。",
  "async function pluginsCall(action,extra){",
  "  const response=await fetch('/api/plugins',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.assign({action},extra||{}))});",
  "  const data=await response.json().catch(function(){return {}});",
  "  clientLog('plugins '+action+' -> '+response.status+(response.ok?'':' '+(data.error||'')));",
  "  if(!response.ok)throw new Error(data.error||('Plugins '+action+' failed'));",
  "  return data;",
  "}",
  "",
].join("\n");

{
  const path = resolve(appDir, "public/app.js");
  const source = readFileSync(path, "utf8");
  if (!source.includes("async function pluginsCall(")) {
    writeFileSync(path, source + JS);
    console.log("apply public/app.js: pluginsCall helper");
  } else {
    console.log("skip  public/app.js (helper already applied)");
  }
}

// --- CSS + i18n --------------------------------------------------------------
{
  const path = resolve(appDir, "public/style.css");
  let css = readFileSync(path, "utf8");
  if (!css.includes(".settings-plugin-list")) {
    css += [
      "",
      "/* 插件页（patches/0093）。 */",
      ".settings-plugin-list{display:flex;flex-direction:column;gap:2px}",
      ".settings-plugin-list .settings-row{align-items:center;gap:8px}",
      ".settings-write-row input[type=text]{flex:1;min-width:0;min-height:32px;padding:0 8px;border:1px solid var(--app-border-default,var(--border-strong));border-radius:8px;background:transparent;color:var(--app-text);font:11.5px var(--mono)}",
      "",
    ].join("\n");
    writeFileSync(path, css);
    console.log("apply public/style.css: plugin rows");
  }
}

edit("public/i18n.js", '"Add a marketplace"', [
  ['  "MCP config reloaded": "MCP 配置已重新加载",\n',
   '  "MCP config reloaded": "MCP 配置已重新加载",\n'
     + '  "Add a marketplace": "添加插件市场",\n'
     + '  "local directory or https URL": "本地目录或 https 地址",\n'
     + '  "Add": "添加",\n'
     + '  "Add a plugin marketplace?": "添加插件市场？",\n'
     + '  "A marketplace source is required": "请填写市场来源",\n'
     + '  "Marketplace added": "市场已添加",\n'
     + '  "Remove this marketplace?": "移除这个市场？",\n'
     + '  "Marketplace removed": "市场已移除",\n'
     + '  "No plugin marketplace is configured. Add one below (a local directory containing marketplace.json, or an https URL).": "还没有配置插件市场。可以在下面添加（含 marketplace.json 的本地目录，或 https 地址）。",\n'
     + '  "plugins": "个插件",\n'
     + '  "Install": "安装",\n'
     + '  "Uninstall": "卸载",\n'
     + '  "installed": "已安装",\n'
     + '  "not installed": "未安装",\n'
     + '  "uninstalled": "已卸载",\n',
   "zh entries"],
]);

console.log("done — rebuild the bundle: cd app && bun build public/app.js --target=browser --outfile=public/app.bundle.js");
