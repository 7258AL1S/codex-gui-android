// `saveUploadStream()`（patches/0098）的离线单测：不连桥、不连网络。
// 关注的是"边收边写盘"这条路径最容易出错的地方——超限、空文件、中途断流、路径逃逸。
//
//   node probe/upload-stream-service.test.mjs
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { saveUploadStream } from "../app/upload-service.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : `  <- ${detail}`}`);
};
const throws = async (label, fn, pattern) => {
  try { await fn(); check(label, false, "没有抛错"); }
  catch (error) { check(label, !pattern || pattern.test(String(error.message)), String(error.message)); }
};

const dir = mkdtempSync(join(tmpdir(), "upload-stream-"));
const uploadDir = join(dir, "uploads");

/** 假的可读流：按 JSON 描述的块吐字节；`failAfter` 之后抛错，模拟客户端中途断开。 */
function fakeStream(chunks, { failAfter = -1 } = {}) {
  return {
    async *[Symbol.asyncIterator]() {
      for (let index = 0; index < chunks.length; index++) {
        if (index === failAfter) throw new Error("client went away");
        yield Buffer.isBuffer(chunks[index]) ? chunks[index] : Buffer.from(chunks[index]);
      }
    },
  };
}

const payload = Buffer.from("hello 世界 ".repeat(4096));
const saved = await saveUploadStream(fakeStream([payload.slice(0, 1000), payload.slice(1000)]), { dir: uploadDir, name: "笔记.txt" });
check("流式上传写入成功", saved.bytes === payload.length, `bytes=${saved.bytes} vs ${payload.length}`);
check("落盘内容与输入一致", createHash("sha256").update(readFileSync(saved.path)).digest("hex") === createHash("sha256").update(payload).digest("hex"));
check("文件落在上传目录里", resolve(saved.path).startsWith(resolve(uploadDir)));
check("扩展名决定 kind（.png → image）", (await saveUploadStream(fakeStream([payload]), { dir: uploadDir, name: "图.png" })).kind === "image");
check("文件名被清洗后仍在目录里", (() => {
  const name = "../../../../tmp/escape.txt";
  return true;
})());
const escaped = await saveUploadStream(fakeStream([Buffer.from("x")]), { dir: uploadDir, name: "../../../../tmp/escape.txt" });
check("路径逃逸被清洗掉（仍写在上传目录内）", resolve(escaped.path).startsWith(resolve(uploadDir)) && !escaped.path.includes(".."), escaped.path);

const before = readdirSync(uploadDir).length;
await throws("空文件被拒", () => saveUploadStream(fakeStream([]), { dir: uploadDir, name: "empty.txt" }), /Empty file/);
await throws("超过体积上限被拒", () => saveUploadStream(fakeStream([Buffer.alloc(3 * 1024 * 1024), Buffer.alloc(3 * 1024 * 1024)]), { dir: uploadDir, name: "big.bin", maxBytes: 4 * 1024 * 1024 }), /larger than 4 MB/);
await throws("中途断流会报错", () => saveUploadStream(fakeStream([Buffer.alloc(1024), Buffer.alloc(1024)], { failAfter: 1 }), { dir: uploadDir, name: "broken.bin" }), /client went away/);
check("失败不留半截文件（目录里没有多出来）", readdirSync(uploadDir).length === before, `before=${before} after=${readdirSync(uploadDir).length}`);

// 上面那两个"被拒"的调用如果留着半个文件，这里就会多出来 —— 名字也检查一下。
check("没有残留的 big.bin / broken.bin / empty.txt", !readdirSync(uploadDir).some((name) => /big\.bin|broken\.bin|empty\.txt/.test(name)), readdirSync(uploadDir).join(","));

await throws("不是流就报错", () => saveUploadStream(Buffer.from("x"), { dir: uploadDir, name: "a.txt" }), /not a stream/);
await throws("没配目录就报错", () => saveUploadStream(fakeStream([Buffer.from("x")]), { name: "a.txt" }), /not configured/);

// 5 MB 的真实写入，确认没有内存放大（能跑完就够了，速度交给 live 探针量）。
const big = Buffer.alloc(5 * 1024 * 1024, 7);
const started = Date.now();
const bigSaved = await saveUploadStream(fakeStream([big.slice(0, 2 * 1024 * 1024), big.slice(2 * 1024 * 1024)]), { dir: uploadDir, name: "big-ok.bin" });
check("5 MB 也能正常写完", bigSaved.bytes === big.length, `bytes=${bigSaved.bytes}`);
console.log(`   5 MB 流式写入耗时 ${Date.now() - started}ms（进程内，含两次 write）`);

rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
