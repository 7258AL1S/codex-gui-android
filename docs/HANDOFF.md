# HANDOFF.md — 交接说明

写给**接手这个项目的下一个会话**（可能是你，也可能是浏览器里的那个新会话）。
目标：读完这一份就能接着干，不用从我之前的对话里反推。

最后更新：2026-10-14

---

## 1. 这是什么项目

给 Codex CLI 做一个**在 Android 手机上用的 GUI**，以 Termux 里的 `codex app-server` 为后端，
交互与视觉参考 Codex 桌面端。近期交付形态是 **WebUI**（用户 2026-10-14 决策），APK 后置但不取消。

文档地图（都在本目录）：

| 文件 | 作用 |
|---|---|
| `FEATURES.md` | 功能对照表（桌面功能 → 手机交互 → 后端来源 → 状态 → 验收 → 限制与证据） |
| `PLAN.md` | 阶段计划 P0–P9 + 端到端验收清单 + 用户决策记录 + 暂缓问题 |
| `VERIFICATION.md` | 证据库 E1–E48，**每条都带命令或类型出处**；已实测 / 协议已核实（静态）分开标注 |
| `PATCHES.md` | 对上游 codex-webui 的全部改动 + 可重放顺序 |
| `RESEARCH-codex-mobile-gui.md` | 最初的调研报告（v2，含修订记录；v1 存档在 `archive/`） |
| 本文件 | 接手须知：怎么操作、什么已验证、有哪些坑 |

---

## 1.5 APK（P9，2026-10-16 起为交付形态）

> **发布约定（用户 2026-10-16 要求，长期有效）：每次产出新 APK 都要发一个 GitHub Release。**
> 一条命令：`cd ~/codex-gui-github && scripts/release-apk.sh`（构建 → 提交版本号 → 打 tag → 建 Release → 传 APK）。
> 仓库：<https://github.com/7258AL1S/codex-gui-android>（public，Apache-2.0）。
> 说明与"发布后自检"清单见仓库的 `docs/RELEASING.md`；**APK 不进 git**，只作为 Release 资产。

> 交付目录（`/sdcard/Download/codex-gui/`）里还有一份面向使用者的
> **`INSTALL.md`**：安装前提、覆盖安装、回滚、卸载要清什么、四类故障看哪个日志。发给别人/自己重装时先看它。

### 启动自检（E139，别绕开它排障）

设置 → 配置 最上面是「启动自检」，数据来自 `GET /api/setup`：**Android 侧事实由应用上报**
（`POST /api/setup`：Termux 装没装 / RUN_COMMAND 授权 / 通知是否被禁 / 版本），
**Termux 侧事实由桥现查**（`~/bin/codex-gui-web`、termux-api 四项、codex 版本、状态目录可写、兜底唤醒作业）。
它明确区分"查不到"和"没有"（应用没上报过时写"打开一次应用就会上报"）。

**注意**：判断命令是否存在**不要用 `which`** —— 本机没有这个命令，`execFileSync` 抛错被吞掉会让每项
都变成 null，看起来像"termux-api 全没装"（E139 第一次跑就中招）。桥里用的是按 `~/bin` 与 `$PREFIX/bin` 解析。

```sh
sh ~/android-build/codexgui/build.sh --install   # 构建 + 签名 + 复制到 /sdcard/Download/codex-gui/
```

- 包名 `dev.termux.codexgui`；**每次构建自动同时加 `versionCode` 和 `versionName` 的补丁位**
  （0.1.0 → 0.1.1 → …）：前者是 Android 覆盖安装的前提，后者让用户一眼看出装的是哪一版。
  产物名同样带版本号 + 秒级时间戳。**应用里能确认版本**：前台服务通知标题是
  `Codex <versionName>`，启动页右下角也写 `v<versionName>`（用户 2026-10-16 明确要求）。
- 本机没有 Gradle/AGP，走手工流水线：aapt → `javac --release 11` → d8 → zip → apksigner
  （android.jar 在 `~/android-build/android-35/`，keystore 复用 CodexBridge 的 debug.keystore）。
- 源码：`~/android-build/codexgui/`（`MainActivity` WebView 壳、`BridgeService` 前台服务、`BridgeClient` Termux 交互）。
- 应用侧依赖：Termux + `~/bin/codex-gui-web` + `allow-external-apps=true` +
  **手动授予一次 `com.termux.permission.RUN_COMMAND`**（缺权限时应用会明确提示并给跳转按钮）。
- **APK 的价值不只是"有个图标"**：前台服务持有设备级 PARTIAL_WAKE_LOCK，这正是 WebUI
  形态做不到、而 E100 证明必需的那件事（屏幕熄灭 → 整台设备睡眠 → 流式输出断在半路）。

### 启动桥的判定（0.3.5 起，E135 —— 别退回去）

