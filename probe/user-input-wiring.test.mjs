// 模型提问（`item/tool/requestUserInput`）的接线测试。
//
// 出发点是真机现象（E114）：Plan 模式下模型真的发来了 requestUserInput（`/api/requests/pending`
// 里能看到完整 questions 结构），但应用界面上**什么都没出现**——刷新后也没有。
// 所以先把这条链路单独跑起来，判断是"代码没渲染"还是"应用状态/容器不对"。
//
// fixture 直接抄真机那条请求（trim 过的 questions），确保测的是真实形状。
//
// Usage: node probe/user-input-wiring.test.mjs
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "../app/node_modules/jsdom/lib/api.js";

const appDir = resolve(fileURLToPath(new URL("../app", import.meta.url)));
const dom = new JSDOM(readFileSync(resolve(appDir, "public/index.html"), "utf8"),
  { url: "http://127.0.0.1:8899/", pretendToBeVisual: true });
const { window } = dom;
for (const key of ["document", "navigator", "localStorage", "HTMLElement", "Element", "Node", "Event", "CustomEvent",
  "KeyboardEvent", "MouseEvent", "DOMParser", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame",
  "Blob", "URL", "Image", "history", "location", "screen"]) {
  if (window[key] === undefined) continue;
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
}
Object.defineProperty(globalThis, "window", { value: window, configurable: true, writable: true });
Object.defineProperty(globalThis, "addEventListener", { value: window.addEventListener.bind(window), configurable: true, writable: true });
Object.defineProperty(globalThis, "removeEventListener", { value: window.removeEventListener.bind(window), configurable: true, writable: true });
for (const key of ["innerWidth", "innerHeight", "devicePixelRatio", "scrollX", "scrollY", "self", "top", "parent",
  "getSelection", "alert", "confirm", "prompt", "focus", "blur"]) {
  const value = window[key];
  if (value === undefined) continue;
  Object.defineProperty(globalThis, key, { value: typeof value === "function" ? value.bind(window) : value, configurable: true, writable: true });
}
globalThis.matchMedia = window.matchMedia?.bind(window) || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
globalThis.EventSource = class { constructor() { this.readyState = 0; } close() {} addEventListener() {} };
globalThis.WebSocket = class { constructor() { this.readyState = 0; } send() {} close() {} };
const fakeContext = {
  fillStyle: "", strokeStyle: "", font: "", textAlign: "", textBaseline: "", lineWidth: 1, globalAlpha: 1,
  measureText: () => ({ width: 0 }), fillRect() {}, clearRect() {}, strokeRect() {}, fillText() {}, strokeText() {},
  beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, save() {}, restore() {}, scale() {}, translate() {},
  rotate() {}, setTransform() {}, drawImage() {}, arc() {}, closePath() {}, rect() {}, clip() {},
  getImageData: () => ({ data: [] }), putImageData() {}, createLinearGradient: () => ({ addColorStop() {} }),
};
window.HTMLCanvasElement.prototype.getContext = () => fakeContext;
globalThis.ResizeObserver = globalThis.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
window.Element.prototype.scrollIntoView = function () {};
window.Element.prototype.animate = window.Element.prototype.animate || function () { return { cancel() {}, finished: Promise.resolve() }; };
Object.defineProperty(globalThis, "CSS", { value: { escape: (v) => String(v).replace(/[^a-zA-Z0-9_\u00a0-\uffff-]/g, (c) => `\\${c}`) }, configurable: true, writable: true });
window.__codexTestPosts = [];
globalThis.fetch = async (url, options = {}) => {
  window.__codexTestPosts.push({ url: String(url), body: options.body ? String(options.body) : null });
  return { ok: true, status: 200, json: async () => ({ ok: true, data: [] }), text: async () => "" };
};

await import(pathToFileURL(resolve(appDir, "public/app.bundle.js")).href);

const debug = globalThis.__codexWebuiDebug;
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` — ${detail}`}`);
};

debug.state.transport = "sse";
document.querySelector("#conversation").innerHTML = "";

// 真机那条请求（E114）：单选 + 允许自由输入（isOther），带推荐项。
const request = {
  id: 2,
  method: "item/tool/requestUserInput",
  params: {
    threadId: "t1", turnId: "turn-plan", itemId: "item-ask",
    questions: [{
      id: "today_task",
      header: "今天做什么",
      question: "今天想做什么工作？",
      isOther: true,
      isSecret: false,
      options: [
        { label: "codex-gui 交接推进", description: "把 PLAN 里剩下的项往下做" },
        { label: "设备级实测", description: "在这台手机上跑基线" },
      ],
    }],
  },
};

console.log("fixture 1 — 模型提问要变成卡片");
await debug.request(request);
// 卡片真实类名是 approval-card + data-codex-user-input-surface（第一次写这个测试时猜错了）
const card = document.querySelector("[data-codex-user-input-surface]");
const conversationHtml = document.querySelector("#conversation").innerHTML;
check("卡片出现", Boolean(card), conversationHtml.slice(0, 200));
check("问题文案在卡片里", (card?.textContent || "").includes("今天想做什么工作？"), card?.textContent?.slice(0, 120));
check("选项都在", (card?.textContent || "").includes("codex-gui 交接推进") && (card?.textContent || "").includes("设备级实测"), card?.textContent?.slice(0, 200));
check("自由文本入口也在（isOther）", Boolean(card?.querySelector('input[data-free="today_task"]')), card?.innerHTML?.slice(0, 200));

console.log("fixture 2 — 选一项后发出的载荷");
window.__codexTestPosts.length = 0;
const radios = [...card.querySelectorAll('input[type="radio"]')];
check("有两个单选", radios.length === 2, String(radios.length));
const chosen = radios.find((radio) => radio.value === "设备级实测");
chosen.checked = true;
const submit = card.querySelector("form");
submit.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
await new Promise((r) => setTimeout(r, 40));
const post = window.__codexTestPosts.find((p) => p.url.includes("/api/codex/respond"));
check("发出 POST /api/codex/respond", Boolean(post), JSON.stringify(window.__codexTestPosts.map((p) => p.url)));
check("载荷带 requestId=2", Boolean(post?.body?.includes("\"requestId\":2")), post?.body);
check("载荷里 answers 指向 today_task", Boolean(post?.body?.includes("today_task")), post?.body);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
