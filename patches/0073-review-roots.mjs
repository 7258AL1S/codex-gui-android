// Patch 0073 — 撤销的允许根要与"用户真实工作区"一致，否则永远撤不了。
//
// 现场（真机）：手机上按撤销没有任何反应。直接打接口才看到真正的原因：
//     $ curl -X POST …/api/review/patch -d '{"threadId":"…","turnId":"…","action":"undo"}'
//     {"error":"outside allowed roots"}
// 因为 `reviewRoots` 只取了**一个**目录：
//     const reviewRoots = [resolve(configuredReviewRoot || defaultCwd)];
// 那是桥自己的默认工作目录（~/codex-gui/app 或 home），而用户实际的会话工作区可以
// 是任何项目目录 —— 于是"撤销"对绝大多数真实工作区都是拒绝。失败是**闭**的
// （不会乱改文件，这点没问题），但功能等于没有。
//
// 改成：显式配置的根 + 家目录（browseRoots）+ 文件面板的额外根。
// 这不是放宽授权：这些目录本来就是本项目会写文件的地方（文件面板保存、Git 操作、终端），
// 而 applyReviewPatch 自己仍然会做 git 仓库校验、路径校验、符号链接与 .env 拦截、`--check`。
//
// Usage: node patches/0073-review-roots.mjs [appDir]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(process.argv[2] ?? new URL("../app", import.meta.url).pathname);
const file = resolve(appDir, "server.ts");
let source = readFileSync(file, "utf8");

if (source.includes("configuredReviewRoot || defaultCwd), ...browseRoots")) {
  console.log("skip  server.ts (already applied)");
} else {
  const from = "const reviewRoots = [resolve(configuredReviewRoot || defaultCwd)];";
  const to = "// 撤销会写文件，所以允许根必须覆盖「用户真实的工作区」——只取 defaultCwd 会让\n"
    + "// 绝大多数项目的撤销以 `outside allowed roots` 失败（真机撞上，见 E122）。\n"
    + "const reviewRoots = [...new Set([resolve(configuredReviewRoot || defaultCwd), ...browseRoots, ...extraFileRoots])];";
  const hits = source.split(from).length - 1;
  if (hits !== 1) throw new Error("cannot locate reviewRoots exactly once (hits=" + hits + ")");
  writeFileSync(file, source.replace(from, to));
  console.log("apply server.ts: review roots cover the real workspaces");
}

console.log("done — restart the bridge: ~/bin/codex-gui-web restart");