用户报过"点开应用一直转圈，打开 Termux 就好了"。根因是启动判定用错了信号：
`BridgeClient.isPortOpen()`（一次 TCP connect）在 **Termux 进程被系统冻结**时**也是 true** ——
监听 socket 还在内核里、握手由 backlog 完成，但没有任何代码去 accept。旧逻辑看到"端口开着"
就既不重发启动请求也不叫醒 Termux，干等 90 秒。

现在的规则（改这三处时请一起看）：

1. **存活用 HTTP 应答判断**（`BridgeClient.health()`），不是端口；
2. 端口开着也**照常发启动请求**；
3. HTTP 静默满 **8 秒** → `wakeTermux()`（把 Termux 切前台 + 再发一次分享启动），此后每 20 秒一次；
   界面写"正在把它切到前台解冻并重新启动…"。**只在 HTTP 静默时抢前台** ——
   桥自己在慢启动（`ready after 13s/15s` 那种，HTTP 已应答）不该把用户切走；
4. 抢过前台、桥就绪后，发一条原生通知「Codex 已经就绪，点这里回到应用」：
   Android 12+ 不允许应用从后台把自己拉到前台，别硬闯也别假装没这回事。

桥侧的数字供参考：真起来的桥 `START +766ms connected (ready=true)` —— 慢的是"没在跑"，不是"跑得久"。

**复现/回归这件事故的夹具**：`node probe/zombie-listener.mjs 8899`（占住端口但永不回答 HTTP =
被冻结进程的样子），`--check` 会自证"TCP 通、HTTP 不通"。用它 + `adb shell am start` 就能重放
"打开应用一直转圈"的场景（完整步骤与实测数字见 VERIFICATION.md E135）。

### "端口有人 listen 却完全不应答" = 冻住的监听（E140，非常好用的判别法）

**`curl` 的退出码把两种情况分得很干净**：

- **7 = 连接被拒** → 端口空着（桥还没绑定，属于"正在启动"）；
- **28 = 连上了但没回应** → 有监听听在内核里、没有代码 accept（**冻住的旧桥**），等多久都不会好。

`~/bin/codex-gui-web` 现在就用它决定"要不要白等 25 秒"：28 就跳过等待、直接按卡死重启，
而且**只收掉按 cmdline + cwd 匹配到的本项目 `server.ts` 进程**（不是我们的就只警告不动手，
日志里写 `port … is occupied by a silent listener that is not ours`）。

效果：夹具复现下 `start` **78s → 5s**；真机上"打开应用 + 冻住的桥" **35~37s → 8s**
（APK 日志 `apk: boot: ready after 6s`）。另一件要记住的事：这个尾延迟的根因在 Termux 侧的启动脚本，
**不在** APK 的探测频率 —— 所以修的是脚本，不是把重试调得更密。

夹具：`cd ~/codex-gui/app && node ~/codex-gui/probe/frozen-bridge-lookalike/server.ts`（文件名与 cwd 都像真桥）。

### 自己装包的正确顺序（2026-10-16 实测，2026-10-16 01:14 起可用）

`termux-open <apk>` **必须先让 Termux 在前台**，否则 Android 直接忽略
"后台启动 Activity"（表现为：命令返回成功、屏幕毫无变化——这也是为什么最初几次自动弹安装界面失败）。

```sh
bin/codex-bridge open com.termux      # 1. 把 Termux 拉到前台
sleep 3
termux-open /sdcard/Download/codex-gui/codexgui-<ver>-<stamp>.apk   # 2. 这时才允许
sleep 12                              # 3. 等 HyperOS 校验
bin/codex-bridge tapText 继续更新      # 4. 点确认（对话框：继续更新 / 取消更新）
```

装完对话框会变成「完成 / 打开」。**用这个流程在 01:14 把 0.1.2 升到了 0.1.3。**
确认装成功看两处：安装器对话框的「版本：x -> y」，以及应用自己上报的
`apk: boot: … version=<versionName>`（0.1.3 起带这个字段）。

### adb（2026-10-16 打通，比上面那条更可靠）

```sh
./bin/adb version                        # wrapper：把 $PREFIX/lib 前置到 LD_LIBRARY_PATH，见下
./bin/adb start-server
node $TMPDIR/scan.mjs                    # 扫回环端口找 adbd（本版 adb 无 mDNS）
./bin/adb connect 127.0.0.1:<port>       # 端口每次重开无线调试都会变
./bin/adb install -r /sdcard/Download/codex-gui/codexgui-<ver>.apk
./bin/adb shell am force-stop dev.termux.codexgui && ./bin/adb shell am start -n dev.termux.codexgui/.MainActivity
```

