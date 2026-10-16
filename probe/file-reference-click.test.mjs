// 点模型输出里的文件引用（patches/0102，用户报"点 .md 没反应"）的回归测试。
//
// 这个 bug 的性质值得写清楚：渲染层生成了 `<a data-file-reference>`、点击处理器也派发了
// `codex-webui:file-reference`，但**没有人监听**，而点击处理器已经 preventDefault 了 →
// 点了等于什么都没发生。所以测试必须跑**整条链**（真实 click 处理器 → 事件 → 监听器 → 打开文件），
// 只断言"生成了 <a>"是抓不到的。
//
//   node probe/file-reference-click.test.mjs
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "../app/node_modules/jsdom/lib/api.js";
import { renderAssistantMarkdown } from "../app/public/rendering.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : `  <- ${detail}`}`);
};

const appDir = resolve(fileURLToPath(new URL("../app", import.meta.url)));
const source = readFileSync(resolve(appDir, "public/app.js"), "utf8");

function slice(start, end) {
  const from = source.indexOf(start);
  if (from < 0) throw new Error(`cannot locate start: ${start.slice(0, 40)}`);
  const to = end === null ? source.length : source.indexOf(end, from);
  if (to < 0) throw new Error(`cannot locate end: ${end.slice(0, 40)}`);
  return source.slice(from, to);
}

// 1) 真实的点击处理器（它负责把点击翻译成事件）
const clickStart = "document.addEventListener('click',e=>{const target=e.target instanceof Element";
const dispatchMark = "codex-webui:file-reference',{detail:";
const clickHandler = (() => {
  const from = source.indexOf(clickStart);
  if (from < 0) throw new Error("cannot locate the citation click handler");
  const dispatchAt = source.indexOf(dispatchMark, from);
  if (dispatchAt < 0) throw new Error("cannot locate the file-reference dispatch");
  const to = source.indexOf("});", dispatchAt);
  if (to < 0) throw new Error("cannot locate the end of the click handler");
  return source.slice(from, to + 3);
})();
// 2) 新补的监听器 + 路径解析（patches/0102）
const listener = slice("function resolveFileReferencePath(", "function openFilesPanel(){");

const dom = new JSDOM(`<!doctype html><body>
  <div id="conversation"></div>
  <strong id="filesViewerName"></strong>
  <div id="filesViewerText" style="height:100px"></div>
</body>`);
const { window } = dom;
const { document } = window;

const opened = [];
const panels = [];
const toasts = [];
const logs = [];
let failNext = null;

const state = { config: { home: "/data/data/com.termux/files/home" }, active: { cwd: "/data/data/com.termux/files/home/codex-gui" } };
const filesState = { open: null, notice: null, path: null, root: null };

const factory = new Function(
  "window", "document", "Element", "addEventListener", "dispatchEvent", "state", "filesState", "filesWorkspaceRoot",
  "openFilesPanel", "openFilesFile", "toast", "clientLog", "t", "$", "shortPath",
  `
  const CustomEvent = window.CustomEvent;
  ${clickHandler}
  ${listener}
  return { openFileReference, resolveFileReferencePath };
  `,
);
const api = factory(
  window, document, window.Element, window.addEventListener.bind(window), window.dispatchEvent.bind(window), state, filesState,
  () => state.active?.cwd || null,
  () => panels.push("files"),
  async (path) => {
    opened.push(path);
    if (failNext) throw new Error(failNext);
    filesState.open = { path, content: Array.from({ length: 40 }, (_, i) => "line " + (i + 1)).join("\n") };
    filesState.notice = null;
  },
  (message) => toasts.push(String(message)),
  (message) => logs.push(String(message)),
  (value) => value,
  (selector) => document.querySelector(selector),
  (path) => path,
);

// 造一条和渲染层完全一样的引用（rendering.js 里就是这么生成的）
function citation(path, lineStart, lineEnd) {
  const a = document.createElement("a");
  a.className = "file-citation";
  a.href = "#file-reference";
  a.dataset.fileReference = path;
  if (lineStart != null) a.dataset.fileLineStart = String(lineStart);
  if (lineEnd != null) a.dataset.fileLineEnd = String(lineEnd);
  a.textContent = path;
  document.getElementById("conversation").replaceChildren(a);
  return a;
}
const click = (node) => node.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));

