// Git 面板的后端（P6）：app-server 协议里**没有** Git 方法，所以这部分是本项目自己实现的
// （FEATURES 第 4 节的 B+C 类），职责边界写在这里：
//
//   - 只在「允许的根目录」内、且确实是 Git 仓库的地方执行；
//   - 一律 argv 直传给 `git`，不经过 shell（用户输入永远进不了命令行解析）；
//   - 分支名、worktree 路径都要先对上**真实状态**（`for-each-ref` / `worktree list`）才动手；
//   - 失败时把 git 的原始 stderr 与真实命令一起带回去——不做"假装成功"，也不编造文案。
//
// 前端负责确认（丢弃改动、切换分支、删除 worktree 都要点确认），桥这一层不替用户做决定。
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve, sep } from "node:path";

const inside = (candidate, root) => candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
const MAX_BUFFER = 16 * 1024 * 1024;

export class GitError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = "GitError";
    this.command = detail.command || null;
    this.stderr = detail.stderr || "";
  }
}

function run(cwd, args, { timeoutMs = 20000, allowFailure = false } = {}) {
  const command = `git ${args.join(" ")}`;
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER,
    });
    return { ok: true, stdout: String(stdout), stderr: "", command };
  } catch (error) {
    const stderr = String(error?.stderr ?? "").trim();
    const stdout = String(error?.stdout ?? "");
    const detail = { command, stderr, exitCode: error?.status ?? null };
    if (allowFailure) return { ok: false, ...detail, stdout };
    throw new GitError(stderr || `${command} failed`, detail);
  }
}

function canonicalRoots(allowedRoots = []) {
  const roots = [];
  for (const root of allowedRoots) {
    try {
      const canonical = realpathSync(resolve(root));
      if (!roots.includes(canonical)) roots.push(canonical);
    } catch { /* 不可用的根目录直接忽略 */ }
  }
  return roots;
}

/** cwd → { cwd, root, name }；不在允许根内 / 不是仓库时给出明确原因。 */
export function resolveRepository(inputCwd, allowedRoots) {
  const roots = canonicalRoots(allowedRoots);
  if (!roots.length) throw new GitError("No Git roots are configured");
  const requested = resolve(inputCwd || roots[0]);
  if (!roots.some((root) => inside(requested, root))) throw new GitError("Workspace is outside the allowed roots");
  let cwd;
  try { cwd = realpathSync(requested); }
  catch { throw new GitError("Workspace directory not found"); }
  if (!statSync(cwd).isDirectory()) throw new GitError("Workspace is not a directory");
  const top = run(cwd, ["rev-parse", "--show-toplevel"], { allowFailure: true });
  if (!top.ok) throw new GitError("Workspace is not inside a Git repository", { command: top.command, stderr: top.stderr });
  const root = realpathSync(top.stdout.trim());
  if (!roots.some((allowed) => inside(root, allowed))) throw new GitError("Git repository is outside the allowed roots");
  return { cwd, root, name: basename(root) || root };
}

/** 只允许仓库内的相对路径，且不能让 git 把它当成选项。 */
function safeRelPath(value) {
  const path = String(value ?? "").trim();
  if (!path || path.length > 4096 || path.includes("\0")) throw new GitError("Invalid file path");
  if (isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path)) throw new GitError("Only repository-relative paths are supported");
  const parts = path.split(/[\\/]/);
  if (parts.some((part) => part === "..")) throw new GitError("Path may not escape the repository");
  return path;
}

function safeRelPaths(values) {
  const list = Array.isArray(values) ? values : [];
  if (!list.length) throw new GitError("No paths were provided");
  if (list.length > 500) throw new GitError("Too many paths in one request");
  return [...new Set(list.map(safeRelPath))];
}

function parseNumstat(output) {
  const stats = new Map();
  for (const record of String(output).split("\0")) {
    if (!record) continue;
    const first = record.indexOf("\t");
    const second = first < 0 ? -1 : record.indexOf("\t", first + 1);
    if (second < 0) continue;
    const added = record.slice(0, first);
    const deleted = record.slice(first + 1, second);
    const path = record.slice(second + 1);
    stats.set(path, {
      additions: added === "-" ? null : Number(added),
      deletions: deleted === "-" ? null : Number(deleted),
    });
  }
  return stats;
}

