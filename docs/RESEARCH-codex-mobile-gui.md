# Codex CLI 手机 GUI — 可行性调研与设计方案

> 调研日期：2026-10-14
> 调研环境：Termux aarch64 / Android 16（Redmi，HyperOS 3.0）/ Codex CLI 0.162.1（第三方 provider: deepseek）
> 产出位置：`~/codex-gui/RESEARCH-codex-mobile-gui.md`
> 状态：**v2（2026-10-14 修订）**。部分 v1 结论已被后续实测推翻，见下方「v2 修订记录」。原始 v1 存档于 `archive/RESEARCH-v1.md`。

---

## v2 修订记录（务必先读）

v1 的若干结论属于**未经验证的推论**，已被本轮实测推翻或修正。以下为权威版本：

| # | v1 说法 | v2 修正 | 证据 |
|---|---|---|---|
| 1 | GUI 可通过 `app-server proxy --sock` 挂到共享守护进程 | **撤回**。三种场景（运行中守护进程 / 全新 `--listen unix://` / 同版本隔离守护进程）全部 `Broken pipe`；裸 socket 发 `initialize` 或 `connection/hello` 均被立即关闭 | VERIFICATION E8、E9 |
| 2 | 审批统一四按钮：允许一次 / 允许同类 / 本会话 / 拒绝 | **更正**。决策集按请求类型不同：命令审批 6 种（含 `acceptWithExecpolicyAmendment`、`applyNetworkPolicyAmendment`、`cancel`），文件审批 4 种，legacy 走 `ReviewDecision` 8 种；按钮必须由请求类型 + 提案字段 + `availableDecisions` 动态生成 | E13、E14 |
| 3 | `thread/revert` 可用于文件撤销 / Reapply | **更正**。协议原文：只替换对话历史，*does not revert local file changes*。文件撤销必须另行实现（Git）并做冲突检测 | E12 |
| 4 | 集成终端依赖 node-pty，可能被迫砍掉 | **更正**。协议原生支持 PTY：`command/exec{tty:true}` + `write/resize/terminate` | E11 |
| 5 | 守护进程 0.160.0 与 CLI 0.162.1 疑为标签差异 | **更正**。守护进程启动时记录的 executable 摘要与当前 `codex.bin` 的 sha256 不一致，确为**旧二进制** | E7 |
| 6 | 官方 remote-control 配对可用于接入 | **更正**。实测 `remote control pairing is unavailable until enrollment completes`，依赖官方注册，属第 4 类能力 | E10 |
| 7 | 手机端可直接连 app-server（`?token=` 或子协议） | **撤回**。仅 `Authorization` 头可行，浏览器无法设置 → 必须有本地桥 | E2 |
| 8 | 照搬「Codex Desktop 46px 头部」 | **更正**。手机端按尺寸、安全区与触控重新设计，不固定 46px | 用户要求 |
| 9 | M0—M4 可作为项目完成标准 | **更正**。仅为基础阶段；完整功能对照与实施计划见 `FEATURES.md` / `PLAN.md` | 用户要求 |

另外，v1 未涵盖但已核实的重要协议面：`item/tool/requestUserInput`（模型向用户提问）、`mcpServer/elicitation/request`（MCP 表单/URL 授权，四种模式）、`ServerRequestResolved`、Guardian 严格复核、8 类 ThreadItem、子代理协作事件族。

**配套文档**：[`FEATURES.md`](./FEATURES.md) 功能对照表 · [`PLAN.md`](./PLAN.md) 实施计划 · [`VERIFICATION.md`](./VERIFICATION.md) 证据库

---

## 0. 一句话结论

**不需要从零写。**

Codex CLI 自带 `app-server`（WebSocket 传输 + 令牌鉴权 + 配对码 + 官方 TypeScript 类型生成），这就是官方 Codex 桌面端 / IDE 插件使用的同一套协议。社区已有一个几乎现成的手机 WebUI（MIT 许可，直连该协议）。推荐路径是**复用它作为基座，重做移动端界面**。

