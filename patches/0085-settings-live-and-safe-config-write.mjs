// Patch 0085 — P7：设置页填真数据 + 配置只许"逐项安全写"。
//
// 背景一（安全）：上游把 `config/value/write` / `config/batchWrite` 直接放进了**浏览器白名单**，
// 也就是说页面能给任意 keyPath 写值。用户的要求是"配置安全修改、禁全量覆盖"，
// 所以这两个从浏览器白名单里摘掉，改由桥开一个**受控出口**：
//     POST /api/config/write {keyPath, value}
//   - keyPath 只允许 `approval_policy` / `sandbox_mode`（其余一律拒绝，理由写在响应里）；
//   - 值要过枚举校验（AskForApproval / SandboxMode 的真实取值）；
//   - 内层仍走协议 `config/value/write {keyPath,value,mergeStrategy:"replace"}`——单键写入、
//     保留其它键（已在一次性 CODEX_HOME 上实测：改 approval_policy 后 model/sandbox_mode 原样保留）。
//
// 背景二（诚实）：P7 要求"核实 Android 上权限与沙箱是否真的生效，不能仅凭配置字段宣称已隔离"。
// 实测结论（E126）：**本平台沙箱不生效**——`command/exec` 带 readOnly/workspaceWrite 策略照样能写工作区外、
// 照样能联网；thread 级 `sandbox:"read-only"` + 实例级 `-c sandbox_mode=read-only` 时，
// 模型的命令**依然把文件写进去了**。所以 Configuration 页必须把这句话写在最显眼处，
// 并说清"真正生效的是审批（harness 级门禁）"。
//
// 顺带把设置页的占位符换成真数据（profile / plugins+MCP / skills / hooks），
// 平台不可用的页给出具体原因而不是"Not configured"。
//
// Usage: node patches/0085-settings-live-and-safe-config-write.mjs [appDir]
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

// --- 安全：从浏览器白名单摘掉任意 key 的配置写入 --------------------------------
edit("server-security.js", "config writes go through the bridge", [
  [
    '  "config/value/write",\n  "config/batchWrite",',
    '  // config writes go through the bridge\'s guarded route (POST /api/config/write):\n'
      + '  // the browser must not be able to write arbitrary keyPaths (P7 requirement).',
    "drop raw config writes from the browser allowlist",
  ],
]);

// --- 桥：受控的配置写出口 -----------------------------------------------------
edit("server.ts", '"/api/config/write"', [
  [
    '  if (url.pathname === "/api/config") {',
    '  if (url.pathname === "/api/config/write") {\n'
      + '    if (req.method !== "POST") {\n'
      + '      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "POST" });\n'
      + '      res.end(JSON.stringify({ error: "Method not allowed" }));\n'
      + '      return;\n'
      + '    }\n'
      + '    let configBody = "";\n'
      + '    req.setEncoding("utf8");\n'
      + '    req.on("data", (chunk) => { configBody += chunk; if (configBody.length > 64_000) req.destroy(new Error("Config payload too large")); });\n'
      + '    req.on("end", async () => {\n'
      + '      let status = 200;\n'
      + '      let payload: any;\n'
      + '      try {\n'
      + '        const body = JSON.parse(configBody || "{}");\n'
      + '        const keyPath = String(body.keyPath ?? "");\n'
      + '        // 只允许这两个键：它们直接决定"模型能不能在没批准的情况下动你的文件"。\n'
      + '        // 其它键（model/provider/凭据路径等）一律不从这里改——那是用户自己的配置。\n'
      + '        const WRITABLE: Record<string, string[]> = {\n'
      + '          approval_policy: ["untrusted", "on-request", "on-failure", "never"],\n'
      + '          sandbox_mode: ["read-only", "workspace-write", "danger-full-access"],\n'
      + '        };\n'
      + '        if (!Object.hasOwn(WRITABLE, keyPath)) {\n'
      + '          throw new Error(`This build only writes ${Object.keys(WRITABLE).join(" / ")} from the app (asked for ${keyPath || "nothing"})`);\n'
      + '        }\n'
      + '        const value = String(body.value ?? "");\n'
      + '        if (!WRITABLE[keyPath].includes(value)) {\n'
      + '          throw new Error(`Invalid value for ${keyPath}: ${value || "(empty)"}`);\n'
      + '        }\n'
      + '        const result = await request("config/value/write", { keyPath, value, mergeStrategy: "replace" });\n'
      + '        console.log(`[codex-webui] config write ${keyPath}=${value} -> ${result?.status || "?"}`);\n'
      + '        payload = { ok: true, keyPath, value, status: result?.status || null, filePath: result?.filePath || null };\n'
      + '      } catch (error) {\n'
      + '        status = 400;\n'
      + '        payload = { error: error instanceof Error ? error.message : String(error) };\n'
      + '      }\n'
      + '      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });\n'
      + '      res.end(JSON.stringify(payload));\n'
      + '    });\n'
      + '    return;\n'
      + '  }\n'
      + '  if (url.pathname === "/api/config") {',
    "guarded config write route",
  ],
]);

