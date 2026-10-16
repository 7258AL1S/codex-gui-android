// Patch 0060 — 桥开一个 Git 出口：`POST /api/git {action, cwd, …}` → app/git-service.js。
//
// app-server 协议里没有任何 Git 方法（`gitDiffToRemote` 只给 diff），所以暂存/提交/拉取/推送、
// 分支切换、worktree 这些是**本项目自己实现**的（FEATURES 第 4 节 B+C 类）。职责写在
// git-service.js 的文件头：只在允许的根目录内、argv 直传不走 shell、破坏性动作由前端确认。
//
// 动作白名单在 gitDispatch()；错误一律带 git 的原始 stderr 与真实命令回去，不编文案。
//
// Usage: node patches/0060-bridge-git-route.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const file = resolve(appDir, "server.ts");
let source = readFileSync(file, "utf8");

if (source.includes('"/api/git"')) {
  console.log("skip  server.ts (already applied)");
} else {
  const steps = [
    [
      'import { applyReviewPatch } from "./review-service.js";',
      'import { applyReviewPatch } from "./review-service.js";\n'
        + '// Git 没有协议方法：暂存/提交/拉取/推送/worktree 由桥调用 git 实现（见该文件头部的职责边界）。\n'
        + 'import { GitError, gitDispatch } from "./git-service.js";',
      "import git service",
    ],
    [
      '  if (url.pathname === "/api/review/patch") {',
      '  if (url.pathname === "/api/git") {\n'
        + '    if (req.method !== "POST") {\n'
        + '      res.writeHead(405, { "content-type": "application/json; charset=utf-8", allow: "POST" });\n'
        + '      res.end(JSON.stringify({ error: "Method not allowed" }));\n'
        + '      return;\n'
        + '    }\n'
        + '    let gitBody = "";\n'
        + '    req.setEncoding("utf8");\n'
        + '    req.on("data", (chunk) => {\n'
        + '      gitBody += chunk;\n'
        + '      if (gitBody.length > 5_000_000) req.destroy(new Error("Git payload too large"));\n'
        + '    });\n'
        + '    req.on("end", () => {\n'
        + '      // 同步执行：git 本身是短的，只有 pull/push 会慢（各自的 timeout 在 git-service 里）。\n'
        + '      // 这里放在事件循环上是有意的——改前端后"看不出来是哪一步卡住"比慢更难查。\n'
        + '      let status = 200;\n'
        + '      let payload: any;\n'
        + '      try {\n'
        + '        const body = JSON.parse(gitBody || "{}");\n'
        + '        const { action, ...rest } = body;\n'
        + '        payload = gitDispatch(String(action ?? ""), rest, browseRoots);\n'
        + '      } catch (error) {\n'
        + '        status = 400;\n'
        + '        const detail = error instanceof GitError ? { command: error.command, stderr: error.stderr } : {};\n'
        + '        payload = { error: error instanceof Error ? error.message : String(error), ...detail };\n'
        + '      }\n'
        + '      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });\n'
        + '      res.end(JSON.stringify(payload));\n'
        + '    });\n'
        + '    return;\n'
        + '  }\n'
        + '  if (url.pathname === "/api/review/patch") {',
      "git route",
    ],
  ];
  for (const [from, to, label] of steps) {
    const hits = source.split(from).length - 1;
    if (hits !== 1) throw new Error("cannot locate " + label + " exactly once (hits=" + hits + ")");
    source = source.replace(from, to);
    console.log("apply server.ts: " + label);
  }
  writeFileSync(file, source);
}

console.log("done — restart the bridge: ~/bin/codex-gui-web restart");