/** `git status --porcelain=v1 -z` 的条目解析（rename/copy 会多带一个原路径 token）。 */
function parsePorcelain(records) {
  const staged = [];
  const unstaged = [];
  const untracked = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const index1 = record[0];
    const index2 = record[1];
    let path = record.slice(3);
    if (index1 === "R" || index1 === "C" || index2 === "R" || index2 === "C") index += 1; // 原路径（界面用新路径）
    if (index1 === "?" && index2 === "?") { untracked.push(path); continue; }
    if (index1 !== " " && index1 !== "?") staged.push({ path, status: index1 });
    if (index2 !== " " && index2 !== "?") unstaged.push({ path, status: index2 });
  }
  return { staged, unstaged, untracked };
}

function operationInProgress(root) {
  const gitDir = resolve(root, ".git");
  if (!existsSync(gitDir)) return null;
  if (existsSync(resolve(gitDir, "MERGE_HEAD"))) return "merge";
  if (existsSync(resolve(gitDir, "rebase-merge")) || existsSync(resolve(gitDir, "rebase-apply"))) return "rebase";
  if (existsSync(resolve(gitDir, "CHERRY_PICK_HEAD"))) return "cherry-pick";
  if (existsSync(resolve(gitDir, "REVERT_HEAD"))) return "revert";
  return null;
}

export function worktreeList(root) {
  const result = run(root, ["worktree", "list", "--porcelain"]);
  const entries = [];
  let current = null;
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) { current = { path: line.slice(9).trim(), branch: null, detached: false, bare: false, locked: false }; entries.push(current); continue; }
    if (!current) continue;
    if (line.startsWith("branch ")) current.branch = line.slice(7).trim().replace(/^refs\/heads\//, "");
    else if (line === "detached") current.detached = true;
    else if (line === "bare") current.bare = true;
    else if (line.startsWith("locked")) current.locked = true;
  }
  return entries;
}

export function gitStatus({ cwd }, allowedRoots) {
  const repo = resolveRepository(cwd, allowedRoots);
  const head = run(repo.root, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFailure: true });
  const detached = !head.ok || head.stdout.trim() === "HEAD";
  const status = run(repo.root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const records = status.stdout.split("\0");
  const { staged, unstaged, untracked } = parsePorcelain(records);
  const stagedStats = parseNumstat(run(repo.root, ["diff", "--cached", "--numstat", "-z"], { allowFailure: true }).stdout);
  const unstagedStats = parseNumstat(run(repo.root, ["diff", "--numstat", "-z"], { allowFailure: true }).stdout);
  const upstream = run(repo.root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { allowFailure: true });
  const counts = upstream.ok
    ? run(repo.root, ["rev-list", "--left-right", "--count", `${upstream.stdout.trim()}...HEAD`], { allowFailure: true })
    : { ok: false, stdout: "" };
  const [behind, ahead] = counts.ok ? counts.stdout.trim().split(/\s+/).map(Number) : [null, null];
  const withStats = (entry, stats) => ({ ...entry, additions: stats.get(entry.path)?.additions ?? null, deletions: stats.get(entry.path)?.deletions ?? null });
  return {
    ok: true,
    repo: repo.root,
    name: repo.name,
    branch: detached ? null : head.stdout.trim(),
    detached,
    upstream: upstream.ok ? upstream.stdout.trim() : null,
    ahead: Number.isFinite(ahead) ? ahead : null,
    behind: Number.isFinite(behind) ? behind : null,
    staged: staged.map((entry) => withStats(entry, stagedStats)),
    unstaged: unstaged.map((entry) => withStats(entry, unstagedStats)),
    untracked,
    clean: !staged.length && !unstaged.length && !untracked.length,
    operation: operationInProgress(repo.root),
    worktrees: worktreeList(repo.root),
  };
}

export function gitStage({ cwd, paths }, allowedRoots) {
  const repo = resolveRepository(cwd, allowedRoots);
  const list = safeRelPaths(paths);
  run(repo.root, ["add", "--", ...list]);
  return { ok: true, staged: list };
}

export function gitUnstage({ cwd, paths }, allowedRoots) {
  const repo = resolveRepository(cwd, allowedRoots);
  const list = safeRelPaths(paths);
  // 还没有首个提交时 `restore --staged` 会失败（没有 HEAD 可比），退回 rm --cached。
  const result = run(repo.root, ["restore", "--staged", "--", ...list], { allowFailure: true });
  if (!result.ok) run(repo.root, ["rm", "--cached", "-r", "--", ...list]);
  return { ok: true, unstaged: list };
}

