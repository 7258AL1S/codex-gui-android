// P7 产物动作：打开 / 分享 / 存到 Download 三条路 + 拒绝路径（确定性，不需要真机）。
//
//   node probe/files-action.test.mjs
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = process.env.CODEX_GUI_PORT ?? "8899";
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : `  <- ${detail}`}`);
};

async function act(action, path) {
  const response = await fetch(`http://127.0.0.1:${PORT}/api/files/action`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, path }),
  });
  return { status: response.status, data: await response.json().catch(() => ({})) };
}

const scratch = mkdtempSync(join(homedir(), "tmp", "artifact-"));
const file = join(scratch, "note.txt");
writeFileSync(file, "artifact payload\n");

try {
  const saved = await act("saveToDownloads", file);
  check("存到 Download 成功", saved.status === 200 && saved.data.ok === true, JSON.stringify(saved.data));
  check("目标真的出现在 /sdcard/Download/codex-gui", existsSync(saved.data.path), String(saved.data.path));
  check("复制后的内容一致", readFileSync(saved.data.path, "utf8") === "artifact payload\n");

  const opened = await act("open", file);
  check("打开（交给系统应用）成功", opened.status === 200 && opened.data.ok === true, JSON.stringify(opened.data).slice(0, 160));
  const shared = await act("share", file);
  check("分享（--send）成功", shared.status === 200 && shared.data.ok === true, JSON.stringify(shared.data).slice(0, 160));

  const unknown = await act("deleteEverything", file);
  check("未知动作被拒绝", unknown.status === 400 && /Unsupported file action/.test(unknown.data.error || ""), String(unknown.data.error));
  const outside = await act("open", "/data/local/tmp/whatever.txt");
  check("允许根之外的路径被拒绝", outside.status === 400, JSON.stringify(outside.data).slice(0, 120));
  const directory = await act("open", homedir());
  check("目录不能被当成文件打开", directory.status === 400, JSON.stringify(directory.data).slice(0, 120));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