// --- 前端：设置页真数据 -------------------------------------------------------
const JS = [
  "",
  "// --- 设置页的真数据（patches/0085）------------------------------------------",
  "// 上游的设置页大多是静态占位符（\"Not configured\"），这里按页去取**真实**信息：",
  "//   agent → config/read + permissionProfile/list（含沙箱在本平台是否生效的实测结论）",
  "//   profile → account/read + usage/rateLimits（第三方 provider 的真实原因）",
  "//   plugins-settings → plugin/installed + mcpServerStatus/list",
  "//   skills-settings → skills/list    hooks-settings → hooks/list",
  "// 拿不到就显示真实错误文本，不写\"None\"糊弄。",
  "const SETTINGS_PLATFORM_NOTES={",
  "  'browser-use':['浏览器自动化','本机 app-server 没有 browser_use 后端（Android 上无对应实现）；要预览网页请用侧栏「浏览器」面板，它是普通 WebView，不是自动化驱动。'],",
  "  'computer-use':['电脑操作','无 Android 对等实现（依赖桌面图形栈）。替代：本项目的无障碍桥 CodexBridge 能驱动本机 UI，但那是另一套东西。'],",
  "  connections:['连接器','connector 依赖官方账户（第三方 provider 下不可用）。替代：直接用 MCP 服务器，见 Plugins 页。'],",
  "  'cloud-settings':['云任务','Codex Cloud 依赖官方账户；本机 provider 是第三方，不可用。替代：本地会话 + 后台任务（P8 会做本地调度）。'],",
  "  'cloud-environments':['云环境','同上：需要官方账户。替代：本地 worktree（Git 面板里已可用）。'],",
  "  worktrees:['worktree','本机走侧栏 Git 面板的 worktree 段（创建/打开/删除/清理）——那是真实实现，不是这个占位页。'],",
  "  'git-settings':['Git','本机走侧栏 Git 面板：暂存/提交/推送/拉取/丢弃/worktree 都是桥直接调 git。'],",
  "  'data-controls':['归档会话','侧栏「已归档」入口可以直接恢复会话。'],",
  "};",
  "",
  "function settingsRow(label,value,note){",
  "  const row=document.createElement('div');",
  "  row.className='settings-row settings-readonly-row';",
  "  const copy=document.createElement('span'),strong=document.createElement('strong'),status=document.createElement('span');",
  "  strong.textContent=t(label);",
  "  copy.append(strong);",
  "  if(note)copy.append(Object.assign(document.createElement('small'),{className:'settings-row-note',textContent:note}));",
  "  status.className='settings-row-value';",
  "  status.textContent=value;",
  "  row.append(copy,status);",
  "  return row;",
  "}",
  "",
  "function settingsNotice(text,tone){",
  "  const note=document.createElement('p');",
  "  note.className='settings-notice'+(tone?' '+tone:'');",
  "  note.textContent=text;",
  "  return note;",
  "}",
  "",
  "async function renderSettingsLive(page){",
  "  const title=$('#settingsPlaceholderTitle'),description=$('#settingsPlaceholderDescription'),rows=$('#settingsPlaceholderRows');",
  "  if(!rows)return false;",
  "  const hosted=['agent','profile','plugins-settings','skills-settings','hooks-settings'];",
  "  const platform=SETTINGS_PLATFORM_NOTES[page];",
  "  if(!hosted.includes(page)&&!platform)return false;",
  "  rows.replaceChildren();",
  "  if(description){description.hidden=true;description.textContent=''}",
  "  if(title)title.textContent=t(settingsPages[page]?.title||page);",
  "  if(platform){",
  "    rows.append(settingsNotice(t(platform[0]),'warning'),settingsRow(t('What this build uses instead'),t(platform[1])));",
  "    return true;",
  "  }",
  "  rows.append(settingsNotice(t('Loading…')));",
  "  try{",
  "    if(page==='agent'){",
  "      const config=await rpc('config/read',{});",
  "      const cfg=config?.config||{};",
  "      const profiles=await rpc('permissionProfile/list',{}).catch(function(){return null});",
  "      rows.replaceChildren();",
  "      rows.append(settingsNotice(t('Sandbox is NOT enforced on this platform: measured with read-only and workspace-write policies, commands could still write outside the workspace and reach the network. Treat the permission chips as a display of intent, not as a boundary.'),'warning'));",
  "      rows.append(settingsRow('approval_policy',String(cfg.approval_policy??'—'),t('This is what actually gates commands: the agent asks, and nothing runs until you answer.')));",
  "      rows.append(settingsRow('sandbox_mode',String(cfg.sandbox_mode??'—'),t('Accepted by the backend, but see the notice above — it does not isolate anything here.')));",
  "      rows.append(settingsRow(t('Model'),modelDisplay(selectedModel()),t('Per-conversation; change it in the composer.')));",
  "      rows.append(settingsRow(t('Provider'),String(cfg.model_provider??'—'),''));",
  "      rows.append(settingsRow(t('Reasoning effort'),reasoningLabel($('#effortSelect')?.value),''));",
  "      const ids=(profiles?.data||[]).map(function(item){return item.id}).join(', ');",
  "      rows.append(settingsRow(t('Permission profiles'),ids||'—',t('Reported by permissionProfile/list.')));",
  "      const writeRow=document.createElement('div');",
  "      writeRow.className='settings-row settings-write-row';",
  "      const label=document.createElement('span');",
  "      label.append(Object.assign(document.createElement('strong'),{textContent:t('Approval policy')}));",
  "      const select=document.createElement('select');",
  "      for(const value of ['never','on-request','on-failure','untrusted']){",
  "        const option=document.createElement('option');",
  "        option.value=value;option.textContent=value;",
  "        if(String(cfg.approval_policy)===value)option.selected=true;",
  "        select.append(option);",
  "      }",
  "      const save=document.createElement('button');",
  "      save.type='button';save.className='settings-save';save.textContent=t('Save');",
  "      save.onclick=async function(){",
  "        const value=select.value;",
  "        const ok=await gitConfirm({title:t('Write to config.toml?'),message:'approval_policy = \"'+value+'\"',confirmLabel:t('Save')});",
  "        if(!ok)return;",
  "        try{",
  "          const response=await fetch('/api/config/write',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({keyPath:'approval_policy',value})});",
  "          const data=await response.json().catch(function(){return {}});",
  "          if(!response.ok)throw new Error(data.error||'Config write failed');",
  "          toast(t('Saved')+' · approval_policy = '+value);",
  "          clientLog('config write ok: approval_policy='+value+' status='+(data.status||'?'));",
  "          void renderSettingsLive('agent');",
  "        }catch(error){toast(error.message)}",
  "      };",
  "      writeRow.append(label,select,save);",
  "      rows.append(writeRow);",
  "      return true;",
  "    }",
  "    if(page==='profile'){",
  "      const account=await rpc('account/read',{}).catch(function(error){return {__error:error.message}});",
  "      const usage=await rpc('account/usage/read',{}).catch(function(error){return {__error:error.message}});",
  "      const limits=await rpc('account/rateLimits/read',{}).catch(function(error){return {__error:error.message}});",
  "      rows.replaceChildren();",
  "      const info=account?.account;",
  "      rows.append(settingsRow(t('Account'),info?(info.email||info.planType||info.type||'—'):'—',info?'':t('This provider does not expose an account (third-party provider). Everything above is local; billing and limits live with your provider.')));",
  "      rows.append(settingsRow(t('Usage'),usage?.__error?usage.__error:(usage?JSON.stringify(usage).slice(0,80):'—'),''));",
  "      rows.append(settingsRow(t('Rate limits'),limits?.__error?limits.__error:(limits?JSON.stringify(limits).slice(0,80):'—'),''));",
  "      return true;",
  "    }",
  "    if(page==='plugins-settings'){",
  "      const installed=await rpc('plugin/installed',{}).catch(function(error){return {__error:error.message}});",
  "      const servers=await rpc('mcpServerStatus/list',{}).catch(function(error){return {__error:error.message}});",
  "      rows.replaceChildren();",
  "      const list=installed?.data||installed?.plugins||[];",
  "      rows.append(settingsRow(t('Installed plugins'),installed?.__error?installed.__error:String(list.length),installed?.__error?'':list.map(function(item){return item.id||item.name}).slice(0,6).join(', ')));",
  "      const mcp=servers?.data||servers?.servers||[];",
  "      rows.append(settingsRow(t('MCP servers'),servers?.__error?servers.__error:String(mcp.length),servers?.__error?'':mcp.map(function(item){return (item.name||item.id)+'·'+(item.status||item.state||'?')}).slice(0,6).join(', ')));",
  "      return true;",
  "    }",
  "    if(page==='skills-settings'){",
  "      const skills=await rpc('skills/list',{}).catch(function(error){return {__error:error.message}});",
  "      rows.replaceChildren();",
  "      const list=skills?.data||skills?.skills||[];",
  "      rows.append(settingsRow(t('Skills'),skills?.__error?skills.__error:String(list.length),skills?.__error?'':list.map(function(item){return item.name||item.id}).slice(0,8).join(', ')));",
  "      return true;",
  "    }",
  "    if(page==='hooks-settings'){",
  "      const hooks=await rpc('hooks/list',{}).catch(function(error){return {__error:error.message}});",
  "      rows.replaceChildren();",
  "      const list=hooks?.data||hooks?.hooks||[];",
  "      rows.append(settingsRow(t('Hooks'),hooks?.__error?hooks.__error:String(list.length),hooks?.__error?'':list.map(function(item){return item.event||item.name||item.id}).slice(0,8).join(', ')));",
  "      return true;",
  "    }",
  "  }catch(error){",
  "    rows.replaceChildren(settingsNotice(t('Could not load: ')+error.message,'warning'));",
  "    return true;",
  "  }",
  "  return false;",
  "}",
  "",
].join("\n");