唯一硬约束：浏览器**无法**直连 app-server（因为不能用自定义 WebSocket 请求头），所以中间必须有一个本地桥进程。这个桥顺带承担手机通知（审批 / 完成事件）和文件上传，属于必需的而不是额外成本。

---

## 1. 环境快照（本机实测）

| 项目 | 实测值 |
|---|---|
| Codex CLI | `codex-cli 0.162.1` |
| app-server 协议 | `[experimental]`，command 面为 v2 |
| 已运行的守护进程 | 有：`codex.bin app-server --listen unix:// --managed-daemon`，PID 12365 |
| 守护进程 socket | `/data/data/com.termux/files/home/.codex/app-server-control-termux/app-server-control.sock` |
| 守护进程 app-server 版本 | 0.160.0（**与 CLI 0.162.1 不一致，见风险章节**） |
| Node.js | `v26.4.0`（可原生直接执行 `.ts`，无需构建步骤） |
| npm | 可用（`/data/data/com.termux/files/usr/bin/npm`） |
| bun | 未安装，但 **Termux 仓库有：candidate 1.4.3** |
| 沙箱注意 | 环境拒绝 `rm -f`（报 "rm -f style commands are not permitted"），需用普通 `rm` / `rm -r` |

---

## 2. 关键实测证据（本轮真跑，非推演）

### 2.1 app-server 可通过 WebSocket + Bearer 令牌连接 ✅

启动命令：

```sh
printf 'demo-token-%s\n' "$(date +%s)" > token.txt
codex app-server --listen ws://127.0.0.1:8791 \
  --ws-auth capability-token --ws-token-file "$PWD/token.txt"
```

启动输出：

```
codex app-server (WebSockets)
  listening on: ws://127.0.0.1:8791
  readyz: http://127.0.0.1:8791/readyz
  healthz: http://127.0.0.1:8791/healthz
  note: binds localhost only (use SSH port-forwarding for remote access)
```

连接结果（Node 内置 WebSocket）：

| 握手方式 | 结果 |
|---|---|
| 不带令牌 | ❌ 关闭，code=1006 |
| `Authorization: Bearer <token>` | ✅ 连通 |
| URL 查询参数 `/?token=...` | ❌ 失败 |
| `Sec-WebSocket-Protocol` 子协议 | ❌ 失败 |

`initialize` 返回：

```json
{"userAgent":"gui-probe/0.162.1 (Android 16.0.0; unknown) xterm-256color (gui-probe; 0.0.2)",
 "codexHome":"/data/data/com.termux/files/home/.codex",
 "platformFamily":"unix","platformOs":"android"}
```

**推论（架构决定性）**：浏览器 `new WebSocket()` 不能设置 `Authorization` 头，查询参数与子协议又不被服务端接受 → **纯静态前端直连 app-server 不可行，必须有本地桥**。

### 2.2 只读调用返回真实数据 ✅

- `model/list` → 返回真实模型目录，含当前 provider 的 `deepseek-flash`（`displayName: "DeepSeek-Flash"`，支持 `low/high/max` 推理档位，输入模态 `text,image`）。
- `thread/list`（`{"limit":3}`）→ 返回真实会话列表，**包含正在进行的当前这条对话**，字段含 `preview`、`cwd`、`model`、`reasoningEffort`、`createdAt`、`status.type`、`path`（rollout jsonl 路径）。
- `account/read` → `{"account":null,"requiresOpenaiAuth":false}` —— 第三方 provider 的正常表现，**UI 必须对此优雅降级**。

### 2.3 协议类型绑定可在本机生成 ✅

```sh
codex app-server generate-ts --out ts
# → 743 个文件，约 3.1 MB
```

说明：协议面完备且官方维护，GUI 可以拿到强类型；但**属 experimental，升级 CLI 后需重新生成**。

### 2.4 文档站不可达（改用本机事实源）

`developers.openai.com` 从本机网络返回 **403 Forbidden**（IP 被挡）。因此本报告所有协议结论来自**本机生成的类型绑定 + 实测调用**，可靠度高于文档快照。

---

## 3. Codex app-server 协议速查（GUI 会用到）

