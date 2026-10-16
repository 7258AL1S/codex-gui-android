// P6 两项遗留的确定性测试（不依赖模型、不依赖真机）：
//   1. `startReview()` 对四种 `ReviewTarget` 变体发出的 RPC 载荷是否与协议一致
//      （proto-ts/v2/ReviewTarget.ts：uncommittedChanges / baseBranch / commit / custom）；
//   2. 行内定位的 `citationHtml()` 是否把 `memoryCitation.entries` 渲染成可点的芯片。
//
// 为什么要这么测：本机 provider **不返回** `memoryCitation`（实测 review 回合里是 null），
// 真机截不到那个芯片；而 target 的四种变体也不值得每种都花一个模型回合。这里把两段代码从
// app.js 里切出来直接跑（与 probe/user-attachment-chip.test.mjs 同一套办法）。
//
//   node probe/review-targets-citations.test.mjs
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(fileURLToPath(new URL("../app", import.meta.url)));
const source = readFileSync(resolve(appDir, "public/app.js"), "utf8");

function slice(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`cannot locate ${start}`);
  return source.slice(from, to);
}

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : `  <- ${detail}`}`);
};

const escapeHtml = (value = "") => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const t = (value) => value;
const shortPath = (path = "") => String(path).replace("/data/data/com.termux/files/home", "~");

// --- 1. startReview 的载荷 ----------------------------------------------------
const calls = [];
const sandbox = {
  state: { active: { id: "thread-1" } },
  rpc: async (method, params) => { calls.push({ method, params }); return { ok: true }; },
  toast: () => {},
  clientLog: () => {},
  closeReviewTarget: () => {},
  escapeHtml, t, shortPath,
  $: () => null,
};
const helpers = new Function(...Object.keys(sandbox), `
  ${slice("async function startReview(target){", "function closeReviewTarget(){")}
  return { startReview };
`)(...Object.values(sandbox));

const variants = [
  [{ type: "uncommittedChanges" }, undefined],
  [{ type: "baseBranch", branch: "main" }, undefined],
  [{ type: "commit", sha: "abc1234", title: "initial" }, undefined],
  [{ type: "custom", instructions: "看并发" }, undefined],
];
for (const [target] of variants) {
  calls.length = 0;
  await helpers.startReview(target);
  const call = calls[0];
  check(`review/start 的 target 形状：${target.type}`, call?.method === "review/start" && JSON.stringify(call.params.target) === JSON.stringify(target) && call.params.threadId === "thread-1", JSON.stringify(call));
}

// 没有活动会话时不发请求，只提示
calls.length = 0;
const messages = [];
const sandbox2 = { ...sandbox, state: { active: null }, toast: (message) => messages.push(message) };
const noThreadHelpers = new Function(...Object.keys(sandbox2), `
  ${slice("async function startReview(target){", "function closeReviewTarget(){")}
  return { startReview };
`)(...Object.values(sandbox2));
await noThreadHelpers.startReview({ type: "uncommittedChanges" });
check("没有活动会话时不发 RPC、只提示", calls.length === 0 && messages.length === 1, JSON.stringify(messages));

// --- 2. citationHtml ----------------------------------------------------------
const citationHtml = new Function("escapeHtml", "shortPath", `
  ${slice("function citationHtml(item){", "async function openCitation(")}
  return citationHtml;
`)(escapeHtml, shortPath);

const html = citationHtml({
  memoryCitation: {
    entries: [
      { path: "/data/data/com.termux/files/home/tmp/review-probe/calc.py", lineStart: 4, lineEnd: 5, note: "新加的 div()" },
      { path: "/data/data/com.termux/files/home/tmp/review-probe/README.md", lineStart: 1, lineEnd: 1, note: "" },
    ],
    threadIds: ["t1"],
  },
});
check("两条引用渲染成两个芯片", (html.split("data-citation-index=").length - 1) === 2, html.slice(0, 200));
check("芯片带行号范围", html.includes("calc.py :4-5"), html);
check("单行引用不显示范围", html.includes("README.md :1<"), html);
check("note 放进 title（悬浮可见）", html.includes('title="新加的 div()"'), html.slice(0, 260));
check("没有 citation 时什么都不渲染", citationHtml({ memoryCitation: null }) === "" && citationHtml({}) === "", JSON.stringify(citationHtml({})));
check("空 entries 也不渲染", citationHtml({ memoryCitation: { entries: [] } }) === "");

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
