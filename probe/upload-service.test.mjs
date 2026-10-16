// P4 attachments — the bridge-side half: bytes from the browser become a file
// with a safe name, inside the bridge's own directory, and nothing else.
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createUploadPruner,
  pruneUploads,
  sanitizeUploadName,
  saveUpload,
  uploadKind,
} from "../app/upload-service.js";

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};
const throws = (label, run) => {
  try {
    run();
    failures += 1;
    console.log(`FAIL ${label}: no error thrown`);
  } catch (error) {
    console.log(`ok   ${label}: ${error.message}`);
  }
};

const dir = mkdtempSync(join(tmpdir(), "codex-upload-"));

console.log("— 文件名净化（这是从 HTTP 来的不可信输入）—");
check("路径分隔符剥掉，只剩末段", sanitizeUploadName("../../etc/passwd"), "passwd");
check("反斜杠同样处理", sanitizeUploadName("C:\\Windows\\evil.exe"), "evil.exe");
check("空格换成下划线、控制字符直接丢弃", sanitizeUploadName("a b\u0007c.png"), "a_bc.png");
check("前导点不会变成隐藏文件", sanitizeUploadName(".bashrc"), "bashrc");
check("扩展名前的残余下划线不留", sanitizeUploadName("a??.png"), "a.png");
check("中文名保留可读（用户看得懂才有用）", sanitizeUploadName("截图 2026-10-14.png"), "截图_2026-10-14.png");
check("空名有兜底", sanitizeUploadName("   "), "upload");
check("全是分隔符也有兜底", sanitizeUploadName("___"), "upload");
check("超长名截断后仍保留扩展名", sanitizeUploadName(`${"x".repeat(300)}.png`).endsWith(".png"), true);

console.log("\n— 类型判定与 image-service 的渲染清单一致 —");
check(".png 走图片路径", uploadKind("a.PNG"), "image");
check(".jpg 走图片路径", uploadKind("a.jpg"), "image");
check(".docx 走文件引用", uploadKind("选课说明.docx"), "file");
check("没有扩展名算文件", uploadKind("README"), "file");

console.log("\n— 落盘：内容一字不差，且一定在目录内 —");
{
  const payload = Buffer.from("hello 附件\n", "utf8");
  const saved = saveUpload({ name: "笔记.txt", dataBase64: payload.toString("base64") }, { dir });
  check("返回真实绝对路径", saved.path.startsWith(join(dir, "")), true);
  check("文件确实存在", existsSync(saved.path), true);
  check("内容字节一致", readFileSync(saved.path).equals(payload), true);
  check("字节数如实回报", saved.bytes, payload.length);
  check("类型为 file", saved.kind, "file");
  check("文件名可读", saved.name, "笔记.txt");
}
{
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const saved = saveUpload({ name: "截图.png", dataBase64: `data:image/png;base64,${png.toString("base64")}` }, { dir });
  check("data: 前缀被剥掉后再解码", readFileSync(saved.path).equals(png), true);
  check("类型为 image", saved.kind, "image");
}
{
  const evil = saveUpload({ name: "../../../tmp/codex-escape.txt", dataBase64: Buffer.from("x").toString("base64") }, { dir });
  check("穿越名没有逃出目录", evil.path.startsWith(join(dir, "")), true);
  check("穿越名的落盘名是末段", evil.name, "codex-escape.txt");
  check("没有在 /tmp 直下写出同名文件", existsSync("/tmp/codex-escape.txt"), false);
}
{
  const again = saveUpload({ name: "同名.png", dataBase64: Buffer.from("a").toString("base64") }, { dir });
  const again2 = saveUpload({ name: "同名.png", dataBase64: Buffer.from("a").toString("base64") }, { dir });
  check("同名文件不会互相覆盖", again.path === again2.path, false);
}

console.log("\n— 拒绝路径 —");
throws("没有 base64 内容", () => saveUpload({ name: "a.txt" }, { dir }));
throws("内容为空", () => saveUpload({ name: "a.txt", dataBase64: "" }, { dir }));
throws("内容不是 base64", () => saveUpload({ name: "a.txt", dataBase64: "not base64 !!!" }, { dir }));
throws("超过上限（解码前就拦下）", () => saveUpload({ name: "a.txt", dataBase64: "A".repeat(2000) }, { dir, maxBytes: 1000 }));
throws("没配置目录", () => saveUpload({ name: "a.txt", dataBase64: "aGk=" }, {}));

console.log("\n— 清理：上传目录是缓存，不是存档 —");
{
  const house = mkdtempSync(join(tmpdir(), "codex-upload-prune-"));
  const oldFile = join(house, "old.png");
  const freshFile = join(house, "fresh.png");
  writeFileSync(oldFile, "old");
  writeFileSync(freshFile, "fresh");
  const longAgo = (Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000;
  utimesSync(oldFile, longAgo, longAgo);
  const removed = pruneUploads(house, { maxAgeMs: 7 * 24 * 60 * 60 * 1000 });
  check("过期文件被删", removed, ["old.png"]);
  check("过期文件真的不在了", existsSync(oldFile), false);
  check("新文件被留下", existsSync(freshFile), true);
}
{
  const house = mkdtempSync(join(tmpdir(), "codex-upload-throttle-"));
  let clock = Date.now();
  const pruner = createUploadPruner(house, { intervalMs: 60_000, maxAgeMs: 7 * 24 * 60 * 60 * 1000, now: () => clock });
  const first = pruner(true);
  check("强制清理会执行，且目录不存在也不报错", first, []);
  const createdAt = join(house, "a.png");
  writeFileSync(createdAt, "x");
  const stale = (clock - 30 * 24 * 60 * 60 * 1000) / 1000;
  utimesSync(createdAt, stale, stale);
  check("间隔内不重复跑（省 IO）", pruner(), []);
  clock += 61_000;
  check("超过间隔后才再跑一次", pruner(), ["a.png"]);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