**adb 在 Codex 会话里原本是坏的**（`cannot locate symbol _ZNSt6__ndk113__hash_memoryEPKvm`）：
Codex CLI 把 `…/codex-cli-termux/bin` 塞进 `LD_LIBRARY_PATH`，那里有个**旧 libc++_shared.so**，
链接器先找到它 → 缺符号。`~/bin/adb` 把 `$PREFIX/lib` **前置**修好。
同理，任何"会话里跑报错、自己手动跑正常"的 Termux 二进制先查这一条（E110）。

---

## 2. 现在的运行状态与操作方式

### 通知（2026-10-16 起由应用自己发，别改回 Termux）

- agent 侧只调 `~/bin/codex-notify -t … -c … -i codex-status`（两层 `AGENTS.md` 都已改）；
  应用在跑 → 桥广播 → 页面 → `CodexNative.notify()` → **应用原生通知**（渠道 `codex-app`）；
  应用没在跑 → 自动退回 `termux-notification` 兜底。
- 页面自己的"回合完成"提醒也走同一条原生出口。
- "应用在跑"是**租约**（页面 30 秒续、桥侧 90 秒过期），不是计数器——
  计数器会在桥重启后归零、在页面重复注册时虚高，最坏情形是通知发给空气且不再兜底。
- 细节与实测见 `VERIFICATION.md` E116。

```sh
~/bin/codex-gui-web start|stop|restart|status|log|url   # 桥的启停与观测
~/bin/codex-gui [resume <threadId>]                      # 打开接了桥实例的 CLI
```

- 桥：`http://127.0.0.1:8899`（仅回环），宿主实例的 app-server 在 `ws://127.0.0.1:8901`
- capability token：`~/.codex/codex-webui/ws-token`（0600，**不要打印到聊天/截图里**）
- 日志：`~/.codex/codex-webui/bridge.log`（含浏览器 RPC 的到达与失败记录）
- `~/bin/codex-gui` 是**桥启动时自动生成**的（生成模板在 `app/server.ts` 的 `installLauncherScript()`）。
  要改启动器就改模板，直接改文件会被覆盖。

健康检查：`curl -s http://127.0.0.1:8899/api/health` → 期望 `{"ok":true,"codex":true,...}`。

### 桥会「自己消失」，这是正常现象（E62）

桥只是一个跑在 Termux 应用进程里的普通进程：**应用进程被系统回收（隔夜、清理后台、重启设备）时，
它会一起消失**，而且日志干净、没有任何报错。数据不会丢（会话都在磁盘上），`codex-gui-web start` 即可恢复。

目前**没有任何机制自动把它拉回来**。可选方案与代价见 `VERIFICATION.md` E62
（`.bashrc` 自动启动 / `termux-wake-lock`（留常驻通知）/ `termux-services` / Termux:Boot）。

---

## 2.5 ReVa（Ghidra MCP server）：本机的逆向工程能力（2026-10-16 加，E131）

用户提出"试试那个能逆向一切的 ReVa，好像有 MCP 服务器"→ 已在本机装好并接进 app-server。
它同时补上了两件事：**设置页 MCP 面板终于有真实对象**（之前 `mcpServerStatus/list` 一直是空表），
以及**模型手里真的多了一组逆向工具**（86 个，实测能导入 ELF、分析、反编译）。

怎么用（三条命令）：

```sh
~/bin/reva-server start          # 起 Ghidra + ReVa MCP（约 45 秒就绪；监听 127.0.0.1:8080）
~/bin/reva-server status|log     # 状态 / 日志（~/.codex/reva-server.log）
~/bin/reva-server stop           # 用完就停（JVM 常驻，别一直挂着）
```

config 里已经有一行（`codex mcp add reva --url http://127.0.0.1:8080/mcp/message` 写的）：

```toml
[mcp_servers.reva]
url = "http://127.0.0.1:8080/mcp/message"
```

改完 config 不用重启 daemon：设置 → 插件页的「重新加载 MCP 配置」按钮，或协议 `config/mcpServer/reload`。
**服务没起来时**这行就是一条连不上的配置：`mcpServerStatus/list` 里会看到它、`runtimeStatus` 为空/失败，
模型调工具会失败——所以要么 `reva-server start`，要么 `codex mcp remove reva`。

验证脚本（都在 `probe/`）：

- `node probe/reva-mcp-live.mjs --tool-call` → 重载 + 状态 + `mcpServer/tool/call` 真调用；
- `node probe/reva-model-turn.mjs` → 真起一个回合，让模型用 `mcp__reva__*` 反编译 `~/tools/reva-test/target`。

三件要知道的事：

1. **Ghidra 官方发行包没有 aarch64 的原生 decompiler**，现在跑的是**本机自编**的
   （源码就是发行包里的 cpp，改了 Makefile 的 arch 分支；`~/tools/decompiler-build/`）。
   重装/升级 Ghidra 时要重做，见 `PATCHES.md` 的「环境侧改动」表。
