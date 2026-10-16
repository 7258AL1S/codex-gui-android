// Patch 0066 — 手机上可用的终端辅助按键（FEATURES 第 5 节的硬性要求）。
//
// 手机没有 Ctrl 键：`Ctrl+C` 中断、`Tab` 补全、`Esc` 退出 vi、方向键翻历史，全都没有入口。
// 面板本身只有一个 xterm 宿主，所以这里补一行按键；点了直接把字节写进 pty
// （走的还是原来那条 `/terminal` WebSocket，二进制帧=键盘输入）。
//
// 只加在侧栏终端（手机上的入口），桌面那种底部面板仍按硬件键盘用。
//
// Usage: node patches/0066-terminal-mobile-keys.mjs [appDir]
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

const KEYS_HTML = [
  '      <div class="terminal-keys" id="terminalKeys" role="toolbar" aria-label="Terminal keys">',
  '        <button type="button" data-terminal-key="esc">Esc</button>',
  '        <button type="button" data-terminal-key="tab">Tab</button>',
  '        <button type="button" data-terminal-key="ctrl-c">Ctrl+C</button>',
  '        <button type="button" data-terminal-key="ctrl-d">Ctrl+D</button>',
  '        <button type="button" data-terminal-key="ctrl-z">Ctrl+Z</button>',
  '        <button type="button" data-terminal-key="up">↑</button>',
  '        <button type="button" data-terminal-key="down">↓</button>',
  '        <button type="button" data-terminal-key="left">←</button>',
  '        <button type="button" data-terminal-key="right">→</button>',
  '      </div>',
].join("\n");

edit("public/index.html", 'id="terminalKeys"', [
  [
    '      <div class="terminal-host side-terminal-host" id="sideTerminalHost" data-connected="false"></div>',
    '      <div class="terminal-host side-terminal-host" id="sideTerminalHost" data-connected="false"></div>\n' + KEYS_HTML,
    "key row",
  ],
]);

const JS_BLOCK = [
  "",
  "// --- 手机端终端辅助按键（patches/0066）-------------------------------------",
  "// 手机没有 Ctrl/Tab/Esc/方向键。这里把按键直接编码成字节写进 pty（二进制帧=键盘输入，",
  "// 与 xterm 自己的 onData 走同一条路），Ctrl+C 就是 \\x03，由 pty 的 ISIG 送给前台进程组。",
  "const TERMINAL_KEYS={esc:'\\u001b',tab:'\\t','ctrl-c':'\\u0003','ctrl-d':'\\u0004','ctrl-z':'\\u001a','ctrl-l':'\\u000c',up:'\\u001b[A',down:'\\u001b[B',right:'\\u001b[C',left:'\\u001b[D'};",
  "",
  "// 手机上终端是侧栏那一个；桌面上可能用底部面板，所以按\"连着的那个\"发。",
  "function activeTerminalState(){",
  "  const connected=(state)=>state&&state.ws&&state.ws.readyState===WebSocket.OPEN;",
  "  if(connected(terminalStates.side))return terminalStates.side;",
  "  if(connected(terminalStates.bottom))return terminalStates.bottom;",
  "  return terminalStates.side||terminalStates.bottom||null;",
  "}",
  "",
  "function sendTerminalKey(kind){",
  "  const data=TERMINAL_KEYS[kind];",
  "  if(!data)return;",
  "  const terminalState=activeTerminalState();",
  "  const ws=terminalState&&terminalState.ws;",
  "  if(!ws||ws.readyState!==WebSocket.OPEN){toast(t('Terminal is not connected'));return}",
  "  ws.send(new TextEncoder().encode(data));",
  "  try{terminalState.term?.focus()}catch(error){}",
  "}",
  "",
  "function wireTerminalKeys(){",
  "  for(const button of document.querySelectorAll('[data-terminal-key]')){",
  "    button.onclick=function(){sendTerminalKey(button.dataset.terminalKey)};",
  "  }",
  "}",
  "wireTerminalKeys();",
  "",
].join("\n");

{
  const path = resolve(appDir, "public/app.js");
  const source = readFileSync(path, "utf8");
  if (source.includes("function wireTerminalKeys(")) {
    console.log("skip  public/app.js (already applied)");
  } else {
    writeFileSync(path, source + JS_BLOCK);
    console.log("apply public/app.js: terminal key block");
  }
}

const CSS = [
  "/* 终端辅助按键（patches/0066）：手机没有 Ctrl/Tab/Esc/方向键，这一行就是它们的入口。",
  "   面板改成竖排 flex，宿主吃掉剩余高度，按键行固定在底部（贴着键盘）。 */",
  ".side-panel-terminal{display:flex;flex-direction:column;min-height:0;height:100%}",
  ".side-panel-terminal[hidden]{display:none}",
  ".terminal-keys{flex:none;display:flex;gap:5px;overflow-x:auto;padding:7px 8px calc(7px + env(safe-area-inset-bottom,0px));border-top:1px solid var(--app-border-default,var(--border));background:var(--app-panel,var(--surface))}",
  ".terminal-keys button{flex:none;min-height:32px;padding:0 10px;border:1px solid var(--app-border-default,var(--border-strong));border-radius:8px;background:transparent;color:var(--app-text);font:12px var(--mono)}",
  ".terminal-keys button:active{background:color-mix(in srgb,var(--app-text) 12%,transparent)}",
].join("\n");

{
  const path = resolve(appDir, "public/style.css");
  let css = readFileSync(path, "utf8");
  if (css.includes(".terminal-keys{")) {
    console.log("skip  public/style.css (already applied)");
  } else {
    writeFileSync(path, css + "\n" + CSS + "\n");
    console.log("apply public/style.css: terminal keys");
  }
}

edit("public/i18n.js", '"Terminal is not connected"', [
  ['  "Pruned": "已清理",\n', '  "Pruned": "已清理",\n  "Terminal is not connected": "终端还没连上",\n', "terminal key entry"],
]);

console.log("done — rebuild the bundle: cd app && bun build public/app.js --target=browser --outfile=public/app.bundle.js");
