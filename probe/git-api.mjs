// P6：从页面这一侧（HTTP）把 Git 出口走一遍——`POST /api/git {action,cwd,…}`。
//
// 真仓库、真远端（本地 bare 仓库当 origin，避免联网），所以暂存/提交/push/pull/worktree
// 都是真发生过的，不是接口形状检查。测试仓库建在 ~/tmp 下（桥只允许 home 内的路径），
// 用完删掉。
//
//   node probe/git-api.mjs
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const PORT = process.env.CODEX_GUI_PORT ?? "8899";
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : `  <- ${detail}`}`);
};
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

async function api(action, payload = {}) {
  const response = await fetch(`http://127.0.0.1:${PORT}/api/git`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, cwd: payload.cwd ?? repo, ...payload }),
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

// 必须在 home 里：桥的允许根是 home（browseRoots）。
const scratch = mkdtempSync(join(homedir(), "tmp", "git-api-"));
const origin = join(scratch, "origin.git");
const repo = join(scratch, "work");
mkdirSync(repo);
git(scratch, "init", "-q", "--bare", origin);
git(repo, "clone", "-q", "--no-hardlinks", origin, ".");
git(repo, "config", "user.email", "api@example.com");
git(repo, "config", "user.name", "API");
writeFileSync(join(repo, "file.txt"), "one\n");
git(repo, "add", "file.txt");
git(repo, "commit", "-qm", "first");
git(repo, "push", "-q", "-u", "origin", "HEAD");

try {
  writeFileSync(join(repo, "file.txt"), "one\ntwo\n");
  writeFileSync(join(repo, "fresh.txt"), "new\n");

  const status = await api("status");
  check("status 200 且能识别仓库", status.status === 200 && status.data.repo === repo, JSON.stringify(status.data).slice(0, 200));
  check("未暂存改动带行数", status.data.unstaged.some((e) => e.path === "file.txt" && e.additions === 1));
  check("未跟踪文件列出", status.data.untracked.includes("fresh.txt"));
  check("分支与上游", status.data.upstream === "origin/master" || status.data.upstream === "origin/main", String(status.data.upstream));

  const staged = await api("stage", { paths: ["fresh.txt", "file.txt"] });
  check("暂存成功", staged.status === 200 && staged.data.ok === true, JSON.stringify(staged.data));
  const afterStage = await api("status");
  check("暂存后两文件都在 staged", afterStage.data.staged.length === 2 && afterStage.data.unstaged.length === 0, JSON.stringify(afterStage.data.staged));

  const committed = await api("commit", { message: "api commit" });
  check("提交成功", committed.status === 200 && /api commit/.test(committed.data.summary || ""), JSON.stringify(committed.data));
  const afterCommit = await api("status");
  check("提交后工作区干净", afterCommit.data.clean === true, JSON.stringify({ staged: afterCommit.data.staged, unstaged: afterCommit.data.unstaged, untracked: afterCommit.data.untracked }));
  check("提交后 ahead=1", afterCommit.data.ahead === 1, String(afterCommit.data.ahead));

  const pushed = await api("push");
  check("push 到本地远端成功", pushed.status === 200 && pushed.data.ok === true, JSON.stringify(pushed.data));
  const afterPush = await api("status");
  check("push 后 ahead=0", afterPush.data.ahead === 0, String(afterPush.data.ahead));

  // 远端多一个提交 → pull 应当快进；再往前落后就由 --ff-only 保护。
  const other = join(scratch, "other");
  git(scratch, "clone", "-q", "--no-hardlinks", origin, other);
  git(other, "config", "user.email", "other@example.com");
  git(other, "config", "user.name", "Other");
  writeFileSync(join(other, "remote.txt"), "from remote\n");
  git(other, "add", "remote.txt");
  git(other, "commit", "-qm", "remote commit");
  git(other, "push", "-q");
  // ahead/behind 是拿本地 remote-tracking ref 算的：不 fetch 就还是旧值（Git 的语义）。
  const stale = await api("status");
  check("未 fetch 时 behind 仍是旧值（0）——这正是为什么要 Fetch", stale.data.behind === 0, String(stale.data.behind));
  const fetched = await api("fetch");
  check("fetch 成功", fetched.status === 200 && fetched.data.ok === true, JSON.stringify(fetched.data));
  const behind = await api("status");
  check("fetch 后 behind=1", behind.data.behind === 1, String(behind.data.behind));
  const pulled = await api("pull");
  check("pull 快进成功", pulled.status === 200 && pulled.data.ok === true, JSON.stringify(pulled.data));
  check("pull 之后文件真的到了", existsSync(join(repo, "remote.txt")));

  // worktree：创建 → 列表 → 删除
  const worktreePath = join(scratch, "wt");
  const created = await api("worktreeAdd", { path: worktreePath, branch: "demo-wt", createBranch: true });
  check("worktree 创建成功", created.status === 200 && existsSync(join(worktreePath, "file.txt")), JSON.stringify(created.data));
  const listed = await api("status");
  check("worktree 出现在 status 里", (listed.data.worktrees || []).some((w) => w.path === worktreePath && w.branch === "demo-wt"), JSON.stringify(listed.data.worktrees));
  const removed = await api("worktreeRemove", { path: worktreePath });
  check("worktree 删除成功", removed.status === 200 && !existsSync(worktreePath), JSON.stringify(removed.data));

  // 错误路径：必须是"明确失败"，而不是静默成功
  const outside = await api("status", { cwd: "/data/local/tmp" });
  check("home 外的路径被拒绝", outside.status === 400 && /outside the allowed roots/.test(outside.data.error || ""), JSON.stringify(outside.data).slice(0, 160));
  const notRepo = await api("status", { cwd: join(homedir(), ".codex") });
  check("非仓库给出明确原因", notRepo.status === 400 && /not inside a Git repository/.test(notRepo.data.error || ""), String(notRepo.data.error));
  const unknown = await api("rm-rf");
  check("未知动作被拒绝", unknown.status === 400 && /Unsupported git action/.test(unknown.data.error || ""), String(unknown.data.error));
  writeFileSync(join(repo, "loose.txt"), "loose\n");
  const discardUntracked = await api("discard", { paths: ["loose.txt"] });
  check("丢弃未跟踪文件被拒绝", discardUntracked.status === 400 && /Untracked/.test(discardUntracked.data.error || ""), String(discardUntracked.data.error));
  const emptyCommit = await api("commit", { message: "  " });
  check("空提交信息被拒绝", emptyCommit.status === 400, String(emptyCommit.data.error));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
