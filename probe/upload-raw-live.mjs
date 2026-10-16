// 上传路径的真机对照（patches/0098）：同一份文件，走**原始字节**（页面现在用的）
// 与旧的 **base64+JSON**（保留兼容）各发一次，比时间、比落盘内容，再验几条拒绝路径。
//
//   node probe/upload-raw-live.mjs
//
// 前置：桥在跑（~/bin/codex-gui-web status）。
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

const BASE = process.env.BRIDGE_URL ?? "http://127.0.0.1:8899";
const UPLOAD_DIR = resolve(process.env.HOME ?? "/data/data/com.termux/files/home", ".codex/codex-webui/uploads");

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : `  <- ${detail}`}`);
};
const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");

function largestUpload() {
  const files = readdirSync(UPLOAD_DIR).map((name) => join(UPLOAD_DIR, name))
    .filter((path) => { try { return statSync(path).isFile(); } catch { return false; } })
    .sort((a, b) => statSync(b).size - statSync(a).size);
  return files[0] ?? null;
}

const source = largestUpload();
if (!source) { console.log("上传目录里没有文件，先造一个 4 MB 的测试文件"); }
const bytes = source ? readFileSync(source) : Buffer.alloc(4 * 1024 * 1024, 3);
console.log(`测试负载：${(bytes.length / 1024 / 1024).toFixed(2)} MB${source ? `（取自 ${source}）` : ""}`);

async function postJson(payload) {
  const started = Date.now();
  const response = await fetch(`${BASE}/api/uploads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body, ms: Date.now() - started };
}
async function postRaw(data, name) {
  const started = Date.now();
  const response = await fetch(`${BASE}/api/uploads`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-upload-name": encodeURIComponent(name) },
    body: data,
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body, ms: Date.now() - started };
}
const cleanup = (path) => { try { unlinkSync(path); } catch { /* 已经没了 */ } };

// ---- 1. 旧路径（base64 + JSON）：留作兼容，也要继续能跑 ----
const json = await postJson({ name: "对照-JSON.jpg", dataBase64: bytes.toString("base64") });
check("旧路径（JSON+base64）仍然可用", json.status === 200 && json.body.bytes === bytes.length, JSON.stringify(json).slice(0, 160));

// ---- 2. 新路径（原始字节）----
const raw = await postRaw(bytes, "对照-RAW.jpg");
check("新路径（原始字节）成功", raw.status === 200 && raw.body.bytes === bytes.length, JSON.stringify(raw).slice(0, 160));
check("新路径落盘内容与源文件逐字节一致", raw.body.path && sha(readFileSync(raw.body.path)) === sha(bytes));
check("新路径识别成 image", raw.body.kind === "image", String(raw.body.kind));
console.log(`   同一份 ${(bytes.length / 1024 / 1024).toFixed(2)} MB：JSON+base64 ${json.ms}ms ／ 原始字节 ${raw.ms}ms（桥侧接收）`);

// ---- 3. 拒绝路径（原始字节）----
const oversize = await postRaw(Buffer.alloc(26 * 1024 * 1024, 1), "too-big.bin");
check("超过 25 MB 被拒且给出可读文案", oversize.status === 400 && /larger than 25 MB/.test(String(oversize.body.error)), JSON.stringify(oversize).slice(0, 160));
const empty = await postRaw(Buffer.alloc(0), "empty.bin");
check("空文件被拒", empty.status === 400 && /Empty file/.test(String(empty.body.error)), JSON.stringify(empty).slice(0, 160));
const escape = await postRaw(Buffer.from("x"), "../../../../tmp/codex-escape.txt");
check("路径逃逸被清洗（落在上传目录内）", escape.status === 200 && resolve(escape.body.path).startsWith(UPLOAD_DIR), JSON.stringify(escape.body).slice(0, 160));
const noName = await postRaw(Buffer.from("x"), "");
check("没有文件名的原始上传会被当成 JSON 路径（返回可读错误而不是崩）", noName.status === 400, JSON.stringify(noName).slice(0, 160));

for (const result of [json, raw, escape]) cleanup(result.body?.path);
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
