// 审批"接线"测试：真的把 bundle 跑在 DOM 里，喂进一条审批请求，检查卡片出现、
// 点击后发出去的东西是对的、重复请求被忽略、服务端说已解决时卡片会收掉。
//
// 为什么需要它（P5）：这台机器的 config 是 `approval_policy = "never"` +
// `sandbox_mode = "danger-full-access"`，所以**真机上永远不会弹审批**——
// 光靠"在应用里点一下"没法验收这一块，必须把这条链路单独测出来。
//
// 用的是页面自己暴露的调试钩子 `globalThis.__codexWebuiDebug`（app.js 里本来就有）。
//
// Usage: node probe/approval-wiring.test.mjs
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "../app/node_modules/jsdom/lib/api.js";

const appDir = resolve(fileURLToPath(new URL("../app", import.meta.url)));
const html = readFileSync(resolve(appDir, "public/index.html"), "utf8");
const dom = new JSDOM(html, { url: "http://127.0.0.1:8899/", pretendToBeVisual: true });

// 把 bundle 需要的浏览器全局铺好（缺哪个补哪个，缺的都显式列出来）。
const { window } = dom;
const passthrough = ["document", "navigator", "localStorage", "HTMLElement", "Element", "Node", "Event",
  "CustomEvent", "KeyboardEvent", "MouseEvent", "DOMParser", "getComputedStyle", "requestAnimationFrame",
  // 注意不要把 jsdom 的 performance 换进来：它的 now() 在 pretendToBeVisual 模式下会自我递归
  // （RangeError: Maximum call stack size exceeded）。Node 自带的 performance 够用。
  "cancelAnimationFrame", "Blob", "URL", "Image", "history", "location", "screen"];
for (const key of passthrough) {
  if (window[key] === undefined) continue;
  // Node ≥21 里 navigator 之类是只读 getter，直接赋值会抛；用 defineProperty 覆盖。
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
}
Object.defineProperty(globalThis, "window", { value: window, configurable: true, writable: true });
// 裸的窗口尺寸/选择类全局（浏览器里都挂在 window 上）
for (const key of ["innerWidth", "innerHeight", "outerWidth", "outerHeight", "devicePixelRatio", "scrollX", "scrollY",
  "pageXOffset", "pageYOffset", "self", "top", "parent", "getSelection", "alert", "confirm", "prompt", "open", "close", "focus", "blur"]) {
  const value = window[key];
  if (value === undefined) continue;
  Object.defineProperty(globalThis, key, {
    value: typeof value === "function" ? value.bind(window) : value,
    configurable: true,
    writable: true,
  });
}
// bundle 里用的是裸的 addEventListener（浏览器里就是 window.addEventListener）
Object.defineProperty(globalThis, "addEventListener", { value: window.addEventListener.bind(window), configurable: true, writable: true });
Object.defineProperty(globalThis, "removeEventListener", { value: window.removeEventListener.bind(window), configurable: true, writable: true });
globalThis.matchMedia = window.matchMedia?.bind(window) || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || ((fn) => setTimeout(() => fn(0), 0));
globalThis.cancelAnimationFrame = globalThis.cancelAnimationFrame || clearTimeout;
globalThis.EventSource = class { constructor() { this.readyState = 0; } close() {} addEventListener() {} };
globalThis.WebSocket = class { constructor() { this.readyState = 0; } send() {} close() {} };
// jsdom 没有 canvas 实现：bundle 里字体测量/动画会取 2d 上下文，给个够用的假对象。
const fakeContext = {
  fillStyle: "", strokeStyle: "", font: "", textAlign: "", textBaseline: "", lineWidth: 1, globalAlpha: 1,
  measureText: () => ({ width: 0 }), fillRect() {}, clearRect() {}, strokeRect() {}, fillText() {}, strokeText() {},
  beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, save() {}, restore() {}, scale() {},
  translate() {}, rotate() {}, setTransform() {}, drawImage() {}, arc() {}, closePath() {}, rect() {}, clip() {},
  getImageData: () => ({ data: [] }), putImageData() {}, createLinearGradient: () => ({ addColorStop() {} }),
};
window.HTMLCanvasElement.prototype.getContext = () => fakeContext;
globalThis.ResizeObserver = globalThis.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
// jsdom 不带 CSS.escape（bundle 用它拼属性选择器）
Object.defineProperty(globalThis, "CSS", {
  value: { escape: (value) => String(value).replace(/[^a-zA-Z0-9_\u00a0-\uffff-]/g, (ch) => `\\${ch}`) },
  configurable: true,
  writable: true,
});
window.Element.prototype.scrollIntoView = function () {};
window.Element.prototype.animate = window.Element.prototype.animate || function () { return { cancel() {}, finished: Promise.resolve() }; };
window.URL.createObjectURL = window.URL.createObjectURL || (() => "blob:jsdom");
globalThis.URL.createObjectURL = window.URL.createObjectURL;
window.__codexTestPosts = [];
globalThis.fetch = async (url, options = {}) => {
  window.__codexTestPosts.push({ url: String(url), body: options.body ? String(options.body) : null });
  return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "" };
};

