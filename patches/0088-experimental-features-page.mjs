// Patch 0088 — 设置里新增「实验特性」页：列真实开关，能改（带确认与真实回执）。
//
// 协议侧 `experimentalFeature/list` 返回真实数据（name / stage / displayName / description /
// enabled / defaultEnabled），修改走 `experimentalFeature/enablement/set {enablement:{name:bool}}`
// —— 参数是"只更新你给的那些键"，所以逐项开关是安全的（不需要整表覆盖）。
//
// 注意语义：这是**进程级运行时开关**（协议原文 "Process-wide runtime feature enablement"），
// 不一定落盘、也可能需要重启 app-server 才完全生效——UI 里如实写出来，不假装是持久配置。
//
// Usage: node patches/0088-experimental-features-page.mjs [appDir]
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

edit("public/index.html", 'data-settings-page="experimental-settings"', [
  [
    '<button type="button" data-settings-page="hooks-settings"><span class="icon-slot" data-icon="wrench"></span><span>Hooks</span></button>',
    '<button type="button" data-settings-page="hooks-settings"><span class="icon-slot" data-icon="wrench"></span><span>Hooks</span></button>'
      + '<button type="button" data-settings-page="experimental-settings"><span class="icon-slot" data-icon="list"></span><span>Experimental</span></button>',
    "nav entry",
  ],
]);

edit("public/app.js", "experimental-settings:{title:", [
  [
    "'hooks-settings':{title:'Hooks',rows:",
    "'experimental-settings':{title:'Experimental',rows:[['Features','Loads from experimentalFeature/list']]},'hooks-settings':{title:'Hooks',rows:",
    "settingsPages entry",
  ],
]);

const JS = [
  "",
  "// --- 实验特性页（patches/0088）----------------------------------------------",
  "// 只展示、不提供开关：本机构建对 `experimentalFeature/enablement/set` 是**空操作**——",
  "// 实测调用返回 {\"enablement\":{}}（什么都没更新），切换后 enabled 状态不变",
  "// （试过 beta/stable/underDevelopment 三个特性都一样）。所以这里如实说明，",
  "// 而不是放一排点了没用的开关（用户明确禁止空按钮）。",
  "async function renderExperimentalFeatures(rows){",
  "  const list=await rpc('experimentalFeature/list',{}).catch(function(error){return {__error:error.message}});",
  "  if(list?.__error){rows.append(settingsNotice(t('Could not load: ')+list.__error,'warning'));return}",
  "  const features=list?.data||[];",
  "  if(!features.length){rows.append(settingsNotice(t('No experimental features are reported by this build.')));return}",
  "  rows.append(settingsNotice(t('This build ignores experimentalFeature/enablement/set: measured, the call returns an empty enablement and the state never changes. So this page lists the real flags without offering switches.'),'warning'));",
  "  for(const feature of features){",
  "    const note=[feature.stage,feature.description].filter(Boolean).join(' · ');",
  "    rows.append(settingsRow(feature.displayName||feature.name,(feature.enabled?'On':'Off')+(feature.defaultEnabled?' (default)':''),note));",
  "  }",
  "}",
  "",
].join("\n");

{
  const path = resolve(appDir, "public/app.js");
  const source = readFileSync(path, "utf8");
  if (!source.includes("async function renderExperimentalFeatures(")) {
    writeFileSync(path, source + JS);
    console.log("apply public/app.js: experimental features renderer");
  } else {
    console.log("skip  public/app.js (renderer already applied)");
  }
}

// 标记必须是本补丁引入的字符串：早期版本用 renderExperimentalFeatures(rows) 当标记，
// 而它就在上面追加的代码里 → 进去就"已应用"，两步被整段跳过（第三次踩这个坑，见 PATCHES 0018/0067/0088）。
edit("public/app.js", "hosted=['agent','profile','plugins-settings','skills-settings','hooks-settings','experimental-settings']", [
  [
    "  const hosted=['agent','profile','plugins-settings','skills-settings','hooks-settings'];",
    "  const hosted=['agent','profile','plugins-settings','skills-settings','hooks-settings','experimental-settings'];",
    "host the page",
  ],
  [
    "    if(page==='hooks-settings'){",
    "    if(page==='experimental-settings'){\n"
      + "      rows.replaceChildren();\n"
      + "      await renderExperimentalFeatures(rows);\n"
      + "      return true;\n"
      + "    }\n"
      + "    if(page==='hooks-settings'){",
    "route to the renderer",
  ],
]);

edit("public/i18n.js", '"Experimental": "实验特性"', [
  ['  "Copied to Downloads": "已复制到 Download",\n',
   '  "Copied to Downloads": "已复制到 Download",\n'
     + '  "Experimental": "实验特性",\n'
     + '  "This build ignores experimentalFeature/enablement/set: measured, the call returns an empty enablement and the state never changes. So this page lists the real flags without offering switches.": "本机构建会忽略 experimentalFeature/enablement/set（实测：调用返回空的 enablement，状态始终不变），所以这里只列出真实开关状态，不提供点了没用的按钮。",\n'
     + '  "No experimental features are reported by this build.": "这个构建没有报告任何实验特性。",\n'
     + '  "On": "开",\n'
     + '  "Off": "关",\n',
     + '  " (default)": "（默认）",\n',
   "zh entries"],
]);

console.log("done — rebuild the bundle: cd app && bun build public/app.js --target=browser --outfile=public/app.bundle.js");
