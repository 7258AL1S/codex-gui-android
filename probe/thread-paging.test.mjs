// 打开长会话要分页渲染（patches/0104，用户报"一直在 loading conversation"）。
//
// 背景：那条会话 `thread/read` 返回 **13.4 MB / 143 轮 / 893 条消息**，而 `openThread()`
// 原来把全部轮次一次性 renderTurn —— 手机 WebView 上就是几十秒的 "Loading conversation…"。
// 代码里本来就有 `renderThread()`（每页 20 轮 + "Load earlier messages"），只是没被 openThread 用上。
//
//   node probe/thread-paging.test.mjs
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "../app/node_modules/jsdom/lib/api.js";
import { DEFAULT_ITEM_BUDGET, DEFAULT_TURN_PAGE_SIZE, createTurnWindow } from "../app/public/ui-core.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : `  <- ${detail}`}`);
};

const appDir = resolve(fileURLToPath(new URL("../app", import.meta.url)));
const source = readFileSync(resolve(appDir, "public/app.js"), "utf8");

// ---- 1. 纯逻辑：窗口只取最近一页，loadMore 时往前扩 ----
const turns = Array.from({ length: 45 }, (_, i) => ({ id: "t" + i }));
const first = createTurnWindow(turns, DEFAULT_TURN_PAGE_SIZE, undefined, 0);
check("默认只显示最近一页（20 轮）", first.visible.length === DEFAULT_TURN_PAGE_SIZE, String(first.visible.length));
check("隐藏了 25 轮", first.hiddenCount === 25, String(first.hiddenCount));
check("显示的是最后 20 轮（不是最前面）", first.visible[first.visible.length - 1].id === "t44" && first.visible[0].id === "t25", `${first.visible[0].id}..${first.visible[first.visible.length - 1].id}`);
const more = createTurnWindow(turns, DEFAULT_TURN_PAGE_SIZE, first.start, DEFAULT_TURN_PAGE_SIZE);
check("Load earlier 之后再往前扩一页", more.visible.length === 40 && more.hiddenCount === 5, `${more.visible.length}/${more.hiddenCount}`);

// ---- 1.5 条目预算：轮数一样但 item 很多时，窗口必须收窄（这才是手机上真正的负担）----
const heavyTurns = Array.from({ length: 40 }, () => ({ items: Array.from({ length: 70 }, () => ({})) }));
const heavy = createTurnWindow(heavyTurns, DEFAULT_TURN_PAGE_SIZE, undefined, 0, DEFAULT_ITEM_BUDGET);
const heavyItems = heavy.visible.reduce((sum, turn) => sum + turn.items.length, 0);
check("每轮 70 个 item 时只排预算内的轮数", heavy.visible.length < 20 && heavy.visible.length >= 1, `${heavy.visible.length} 轮`);
check("总 item 数被压在预算附近", heavyItems <= DEFAULT_ITEM_BUDGET + 70, String(heavyItems));
check("收窄的是最前面，最近一轮一定在", heavy.visible[heavy.visible.length - 1] === heavyTurns[heavyTurns.length - 1]);
const heavyMore = createTurnWindow(heavyTurns, DEFAULT_TURN_PAGE_SIZE, heavy.start, DEFAULT_TURN_PAGE_SIZE, DEFAULT_ITEM_BUDGET);
check("Load earlier 每次也只多排预算内的量", heavyMore.visible.length > heavy.visible.length && heavyMore.visible.length <= heavy.visible.length + 20, `${heavy.visible.length} -> ${heavyMore.visible.length}`);

// ---- 2. renderThread：只画窗口内的轮次 + 给出「Load earlier messages」按钮 ----
const dom = new JSDOM('<!doctype html><body><div id="conversation"></div></body>');
const { window } = dom;
const { document } = window;
const rendered = [];
let scrollCalls = 0;

const factory = new Function(
  "window", "document", "$", "state", "renderTurn", "createTurnWindow", "DEFAULT_TURN_PAGE_SIZE", "DEFAULT_ITEM_BUDGET", "clientLog",
  "clearConversationRuntime", "showEmpty", "scrollBottom",
  `
  ${(() => {
    const from = source.indexOf("function renderThread(thread,loadMore=0){");
    const to = source.indexOf("\n", from);
    if (from < 0 || to < 0) throw new Error("cannot locate renderThread");
    return source.slice(from, to);
  })()}
  return { renderThread };
  `,
);
const state = { turnWindow: null };
const api = factory(
  window, document, (sel) => document.querySelector(sel), state,
  (turn) => rendered.push(turn.id), createTurnWindow, DEFAULT_TURN_PAGE_SIZE, DEFAULT_ITEM_BUDGET,
  () => {},
  () => {}, () => {}, () => { scrollCalls += 1; },
);

api.renderThread({ id: "th", turns });
check("renderThread 只渲染一页（20 轮）", rendered.length === 20, String(rendered.length));
check("第一轮渲染的是最后 20 轮的第一条", rendered[0] === "t25", rendered[0]);
const button = document.querySelector(".load-older");
check("给出「Load earlier messages」按钮并标出隐藏数量", Boolean(button) && /25/.test(button.textContent), button?.textContent);

rendered.length = 0;
button.onclick();
check("点一次往前扩一页（累计 40 轮）", rendered.length === 40, String(rendered.length));
const second = document.querySelector(".load-older");
check("还剩 5 轮时按钮仍在", Boolean(second) && /5/.test(second.textContent), second?.textContent);

rendered.length = 0;
second.onclick();
check("全部展开后不再有按钮", rendered.length === 45 && !document.querySelector(".load-older"), String(rendered.length));

// ---- 3. 回归护栏：openThread 不许回到"全量渲染"，失败也不许永远停在 Loading ----
check("openThread 走分页渲染（不再 for 循环全量 renderTurn）",
  /renderThread\(thread\)/.test(source) && !/for\(const turn of thread\.turns\)renderTurn\(turn\)/.test(source));
check("加载失败的分支给出原因 + 重试按钮（不再把占位文字留在那儿）",
  /retry\.textContent='Retry'/.test(source) && /Could not load history: '/.test(source));

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