{
  const path = resolve(appDir, "public/app.js");
  const source = readFileSync(path, "utf8");
  if (source.includes("function renderSettingsLive(")) {
    console.log("skip  public/app.js (already applied)");
  } else {
    writeFileSync(path, source + JS);
    console.log("apply public/app.js: live settings pages");
  }
}

edit("public/app.js", "renderSettingsLive(page))return", [
  [
    "function renderSettingsPlaceholder(page){",
    "function renderSettingsPlaceholder(page){if(renderSettingsLive(page))return;",
    "prefer live settings content",
  ],
]);

// --- i18n -------------------------------------------------------------------
edit("public/i18n.js", '"Sandbox is NOT enforced',
  [
    ['  "No active conversation": "当前没有打开的会话",\n',
     '  "No active conversation": "当前没有打开的会话",\n'
       + '  "Sandbox is NOT enforced on this platform: measured with read-only and workspace-write policies, commands could still write outside the workspace and reach the network. Treat the permission chips as a display of intent, not as a boundary.": "本平台的沙箱没有生效（实测）：即使用 read-only / workspace-write 策略，命令照样能写工作区外、照样能联网。请把权限选项当成\\u201c意图声明\\u201d，不要当成安全边界。",\n'
       + '  "This is what actually gates commands: the agent asks, and nothing runs until you answer.": "真正起作用的是审批：模型会先问，你不回答它就不执行。",\n'
       + '  "Accepted by the backend, but see the notice above — it does not isolate anything here.": "后端接受这个字段，但见上面的提示——在本机它不隔离任何东西。",\n'
       + '  "Provider": "provider",\n'
       + '  "Permission profiles": "权限档位",\n'
       + '  "Reported by permissionProfile/list.": "来自 permissionProfile/list。",\n'
       + '  "Approval policy": "审批策略",\n'
       + '  "Write to config.toml?": "写入 config.toml？",\n'
       + '  "Account": "账户",\n'
       + '  "This provider does not expose an account (third-party provider). Everything above is local; billing and limits live with your provider.": "这个 provider 不提供账户信息（第三方）。本地信息都在上面；计费与限额在你的 provider 那边。",\n'
       + '  "Usage": "用量",\n'
       + '  "Rate limits": "限额",\n'
       + '  "Installed plugins": "已安装插件",\n'
       + '  "MCP servers": "MCP 服务器",\n'
       + '  "Skills": "技能",\n'
       + '  "Hooks": "钩子",\n'
       + '  "What this build uses instead": "本机构建实际用什么替代",\n'
       + '  "Could not load: ": "加载失败：",\n',
     "zh entries"],
  ]);

