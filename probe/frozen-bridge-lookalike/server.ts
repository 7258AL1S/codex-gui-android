// 夹具：**冒充"被系统冻结的桥"**（E140 的回归用）。
//
// 被冻结的 Termux 进程对外表现是：TCP 连接能建立（内核 backlog 完成握手），但没有任何代码去 accept，
// HTTP 永远不应答。这个文件就干这件事——同时它的**文件名与 cmdline 里带 `server.ts`**、
// 运行时的 cwd 是 `~/codex-gui/app`，因此会被 `~/bin/codex-gui-web` 的 `bridge_pids()` 认成自家桥，
// 从而验证"启动前先把冻住的旧监听收掉"这条逻辑。
//
//   cd ~/codex-gui/app && node ~/codex-gui/probe/frozen-bridge-lookalike/server.ts &
//   ~/bin/codex-gui-web start        # 期望：先打印"发现僵住的监听并收掉"，然后正常起来
import net from "node:net";
import { writeFileSync } from "node:fs";

const port = Number(process.argv[2] ?? 8899);
try { writeFileSync(`${process.env.TMPDIR ?? "/tmp"}/frozen-lookalike.pid`, String(process.pid)); } catch { /* 尽力而为 */ }
net.createServer(() => {}).listen(port, "127.0.0.1", () => {
  console.log(`frozen look-alike listening on 127.0.0.1:${port}（accept 了但永不应答）`);
});