2. 官方 headless 启动器走 PyGhidra/JPype，本机 Python 3.14 没有对应 jpype wheel →
   我们直接起扩展里的 Java 类（`~/tools/reva-server/RevaServerMain.java` + `~/bin/reva-server`）。
3. **不随开机自启**，也没集成进 APK；要"点一下就有"得单独设计（见 PLAN 的开放项）。

---

## 2.6 定时任务（P8，2026-10-16 加，E132）

设置 → **Automation**。后端是桥自己的 `/api/automation` —— **协议里没有任何调度方法**，
所以调度、记录、漏跑补跑全是桥实现的（`app/automation-service.js`）。

- 状态文件：`~/.codex/codex-webui/automation.json`（任务 + 最近 200 条运行记录；原子写）。
  它是桥自己的状态，**不要**和用户 `~/.codex/config.toml` 混。
- 语义（写在这里是因为很容易踩）：
  - **时间槽幂等**：`<jobId>@<本地时间 YYYY-MM-DDTHH:MM>` 一个槽只跑一次，重启不会重复；
  - **补跑只补最新一个**（`catchUp=runOnce`），更早的错过记成 `skipped` 并写明原因；
    `skip` 是一个都不补、**但照样记账**；
  - 扫描间隔 30s、并发上限 2、回合超时默认 30 分钟（超时 `turn/interrupt` 并记 `timeout`）；
  - 桥被冻结/回收时**到点不会触发**（这是 Android 的限制，不是 bug）。桥回来时 `initialize()`
    之后会自动跑一次 `sweep("startup")` 结账。
- 验证脚本：`node probe/automation.test.mjs`（离线 39 项）、`node probe/automation-page.test.mjs`
  （页面 31 项）、`node probe/automation-live.mjs`（真桥：建一个两分钟后的任务等到点，再删干净）。
  - 「继续某个会话」现在是**真实选择器**（`thread/list` 拉最近 50 条，patches/0099/E137）；
    拉不到列表会退回手填并写出原因，不会给一个空下拉框。
  - 定时回合遇到审批/提问：请求一到就记 `run.awaiting` + 立刻发**带会话深链**的通知，
    页面显示「等待你审批/回答」并可「打开会话」（patches/0100/E138）。
    **注意**：真机尝试过 `default` 档写工作区外，后端**没有**发审批请求（E126 同源），
    所以这条路的"触发"没被真机观察到，靠单元 + DOM 测试钉住。
  - 已知未做：任务行不反查会话标题（只显示 id 前 8 位）。

### 兜底唤醒（别再说它"没接入"）

`termux-job-scheduler` 里挂着一个 15 分钟周期的作业（job id **4711**）跑
`~/bin/codex-gui-watchdog`：补 `termux-wake-lock`，桥没 ready 就 `codex-gui-web start`。
它从 2026-10-15 起就在跑（`watchdog.log` 里 136 次运行，每小时 6~8 拍；E136 见过它把桥拉起来）。
桥的 `GET /api/automation` 会带一个 `wake` 字段（作业列表 + 最近运行 + 总次数），
设置 → Automation 里显示的就是它；缺注册可以用页面上的「立即注册」补装
（`POST /api/automation {action:"wakeInstall"}`，复用 job id 4711）。
**限制**：最小周期 15 分钟、没有绝对时刻保证 —— 桥不在过的时候，任务最多晚约 15 分钟才结账。

---

## 3. 怎么改代码（上游是 codex-webui，MIT）

> **纪律：`server.ts` 的改动需要重启桥，而重启会打断用户正在看的页面**（页面断开几秒，
> 用户看到的就是"等待桥响应"，还可能被误判成系统冻结——E117 就是这么发生的一次）。
> 所以：需要重启的改动**攒到一起**，重启前确认没有正在跑的回合；纯前端改动一律
> `bun build` + 刷新即可，不要重启。

- 工作副本：`app/`（解包自上游 2026-10-04 的 `main`）。
- `app/public/app.js` 是**超长单行**，`apply_patch` 常常匹配不上 → 用 `patches/NNNN-*.mjs` 脚本做精确替换。
- **补丁脚本必须真幂等**：如果替换文本本身包含锚点，`skipIf` 标记是必需的，
  否则重复执行会插两遍（0008 就踩过，已加去重规则）。
- 改完前端要重建 bundle：`cd app && bun build public/app.js --target=browser --outfile=public/app.bundle.js`。
  `style.css` / `index.html` 是静态文件，改完刷新即可。
- **必须有 bun**：`node server.ts` 跑不起来（Node 的类型剥离不做 `.js`→`.ts` 映射）。
- 测试：`node probe/*.test.mjs`。当前 **9 套全绿**（approval-model / interaction-surfaces /
  model-catalog / model-display / overlay-back / security-auth / request-registry /
  submit-gate / upload-service）。