// --- CSS --------------------------------------------------------------------
{
  const path = resolve(appDir, "public/style.css");
  let css = readFileSync(path, "utf8");
  if (css.includes(".settings-notice")) {
    console.log("skip  public/style.css (already applied)");
  } else {
    css += [
      "",
      "/* 设置页真数据（patches/0085）。 */",
      ".settings-notice{margin:2px 0 8px;padding:9px 11px;border-radius:9px;font-size:11.5px;line-height:1.55;background:color-mix(in srgb,var(--app-text) 6%,transparent);color:var(--app-text-secondary);overflow-wrap:anywhere}",
      ".settings-notice.warning{background:color-mix(in srgb,var(--warning,#d7a95e) 18%,transparent);color:var(--text,#ececec)}",
      ".settings-row-note{display:block;margin-top:3px;font-size:10.5px;line-height:1.5;color:var(--app-text-tertiary)}",
      ".settings-row-value{text-align:right;font:11px var(--mono);color:var(--app-text);max-width:46%;overflow-wrap:anywhere}",
      ".settings-write-row{display:flex;align-items:center;gap:8px;justify-content:space-between}",
      ".settings-write-row select{min-height:32px;padding:0 8px;border:1px solid var(--app-border-default,var(--border-strong));border-radius:8px;background:transparent;color:var(--app-text);font:11.5px var(--mono)}",
      ".settings-save{min-height:32px;padding:0 12px;border:0;border-radius:8px;background:var(--app-text);color:var(--app-main);font-size:12px;font-weight:600}",
      "",
    ].join("\n");
    writeFileSync(path, css);
    console.log("apply public/style.css: settings live rows");
  }
}

console.log("done — rebuild the bundle: cd app && bun build public/app.js --target=browser --outfile=public/app.bundle.js");
