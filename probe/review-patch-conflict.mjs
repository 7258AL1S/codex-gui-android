// P6：撤销文件改动必须**保护用户后来的修改**（用户硬性要求，E12 的背景）。
//
// 撤销走的是桥里的 `applyReviewPatch`（`/api/review/patch` 的后端）：把那一轮的 unified diff
// 反向 `git apply`。这个探针在临时仓库里把三种情形钉住：
//   1. 干净撤销：diff 反着应用成功，文件回到改动前的样子；
//   2. 再应用（reapply）：又回到改动后的样子；
//   3. **冲突**：撤销之前用户又改了这个文件 → 必须拒绝，且**不能动**用户的新内容；
//   4. 危险/越界：碰 .env、绝对路径、符号链接、仓库外目录 → 一律拒绝。
//
//   node probe/review-patch-conflict.mjs
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { applyReviewPatch } from "../app/review-service.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : `  <- ${detail}`}`);
};
const rejects = async (label, run, pattern) => {
  try {
    await run();
    failures += 1;
    console.log(`FAIL ${label}: no error thrown`);
  } catch (error) {
    const ok = !pattern || pattern.test(error.message);
    if (!ok) failures += 1;
    console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${error.message}`);
  }
};
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const scratch = mkdtempSync(join(tmpdir(), "codex-review-"));
const repo = join(scratch, "repo");
mkdirSync(repo);
git(repo, "init", "-q", "-b", "main");
git(repo, "config", "user.email", "probe@example.com");
git(repo, "config", "user.name", "Probe");
writeFileSync(join(repo, "app.txt"), "line one\n");
git(repo, "add", "app.txt");
git(repo, "commit", "-qm", "initial");

// 造出"Codex 改了什么"的 diff：新增一行。
const patched = "line one\nline two added by codex\n";
writeFileSync(join(repo, "app.txt"), patched);
const diff = git(repo, "diff", "--", "app.txt");
git(repo, "checkout", "--", "app.txt");

const ROOTS = [scratch];

try {
  // 磁盘上还没有这个改动时，反向应用必须先被 `--check` 拦下（保护的第一层）。
  await rejects("反向应用一个并不存在的改动会被拒绝", () => applyReviewPatch({ cwd: repo, diff, action: "undo" }, ROOTS), /does not apply|patch failed|error/i);
  check("被拒绝后文件没有被改动", readFileSync(join(repo, "app.txt"), "utf8") === "line one\n");
  await applyReviewPatch({ cwd: repo, diff, action: "reapply" }, ROOTS);
  check("reapply 后文件是改动后的内容", readFileSync(join(repo, "app.txt"), "utf8") === patched, JSON.stringify(readFileSync(join(repo, "app.txt"), "utf8")));
  await applyReviewPatch({ cwd: repo, diff, action: "undo" }, ROOTS);
  check("undo 后文件回到改动前", readFileSync(join(repo, "app.txt"), "utf8") === "line one\n");

  // 冲突：应用改动之后，用户又自己改了这个文件 → 撤销必须拒绝，且保留用户的内容。
  await applyReviewPatch({ cwd: repo, diff, action: "reapply" }, ROOTS);
  writeFileSync(join(repo, "app.txt"), "line one\nline two added by codex\n用户后来又加了一行\n");
  await rejects("用户改动之后 undo 被拒绝（保护后续修改）", () => applyReviewPatch({ cwd: repo, diff, action: "undo" }, ROOTS), /patch|apply|conflict|does not apply/i);
  check("拒绝之后用户的内容原样保留", readFileSync(join(repo, "app.txt"), "utf8").includes("用户后来又加了一行"));

  // 越界与敏感路径
  await rejects("仓库之外的 cwd 被拒绝", () => applyReviewPatch({ cwd: "/data/local/tmp", diff, action: "undo" }, ROOTS), /outside allowed roots|not inside a Git repository/i);
  await rejects("碰到 .env 的 diff 被拒绝", () => applyReviewPatch({
    cwd: repo,
    action: "undo",
    diff: "diff --git a/.env b/.env\n--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-A=1\n+A=2\n",
  }, ROOTS), /protected or sensitive path/);
  await rejects("绝对路径的 diff 被拒绝", () => applyReviewPatch({
    cwd: repo,
    action: "undo",
    diff: "diff --git a//etc/passwd b//etc/passwd\n--- a//etc/passwd\n+++ b//etc/passwd\n@@ -1 +1 @@\n-a\n+b\n",
  }, ROOTS), /unsafe path|protected/);
  const link = join(repo, "link.txt");
  symlinkSync(join(repo, "app.txt"), link);
  await rejects("经由符号链接改文件的 diff 被拒绝", () => applyReviewPatch({
    cwd: repo,
    action: "undo",
    diff: "diff --git a/link.txt b/link.txt\n--- a/link.txt\n+++ b/link.txt\n@@ -1 +1 @@\n-line one\n+changed\n",
  }, ROOTS), /symbolic link|unsafe|protected/);
  await rejects("不支持的 action 被拒绝", () => applyReviewPatch({ cwd: repo, diff, action: "delete-everything" }, ROOTS), /Unsupported review action/);
  check("越界 diff 没有被写进文件", !readFileSync(join(repo, "app.txt"), "utf8").includes("changed"));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