- 端到端探针（要桥在跑）：`probe/p4-attachments.mjs`（附件接口）、
  `probe/p4-attachment-turn.mjs`（附件真的进模型）、`probe/p4-acceptance.mjs`（P4 验收链路）。
  默认打 `http://127.0.0.1:8899`，用 `BASE_URL=` / `BRIDGE_URL=` 可以指向别的实例。
- **对构建产物断言要用格式无关的正则**：bun 会重新排版（加空格、单引号改双引号，见 E41）。

---

## 4. 已验证 / 未验证（不要越界宣称）

`PLAN.md` 顶部有勾选约定：`[x]` = 有实测证据；`[~]` = **代码已实现 + 单测通过，但运行时/真机未验证**
（不算通过，只是不再计入"未开工"）。

几条容易搞错的：

- **实时共享有前提**：同一实例内，「另一侧实时看到你的回合」**要求对方已打开（resume）那条线程**。
  不打开只会收到极少数全局事件（E47 实测）。
- **`interrupted` 不等于真被打断**，它只是读取方看不到完成事件时的兜底标记（E48）。
- **两个 app-server 实例并存**：浏览器走桥的实例，普通 `codex`（含本会话）走 managed daemon，
  互不可见进行中的回合（E46）。用 `codex-gui` 开才会进同一个实例。
- 审批按钮**只能发 `availableDecisions` 里列出的值**；该字段**不在生成的 TS 类型里**，只在 wire 上（E29）。
- `thread/revert` **只改对话历史，不回退文件**（E12）。
- `command/exec{tty:true}` 是集成终端的正道，不需要 node-pty（E11，尚未运行时验证）。

---

## 5. 环境与工作约定（用户明确要求）

- 用中文沟通；命令、错误串、路径保留英文原文。
- **每轮回复结束前必须发一条手机通知**（固定 `-i codex-status`，默认渠道，不传 `--channel`；
  正常完成用「Codex ✅ 完成」，需要用户确认用「Codex ⚠️ 需要确认」；每轮只发一条；返回非 0 要说明）。
- 结论必须有证据；**未执行过的测试不许标通过**；做不到的事说清楚限制与替代路径，不用假数据或空按钮。
- 产出交付到手机：文档镜像到 `/sdcard/Download/codex-gui/`；截图在 `/sdcard/DCIM/Screenshots/`；
  用户会通过 `/sdcard/Download/CodexInbox/` 递文件。
- 不要把常驻通知 / 防杀 / wake-lock / 探测脚本留在设备上跑过任务需要。
- `termux-open` 的 `exit=0` 只代表广播已发出，不代表真的打开了。

## 6. 这个环境里的坑（都踩过）

