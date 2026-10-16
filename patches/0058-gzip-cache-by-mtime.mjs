// Patch 0058 — 桥的 gzip 缓存必须按 mtime 失效，不能只看文件长度。
//
// 现场（2026-10-16，查 E119 的"改动没到浏览器"时挖出来的真凶）：
// 我改完前端、重建了 bundle，磁盘上是新代码，桥也确实每次请求都 `readFileSync` 读了新文件，
// **但它发出去的还是上一次构建的字节**：
//
//   $ curl -s --compressed http://127.0.0.1:8899/app.bundle.js | grep -o 'name.length <= 36'
//   name.length <= 36          ← 旧的
//   $ grep -c 'name.length <= 26' app/public/app.bundle.js
//   1                          ← 磁盘上是新的
//
// 两次构建**字节数完全相同**（只改了两个两位数字），于是那句
//     `if (!compressed || compressed.size !== body.length)`
// 永远判定"缓存还有效"，一直重放旧 gzip。（注释里写的是"按 (path, mtime, size) 缓存"，
// 但 mtime 从来没进过判断——注释比代码诚实。）
//
// 这也回头解释了 E86/E117 里那些"我怀疑你的更改根本没到浏览器端"：
// 不是浏览器缓存，是桥自己发的旧字节。改前端后看到的"没生效"，先查这里。
//
// 修法：缓存条目带上 mtimeMs，长度或 mtime 任一变化就重新压缩；
// 静态日志同时打印 `mt=<mtimeMs>`，以后"发的是哪一份文件"一眼可查。
//
// Usage: node patches/0058-gzip-cache-by-mtime.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const file = resolve(appDir, "server.ts");
let source = readFileSync(file, "utf8");

if (source.includes("mtimeMs: number")) {
  console.log("skip  server.ts (already applied)");
} else {
  const steps = [
    [
      "// path -> { size, buf } for gzipped static assets (see the static handler).\nconst gzipCache = new Map<string, { size: number; buf: Buffer }>();",
      "// path -> { size, mtimeMs, buf } for gzipped static assets (see the static handler).\n"
        + "// mtimeMs is load-bearing: two builds can have the exact same byte length (a rebuild that\n"
        + "// only touches two digits), and a size-only check then replays the previous build's bytes\n"
        + "// forever — which looks exactly like \"my change never reached the browser\" (E120).\n"
        + "const gzipCache = new Map<string, { size: number; mtimeMs: number; buf: Buffer }>();",
      "gzipCache type",
    ],
    [
      "  const uaTag = url.pathname === \"/\" || url.pathname === \"/app.bundle.js\" ? ` ua=${shortUa(req)}` : \"\";\n"
        + "  console.log(`[codex-webui] static ${url.pathname} ${body.length}B enc=${wantsGzip ? \"gzip\" : \"identity\"}${uaTag}`);",
      "  const fileMtimeMs = statSync(file).mtimeMs;\n"
        + "  const uaTag = url.pathname === \"/\" || url.pathname === \"/app.bundle.js\" ? ` ua=${shortUa(req)}` : \"\";\n"
        + "  // mt= is what makes \"did the browser get the file I just built?\" answerable without a rebuild:\n"
        + "  // compare it with `stat -c %Y app/public/app.bundle.js`.\n"
        + "  console.log(`[codex-webui] static ${url.pathname} ${body.length}B mt=${Math.round(fileMtimeMs)} enc=${wantsGzip ? \"gzip\" : \"identity\"}${uaTag}`);",
      "static log with mtime",
    ],
    [
      "  let compressed = gzipCache.get(file);\n  if (!compressed || compressed.size !== body.length) {\n    compressed = { size: body.length, buf: gzipSync(body) };",
      "  let compressed = gzipCache.get(file);\n"
        + "  if (!compressed || compressed.size !== body.length || compressed.mtimeMs !== fileMtimeMs) {\n"
        + "    compressed = { size: body.length, mtimeMs: fileMtimeMs, buf: gzipSync(body) };",
      "cache invalidation by mtime",
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
