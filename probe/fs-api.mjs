// P6：文件面板的后端（`POST /api/fs`）当真的用一遍。
//
// 断言行为而不是形状：列目录（目录在前）、读文本（内容一致）、读二进制（明说不能预览）、
// 写入后读回（真的落盘）、搜索命中，以及几条必须失败的路径：允许根之外、超大文件、
// 未知动作。测试文件建在 ~/tmp 下（桥的允许根是 home），用完删掉。
//
//   node probe/fs-api.mjs
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = process.env.CODEX_GUI_PORT ?? "8899";
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : `  <- ${detail}`}`);
};

const scratch = mkdtempSync(join(homedir(), "tmp", "fs-api-"));
mkdirSync(join(scratch, "sub"));
writeFileSync(join(scratch, "note.txt"), "hello fs\n");
writeFileSync(join(scratch, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x00, 0x41]));
writeFileSync(join(scratch, "sub", "deep.txt"), "deep\n");

async function call(action, extra = {}) {
  const response = await fetch(`http://127.0.0.1:${PORT}/api/fs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, ...extra }),
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

try {
  const list = await call("list", { path: scratch });
  check("list 200", list.status === 200, JSON.stringify(list.data).slice(0, 160));
  check("目录排在文件前面", JSON.stringify(list.data.entries.map((e) => e.name)) === JSON.stringify(["sub", "blob.bin", "note.txt"]), JSON.stringify(list.data.entries.map((e) => e.name)));
  check("条目带绝对路径", list.data.entries.every((e) => e.path.startsWith(scratch)));
  check("parent 指向上一层", list.data.parent === join(scratch, ".."), String(list.data.parent));
  check("~ 展开成 home", (await call("list", { path: "~" })).data.path === homedir(), String((await call("list", { path: "~" })).data.path));

  const read = await call("read", { path: join(scratch, "note.txt") });
  check("读文本内容一致", read.data.text === "hello fs\n" && read.data.binary === false, JSON.stringify(read.data).slice(0, 160));

  const blob = await call("read", { path: join(scratch, "blob.bin") });
  check("二进制文件明说不能预览", blob.data.binary === true && blob.data.text === "", JSON.stringify(blob.data).slice(0, 160));

  const payload = Buffer.from("written from the phone\n", "utf8").toString("base64");
  const written = await call("write", { path: join(scratch, "written.txt"), dataBase64: payload });
  check("写入成功", written.status === 200 && written.data.ok === true, JSON.stringify(written.data));
  check("写入真的落盘", readFileSync(join(scratch, "written.txt"), "utf8") === "written from the phone\n");

  const search = await call("search", { cwd: scratch, query: "deep" });
  check("搜索命中子目录文件", (search.data.items || []).some((item) => String(item.path).endsWith("deep.txt")), JSON.stringify(search.data).slice(0, 200));

  const outside = await call("list", { path: "/data/local/tmp" });
  check("允许根之外被拒绝", outside.status === 400 && /outside allowed roots/.test(outside.data.error || ""), JSON.stringify(outside.data).slice(0, 160));
  const unknown = await call("rm-rf", { path: scratch });
  check("未知动作被拒绝", unknown.status === 400 && /Unsupported file action/.test(unknown.data.error || ""), String(unknown.data.error));
  const missing = await call("read", { path: join(scratch, "nope.txt") });
  check("不存在的文件给出明确错误", missing.status === 400 && /not found|No such file/i.test(missing.data.error || ""), String(missing.data.error));

  const huge = join(scratch, "huge.txt");
  writeFileSync(huge, Buffer.alloc(3 * 1024 * 1024, 0x61));
  const tooLarge = await call("read", { path: huge });
  check("超过 2 MB 的文件被拒绝（不截断）", tooLarge.status === 400 && /too large/i.test(tooLarge.data.error || ""), String(tooLarge.data.error));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
