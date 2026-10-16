// P6：后端给的 fileChange（add 是内容、update 是无头 diff 主体）必须能变成**能被 git apply 的**补丁。
//
// 这三个形状都是从真 app-server 读回来的原样数据（见 VERIFICATION E122）：
//   add     {"path":"…/mobile-probe.txt","kind":{"type":"add"},"diff":"hello\n"}
//   update  {"path":"…","kind":{"type":"update","move_path":null},"diff":"@@ -1 +1,2 @@\n hello\n+world\n"}
//
// 断言：合成出的 diff 在临时仓库里 `git apply --check` 通过、真应用后文件内容正确、
// 反向应用能还原；前端 `parseUnifiedDiff` 也能数出增删行（否则审阅面板是空的）。
//
//   node probe/file-change-diff.test.mjs
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parseUnifiedDiff, unifiedDiffFromFileChanges } from "../app/public/codex-surfaces.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : `  <- ${detail}`}`);
};
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const applyCheck = (cwd, diff) => {
  try {
    execFileSync("git", ["apply", "--check", "-"], { cwd, input: diff, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch (error) {
    return String(error.stderr || error.message).trim().split("\n")[0];
  }
};

const scratch = mkdtempSync(join(tmpdir(), "codex-filediff-"));
git(scratch, "init", "-q", "-b", "main");
git(scratch, "config", "user.email", "probe@example.com");
git(scratch, "config", "user.name", "Probe");
writeFileSync(join(scratch, "existing.txt"), "hello\n");
git(scratch, "add", "existing.txt");
git(scratch, "commit", "-qm", "initial");

try {
  // 1) add：后端只给内容
  const addDiff = unifiedDiffFromFileChanges([{ path: "brand.txt", kind: { type: "add" }, diff: "hello\n" }]);
  check("add 合成出 new file mode", /new file mode 100644/.test(addDiff), addDiff.slice(0, 80));
  check("add 合成出 @@ -0,0 +1,1 @@", /@@ -0,0 \+1,1 @@/.test(addDiff), addDiff);
  check("add 的每一行都带 +", /\+hello/.test(addDiff));
  const addCheck = applyCheck(scratch, addDiff);
  check("add 的补丁 git apply --check 通过", addCheck === true, String(addCheck));
  execFileSync("git", ["apply", "-"], { cwd: scratch, input: addDiff, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  check("add 真应用后文件内容正确", readFileSync(join(scratch, "brand.txt"), "utf8") === "hello\n");
  execFileSync("git", ["apply", "--reverse", "-"], { cwd: scratch, input: addDiff, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  check("add 反向应用后文件被删掉", (() => { try { readFileSync(join(scratch, "brand.txt")); return false; } catch { return true; } })());
  const addReview = parseUnifiedDiff(addDiff);
  check("前端能解析 add（+1 行）", addReview.hasChanges && addReview.linesAdded === 1 && addReview.fileCount === 1, JSON.stringify({ added: addReview.linesAdded, files: addReview.fileCount }));

  // 2) update：后端给的是无头部的 diff 主体
  const updateDiff = unifiedDiffFromFileChanges([{ path: "existing.txt", kind: { type: "update", move_path: null }, diff: "@@ -1 +1,2 @@\n hello\n+world\n" }]);
  check("update 补上了 --- / +++ 头", /--- a\/existing\.txt/.test(updateDiff) && /\+\+\+ b\/existing\.txt/.test(updateDiff), updateDiff);
  const updateCheck = applyCheck(scratch, updateDiff);
  check("update 的补丁 git apply --check 通过", updateCheck === true, String(updateCheck));
  execFileSync("git", ["apply", "-"], { cwd: scratch, input: updateDiff, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  check("update 应用后多了一行", readFileSync(join(scratch, "existing.txt"), "utf8") === "hello\nworld\n");
  check("前端能解析 update（+1 行）", parseUnifiedDiff(updateDiff).linesAdded === 1);

  // 3) delete：后端同样只给内容
  const deleteDiff = unifiedDiffFromFileChanges([{ path: "existing.txt", kind: { type: "delete" }, diff: "hello\nworld\n" }]);
  const deleteCheck = applyCheck(scratch, deleteDiff);
  check("delete 的补丁 git apply --check 通过", deleteCheck === true, String(deleteCheck));
  execFileSync("git", ["apply", "-"], { cwd: scratch, input: deleteDiff, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  check("delete 应用后文件不存在", (() => { try { readFileSync(join(scratch, "existing.txt")); return false; } catch { return true; } })());

  // 4) 已经带完整头部的补丁原样透传（有的后端就是这么给的）
  const fullDiff = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";
  check("完整补丁原样透传", unifiedDiffFromFileChanges([{ path: "x", kind: { type: "update" }, diff: fullDiff }]).includes("--- a/x"));
  check("空 diff 不产出垃圾补丁", unifiedDiffFromFileChanges([{ path: "x", kind: { type: "update" }, diff: "" }]) === "");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
