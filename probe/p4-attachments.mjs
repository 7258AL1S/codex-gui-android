// P4 attachments — the browser-side half, over the bridge's real HTTP surface.
//
// The browser has the bytes and never a path; this is the endpoint that turns
// them into one. Run it against a bridge that has /api/uploads:
//
//   node probe/p4-attachments.mjs                      # 默认 127.0.0.1:8899
//   BASE_URL=http://127.0.0.1:8893 node probe/p4-attachments.mjs
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:8899";
const UPLOAD_DIR = join(homedir(), ".codex", "codex-webui", "uploads");
const KEEP_UPLOADS = process.env.KEEP_UPLOADS === "1";
// Uploads are a cache, and a probe should not top up that cache: remember what
// this run created and take it back out at the end.
const created = [];

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};
const post = (body) => fetch(`${BASE_URL}/api/uploads`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

// A real 1x1 PNG: the point is that the bytes survive, so a real file beats a
// fixture string.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");

console.log(`— 上传一张真实图片（${BASE_URL}）—`);
const imageResponse = await post({ name: "截图.png", dataBase64: `data:image/png;base64,${PNG.toString("base64")}` });
const imagePayload = await imageResponse.json();
created.push(imagePayload.path);
check("HTTP 200", imageResponse.status, 200);
check("ok=true", imagePayload.ok, true);
check("类型判定为 image", imagePayload.kind, "image");
check("文件名可读", imagePayload.name, "截图.png");
check("字节数如实回报", imagePayload.bytes, PNG.length);
check("落在桥自己的上传目录里", imagePayload.path?.startsWith(join(UPLOAD_DIR, "")), true);
check("磁盘上确实有这份文件", existsSync(imagePayload.path), true);
check("落盘内容与上传字节一致", existsSync(imagePayload.path) && readFileSync(imagePayload.path).equals(PNG), true);

console.log("\n— 同一路径能被缩略图接口读到（否则界面只能给破图）—");
{
  const thumb = await fetch(`${BASE_URL}/api/images/local?path=${encodeURIComponent(imagePayload.path)}`);
  check("缩略图 200", thumb.status, 200);
  check("content-type 是图片", thumb.headers.get("content-type"), "image/png");
  const body = Buffer.from(await thumb.arrayBuffer());
  check("缩略图字节与原文一致", body.equals(PNG), true);
}

console.log("\n— 普通文件走文件引用（不是图片）—");
{
  const bytes = Buffer.from("# 附件测试\n中文内容\n", "utf8");
  const response = await post({ name: "选课说明 2026.docx", dataBase64: bytes.toString("base64") });
  const payload = await response.json();
  created.push(payload.path);
  check("HTTP 200", response.status, 200);
  check("类型判定为 file", payload.kind, "file");
  check("中文与空格名可读", payload.name, "选课说明_2026.docx");
  check("内容一致", readFileSync(payload.path).equals(bytes), true);
  check("权限是 0600", (statSync(payload.path).mode & 0o777), 0o600);
}

console.log("\n— 拒绝路径不会悄悄吞掉 —");
{
  const oversize = await post({ name: "big.bin", dataBase64: "A".repeat(36 * 1024 * 1024) });
  check("超大文件 400", oversize.status, 400);
  check("给出可读原因", (await oversize.json()).error?.includes("larger than"), true);
}
{
  const junk = await post({ name: "x.txt", dataBase64: "这不是 base64 !!!" });
  check("非 base64 400", junk.status, 400);
}
{
  const empty = await post({});
  check("空载荷 400", empty.status, 400);
}

console.log("\n— 穿越名不会写到目录外 —");
{
  const escape = await post({ name: "../../../../tmp/codex-upload-escape.txt", dataBase64: Buffer.from("x").toString("base64") });
  const payload = await escape.json();
  created.push(payload.path);
  check("HTTP 200（名字被净化，不是错误）", escape.status, 200);
  check("落点仍在上传目录内", payload.path?.startsWith(join(UPLOAD_DIR, "")), true);
  check("没有在 /tmp 直下写出文件", existsSync("/tmp/codex-upload-escape.txt"), false);
}

if (!KEEP_UPLOADS) {
  let removed = 0;
  for (const path of created) {
    try { rmSync(path); removed += 1; } catch { /* already gone is fine */ }
  }
  console.log(`\n清理：删掉本次上传的 ${removed}/${created.length} 个测试文件`);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
