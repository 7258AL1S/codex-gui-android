// 上传的**客户端**行为（patches/0098）：真正驱动一遍 `uploadAttachments`，用假 XHR 走完
// "上传中 → 等桥响应 → 成功/失败"三个阶段，检查：
//   1. `xhr.send()` 收到的是 **File 对象本身**（原始字节），不是 base64 字符串 —— 这是
//      进度条能不能工作的分水岭（字符串 body 拿不到 lengthComputable，进度条永远停在 0）；
//   2. 请求头带上文件名（URL 编码）与文件类型；
//   3. 进度事件真的把芯片背景撑到 50%，相位文字跟着变；
//   4. 字节发完、还没收到响应时，芯片进入 `waiting`（条纹动画）并显示等了几秒；
//   5. 成功后占位芯片被真正的附件芯片替换；失败会重试一次，再失败就报错并清理。
//
//   node probe/upload-client.test.mjs
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "../app/node_modules/jsdom/lib/api.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : `  <- ${detail}`}`);
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

const appDir = resolve(fileURLToPath(new URL("../app", import.meta.url)));
const source = readFileSync(resolve(appDir, "public/app.js"), "utf8");
function slice(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`cannot locate ${start} … ${end}`);
  return source.slice(from, to);
}

const dom = new JSDOM('<!doctype html><body><div id="composerContextTray"></div></body>');
const { window } = dom;
const { document } = window;

class FakeXHR {
  static instances = [];
  constructor() { this.upload = {}; this.headers = {}; FakeXHR.instances.push(this); }
  open(method, url) { this.method = method; this.url = url; }
  setRequestHeader(key, value) { this.headers[key.toLowerCase()] = value; }
  send(body) { this.body = body; }
  emitUploadProgress(loaded, total) { this.upload.onprogress?.({ lengthComputable: true, loaded, total }); }
  emitUploadLoad() { this.upload.onload?.(); }
  respond(status, payload) { this.status = status; this.responseText = JSON.stringify(payload ?? {}); this.onload?.(); }
}

const state = { composerAttachments: [], composerMentions: [] };
const logs = [];
const toasts = [];

// renderContextTray 用真代码会更贴近，但它引用了不少别的东西；这里给一个等价的最小实现：
// 关键契约是"芯片上有 data-attachment-id、.composer-context-fill、.composer-context-phase"。
function renderContextTray() {
  const tray = document.getElementById("composerContextTray");
  tray.replaceChildren();
  for (const attachment of state.composerAttachments) {
    const chip = document.createElement("div");
    chip.className = "composer-context-chip" + (attachment.pending ? " pending" : "");
    chip.dataset.attachmentId = attachment.id;
    const fill = Math.round(Math.max(0, Math.min(1, Number(attachment.progress) || 0)) * 100);
    chip.innerHTML = (attachment.pending ? `<span class="composer-context-fill" style="width:${fill}%"></span>` : "")
      + `<span class="composer-context-label">${attachment.name}</span>`
      + (attachment.pending ? `<span class="composer-context-phase">${attachment.phase ?? ""}</span>` : "");
    tray.append(chip);
  }
  tray.hidden = !state.composerAttachments.length;
}

const factory = new Function(
  "window", "document", "state", "renderContextTray", "XMLHttpRequest", "t", "codexIcon", "escapeHtml",
  "clientLog", "beginBridgeWait", "endBridgeWait", "toast",
  `
  ${slice("async function uploadAttachments(files){", "// Startup timing report")}
  ${slice("// --- upload failure wording", "// --- upload progress on the chip")}
  ${slice("function postUploadWithProgress(", "// --- upload failure wording")}
  ${slice("function updateAttachmentProgress(", "// --- user message rendering")}
  return { uploadAttachments, updateAttachmentProgress };
  `,
);
const api = factory(
  window, document, state, renderContextTray, FakeXHR,
  (value) => value,
  () => "",
  (value = "") => String(value),
  (message) => logs.push(message),
  () => {},
  () => {},
  (message) => toasts.push(message),
);

const file = new window.File([new Uint8Array(2048).fill(7)], "截图 2026.png", { type: "image/png" });

// ---- 上传中 ----
const pending = api.uploadAttachments([file]);
await tick();
const first = FakeXHR.instances[0];
check("请求打到 /api/uploads", first?.url === "/api/uploads" && first?.method === "POST", `${first?.method} ${first?.url}`);
check("body 是 File 本身（原始字节，不是 base64 字符串）", first?.body === file, typeof first?.body);
check("带上文件类型", first?.headers["content-type"] === "image/png", String(first?.headers["content-type"]));
check("文件名以 URL 编码放在 x-upload-name", first?.headers["x-upload-name"] === encodeURIComponent("截图 2026.png"), String(first?.headers["x-upload-name"]));
check("芯片立刻出现且是待传状态", document.querySelectorAll(".composer-context-chip.pending").length === 1);
check("芯片一开始就写着（上传中…）", /uploading/.test(document.querySelector(".composer-context-phase")?.textContent ?? ""), document.querySelector(".composer-context-phase")?.textContent);

// ---- 进度事件（这就是"有没有进度条"）----
first.emitUploadProgress(1024, 2048);
const fill = document.querySelector(".composer-context-fill");
check("进度 50% 时背景层宽度是 50%", fill?.style.width === "50%", fill?.style.width);
check("相位文字跟着变成 50%", document.querySelector(".composer-context-phase")?.textContent === "50%", document.querySelector(".composer-context-phase")?.textContent);
first.emitUploadProgress(2048, 2048);
check("进度 100%", document.querySelector(".composer-context-fill")?.style.width === "100%");

// ---- 字节发完、等桥响应 ----
first.emitUploadLoad();
const waitingChip = document.querySelector(".composer-context-chip");
check("等桥响应时芯片进入 waiting（条纹动画那一档）", waitingChip?.classList.contains("waiting"));
check("等桥响应时显示秒数", /waiting for the bridge/.test(document.querySelector(".composer-context-phase")?.textContent ?? ""), document.querySelector(".composer-context-phase")?.textContent);

// ---- 成功 ----
first.respond(200, { ok: true, path: "/data/data/com.termux/files/home/.codex/codex-webui/uploads/x-截图.png", name: "截图.png", kind: "image", bytes: 2048 });
await pending;
check("成功后占位芯片被真附件替换", document.querySelectorAll(".composer-context-chip").length === 1 && !document.querySelector(".composer-context-chip").classList.contains("pending"));
check("真附件芯片带着服务端给的路径", state.composerAttachments[0]?.path?.includes("uploads/x-截图.png"), JSON.stringify(state.composerAttachments));
check("上传结束收掉 waiting 样式", !document.querySelector(".composer-context-chip").classList.contains("waiting"));
check("客户端记了 upload http 日志（可用来量耗时）", logs.some((line) => /upload http 200 in \d+ms/.test(line)), JSON.stringify(logs.slice(-3)));

// ---- 失败与重试 ----
state.composerAttachments = [];
FakeXHR.instances.length = 0;
const failing = api.uploadAttachments([file]);
await tick();
const attempt1 = FakeXHR.instances[0];
attempt1.respond(503, { error: "bridge busy" });
await tick();
const attempt2 = FakeXHR.instances[1];
check("5xx 会重试一次（同一个 File 对象）", Boolean(attempt2) && attempt2.body === file, String(FakeXHR.instances.length));
attempt2.respond(503, { error: "bridge busy" });
await failing;
check("重试仍失败就报错并清理占位芯片", state.composerAttachments.length === 0 && toasts.length === 1, JSON.stringify(toasts));

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