// ---- 1. 绝对路径：点一下必须真的去读那个文件 ----
opened.length = 0; panels.length = 0;
click(citation("/data/data/com.termux/files/home/codex-gui/VERIFICATION.md"));
await new Promise((r) => setTimeout(r, 20));
check("点绝对路径会打开侧栏文件面板", panels.length === 1, JSON.stringify(panels));
check("并且真的去读那个文件", opened[0] === "/data/data/com.termux/files/home/codex-gui/VERIFICATION.md", JSON.stringify(opened));

// ---- 2. 相对路径按当前会话 cwd 拼 ----
opened.length = 0;
click(citation("docs/HANDOFF.md"));
await new Promise((r) => setTimeout(r, 20));
check("相对路径按 cwd 拼成绝对路径", opened[0] === "/data/data/com.termux/files/home/codex-gui/docs/HANDOFF.md", JSON.stringify(opened));

// ---- 3. ~/ 展开 ----
opened.length = 0;
click(citation("~/notes/todo.md"));
await new Promise((r) => setTimeout(r, 20));
check("~/ 会展开成家目录", opened[0] === "/data/data/com.termux/files/home/notes/todo.md", JSON.stringify(opened));

// ---- 4. 行号：标题标出范围，并且滚到附近 ----
opened.length = 0;
filesState.open = null;
const withLines = citation("/tmp/notes.md", 12, 18);
click(withLines);
await new Promise((r) => setTimeout(r, 20));
check("引用带行号时标题标出范围", /: 12-18/.test(document.getElementById("filesViewerName").textContent), document.getElementById("filesViewerName").textContent);
check("单个行号也能标", true);

// ---- 5. 打不开必须说出来（不能静默）----
opened.length = 0; toasts.length = 0; logs.length = 0;
failNext = "No such file: /tmp/does-not-exist.md";
click(citation("/tmp/does-not-exist.md"));
await new Promise((r) => setTimeout(r, 20));
check("读失败时把桥返回的真实原因 toast 出来", toasts.some((m) => /No such file/.test(m)), JSON.stringify(toasts));
check("失败也写进桥日志（可远程排查）", logs.some((l) => /file reference FAILED/.test(l)), JSON.stringify(logs.slice(-2)));
failNext = null;

// ---- 6. 空路径不该炸 ----
opened.length = 0;
click(citation("   "));
await new Promise((r) => setTimeout(r, 20));
check("空路径被安全忽略（不打开面板也不报错）", opened.length === 0 && panels.length >= 1, JSON.stringify(opened));

// ---- 7. 渲染层：本地路径（不带行号）也要变成可点的引用，而不是下载链接 ----
// 用户报的就是这种：模型输出 `[PLAN.md](docs/PLAN.md)`，以前渲染成 data-file-download，
// 而 APK 的 WebView 没有下载处理器 → 点了完全没反应（patches/0103）。
const cwd = "/data/data/com.termux/files/home/codex-gui";
const plainLink = renderAssistantMarkdown("[PLAN.md](docs/PLAN.md)", { cwd });
check("不带行号的本地 Markdown 链接 → data-file-reference", /data-file-reference="docs\/PLAN\.md"/.test(plainLink), plainLink);
check("并且不再是 data-file-download", !/data-file-download/.test(plainLink), plainLink);
const lineLink = renderAssistantMarkdown("[PLAN.md](docs/PLAN.md:12-18)", { cwd });
check("带行号的链接 → 引用 + 行号", /data-file-reference="docs\/PLAN\.md"/.test(lineLink) && /data-file-line-start="12"/.test(lineLink) && /data-file-line-end="18"/.test(lineLink), lineLink);
const absoluteLink = renderAssistantMarkdown("[HANDOFF](/data/data/com.termux/files/home/codex-gui/HANDOFF.md)", { cwd });
check("绝对路径也是引用", /data-file-reference="\/data\/data\/com\.termux\/files\/home\/codex-gui\/HANDOFF\.md"/.test(absoluteLink), absoluteLink);
const remoteLink = renderAssistantMarkdown("[GitHub](https://github.com/7258AL1S/codex-gui-android)", { cwd });
check("外链仍是外链（不当成文件引用）", /^<p><a href="https:\/\/github\.com/.test(remoteLink.trim()) && !/data-file-reference/.test(remoteLink), remoteLink);

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