### 3.1 客户端 → 服务端（请求）

线程与会话管理：

```
initialize
thread/list            thread/start          thread/resume
thread/read            thread/turns/list     thread/items/list
thread/fork            thread/archive        thread/unarchive
thread/delete          thread/name/set       thread/compact/start
thread/revert          thread/unsubscribe    thread/loaded/list
thread/attachment/add|list|remove
threadSection/list|create|update|delete|move
```

回合控制：

```
turn/start             turn/steer            turn/interrupt
review/start           thread/shellCommand
```

配置、模型、账户：

```
model/list             modelProvider/capabilities/read
config/read            config/value/write    config/batchWrite
permissionProfile/list
account/read           account/login/start   account/logout
account/usage/read     account/rateLimits/read
experimentalFeature/list
```

扩展与文件：

```
skills/list  skills/config/write  skills/extraRoots/set
mcpServerStatus/list   mcpServer/tool/call   mcpServer/oauth/login
plugin/list|read|install|uninstall      marketplace/add|remove|upgrade
fs/readFile  fs/writeFile  fs/readDirectory  fs/getMetadata
fs/createDirectory  fs/remove  fs/copy  fs/watch  fs/unwatch
fuzzyFileSearch        gitDiffToRemote       getAuthStatus
command/exec  command/exec/write|resize|terminate
feedback/upload
```

### 3.2 服务端 → 客户端（通知）

```
thread/started    thread/closed      thread/archived   thread/deleted
thread/compacted  thread/reverted
turn/started      turn/completed
item/started      item/completed
process/outputDelta   process/exited
project/changed   fs/changed
skills/changed    hook/started      hook/completed
account/updated   model/rerouted
autoApprovalReview/strictReviewRequired
serverRequest/resolved
```

### 3.3 审批（服务端发起的反向请求）

**（v2 更正）** 审批不是一套统一流程，而是**两套协议 + 按类型不同的决策集**：

| 服务端请求 | 决策集 |
|---|---|
| `item/commandExecution/requestApproval` | `accept` / `acceptForSession` / `{acceptWithExecpolicyAmendment}` / `{applyNetworkPolicyAmendment}` / `decline` / `cancel` |
| `item/fileChange/requestApproval` | `accept` / `acceptForSession` / `decline` / `cancel` |
| `item/permissions/requestApproval` | 追加 network / fileSystem 权限 |
| legacy `execCommandApproval`、`applyPatchApproval` | `ReviewDecision`（approved / approved_for_session / approved_execpolicy_amendment / approved_mcp_policy_amendment / network_policy_amendment / denied / timed_out / abort） |

可用按钮必须由**请求类型 + 提案字段（`proposedExecpolicyAmendment` / `proposedNetworkPolicyAmendments`）+ `availableDecisions`** 动态推导，且四类审批不得共用同一组按钮、不得扩大授权范围。关联键为 `requestId` + `threadId` + `turnId` + `approvalId`（`approvalId` 用于同一 item 多回调时的路由，例如 zsh-exec-bridge 子命令与 stdin 审批）。另有 `CommandExecutionApprovalKind = "command" | "writeStdin"`。

### 3.4 官方远程通道（同一协议族，可作旁证）

```sh
codex remote-control start      # 以远程控制模式启动守护进程
codex remote-control pair       # 生成短时效配对码
codex --remote ws://host:port   # TUI 自身可连到远端 app-server
codex app-server proxy --sock <path>   # 把 stdio 接到已在跑的守护进程
codex agents                    # 浏览共享守护进程上的会话
codex app-server generate-json-schema / generate-ts
```

`--remote` CLI 参数的存在直接证明：**TUI、IDE 插件、以及我们未来的 GUI 共用同一个 app-server 协议**，所以自建 GUI 与官方客户端的兼容性风险很低。

---

## 4. 可复用项目盘点

星数 / 活跃度 / 许可均经 GitHub API 核实（2026-10-14）。

### 4.1 第一梯队：值得直接复用或改

