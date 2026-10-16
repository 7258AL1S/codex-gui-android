// P6 的 Git 后端：把 git-service.js 真对着一个临时仓库跑一遍。
//
// 断言的是行为而不是"接口存在"：状态解析（暂存/未暂存/未跟踪 + 行数）、暂存/取消暂存、
// 提交、日志、分支、worktree 增删，以及几条**必须失败**的输入：仓库外的目录、非仓库、
// 越界路径、不存在的分支、未跟踪文件的丢弃。
//
//   node probe/git-service.test.mjs
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  gitStatus, gitStage, gitUnstage, gitDiscard, gitCommit, gitLog, gitBranches,
  gitCheckout, gitWorktreeAdd, gitWorktreeRemove, gitWorktrees, gitDispatch,
} from "../app/git-service.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : `  <- ${detail}`}`);
};
const throws = (label, run, pattern) => {
  try {
    run();
    failures += 1;
    console.log(`FAIL ${label}: no error thrown`);
  } catch (error) {
    const ok = !pattern || pattern.test(error.message);
    if (!ok) failures += 1;
    console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${error.message}`);
  }
};
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const scratch = mkdtempSync(join(tmpdir(), "codex-git-"));
const repo = join(scratch, "repo");
mkdirSync(repo);
git(repo, "init", "-q", "-b", "main");
git(repo, "config", "user.email", "probe@example.com");
git(repo, "config", "user.name", "Probe");
writeFileSync(join(repo, "readme.md"), "# hello\n");
git(repo, "add", "readme.md");
git(repo, "commit", "-qm", "initial commit");

const ROOTS = [scratch];

// --- 状态 -------------------------------------------------------------------
let status = gitStatus({ cwd: repo }, ROOTS);
check("识别仓库与分支", status.repo === repo && status.branch === "main", JSON.stringify({ repo: status.repo, branch: status.branch }));
check("干净仓库 clean=true", status.clean === true);

appendFileSync(join(repo, "readme.md"), "line two\n");
writeFileSync(join(repo, "new.txt"), "untracked\n");
writeFileSync(join(repo, "staged.txt"), "staged\n");
git(repo, "add", "staged.txt");
status = gitStatus({ cwd: repo }, ROOTS);
check("未暂存改动被识别（含行数）", status.unstaged.some((e) => e.path === "readme.md" && e.additions === 1), JSON.stringify(status.unstaged));
check("已暂存改动被识别", status.staged.some((e) => e.path === "staged.txt"), JSON.stringify(status.staged));
check("未跟踪文件被识别", status.untracked.includes("new.txt"), JSON.stringify(status.untracked));
check("clean=false", status.clean === false);

// --- 暂存 / 取消暂存 ---------------------------------------------------------
gitStage({ cwd: repo, paths: ["readme.md"] }, ROOTS);
status = gitStatus({ cwd: repo }, ROOTS);
check("暂存后进入 staged", status.staged.some((e) => e.path === "readme.md"));
gitUnstage({ cwd: repo, paths: ["readme.md"] }, ROOTS);
status = gitStatus({ cwd: repo }, ROOTS);
check("取消暂存后回到 unstaged", status.unstaged.some((e) => e.path === "readme.md") && !status.staged.some((e) => e.path === "readme.md"));

// --- 丢弃改动（只对已跟踪文件） -----------------------------------------------
gitDiscard({ cwd: repo, paths: ["readme.md"] }, ROOTS);
check("丢弃后文件内容回到 HEAD", readFileSync(join(repo, "readme.md"), "utf8") === "# hello\n");
throws("丢弃未跟踪文件被拒绝", () => gitDiscard({ cwd: repo, paths: ["new.txt"] }, ROOTS), /Untracked/);
throws("越界路径被拒绝", () => gitStage({ cwd: repo, paths: ["../outside.txt"] }, ROOTS), /escape/);
throws("绝对路径被拒绝", () => gitStage({ cwd: repo, paths: ["/etc/passwd"] }, ROOTS), /repository-relative/);

// --- 提交 / 日志 -------------------------------------------------------------
gitStage({ cwd: repo, paths: ["staged.txt"] }, ROOTS);
const commit = gitCommit({ cwd: repo, message: "add staged file" }, ROOTS);
check("提交成功并回报标题", /add staged file/.test(commit.summary), JSON.stringify(commit.summary));
throws("空提交信息被拒绝", () => gitCommit({ cwd: repo, message: "   " }, ROOTS), /required/);
const log = gitLog({ cwd: repo, limit: 5 }, ROOTS);
check("日志按时间倒序", log.commits.length === 2 && /add staged file/.test(log.commits[0].subject), JSON.stringify(log.commits.map((c) => c.subject)));

// --- 分支 --------------------------------------------------------------------
git(repo, "branch", "feature-x");
const branches = gitBranches({ cwd: repo }, ROOTS);
check("分支列表含 feature-x", branches.branches.some((b) => b.name === "feature-x"), JSON.stringify(branches.branches.map((b) => b.name)));
const checkout = gitCheckout({ cwd: repo, branch: "feature-x" }, ROOTS);
check("切换分支成功", checkout.branch === "feature-x" && gitStatus({ cwd: repo }, ROOTS).branch === "feature-x");
throws("不存在的分支被拒绝", () => gitCheckout({ cwd: repo, branch: "nope; rm -rf /" }, ROOTS), /Unknown branch/);
gitCheckout({ cwd: repo, branch: "main" }, ROOTS);

// --- worktree ----------------------------------------------------------------
const worktreePath = join(scratch, "wt-feature");
const created = gitWorktreeAdd({ cwd: repo, path: worktreePath, branch: "wt-branch", createBranch: true }, ROOTS);
check("worktree 创建成功", created.ok && readFileSync(join(worktreePath, "readme.md"), "utf8").includes("hello"));
check("worktree 出现在列表里且带分支名", gitWorktrees({ cwd: repo }, ROOTS).worktrees.some((w) => w.path === worktreePath && w.branch === "wt-branch"));
throws("worktree 路径越界被拒绝", () => gitWorktreeAdd({ cwd: repo, path: "/data/local/tmp/outside", branch: "x" }, ROOTS), /allowed roots/);
gitWorktreeRemove({ cwd: repo, paths: [], path: worktreePath }, ROOTS);
check("worktree 删除后列表里没有了", !gitWorktrees({ cwd: repo }, ROOTS).worktrees.some((w) => w.path === worktreePath));
throws("删除非 worktree 路径被拒绝", () => gitWorktreeRemove({ cwd: repo, path: repo }, ROOTS), /main worktree/);

// --- 边界 --------------------------------------------------------------------
throws("仓库外的目录被拒绝", () => gitStatus({ cwd: join(scratch, "..") }, ROOTS), /outside the allowed roots/);
const plainDir = join(scratch, "plain");
mkdirSync(plainDir);
throws("非 Git 目录给出明确原因", () => gitStatus({ cwd: plainDir }, ROOTS), /not inside a Git repository/);
throws("未知动作被拒绝", () => gitDispatch("rm-rf", { cwd: repo }, ROOTS), /Unsupported git action/);

// entry（仓库根的上级）也要能用：页面上的 cwd 可能是子目录
mkdirSync(join(repo, "src"));
writeFileSync(join(repo, "src", "a.js"), "x\n");
check("在子目录里也能解析出仓库根", gitStatus({ cwd: join(repo, "src") }, ROOTS).repo === repo);

rmSync(scratch, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
