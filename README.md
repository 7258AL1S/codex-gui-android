# Codex GUI for Android（Termux 后端）

把 [Codex CLI](https://github.com/openai/codex) 变成一台 Android 手机上**可日常使用**的图形界面：
一个 WebView 壳 APK + 一个跑在 Termux 里的本地桥 + `codex app-server` 作为执行后端。
交互与信息结构参考 Codex 桌面端（侧栏会话、正文、工具活动、输入区、文件/diff/终端工作区）。

> **English summary** — A mobile GUI for the Codex CLI whose backend runs in Termux **on the
> phone itself**. An APK (WebView shell + foreground service) talks to a local bridge
> (`127.0.0.1:8899`) that drives `codex app-server` over its **real protocol** (WebSocket or
> stdio) — never by scraping a terminal. It aims at feature parity with the desktop client, and
> every claim (and every known gap) is recorded with evidence in `docs/VERIFICATION.md`.

---

## 0. 先读这一段（什么是必需的）

| 组成 | 跑在哪 | 必需吗 |
|---|---|---|
| **Termux**（+ Termux:API 应用） | 手机 | **必需**。桥、Codex CLI、会话数据都在这里 |
| **Codex CLI** | Termux 里 | **必需**。提供 `codex app-server` |
| **本仓库的桥**（`app/`） | Termux 里（Node/bun） | **必需**。前面是页面，后面是 app-server |
| **APK**（`android/`，可自己构建） | Android | 可选但推荐。没有它就用浏览器访问 `127.0.0.1:8899` |
| Termux:API 命令行工具（`termux-wake-lock` 等） | Termux 里 | 强烈建议。唤醒锁/通知/兜底调度靠它 |

> 一句话：**APK 里没有模型、没有 CLI、没有执行环境**。它只是界面；真正的执行仍然是你 Termux 里的 `codex`。

### 关于设备与前提

- 本项目的每条结论都在 **Termux aarch64 / Android 16 / 非 root** 上实测（见 `docs/`）。
  Android 版本低一些通常没问题（APK `minSdk 30` = Android 11）。
- 不需要 root，不需要电脑（构建 APK 也在手机上完成）。
- 需要在 Termux 里能跑通 `codex`（官方账户或你自己的第三方 provider 都行，见第 4 步）。

---

## 1. 安装 Termux 和 Termux:API

**不要用 Google Play 里的 Termux**（那个版本已经停止维护，而且和现在的包源不兼容）。
从下面任一来源安装，**两个应用要来自同一个来源**：

- F-Droid：<https://f-droid.org/packages/com.termux/> 与 <https://f-droid.org/packages/com.termux.api/>
- GitHub Releases：<https://github.com/termux/termux-app/releases> 与 <https://github.com/termux/termux-api/releases>

装好后打开 Termux，应该看到一个命令行提示符。下面所有 `$` 开头的命令都在 **Termux 里**执行。

```sh
# 更新包索引并升级（第一次会久一点）
pkg update && pkg upgrade -y

# 基础工具：git / Node / bun / curl / jq / Termux:API 命令行 / zip
pkg install -y git nodejs bun jq curl termux-api zip unzip

# 让 Termux 能访问手机的共享存储（会弹权限框，允许）
termux-setup-storage

# 验证 Termux:API 通了（应该弹一条通知）
termux-notification -t "Termux:API OK" -c "这一条能弹出来就对了"
```

> 如果 `termux-notification` 提示找不到命令，说明 **Termux:API 应用**没装（`pkg install termux-api` 装的是命令行工具，两者都要）。

---

## 2. 允许外部应用在 Termux 里执行命令

这是 **APK 能不能自己把桥拉起来**的前提。编辑（或新建）`~/.termux/termux.properties`，加上一行：

```sh
echo 'allow-external-apps = true' >> ~/.termux/termux.properties
termux-reload-settings        # 让配置立即生效，不用重装
grep allow-external-apps ~/.termux/termux.properties   # 确认写进去了
```

---

## 3. 装 Codex CLI

```sh
npm install -g @mmmbuto/codex-cli-termux
codex --version      # 例：codex-cli 0.162.1
```

> 本项目实测的是 `@mmmbuto/codex-cli-termux`（针对 Termux 的构建）。如果你有别的可用来源也行——
> 唯一的硬要求是 **`codex app-server` 能跑**：`codex app-server --help` 有输出即可。

---

## 4. 配置 provider（模型来自哪里）

Codex CLI 首次使用需要一个可用的模型 provider：

- **官方账户**：`codex login`（按提示在浏览器里完成）；这类账户还能解锁"用量/限额/云任务"等能力。
- **第三方 provider（本项目全程用这种验证）**：在 `~/.codex/config.toml` 里按你的 provider 文档写
  `model_provider` 与 `[model_providers.<名字>]`（`base_url`、环境变量名等）。凭据只放在你自己的环境变量或该文件里，
  **本项目不会读取、不会改写、也不会把它写进日志**。

```sh
# 随便问一句，确认 CLI 自己能跑通（这一步不依赖本项目）
codex exec --skip-git-repo-check "只回复 ok"
```

> 第三方 provider 下，"账户 / 用量 / 限额 / 云任务"这类能力**不可用**是正常的；
> 界面会显示真实原因，而不是转圈或空白（见 `docs/FEATURES.md`）。

---

## 5. 拿到本项目，把脚本放到 `~/bin`

```sh
git clone <你的仓库地址> ~/codex-gui
mkdir -p ~/bin
cp ~/codex-gui/bin/* ~/bin/ && chmod +x ~/bin/*
```

> 桥脚本默认认为项目在 `~/codex-gui`。克隆到别处就导出 `CODEX_GUI_APP_DIR=/path/to/codex-gui/app`。
> 新开的 shell 才会带上 `~/bin` 到 `PATH`（Termux 默认已经包含）。

装了哪些脚本：

| 脚本 | 作用 |
|---|---|
| `codex-gui-web` | **起停桥**：`start` / `stop` / `restart` / `status` / `log` |
| `codex-gui` | 把 CLI 接到**同一个** app-server 上（这样 CLI 和界面共享同一批会话，而不是各起一个实例） |
| `codex-gui-watchdog` | 给定时任务用的兜底：补唤醒锁 + 桥不在就拉起来（第 9 步会挂到系统里） |
| `adb-connect` | 无线调试端口会变，这条命令帮你扫出来并连上 |

---

## 6. 装依赖并第一次启动桥

```sh
cd ~/codex-gui/app
npm install                      # 运行时只多需要一个 ws，其余是前端库
~/bin/codex-gui-web start        # 起桥（内部会 spawn codex app-server）
~/bin/codex-gui-web status       # 应显示"运行中"和健康检查通过
curl -s http://127.0.0.1:8899/api/health
# {"ok":true,"codex":true,"ready":true,...}
```

浏览器（手机上的 Chrome 也行）打开 <http://127.0.0.1:8899> 就能看到界面——这一步不需要 APK。

想让"打开 Termux 就自动起桥"，在 `~/.bashrc` 末尾加上这段（**限流 60 秒**：`.profile` 会 source
`.bashrc`，非交互的 `sh -lc` 也会走到这里，不限流的话每条命令都会试着拉一次；这段必须是 POSIX 语法）：

```sh
if [ -x "$HOME/bin/codex-gui-web" ]; then
  _cgw_stamp_dir="$HOME/.codex/codex-webui"
  _cgw_stamp="$_cgw_stamp_dir/.autostart-stamp"
  _cgw_now=$(date +%s 2>/dev/null || echo 0)
  _cgw_last=$(cat "$_cgw_stamp" 2>/dev/null || echo 0)
  if [ "$_cgw_now" -gt 0 ] && [ $((_cgw_now - _cgw_last)) -gt 60 ]; then
    mkdir -p "$_cgw_stamp_dir" 2>/dev/null
    printf '%s\n' "$_cgw_now" > "$_cgw_stamp" 2>/dev/null
    ( "$HOME/bin/codex-gui-web" start >/dev/null 2>&1 & )
  fi
  unset _cgw_stamp_dir _cgw_stamp _cgw_now _cgw_last
fi
```

---

## 7. 构建 APK（在手机上，不用 Gradle/AGP）

### 7.1 装构建工具

```sh
pkg install -y openjdk-21 aapt d8 apksigner
java -version        # 需要 17+；本机验证的是 OpenJDK 21
```

> `zipalign` **没有独立的包**（`pkg install zipalign` 会报找不到）——它随 `aapt` 一起装；
> `keytool` / `javac` 来自 `openjdk-21`。装完可以用 `command -v aapt zipalign d8 apksigner javac keytool` 一次确认。

### 7.2 准备 `android.jar`

手工流水线只需要 `android.jar`（编译期用），它来自 Google 的 platform 包（约 61 MB）：

```sh
mkdir -p ~/android-build && cd ~/android-build
curl -LO https://dl.google.com/android/repository/platform-35_r02.zip
unzip -q platform-35_r02.zip -d platform-35
# 包内目录层级各版本略有不同，直接找出来复制到约定的位置（构建脚本读的就是这个路径）
mkdir -p ~/android-build/android-35
cp "$(find platform-35 -name android.jar | head -1)" ~/android-build/android-35/android.jar
ls -l ~/android-build/android-35/android.jar     # 27 MB 左右
```

> 已经有 Android SDK 的话，直接 `ANDROID_JAR=/path/to/your/android.jar sh build.sh` 也行。
> 需要的只是**一个平台的 `android.jar`**（本项目在 API 35 上验证）。

### 7.3 准备签名密钥（自签名，用于自己安装）

```sh
mkdir -p ~/android-keys
keytool -genkeypair -v -keystore ~/android-keys/codexgui.keystore \
  -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass android -keypass android \
  -dname "CN=Codex GUI, O=Local, C=CN"
```

> 别名与口令可以自定义，构建时用环境变量传即可（见下）。

### 7.4 构建

```sh
cd ~/codex-gui/android
CODEXGUI_KEYSTORE=~/android-keys/codexgui.keystore sh build.sh
# 产物：android/build/codexgui-<版本>-<时间戳>.apk
# versionCode 与 versionName 每次构建自动 +1（覆盖安装的前提）

# 想顺便拷到 /sdcard/Download 方便点安装：
CODEXGUI_KEYSTORE=~/android-keys/codexgui.keystore sh build.sh --install
```

可覆盖的构建变量：`ANDROID_JAR`、`CODEXGUI_KEYSTORE`、`CODEXGUI_KEY_ALIAS`、
`CODEXGUI_KEYSTORE_PASS`、`CODEXGUI_KEY_PASS`。

### 7.5 安装

- 手机上：文件管理器里点那个 APK（首次要允许"安装未知应用"）；
- 或者用 adb（无线调试）：`adb install -r ~/codex-gui/android/build/codexgui-*.apk`。

---

## 8. 授权，然后第一次打开

APK 要**自己把桥拉起来**，需要拿到 Termux 的一个权限（一次即可）：

```sh
# 方式 A（推荐，命令一行）
adb shell pm grant dev.termux.codexgui com.termux.permission.RUN_COMMAND

# 方式 B：打开应用 → 失败面板上的按钮 → 系统设置里勾选"运行命令"之类的权限项
```

没授权也能用，只是每次冷启动会**短暂切到 Termux**（走"分享给 Termux"通道），界面会提前说明。

打开应用后会发生什么：

1. 应用发一条请求请 Termux 启动桥 → 桥起来（实测约 0.8 秒）；
2. 如果 Termux 被系统冻结，应用等 8 秒后**自动把 Termux 切到前台解冻**并重新请求（实测 8 秒内可用）；
3. 就绪后进界面；如果刚被切走过，会发一条「Codex 已经就绪，点这里回到应用」的通知。

**进「设置 → 配置 → 启动自检」看一遍**：那里把两侧的事实列在一起（Termux 侧由桥现查、Android 侧由应用上报），
缺什么就给具体动作——这是排查"打不开"最快的入口。

---

## 9. 日常使用

| 想做的事 | 怎么做 |
|---|---|
| 起/停/重启桥 | `~/bin/codex-gui-web start｜stop｜restart｜status｜log` |
| 在终端里接着聊同一批会话 | `codex-gui`（接同一个 app-server），`codex-gui resume <threadId>` |
| 看日志（排障第一站） | `~/.codex/codex-webui/bridge.log`（页面/应用的判断也在里面，带 `apk:` 前缀） |
| 定时任务 | 设置 → Automation：时间表、提示词、继续某个会话、补跑策略、运行记录 |
| 让定时任务在桥被杀后还能被唤醒 | 挂 15 分钟兜底作业：`termux-job-scheduler --script ~/bin/codex-gui-watchdog --job-id 4711 --period-ms 900000 --persisted true --network any` |
| 升级 / 卸载 | 见 `docs/INSTALL.md`（覆盖安装要什么、哪些数据在 Termux 侧不会丢、卸载要手动清什么） |

### 常见故障

| 现象 | 先做什么 |
|---|---|
| 打开应用一直转圈 | 应用会自己唤醒 Termux；仍超时就看启动自检。也可以先开一次 Termux 再回来 |
| 界面卡在"等待桥响应" | 桥被系统冻结了：点通知里的「重启桥」，或 `~/bin/codex-gui-web restart` |
| 上传/发送没反应 | 看 `~/.codex/codex-webui/bridge.log`；上传有进度条与"等待桥响应 Ns"的阶段提示 |
| 定时任务没按时跑 | 桥不在时到点不会触发；`~/.codex/codex-webui/watchdog.log` 能看到兜底作业有没有把它拉起来 |
| 应用重启后设置丢了 | 会话/任务/配置都在 Termux 侧（`~/.codex/`），APK 只存 WebView 缓存 |

---

## 10. 从源码开发

```sh
# 前端（桥托管静态文件：改完重建、刷新页面即可，不用重启桥）
cd app && bun build public/app.js --target=browser --outfile=public/app.bundle.js

# 桥（改了 server.ts 需要重启：~/bin/codex-gui-web restart）
cd app && bun run server.ts

# APK（改了 Java 才需要重装）
sh android/build.sh --install

# 验证：全部结论都以这些脚本为准
node probe/automation.test.mjs          # 调度器离线单测（48 项）
node probe/settings-live.test.mjs       # 设置页渲染（jsdom，32 项）
node probe/upload-client.test.mjs       # 上传的客户端行为（假 XHR）
node probe/dom-contract-audit.mjs       # 前端选择器契约
node probe/automation-live.mjs          # 真桥端到端：定时任务到点触发（会真的起一个回合）
```

改前端/桥请按 `docs/PATCHES.md` 的顺序重放：`patches/` 里每个脚本都是**幂等**的（重复跑会 `skip`）。

---

## 架构与目录

```
APK（WebView 壳 + 前台服务 + 置顶通知）
  └─ HTTP/WS  127.0.0.1:8899
       └─ 本地桥（bun/Node，跑在 Termux 里；浏览器直连会被拒，见 docs/VERIFICATION.md E2）
            └─ 子进程：codex app-server（真协议面：WS + capability token）
                 └─ Codex CLI + 你自己的 provider 凭据（沿用现有 ~/.codex，不覆盖）
```

| 目录 | 内容 |
|---|---|
| `app/` | 桥 `server.ts` + 前端 `public/` + 定时任务调度器 `automation-service.js`。派生自 codex-webui（MIT） |
| `android/` | APK 源码（`MainActivity` / `BridgeService` / `BridgeClient`）+ 免 Gradle 的 `build.sh`；图标设计母版在 `android/design/icon-master.svg`（自适应图标三层资源在 `android/res/`） |
| `bin/` | Termux 侧脚本（见第 5 步表格） |
| `probe/` | 全部验证脚本（离线单测、DOM 级测试、真机端到端、以及"冻结监听"这类夹具） |
| `patches/` | 前端改动的可重放补丁（幂等） |
| `proto-ts/` | 从本机 Codex CLI 导出的 app-server 协议类型（协议基线） |
| `docs/` | `PLAN`（计划与三态进度）/ `FEATURES`（功能对照表）/ `VERIFICATION`（证据库 E1–E141）/ `PATCHES` / `HANDOFF` / `INSTALL` / `PUBLISH-AUDIT` |

## 已经做到什么程度

按功能逐项对照桌面端，而不是"能聊天就算"：会话/项目与搜索、流式输出与"过程 vs 最终"区分、
工具活动（命令输出、退出码、耗时、文件改动、MCP 调用）、审批与**模型提问**卡片、
完整 diff 审查与安全撤销、Git 面板与隔离 worktree、协议 PTY 终端（含手机辅助按键）、
产物预览/下载/分享、通知深链、**自建定时任务**（时间槽幂等、漏跑补跑、暂停恢复、运行记录）、
启动自检，以及可选的 **ReVa（Ghidra MCP）** 接入让模型拿到逆向工具。

每一项的证据（日期、命令、原始输出、以及被推翻后的更正）都在 `docs/VERIFICATION.md`；
进度用 `[x]/[~]/[ ]` 记在 `docs/PLAN.md`（`[~]` = 代码写完、运行时未验证）。

## 已知限制（复制自文档，不是免责声明）

- **沙箱在本平台不生效**：`read-only` / `workspace-write` 策略下命令照样能写工作区外、照样联网（E126 实测）。
  真正起作用的是审批策略；界面把它写成"意图声明"而不是边界。
- **桥会被 Android 冻结**（E62/E87/E135/E140）：桥不在时定时任务到点不会触发；应用会自动唤醒 Termux 解冻，
  实测 8 秒内可用。
- **没有官方账户能力**：用量、限额、云任务、插件市场里的账户相关操作不可用，界面显示真实原因。
- **相机**走手写 MediaStore 路径（没有 AndroidX，E141）；**录像**未做；设置页的横屏截图也还没补。
- APK 用 aapt/javac/d8/apksigner 手工构建，**没有 Gradle/AGP**——这是本机环境的选择，不是通用推荐。

## 隐私

`docs/` 里的实测记录包含开发设备的机型、系统版本与本地路径；`probe/` 里的夹具都是合成数据。
技术结论本身不依赖这些标识，介意的话发布前删改即可（自查清单见 `docs/PUBLISH-AUDIT.md`）。

## 图标

应用图标是**原创**的：深色渐变底 + 终端提示符 `>_`（青→蓝渐变描边），
设计母版 `android/design/icon-master.svg`，另有自适应图标三层资源与五档位图兜底
（`android/res/`，设计与取舍见 `docs/VERIFICATION.md` E142）。

**刻意没有使用 Codex/ChatGPT 或任何厂商的 logo**：那属于对方的商标，把它当作第三方应用的图标
会让人误以为存在官方关联，公开仓库尤其容易惹麻烦。如果你只在私人设备上自用、想换成别的图案，
改 `android/design/icon-master.svg` 后按 E142 那段重新生成即可。

## 许可证

本项目**自己的代码以 Apache-2.0 发布**（见 `LICENSE`、`NOTICE.md`）。上游关系分两块，别混：

- **`proto-ts/`** 是由你本机 Codex CLI `app-server` 导出的类型 → 来自
  [openai/codex](https://github.com/openai/codex)（**Apache-2.0**，且带 NOTICE）。
  按 Apache-2.0 §4(d) 的要求，它的 NOTICE 原文已逐字复制到本仓库 `NOTICE.md` 第 1 节。
  本仓库**不分发 Codex CLI 本身**，只与你自己装的那份通信。
- **`app/`** 派生自 **codex-webui（MIT）** → 那部分继续按 MIT 走，许可证原文保留在
  `app/LICENSE`、`app/THIRD_PARTY_NOTICES.md`。把 `app/` 再分发时这两份文件不能删。

所以如果你要基于本项目做二次分发：本项目代码遵守 Apache-2.0；`app/` 里的派生部分遵守 MIT
（两者兼容，MIT 部分保留声明即可）。