| 坑 | 现象 | 对策 |
|---|---|---|
| 沙箱拒绝 `rm -f` | 命令被拒（`rm -f style commands are not permitted`） | 用普通 `rm` / `rm -r` |
| 补丁脚本的幂等标记**跨文件共用一个** | 标记只存在于其中一部分文件里 → 其余文件被**重复追加**（E134：CSS 块与 `saveUploadStream` 各多一份，后者会让桥启动 `SyntaxError`） | 一个文件一个标记，且标记必须是补丁自己写进去的串；跑完再 `rg -c` 复核份数 |
| Termux libc++ 的 `__hash_memory` | 用到 `std::hash<std::string>` 的程序**链接能过、运行时报** `cannot locate symbol _ZNSt6__ndk113__hash_memoryEPKvm`（`libc++_shared.so` 里它明明是 `GLOBAL DEFAULT`；`LD_PRELOAD` 同一个 `.so` 又能跑） | 自己补一个定义再链进可执行文件（`~/tools/decompiler-build/hash_memory_shim.cc`），或运行时 `LD_PRELOAD=/data/data/com.termux/files/usr/lib/libc++_shared.so`。踩于 E131 自编 Ghidra decompiler |
| `pkill -f` / `pgrep -f` 自匹配 | **把自己的 shell 杀掉**（exit 143） | 排除 `$$` 与 `$PPID`；或用 `[0]` 括号技巧 |
| `setsid` 会先 fork | `$!` 记到的是已退出的中间进程，状态误报 | 别靠 `$!`，按 `cwd` 找进程 |
| `/tmp` 不可写 | `mktemp` 失败 | 用 `$TMPDIR`（`/data/.../usr/tmp`） |
| 打包器重排版 | 对 bundle 的子串断言全 FAIL | 用空白/引号容错的正则 |
| 子进程孤儿占端口 | 桥崩溃重启刷屏（`Address already in use`） | 启动时复用已有实例 + 指数退避（已实现） |
| **测试实例改掉用户启动器** | 用 `PORT=8893` 起的临时实例把 `~/bin/codex-gui` 改指到 8893/8895（E83） | 启动器现在**只由默认端口的实例**安装；测试实例不再插手 |
| **前端一行 `null.onclick=…` 打死整个页面** | 静态标记全在、JS 全死：不能发消息、不能传附件、刷新忽快忽慢（`dcl=21782ms`），而日志里 `app.bundle.js` 每次都在重新下载——看起来像缓存问题（E86） | 改完 `public/*.js` 或 `index.html` 后**必跑 `node probe/dom-contract-audit.mjs`**；接线一律 `const el=…; if(el) …`；日志里认启动指纹 `bundle evaluated to end`（没有它就说明模块没跑完） |
| **同一份 HTML 会走两条分支** | 从外部 App 打开（`termux-open-url`、通知、链接）时顶层文档是 `Sec-Fetch-Site: cross-site`，会被判未授权 → 走"登录墙"分支原样返回 HTML，**既没有构建戳也没有访问日志** | 已抽出 `stampIndexHtml()`，两条分支都注入 `?v=` + meta + 内联 beacon；`doc … authorized=… site=…` 会打出真实判定 |
| **只要浏览器在前台用页面，Termux 就被系统冻结** | 页面加载等几十秒到几分钟、`127.0.0.1 拒绝连接`、点击无反应、日志里的 `client:` 行成串晚到（最多见过 1.85 小时） | `codex-gui-web start` 会取 `termux-wake-lock`（`stop` 释放）。实测：不持锁 `sleep 45` 跑成 585 秒，持锁 `sleep 40` 就是 40 秒（E87）。**别再把这类症状当成前端 bug。** |
| **"我改了代码但浏览器没变"——真凶是桥的 gzip 缓存**（E120） | 磁盘上是新 bundle、桥日志也确实读了新文件（长度、`enc=gzip` 都对），**发出去的却是上一次构建的字节**。失效条件只有 `compressed.size !== body.length`，注释里的 mtime 从没参与判断；两次构建**长度恰好相等**（只改两个数字）时就永远重放旧字节 | 已修（patches/0058，缓存带 `mtimeMs`）。**改完前端先自查再断言**：`curl -s --compressed http://127.0.0.1:8899/app.bundle.js …` 对内容，或看静态日志的 `mt=<mtimeMs>` 与 `stat -c %Y` 是否一致。页面侧本来就没缓存问题（`?v=Date.now()` + `LOAD_NO_CACHE`） |
| **`am force-stop` + `am start` 不等于"页面会重载"** | 观感上像重载（画面回来、滚动位置还在），但页面可能仍是旧文档 → 拿它做"改动是否生效"的判据会得出错误结论（E119 排查里就绕了一圈） | 用应用自己的重载动作：`./bin/adb shell am start -n dev.termux.codexgui/.MainActivity -a dev.termux.codexgui.RELOAD`（走 `onNewIntent` → `webView.reload()`），然后在该动作之后的第一条 `static /app.bundle.js` 日志上确认 |
| **`display:flex` 会盖掉 `[hidden]`** | 面板明明 `hidden` 却显示、和别的面板叠在一起（Git 面板 E121、文件面板查看器 0069 都撞过） | 自己写的组件类如果设了 `display`，就要补一条 `.<class>[hidden]{display:none}`；上游 `.icon-button` 也吃这一条（保存按钮靠它藏） |
| **幂等标记不能是"上游也有的字符串"** | 0067 用 `kind==='files'` 当标记（上游底部面板里有）→ 四步接线被整段跳过，代码进了文件但功能没接上，真机表现是"点了还走老分支"（E121） | 标记必须是**本补丁引入**的字符串（如 `const filesPanelMarker=null;`）。PATCHES 里 0018/0019 记过同类坑 |
| **fileChange 的 path 是绝对路径** | 撤销报 `unsafe path`（`git apply` 只认仓库内相对路径）；同一条事实有**三条入口**（实时 `item/completed`、读会话补录 `recordReviewDiffsFromRpc`、回源重建），只改一两条不够（E122） | 合成 diff 前统一走 `reviewDiffFromChanges()`（按仓库根裁相对路径）；`add` 的 `diff` 是**整份内容**、`update` 是**无头部 diff 主体**，hunk 头与 `+` 前缀要自己补 |
| **手机上驱动 UI 的两个坑** | 坐标总是差一行：① 软键盘开/关会改面板高度（launcher 是垂直居中的）；② 面板打开时可能记忆着上次的视图（不是 launcher） | 每次点击**先截图再算坐标**（`magick -crop` 出设备坐标区间再看一眼）；点击前先确认当前视图与键盘状态；别用连按返回键——会把 App 退出到桌面（我的输入曾因此落进 Termux 里的 CLI 输入框，差点误发） |
| **别把孩子的 stdout 当就绪信号** | 桥原来靠 `[codex app-server] listening on:` 这行字判断"可以连了"。而 `spawn(..., stdio:['ignore','pipe','pipe'])` 下 stdout 是**块缓冲**：那行字晚 6 秒才到（E124 实测），app-server 其实 600ms 就能服务 | 启动阶段看 `START +Nms` 打点（patches/0077）；要判断端口可用就**探端口**（HTTP `/readyz` 或直接连 WS），不要读文本 |
| **桥的启动会"被自己人打断"** | `startCodex()` 有 1.2 秒 adopt 窗口，这期间 `codex` 仍是 null；页面重连时的每个 RPC 都会再触发一轮 adopt→spawn → 多个 app-server 抢端口 → 桥把自己刚起的那个杀掉重起 → 启动看起来要十几秒（E124） | 启动路径一律**单飞**（`bridgeStartInFlight`）；`~/bin/codex-gui-web` 也有 `start-lock`（App 服务每 60 秒 + `.bashrc` 每个 shell + 手敲命令三个来源） |
| **无线调试的端口会变，旧端口的表现是 `offline`** | 重开无线调试后 `127.0.0.1:<旧端口>` 一直 offline/not found；我按旧端口连、排查时误以为是别的问题，白绕一圈（E129/E130 两次） | 用 `~/bin/adb-connect`：扫回环端口→逐个 connect→只认最终状态是 `device` 的那个并打印出来。注意**设备锁屏时也会 offline**（需要解锁） |
| **插件市场的清单格式（官方 schema 未公开）** | `marketplace/add` 对本地目录报 `marketplace root does not contain a supported manifest`；逐次试错才收敛 | 清单固定 `<root>/.agents/plugins/marketplace.json`；插件项 `{name, source}`，`source` 相对**市场根**；插件目录要 `.codex-plugin/plugin.json` 且带 `$schema`（agent-plugins 1.0.0）；`marketplace/remove` 的参数名是 `marketplaceName`（E130） |
| **特性开关 ≠ 工具可用** | `experimentalFeature/list` 里 `browser_use`/`computer_use` 都是 `enabled=true`，容易误以为能用；真跑回合才发现模型手里根本没有这两个工具（它自己查 `codex mcp list` 得"无 MCP 服务器"） | 判断"某个工具能不能用"必须**让模型实际调一次**（或看 MCP/工具清单），不要据特性表下结论（E130） |

