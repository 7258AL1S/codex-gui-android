# Codex GUI for Android（Termux 后端）

把 [Codex CLI](https://github.com/openai/codex) 变成一台 Android 手机上**可日常使用**的图形界面：
一个 WebView 壳 APK + 一个跑在 Termux 里的本地桥 + `codex app-server` 作为执行后端。
交互与信息结构参考 Codex 桌面端（侧栏会话、正文、工具活动、输入区、文件/diff/终端工作区）。

> **English summary** — A mobile GUI for the Codex CLI whose backend runs in Termux on the
> phone itself. An APK (WebView shell + foreground service) talks to a local bridge
> (`127.0.0.1:8899`) which drives `codex app-server` over its **real protocol** (WebSocket or
> stdio), never by scraping a terminal. It targets feature parity with the desktop client and
> documents every verified claim — and every known gap — in `docs/VERIFICATION.md`.

## 它是什么，不是什么

- **是**：真机（Termux aarch64 / Android 16，非 root）上逐步做出来、每一条结论都有实测证据的客户端。
- **不是**：不含 Codex 运行时。APK 里没有模型、没有 CLI；执行后端仍然是你 Termux 里的 `codex`。
  所以 Termux 侧的准备是前提，不是可选项。
- **不假装**：做不到的能力写在 `docs/FEATURES.md` 的"限制与证据"列里（沙箱在本平台不生效、
  官方账户相关能力不可用、某些能力需要 APK 侧另行实现……），没有空按钮。

## 架构

```
APK（WebView 壳 + 前台服务 + 置顶通知）
  └─ HTTP/WS  127.0.0.1:8899
       └─ 本地桥（bun/Node，跑在 Termux 里；浏览器直连会被拒，见 docs/VERIFICATION.md E2）
            └─ 子进程：codex app-server（真正的协议面，WS + capability token）
                 └─ Codex CLI + 你自己的 provider 凭据（沿用现有 ~/.codex，不覆盖）
```

| 目录 | 内容 |
|---|---|
| `app/` | 桥（`server.ts`）+ 前端（`public/`）+ 定时任务调度器（`automation-service.js`）。派生自 codex-webui（MIT） |
| `android/` | APK 源码（`MainActivity`/`BridgeService`/`BridgeClient`）+ 手写构建脚本 `build.sh`（aapt→javac→d8→apksigner，**不需要 Gradle/AGP**） |
| `bin/` | Termux 侧脚本：`codex-gui-web`（起停桥）、`codex-gui`（把 CLI 接到同一个 app-server）、`codex-gui-watchdog`（15 分钟兜底唤醒）、`adb-connect`（无线调试端口扫描） |
| `probe/` | 全部验证脚本（`node probe/*.mjs`），包括离线单测、DOM 级测试、真机端到端 |
| `patches/` | 前端改动的可重放补丁（幂等） |
| `proto-ts/` | 由本机 Codex CLI 导出的 app-server 协议类型（协议基线） |
| `docs/` | 真相文档：`PLAN`（计划与三态进度）、`FEATURES`（功能对照表）、`VERIFICATION`（证据库 E1–E141）、`PATCHES`（补丁与重放顺序）、`HANDOFF`（交接）、`INSTALL`（安装/升级/卸载） |

## 依赖

| 依赖 | 说明 |
|---|---|
| Termux + **Termux:API** | 桥的运行环境；唤醒锁、通知、兜底调度都靠 Termux:API |
| Codex CLI | 提供 `app-server`（本项目在 0.162.1 与守护进程 0.160.0 上验证） |
| bun 或 Node ≥ 22 | 桥进程（实测 bun 1.4.3 与 Node 26 都可） |
| 一个 provider | 官方账户或第三方 provider 都行；本项目全程在第三方 provider 上验证，因此"账户/用量/云任务"这类能力如实标注为不可用 |
| Android ≥ 11（minSdk 30） | APK 侧；无需 root |

## 快速开始

1. **Termux 侧准备**（一次性）：装 Termux:API；`~/.termux/termux.properties` 里
   `allow-external-apps = true` 并 `termux-reload-settings`；把 `bin/` 里的脚本放到 `~/bin/`；
   给应用授予一次 `com.termux.permission.RUN_COMMAND`。
2. **构建 APK**：`sh android/build.sh`（产物在 `android/build/`，脚本会自动递增 versionCode）。
3. **安装并打开**：应用会自己把桥拉起来。进「设置 → 配置 → 启动自检」能看到两侧的事实
   （Android 侧由应用上报，Termux 侧由桥现查），缺什么它会给具体动作。
4. 详细步骤与故障对照表见 `docs/INSTALL.md`。

## 从源码跑

```sh
# 桥（Termux 里）
cd app && npm install                  # 只有一个直接运行时依赖需要它：ws（其余是前端库）
cd app && bun run server.ts            # 或 node --experimental-strip-types server.ts

# 前端改动后重建（桥托管的是静态文件，刷新页面即可）
cd app && bun build public/app.js --target=browser --outfile=public/app.bundle.js

# APK（手写流水线，无需 Gradle/AGP）
sh android/build.sh --install          # 构建 + 签名 + 复制到 /sdcard/Download/

# 验证
node probe/automation.test.mjs         # 离线单测（调度器）
node probe/settings-live.test.mjs      # 设置页渲染（jsdom）
node probe/dom-contract-audit.mjs      # 前端选择器契约
```

## 已经做到什么程度

按功能逐项对照 Codex 桌面端，而不是"能聊天就算"：会话/项目与搜索、流式输出与过程/最终区分、
工具活动（命令输出、退出码、耗时、文件改动、MCP 调用）、审批与**模型提问**卡片、
完整 diff 审查与安全撤销、Git 面板与隔离 worktree、协议 PTY 终端（含手机辅助按键）、
产物预览/下载/分享、通知深链、**自建定时任务**（时间槽幂等、漏跑补跑、暂停恢复、运行记录）、
启动自检，以及可选的 **ReVa（Ghidra MCP）** 接入让模型获得逆向工具。

每一项的证据（日期、命令、原始输出、失败与更正）都在 `docs/VERIFICATION.md`；
计划进度用 `[x]/[~]/[ ]` 三态记在 `docs/PLAN.md`（`[~]` = 代码写完、运行时未验证）。

## 已知限制（复制自文档，不是免责声明）

- **沙箱在本平台不生效**：`read-only` / `workspace-write` 策略下命令照样能写工作区外、照样联网（E126 实测）。
  真正起作用的是审批策略；界面上把它写成"意图声明"而不是边界。
- **桥会被 Android 冻结**（E62/E87/E135/E140）：桥不在时定时任务到点不会触发；应用会自动唤醒
  Termux 解冻，恢复时间实测 8 秒。
- **没有官方账户能力**：用量、限额、云任务、插件市场里的账户相关操作都不可用，界面显示真实原因。
- **相机的实现绕过了 AndroidX**（手写 MediaStore 路径，E141）；APK 手工构建，没有 Gradle/AGP。

## 隐私

`docs/` 里的实测记录包含开发设备的机型、系统版本与本地路径；`probe/` 里的夹具都是合成数据。
如果把这份记录当作个人数据，发布前按需删改即可——技术结论本身不依赖这些标识。

## 许可证

本项目以 MIT 发布（见 `LICENSE`）。`app/` 派生自 codex-webui，其 MIT 许可证与第三方声明
保留在 `app/LICENSE`、`app/THIRD_PARTY_NOTICES.md`。