/** 丢弃工作区改动：只对**已跟踪**文件有意义，未跟踪文件走文件面板删除。 */
export function gitDiscard({ cwd, paths }, allowedRoots) {
  const repo = resolveRepository(cwd, allowedRoots);
  const list = safeRelPaths(paths);
  const status = gitStatus({ cwd: repo.root }, allowedRoots);
  const tracked = new Set([...status.staged.map((entry) => entry.path), ...status.unstaged.map((entry) => entry.path)]);
  const untracked = list.filter((path) => !tracked.has(path));
  if (untracked.length) throw new GitError(`Untracked files cannot be discarded with git: ${untracked.join(", ")}`);
  run(repo.root, ["restore", "--worktree", "--", ...list]);
  return { ok: true, discarded: list };
}

export function gitCommit({ cwd, message }, allowedRoots) {
  const repo = resolveRepository(cwd, allowedRoots);
  const text = String(message ?? "").trim();
  if (!text) throw new GitError("Commit message is required");
  if (text.length > 20000) throw new GitError("Commit message is too long");
  const result = run(repo.root, ["commit", "-m", text], { timeoutMs: 60000 });
  return { ok: true, summary: result.stdout.trim().split("\n")[0] || "Committed", output: result.stdout.trim() };
}

/** 拉取：默认只要快进（不制造意外的合并提交）。真实失败原因（网络/鉴权/分叉）原样带回。 */
export function gitPull({ cwd }, allowedRoots) {
  const repo = resolveRepository(cwd, allowedRoots);
  const result = run(repo.root, ["pull", "--ff-only"], { timeoutMs: 180000, allowFailure: true });
  if (!result.ok) throw new GitError(result.stderr || "git pull failed", { command: result.command, stderr: result.stderr });
  return { ok: true, output: result.stdout.trim() };
}

/**
 * 取回远端引用。**必须显式调用**：`ahead/behind` 是拿本地 remote-tracking ref 算的，
 * 不 fetch 就永远是上次的样子（这不是 bug，是 Git 的语义；面板打开时做一次尽力而为的 fetch，
 * 用户手动点 Fetch 时才把真实错误报出来）。
 */
export function gitFetch({ cwd }, allowedRoots) {
  const repo = resolveRepository(cwd, allowedRoots);
  const remotes = run(repo.root, ["remote"], { allowFailure: true });
  if (!remotes.ok || !remotes.stdout.trim()) throw new GitError("This repository has no remote");
  const result = run(repo.root, ["fetch", "--quiet", "--prune"], { timeoutMs: 180000, allowFailure: true });
  if (!result.ok) throw new GitError(result.stderr || "git fetch failed", { command: result.command, stderr: result.stderr });
  return { ok: true, remotes: remotes.stdout.split("\n").filter(Boolean) };
}

export function gitPush({ cwd }, allowedRoots) {
  const repo = resolveRepository(cwd, allowedRoots);
  const result = run(repo.root, ["push"], { timeoutMs: 180000, allowFailure: true });
  if (!result.ok) throw new GitError(result.stderr || "git push failed", { command: result.command, stderr: result.stderr });
  return { ok: true, output: result.stdout.trim() || result.stderr.trim() };
}

export function gitLog({ cwd, limit = 20 }, allowedRoots) {
  const repo = resolveRepository(cwd, allowedRoots);
  const count = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const result = run(repo.root, ["log", `-n${count}`, "--pretty=format:%H%x1f%h%x1f%ad%x1f%s", "--date=short"], { allowFailure: true });
  if (!result.ok) return { ok: true, root: repo.root, commits: [] }; // 还没有提交的仓库
  const commits = result.stdout.split("\n").filter(Boolean).map((line) => {
    const [sha, short, date, subject] = line.split("\u001f");
    return { sha, short, date, subject };
  });
  return { ok: true, root: repo.root, commits };
}

export function gitBranches({ cwd }, allowedRoots) {
  const repo = resolveRepository(cwd, allowedRoots);
  const result = run(repo.root, ["for-each-ref", "--format=%(refname:short)%1f%(objectname:short)%1f%(upstream:short)", "refs/heads"]);
  const branches = result.stdout.split("\n").filter(Boolean).map((line) => {
    const [name, short, upstream] = line.split("\u001f");
    return { name, short, upstream: upstream || null };
  });
  return { ok: true, branches };
}

export function gitCheckout({ cwd, branch }, allowedRoots) {
  const repo = resolveRepository(cwd, allowedRoots);
  const wanted = String(branch ?? "").trim();
  const { branches } = gitBranches({ cwd: repo.root }, allowedRoots);
  if (!branches.some((entry) => entry.name === wanted)) throw new GitError(`Unknown branch: ${wanted}`);
  const result = run(repo.root, ["checkout", wanted], { allowFailure: true });
  if (!result.ok) throw new GitError(result.stderr || `git checkout ${wanted} failed`, { command: result.command, stderr: result.stderr });
  return { ok: true, branch: wanted, output: result.stderr.trim() || result.stdout.trim() };
}

