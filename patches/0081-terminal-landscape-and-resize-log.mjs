// Patch 0081 — 横屏终端：键盘弹出时别把终端挤成一条缝；顺带记一行 resize 日志。
//
// 真机实测（P6 那次"终端旋转未测"的补课）：
//   - 横屏不带键盘：面板正常，按键条（Esc/Tab/Ctrl+C/…）完整可用 —— `~/shots/rot-4.png`
//   - 横屏**带键盘**：输入法吃掉大部分高度，终端内容区被压到接近 0，什么都看不见 —— `~/shots/rot-3.png`
//     （PTY 那边其实收到了 75x11，问题纯在布局）
//
// 修法（只动布局，不动终端本身）：
//   1. 横屏给终端宿主一个最小高度（约 7 行），面板改为可滚动——内容比屏幕高就滚，别再压成 0；
//   2. 横屏把按键条挪到宿主**上面**（`order:-1`）并压扁：键盘弹起时它仍然看得见、点得到；
//   3. 顺带把终端 resize 打进日志（旋转/键盘弹出都会触发），以后"尺寸到底变没变"直接看日志。
//
// Usage: node patches/0081-terminal-landscape-and-resize-log.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);

// --- 前端：横屏布局 -----------------------------------------------------------
{
  const path = resolve(appDir, "public/style.css");
  let css = readFileSync(path, "utf8");
  if (css.includes("/* 横屏终端")) {
    console.log("skip  public/style.css (already applied)");
  } else {
    css += [
      "",
      "/* 横屏终端（patches/0081）：横屏 + 键盘时可用高度只剩几十像素，会把终端压成一条缝。",
      "   给宿主一个最小高度、让面板滚动，按键条挪到上面并压扁——看得见输出，也点得到 Ctrl+C。 */",
      "@media (orientation: landscape){",
      "  .side-panel-terminal{overflow:auto}",
      "  .side-panel-terminal .terminal-keys{order:-1;padding:4px 8px;gap:4px}",
      "  .side-panel-terminal .terminal-keys button{min-height:28px;padding:0 8px;font-size:11px}",
      "  .side-panel-terminal .side-terminal-host{min-height:7.5rem;height:auto}",
      "}",
      "",
    ].join("\n");
    writeFileSync(path, css);
    console.log("apply public/style.css: landscape terminal");
  }
}

// --- 桥：resize 日志 ----------------------------------------------------------
{
  const path = resolve(appDir, "server.ts");
  let source = readFileSync(path, "utf8");
  if (source.includes("terminal resize ->")) {
    console.log("skip  server.ts (already applied)");
  } else {
    const from = "      const resize = normalizeTerminalResize(JSON.parse(String(raw)));\n      if (resize) terminal.resize(resize.cols, resize.rows);";
    const to = "      const resize = normalizeTerminalResize(JSON.parse(String(raw)));\n"
      + "      if (resize) {\n"
      + "        // 旋转/键盘弹出都会走这里：出问题时「尺寸到底变没变」要能直接看到（P6 旋转验收）。\n"
      + "        console.log(`[codex-webui] terminal resize -> ${resize.cols}x${resize.rows}`);\n"
      + "        terminal.resize(resize.cols, resize.rows);\n"
      + "      }";
    const hits = source.split(from).length - 1;
    if (hits !== 1) throw new Error("cannot locate the terminal resize branch exactly once (hits=" + hits + ")");
    writeFileSync(path, source.replace(from, to));
    console.log("apply server.ts: terminal resize log");
  }
}

console.log("done — rebuild the bundle: cd app && bun build public/app.js --target=browser --outfile=public/app.bundle.js");