## 7. 下一步该做什么（按计划）

**P0–P6 已完成**（P6 见 PLAN 与 E121–E123）。**下一步是 P7**：设置与扩展（模型/provider、
账户与用量、权限/沙箱、Skills/MCP/插件、产物查看下载分享、通知深链、拍照与分享入口）。
其中"权限与沙箱要实测是否真的生效"是用户点名的硬要求。

**P6 明确没做完的三件事**（不许当已完成）：

1. **审查目标（分支对比 / 指定提交）**：`review/start` + `ReviewTarget` 未接；
2. **行内审查定位**：`MemoryCitationEntry{lineStart,lineEnd}` 仍未渲染、不跳行；
3. **终端旋转/横屏布局**：手机旋转没测过（协议层 resize 已验）。

另外两件长期待办（用户点名）：

- **历史产物缺失的呈现**（E44）：产物被删后图片取不到，界面现在只给"破图 + 文件名"。
- **通知出口抽象化**：已完成（E116，改由应用发原生通知）。

## 8. 暂缓的决定（用户要求先记录）

- **浏览器与终端的实例合并**：方案 1（用 `~/bin/codex-gui` 开 CLI）已实现并验证；
  但**本对话所在实例无法迁移**。用户表示「之后再说」。
  若将来要让浏览器接手某条对话：等当前回合结束 → 终端退出该会话 → 再在浏览器打开，
  任何时刻只保留一个写者。

---

## 9. 最新状态快照（2026-10-14 傍晚，交接时点）

### 进度

| 阶段 | 状态 |
|---|---|
| P0 版本与协议基线 | 基本完成（仅剩 `experimentalApi` 开关对比） |
| P1 架构验证 | **三项全部通过**（E47 订阅语义 / E49 不串台但不去重 / E50 断线可恢复） |
| P2 桥内核 | **四项全部完成**（E52 鉴权硬化 / E53 审批去重 / E54 待答可恢复 / E55 提交闸门） |
| P3 会话与项目 | **完成**（重命名/分叉/归档/恢复/服务端搜索/归档视图/置顶/compact，E56–E61） |
| P4 对话与工具活动 | **收尾中**：验收链路通过（E64）；模式切换协议+UI+行为三层验证（E66/E69）；消息排队已接（E72/E73，但"运行中排队真被挂住"未实测）；**附件**接口+协议端到端通过（E82）；**E86 修好了"页面根本不跑"**（`dcl` 21782ms → 232ms，全链路启动指纹齐全）；**剩：真机点一次选择器的视觉验收、项目创建入口、`memoryCitation`** |
| P5 交互闭环 | 未开始（legacy 审批渲染、等待态视觉提示、并发审批） |
| P6–P9 | 未开始 |