export function gitWorktreeAdd({ cwd, path, branch, createBranch = false, startPoint = "HEAD" }, allowedRoots) {
  const repo = resolveRepository(cwd, allowedRoots);
  const roots = canonicalRoots(allowedRoots);
  const raw = String(path ?? "").trim();
  if (!raw) throw new GitError("A path for the new worktree is required");
  const target = resolve(raw.startsWith("~") ? resolve(process.env.HOME || roots[0], raw.slice(2)) : raw);
  if (!roots.some((root) => inside(target, root))) throw new GitError("Worktree path must stay inside the allowed roots");
  if (existsSync(target) && !statSync(target).isDirectory()) throw new GitError("Worktree path exists and is not a directory");
  if (existsSync(target) && statSync(target).isDirectory()) {
    if (readdirSync(target).length) throw new GitError("Worktree path already exists and is not empty");
  }
  const name = String(branch ?? "").trim();
  const args = createBranch || !name
    ? ["worktree", "add", "-b", name || `worktree-${Date.now()}`, target, startPoint]
    : ["worktree", "add", target, name];
  const result = run(repo.root, args, { timeoutMs: 120000, allowFailure: true });
  if (!result.ok) throw new GitError(result.stderr || "git worktree add failed", { command: result.command, stderr: result.stderr });
  return { ok: true, path: target, branch: name || null, output: result.stdout.trim() || result.stderr.trim() };
}

export function gitWorktreeRemove({ cwd, path, force = false }, allowedRoots) {
  const repo = resolveRepository(cwd, allowedRoots);
  const raw = String(path ?? "").trim();
  if (!raw) throw new GitError("A worktree path is required");
  let target;
  try { target = realpathSync(resolve(raw)); }
  catch { throw new GitError("Worktree path not found"); }
  const known = worktreeList(repo.root);
  if (!known.some((entry) => entry.path === target)) throw new GitError("That path is not a worktree of this repository");
  if (target === repo.root) throw new GitError("The main worktree cannot be removed");
  const args = ["worktree", "remove", ...(force ? ["--force"] : []), target];
  const result = run(repo.root, args, { timeoutMs: 60000, allowFailure: true });
  if (!result.ok) throw new GitError(result.stderr || "git worktree remove failed", { command: result.command, stderr: result.stderr });
  return { ok: true, removed: target };
}

export function gitWorktreePrune({ cwd }, allowedRoots) {
  const repo = resolveRepository(cwd, allowedRoots);
  const result = run(repo.root, ["worktree", "prune"], { allowFailure: true });
  if (!result.ok) throw new GitError(result.stderr || "git worktree prune failed", { command: result.command, stderr: result.stderr });
  return { ok: true, output: result.stdout.trim() };
}

export function gitWorktrees({ cwd }, allowedRoots) {
  const repo = resolveRepository(cwd, allowedRoots);
  return { ok: true, repo: repo.root, worktrees: worktreeList(repo.root) };
}

/** 供路由使用：动作名 → 实现（保持白名单式，未知动作直接拒绝）。 */
export function gitDispatch(action, payload, allowedRoots) {
  switch (action) {
    case "status": return gitStatus(payload, allowedRoots);
    case "stage": return gitStage(payload, allowedRoots);
    case "unstage": return gitUnstage(payload, allowedRoots);
    case "discard": return gitDiscard(payload, allowedRoots);
    case "commit": return gitCommit(payload, allowedRoots);
    case "pull": return gitPull(payload, allowedRoots);
    case "push": return gitPush(payload, allowedRoots);
    case "fetch": return gitFetch(payload, allowedRoots);
    case "log": return gitLog(payload, allowedRoots);
    case "branches": return gitBranches(payload, allowedRoots);
    case "checkout": return gitCheckout(payload, allowedRoots);
    case "worktrees": return gitWorktrees(payload, allowedRoots);
    case "worktreeAdd": return gitWorktreeAdd(payload, allowedRoots);
    case "worktreeRemove": return gitWorktreeRemove(payload, allowedRoots);
    case "worktreePrune": return gitWorktreePrune(payload, allowedRoots);
    default: throw new GitError(`Unsupported git action: ${String(action)}`);
  }
}