**[lezi-fun/codex-webui](https://github.com/lezi-fun/codex-webui)** — 最贴合

- MIT · 31★ · 119 文件 · 最后推送 2026-10-04 · 创建于 2026-07
- 接入方式：**直连 `codex app-server --stdio`**，通过 WebSocket 桥到浏览器
- 已实现的真实能力：真实模型目录与推理档位、真实线程与流式回合、命令/文件改动/网络/权限审批面、审批粒度（允许一次 / 允许同类命令 / 本会话）、由真实 `item/turn` 通知驱动的工具活动状态、unified 与 split diff 对照、Undo / Reapply、安全 Markdown + GFM + 代码块 + KaTeX、受限的文件系统浏览与项目文件夹选择器、Codex 风格侧栏账户区、**「Codex Desktop 风格 46px 头部」**
- 有 `tests/codex-desktop-layout.mjs`、`tests/mobile-device-mode.e2e.mjs`、`tests/approval-e2e.mjs`、`tests/app-server.integration.test.ts` 等测试
- 运行时依赖极少：`ws`、`marked`、`katex`、`dompurify`、`lottie-web`、`@xterm/*`、`node-pty`（**唯一原生依赖**，仅终端功能需要）
- 服务端是纯 `node:http` + `ws` + `node:child_process`，内建 `server-security.js`（密码会话、RPC 方法白名单、HTTP 授权），LAN 访问有基本保护
- 构建/运行需要 bun（`bun run server.ts`），但代码是标准 ESM + `.ts`，**Node 26 可直接执行 `.ts`**，理论上可去 bun 化

**[siteboon/claudecodeui](https://github.com/siteboon/claudecodeui)（CloudCLI）** — 架构参考价值最高

- AGPL-3.0 · 14062★ · 最后推送 2026-10-12
- 内含完整的 Codex provider 层：`server/modules/providers/list/codex/` 下有 `codex-app-server.client.ts`、`codex-sessions.provider.ts`、`codex-models.provider.ts`、`codex-skills.provider.ts`、`codex-mcp.provider.ts`、`codex-fork.provider.ts`、`codex-auth.provider.ts`、`codex-session-synchronizer.provider.ts`
- 前端 React + Tailwind + CodeMirror，含移动端布局、Web Push 通知
- **不适合直接安装的硬伤**：依赖 `better-sqlite3`、`bcrypt`、`node-pty@beta`、`@vscode/ripgrep`、`@openai/codex@0.156.1` 等原生/架构相关包，在 Termux aarch64 + bionic 上编译安装风险高；且 AGPL-3.0 会约束后续闭源分发
- 建议用途：**作为 Codex provider 层的实现参考**（尤其会话同步与模型目录），不作为安装基座

### 4.2 第二梯队：设计思路参考

| 项目 | 许可 / 星数 | 接入方式 | 借鉴点 |
|---|---|---|---|
| [happier-dev/happier](https://github.com/happier-dev/happier)（原 slopus/happy） | MIT · 1947★ | 自有 daemon 与中继 | 多设备控制室、端到端加密、跨 agent 编排；但它是整套生态，不是薄壳 |
| [AltanS/collie](https://github.com/AltanS/collie) | MIT · 1329★ | Herdr / tmux / zellij（**PTY 抓屏**） | 手机 UX 范本：推送通知、自定义按键板、系统语音听写、状态优先仪表盘；保真度低一档 |
| [K9i-0/ccpocket](https://github.com/K9i-0/ccpocket) | MIT · 1088★ | Flutter App + WebSocket 桥 | 桥协议设计；Flutter 在无 Gradle/AGP 的本机建不了 |
| [rebornix/Agmente](https://github.com/rebornix/Agmente) | MIT · 547★ | 原生实现 **Codex app-server 协议**（ACP 或 app-server） | 原生客户端最佳范本；Swift/iOS，Android 不可用 |
| [Gan-Xing/CodexBridge](https://github.com/Gan-Xing/CodexBridge) | 无许可证 · 454★ | app-server，微信侧 | 斜杠命令、审批、上传的映射方式 |
| [kcosr/codex-threads](https://github.com/kcosr/codex-threads) | MIT · 33★ | Rust CLI 操作 app-server 线程 | 会话读取/搜索/控制的服务端用法 |
| [pwrdrvr/openclaw-codex-app-server](https://github.com/pwrdrvr/openclaw-codex-app-server) | — · 265★ | TypeScript app-server 客户端 PoC | 最小客户端实现参考 |
| [fuergaosi233/claude-codex](https://github.com/fuergaosi233/claude-codex) | — · 99★ | 让 Codex 桌面端连 Claude Code | 旁证：官方 Codex 应用确实走该协议 |
| [1shiharat/awesome-agent-clients](https://github.com/1shiharat/awesome-agent-clients) | 清单 | — | 「Mobile & remote-control clients」一节是选型地图 |

### 4.3 选型结论

> **以 `codex-webui` 为基座；用 `claudecodeui` 的 Codex provider 层和 `Agmente` 的协议用法做补强参考。**

---

## 5. 推荐架构

```
┌──────────────────────────────────────────────┐
│  手机浏览器 / PWA / WebView 壳 APK            │
│  （localhost 是安全上下文 → 可用 SW、可装桌面）│
└───────────────┬──────────────────────────────┘
                │ HTTP + WebSocket（仅 127.0.0.1:8xxx，带本地会话令牌）
                ▼
┌──────────────────────────────────────────────┐
│  codex-guid 本地桥（Node 26，尽量零原生依赖） │
│  · 浏览器 WS  ⇄  app-server JSON-RPC          │
│  · RPC 方法白名单 + 审批请求转发              │
│  · 静态资源 / 图片与文件上传 / 产物下载       │
│  · 审批或回合完成 → termux-notification       │
└───────────────┬──────────────────────────────┘
                │ stdio 或 unix socket
                ▼
┌──────────────────────────────────────────────┐
│  codex app-server                             │
│  （与 TUI / codex agents 共用同一守护进程）   │
└──────────────────────────────────────────────┘
```

**（v2 更正）** 原方案「桥通过 `app-server proxy --sock` 挂到共享守护进程」**已实测失败**（E8/E9），不再是首选路径。修正后的三条候选路径见 [`PLAN.md`](./PLAN.md) 第 2.2 节；其中首选是「桥自建 WS app-server + TUI 用 `codex --remote` 反连」，因为它复用已实测可用的 WS + Bearer 通道（E1）。

### 备选路线（按投入排序）

| 路线 | 内容 | 评价 |
|---|---|---|
| **A. 直接复用 codex-webui** | `pkg install bun` → clone → 改三处：只绑 127.0.0.1、会话源指向共享守护进程、界面中文化 | 最快拿到真实可用体感；MIT 无束缚 |
| **B. 自建薄桥 + 自写前端** | 桥只做白名单 + 审批通知 + 上传 + 静态资源；前端做成 PWA | 推荐终态，可控、可维护 |
| **C. WebView 壳 APK** | 把 B 的地址包成 APK，得到真图标、无地址栏、返回键接管 | 本机已有 aapt/javac/d8/apksigner 手工流水线，约一两百行 Java；TWA 是同类变体 |
| **D. 零开发** | `codex remote-control start` + `pair` 配对码，让官方客户端连本机 | 协议族相同，值得一试点一下；**手机端能否配对本机未验证**，不作主路径 |

建议顺序：**A 先跑通 → B 补自己的桥 → C 收尾成 App**，避免一上来重造前端。

---

## 6. UI 设计方案（参考 ChatGPT App + Codex 桌面端）

### 6.1 线程列表（左侧抽屉，类比 ChatGPT 侧栏）

- 搜索框（可对应 `thread/list` 的 `searchTerm`）
- 按项目 / cwd 分组的会话卡片，卡片显示：标题、模型、推理档位、相对时间、状态徽章（未加载 / 运行中 / 待审批）
- 左滑归档（`thread/archive`）、右滑删除（`thread/delete`），支持分区（`threadSection/*`）
- 底部：账户区、用量与限额入口（`account/usage/read`、`account/rateLimits/read`）

### 6.2 会话页（主体）

- **不用聊天气泡**，采用 Codex 桌面端的「turn 块」：用户消息窄条 + 助手流式正文，工具活动作为块内可折叠卡片
**（v2 更正）** 头部不照搬 46px：按手机尺寸、安全区与触控重新设计（约 52–56dp + 状态栏 inset）。内容仍为：返回、会话名（可点重命名，`thread/name/set`）、模型 chip、推理档位、cwd、git 分支、溢出菜单（fork / compact / archive）。
- 长列表使用分页（`thread/turns/list`、`thread/items/list`）

### 6.3 工具活动卡片

- 命令卡：命令 + 等宽输出 + 退出码 chip；流式输出接 `process/outputDelta`
- 文件改动卡：`+/-` 统计，unified / split 切换，展开折叠，**Undo / Reapply**（`thread/revert`）
- 搜索卡：匹配计数（`fuzzyFileSearch`）

### 6.4 输入区（底部，安全区适配）

- 多行自增高输入框；附件 / 拍照入口
- 斜杠命令面板：`/model`、`/plan`、`/review`、`/compact` 等
- 模型与推理档位选择弹层（数据来自 `model/list`）
- 模式 chip：Default / Plan
- **发送键在回合运行中变形为 Steer（追加指令）/ Interrupt（打断）**，对应 `turn/steer`、`turn/interrupt`

### 6.5 审批（优先级最高）

- 底部弹层卡片，四个按钮：**允许一次 / 允许同类命令 / 本会话允许 / 拒绝**
- 回包给 `ExecCommandApproval`、`ApplyPatchApproval`
- **审批请求必须触发手机通知**（复用已有的 `termux-notification` 约定），点通知深链直达该会话

### 6.6 状态与细节

- 待处理审批 → 全局红点
- 第三方 provider 下用量/限额接口返回空，需显示「当前 provider 不提供」而非转圈或报错
- 中文 i18n；深色主题对齐 Codex 桌面端
- `viewport-fit=cover` + `env(safe-area-inset-bottom)`；输入框关闭自动大写，避免拼音候选遮挡
- 可选：产物生成后用 `termux-open` 分享到外部应用

---

## 7. 里程碑

| 阶段 | 预估 | 内容 | 验收标准 |
|---|---|---|---|
> **（v2 更正）** 以下 M0—M4 仅为基础阶段，**不是**项目完成标准。完整分阶段计划（P0—P9）与端到端验收清单见 [`PLAN.md`](./PLAN.md)。其中 M1 依赖的 proxy 路径已被推翻，替代方案为 `codex --remote` 反连。

| **M0** | 0.5 小时 | `pkg install bun`，克隆 codex-webui，跑起来 | 手机浏览器能打开并看到真实会话列表 |
| **M1** | 0.5 天 | ~~通过 `app-server proxy --sock` 挂共享守护进程~~ → 改为 WS app-server + `codex --remote` 反连 | 终端 TUI 里新建的会话在 GUI 可见，反之亦然 |
| **M2** | 1 天 | 审批事件与回合完成事件 → `termux-notification`；通知深链到会话 | 手机上收到审批通知，点击直达并可批准 |
| **M3** | 1 天 | 移动端打磨：抽屉、安全区、输入区变形键、审批弹层、中文化 | 单手可用，中文界面无英文残留 |
| **M4** | 1 天 | PWA 图标安装；或按手工流水线打成 WebView 壳 APK | 桌面有图标，打开无浏览器地址栏 |

---

## 8. 风险与待验证

1. **Termux 生命周期（最大不确定性）**
   本地桥需要常驻，而此前实测结论是「划走 Termux 会杀掉正在跑的进程」。需**亲手划一次复现验证**。缓解手段：`termux-wake-lock`（会留一条常驻通知，用户明确不喜欢常驻通知）或 `termux-services` 托管。**尚未验证**。
2. **协议是 experimental**
   已观察到守护进程 app-server `0.160.0` 与 CLI `0.162.1` 版本不一致。升级 CLI 后类型绑定需重新 `generate-ts`，建议锁定版本并记录兼容矩阵。
3. **第三方 provider 功能残缺**
   登录、用量、限额、credits 相关调用返回空/不可用（已验证 `account/read` 返回 `null`）。UI 必须逐项降级。
4. **原生依赖**
   **（v2 更正）** 终端不必依赖 `node-pty`：协议原生支持 PTY（`command/exec{tty:true}` + `write/resize/terminate`，见 E11），可直接砍掉该原生依赖。`better-sqlite3` 是 claudecodeui 独有的包袱，选型 A/B 可避开。
5. **安全**
   app-server 等同于在你机器上执行 shell 的能力。桥**绝不能对外网开放**；跨设备访问请走 Tailscale + capability-token。桥必须有会话令牌与 RPC 方法白名单。
6. **前端在 Termux 上的可运行性**
   codex-webui 官方要求 bun；本机已确认 bun 可从 Termux 仓库安装，但**尚未实测该项目在本机的完整启动**（M0 就是验证这一点）。

---

## 9. 复现命令附录（可直接粘贴）

```sh
# 1) 起一个带令牌的本地 app-server（验证用，用完 Ctrl-C）
POC=$(mktemp -d)
printf 'demo-token-%s\n' "$(date +%s)" > "$POC/token.txt"
codex app-server --listen ws://127.0.0.1:8791 \
  --ws-auth capability-token --ws-token-file "$POC/token.txt"

# 2) 健康检查（另开一个 Termux 会话）
curl -sS http://127.0.0.1:8791/healthz; echo

# 3) 生成协议类型绑定（用于写前端）
codex app-server generate-ts --out ts      # 743 个文件，约 3.1 MB
codex app-server generate-json-schema --out schema

# 4) 查看共享守护进程状态与 socket 路径
codex app-server daemon version
codex app-server daemon --help

# 5) 挂到已在跑的守护进程（GUI 桥的推荐接法）
codex app-server proxy --sock "$HOME/.codex/app-server-control-termux/app-server-control.sock"

# 6) 环境准备（M0）
pkg install -y bun
```

Node 侧最小客户端要点（已实测可用）：

```js
const ws = new WebSocket("ws://127.0.0.1:8791", {
  headers: { Authorization: `Bearer ${token}` },
});
ws.onopen = () => ws.send(JSON.stringify({
  method: "initialize", id: 1,
  params: { clientInfo: { name: "gui", title: "GUI", version: "0.0.1" }, capabilities: null },
}));
// 之后的只读调用示例：model/list、thread/list、account/read
```

---

## 10. 参考链接

- Codex CLI 官方文档（**本机网络 403，未能访问**）：https://developers.openai.com/codex
- codex-webui（首选基座）：https://github.com/lezi-fun/codex-webui
- claudecodeui / CloudCLI（provider 层参考）：https://github.com/siteboon/claudecodeui
- Agmente（原生协议客户端范本）：https://github.com/rebornix/Agmente
- awesome-agent-clients（选型地图）：https://github.com/1shiharat/awesome-agent-clients

---

## 11. 本报告的已验证 / 未验证边界

**已验证（本机实测，2026-10-14）**

- app-server 可经 WebSocket + `Authorization: Bearer` 连接并完成 `initialize`
- 查询参数与子协议鉴权均不可用 → 浏览器无法直连
- `model/list`、`thread/list`、`account/read` 返回真实数据
- 本机已有常驻 managed 守护进程及其 socket 路径
- Node 26 存在且可执行 `.ts`；bun 在 Termux 仓库可安装
- `generate-ts` 可生成完整协议类型绑定

**未验证（需在 M0/M1 阶段落实）**

- codex-webui 在本机（Termux aarch64）能否完整启动运行
- ~~用 `app-server proxy --sock` 挂共享守护进程时，GUI 与 TUI 的会话互通行为~~ → 已实测失败（E8/E9）；改为验证 `codex --remote` 反连方案
- 划走 Termux 后本地桥是否存活
- 官方 Codex 客户端用 `pair` 配对码连本机（手机侧）是否可行