### 交接时点必须知道的八件事（血泪）

1. **改前端或白名单后，必跑 `node probe/allowlist-audit.mjs`**。
   它上线以来抓到 **3 个**「前端调了但桥不放行」的静默失败（`thread/queue/add`、`thread/queue/list`、`project/list`）。
   白名单在 `app/server-security.js`，改完要 `~/bin/codex-gui-web restart`。
   现在它有 **4 项**：白名单 vs 服务端、服务端有而我们没有、前端调用的方法是否放行、
   **前端引用的 `/api` 路由是否存在**（第 4 项自带自检，确保这个检查真的会失败）。

2. **`codex-bridge find` 不能用来判断小控件是否存在**。
   composer 里那排 chip（任务/高/默认）**根本不进可访问性树**，`find "任务"` 也返回 not found。
   判断界面要用 **`codex-bridge shot` + 看图**。`find` 只适合查页面里的大块文本（会话正文）。

3. **浏览器不在前台时，不能对它做任何操作**。
   `find` 能看到背景窗口的节点（所以"能找到刷新按钮"是假象），但**点击落在前台应用上**。
   我因此空点了好多次刷新。要自测浏览器界面：**请用户把浏览器切到前台**。

4. **有开发期诊断通道**：`POST /api/client-log {message}` → 写进 `~/.codex/codex-webui/bridge.log`
   的 `[codex-webui] client:` 行；前端有 `clientLog()` 辅助函数。
   **前端 JS 的错误与分支结果原本完全不可见**，这条通道是查 UI 问题的唯一有效手段（E78/E79）。
   不需要时可以删掉。

5. **别再怀疑"浏览器缓存了旧 bundle"**：E86 已经把这条路彻底证伪——浏览器一直在跑当次下载的代码。
   页面"能用但什么都不响应"时，第一件事是看日志里有没有
   `client: bundle evaluated to end; controls wired, attachments bound`；
   没有就是模块求值中途抛错，跑 `probe/dom-contract-audit.mjs` 定位，不要再去清缓存。

6. **`project/*` 是用户自定义集合，不是 `cwd` 的替身**。
   当前 `project/list` 为空；分组已实现为**叠加**（有项目用项目、没项目用 cwd，patches/0028）。
   创建接口形状：`project/create {name, roots:[{path}], idempotencyKey}`（协议自带幂等键）。

7. **桥"很慢"之前先看两条日志**：`event loop blocked for ~Nms`（桥自己报的挂起时长）和
   `client: +Δms …`（浏览器发出到桥收到的延迟）。Δ 是几十秒到几分钟 → 就是被系统冻结（E87），
   不是代码问题。冻结不产生错误、`pgrep` 照样查得到进程，解冻后请求成批涌出。

8. **改前端不用重启桥**：静态文件逐个请求读盘，`bun build` 之后浏览器刷新即可（重启会打断正在跑的会话）。
   另外 `app.js` 里凡是"先清空状态再组 payload"的地方都要用**快照**——附件就栽在这上面：
   文件落了盘、消息里却没有它，模型只能靠翻目录找出你刚发的文件（E89）。

9. **卡顿的第一嫌疑是 `termux-wake-lock` 丢没丢**（不是省电策略——用户实测一直是「无限制」，E99）。
   它在 `codex-gui-web stop`/重启时会被释放，而重启后那次 `termux-wake-lock` 失败只打一行 stderr 警告，
   等于静默丢失；丢了的后果就是浏览器在前台时整台设备把 Termux 挂起 20–60 秒（历史最多 24 分钟）。
   自检：`~/bin/codex-gui-watchdog`（每 15 分钟补锁 + 桥不 ready 就拉起，Job 4711）。
   手测：`sleep 60` 看真实耗时有没有漂移。

### 交接后最该做的三件事（P4 收尾）

0. **让用户真机点一次附件**：代码、接口、协议都已验证，唯一还没验的是"手机选择器 → `change` 事件"。
   期望日志：`attachment picked (attachmentPicker): 1 file(s)` → `attachment ready: …`。
   图片走 `#attachmentPicker`，文档走 `#filePicker`（两个 `<label for>`，`accept` 已分开）。
   （重启桥会打断正在跑的回合，所以只在回合之间做。）
1. **项目创建入口**：形状已完全掌握，缺一个"输入名称 + 用当前目录当 root"的交互；
2. **`memoryCitation` 渲染**：协议会带 `MemoryCitationEntry{lineStart,lineEnd}`，界面没画。

（附件那一条已经做完代码与协议验证，只剩上面第 0 步的视觉验收。）

之后进 P5。**每一项都要按 `[x]`/`[~]` 约定标状态**：`[~]` = 代码写完 + 单测通过，但运行时/真机未验证。
