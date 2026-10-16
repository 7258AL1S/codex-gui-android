// "僵尸监听"夹具：**接受 TCP 连接，但永远不回答 HTTP**。
//
// 这就是 Termux 进程被系统冻结（cached-app freezer）时桥对外表现出的样子：
// 监听 socket 还在内核里，三次握手由 backlog 完成 —— 端口"开着"，但没有代码去 accept。
// 用它来复现/回归 APK 的启动判定（VERIFICATION.md E135）：
//
//   node probe/zombie-listener.mjs 8899 &     # 占住端口，冒充"冻住的桥"
//   adb shell am start -n dev.termux.codexgui/.MainActivity
//   # 期望：8 秒内应用把 Termux 切到前台（而不是像 0.3.1 那样干等 90 秒）
//
//   node probe/zombie-listener.mjs 8899 --check   # 只探测：TCP 通不通 / HTTP 答不答
import net from "node:net";

const port = Number(process.argv[2] ?? 8899);

if (process.argv.includes("--check")) {
  const socket = net.connect(port, "127.0.0.1");
  socket.on("connect", () => {
    console.log(`TCP connect 成功（端口 ${port} "开着"）`);
    socket.destroy();
  });
  socket.on("error", (error) => console.log(`TCP connect 失败：${error.message}`));
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2500) });
    console.log(`HTTP 有应答：${response.status} —— 这不是僵尸监听`);
  } catch (error) {
    console.log(`HTTP 无应答（${error.name}）—— 符合"被冻结"的特征`);
  }
} else {
  net.createServer(() => {}).listen(port, "127.0.0.1", () => {
    console.log(`zombie listening on 127.0.0.1:${port}（接受连接，永不应答）`);
  });
}