await import(pathToFileURL(resolve(appDir, "public/app.bundle.js")).href);

const debug = globalThis.__codexWebuiDebug;
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` — ${detail}`}`);
};

if (!debug?.request) {
  console.log("FAIL 页面没有暴露 __codexWebuiDebug.request —— 没法测接线");
  process.exit(1);
}

// 用 SSE 传输：这样 respondToCodex 走 POST /api/rpc，我能在 fetch 里抓到发出去的内容。
debug.state.transport = "sse";
const conversation = document.querySelector("#conversation");
conversation.innerHTML = "";

console.log("fixture 1 — 现代审批（逐条对照 availableDecisions）");
await debug.request({
  id: 101,
  method: "item/commandExecution/requestApproval",
  params: {
    threadId: "t1", turnId: "turn1", itemId: "item1",
    command: "echo p5-check",
    availableDecisions: ["accept", "decline"],
  },
});
let card = document.querySelector(".approval-card");
check("卡片出现", Boolean(card));
check("标题去问用户", (card?.textContent || "").includes("Allow ChatGPT to run this command?"), card?.textContent?.slice(0, 80));
check("只出现 offered 的按钮", card?.querySelectorAll("button").length === 2, String(card?.querySelectorAll("button").length));

// 回应走的是 POST /api/codex/respond（不是 /api/rpc）——这是第一次跑这个测试时被它纠正的假设。
console.log("fixture 2 — 点“允许一次”发出的是 {result:{decision:'accept'}} 且走 /api/codex/respond");
window.__codexTestPosts.length = 0;
card.querySelector(".approval-primary").click();
await new Promise((r) => setTimeout(r, 30));
const post = window.__codexTestPosts.find((p) => p.url.includes("/api/codex/respond"));
check("发出 POST /api/codex/respond", Boolean(post), JSON.stringify(window.__codexTestPosts.map((p) => p.url)));
check("载荷 result.decision=accept", Boolean(post?.body?.includes("\"decision\":\"accept\"")), post?.body);
check("载荷 requestId=101", Boolean(post?.body?.includes("\"requestId\":101")), post?.body);
check("卡片已移除", !document.querySelector(".approval-card"));

console.log("fixture 3 — 旧版 execCommandApproval");
await debug.request({
  id: 202,
  method: "execCommandApproval",
  params: { callId: "c1", command: ["/bin/sh", "-lc", "echo legacy"], cwd: "/tmp", reason: "旧协议" },
});
card = document.querySelector(".approval-card");
check("旧版也出卡片（原来会回 -32601）", Boolean(card), conversation.innerHTML.slice(0, 120));
check("旧版卡片显示命令", (card?.textContent || "").includes("echo legacy"), card?.textContent?.slice(0, 80));
window.__codexTestPosts.length = 0;
card.querySelector(".approval-scoped").click();
await new Promise((r) => setTimeout(r, 30));
const legacyPost = window.__codexTestPosts.find((p) => p.url.includes("/api/codex/respond"));
check("旧版发出 approved_for_session（不是新版字面量）",
  Boolean(legacyPost?.body?.includes("\"decision\":\"approved_for_session\"")), legacyPost?.body);

console.log("fixture 4 — 同一 requestId 重复送达只留一张卡");
const dup = { id: 303, method: "execCommandApproval", params: { command: ["echo", "dup"] } };
await debug.request(dup);
await debug.request(dup);
check("重复请求被忽略", document.querySelectorAll(".approval-card").length === 1,
  String(document.querySelectorAll(".approval-card").length));

console.log("fixture 5 — 服务端说已解决时卡片收掉（多客户端）");
debug.notify("serverRequest/resolved", { requestId: 303 });
await new Promise((r) => setTimeout(r, 1500));
check("卡片已被移除", !document.querySelector(".approval-card"), conversation.innerHTML.slice(0, 120));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
