# PLAN.md — 实施计划

编制日期：2026-10-14
配套文档：[`FEATURES.md`](./FEATURES.md)（功能对照表）、[`VERIFICATION.md`](./VERIFICATION.md)（证据库）
替代：原调研报告中的 M0—M4（仅视为基础阶段，不作为完成标准）

---

## 1. 最终目标与运行依赖（必须先说清楚）

**交付物**：可安装、可更新的 Android APK，界面与信息结构参考 Codex 桌面端，执行后端是 Termux 中的 Codex CLI / app-server。

**运行依赖**（APK 本身不含 Codex 运行时）：

```
APK（WebView 壳）
   └─ HTTP/WS 到 127.0.0.1:<port>
        └─ 本地桥（Node 26，随 Termux 启动）
             └─ 子进程：codex app-server（stdio 或 ws）
                  └─ Codex CLI 0.162.1 + 用户 provider 凭据
```

| 依赖 | 是否必需 | 说明 |
|---|---|---|
| Termux + Node 26 | 必需 | 桥运行环境；`codex` 已在 npm 全局 |
| Codex CLI | 必需 | 提供 app-server |
| 用户 provider 凭据 | 必需 | 沿用现有 `~/.codex`，**不覆盖** |
| bun | 不需要 | 仅在复用 codex-webui 原始脚本时可用，Node 26 可直接跑 `.ts` |
| node-pty | 不需要 | 终端改用协议 PTY（E11） |
| 官方账户 | 不需要 | 但相应能力不可用（E5/E10） |
| root | 不需要 | 全部路径均在 Termux 与 127.0.0.1 内 |

## 2. 架构决策

### 2.1 采用：桥 + WebView 壳

| 层 | 选型 | 理由 |
|---|---|---|
| 执行后端 | 真实 app-server 协议（JSON-RPC） | 用户硬性要求；禁止抓 TUI 屏幕 |
| 桥 | Node 26 + `ws`，`node:http` 服务静态资源 | 已验证可运行；零编译依赖 |
| 前端 | 复用 codex-webui 的静态资源与渲染层（MIT），按本表补缺 | 避免重复开发终端/diff/Markdown |
| 终端 | `command/exec{tty:true}` | 协议已支持，绕开 node-pty 编译（E11） |
| 壳 | WebView APK，走既有 aapt/javac/d8/apksigner 流水线 | 本机无 Gradle/AGP；已有成熟手工流程 |

### 2.2 会话共享：两个层次，分开验收

| 层次 | 状态 | 方案 |
|---|---|---|
| **读同一份历史** | 已验证可行（E4） | 桥自建 app-server 实例即可读到 CLI 会话 |
| **共享实时运行状态** | **已验证可行（E23–E25）** | 桥自建 WS app-server + CLI `--remote` 反连，双方共享同一实例与内存状态 |

P1 候选路径（按优先级）：

1. **反向接入（已实测通过，见 E23–E25，采用）**：桥启动 `codex app-server --listen ws://127.0.0.1:PORT --ws-auth capability-token`，TUI 用官方参数 `codex --remote ws://… --remote-auth-token-env …` 连到**同一个** app-server 实例。实测确认：两个并发 GUI 客户端共享同一份实时状态；TUI 反连成功后创建的会话对第三方客户端立即可见；客户端断开后任务在服务端继续，可用 `resume <threadId>` 重连。
2. **重启守护进程后再试 proxy**：E8 显示 `proxy` 在同版本下也失败，但守护进程确实存在版本漂移（E7）。重启后（**需你授权**）复测，用于判断 proxy 是否只是被旧二进制拖累。
3. **自建长驻 app-server + 启动器接管**：桥成为会话唯一宿主，CLI 通过启动器脚本自动带 `--remote` 接入。日常不需要手工敲命令。

> 明确不做的：不抓 TUI 屏幕、不解析终端文本作为核心会话实现。

### 2.3 复用边界

| 复用对象 | 决策 | 依据 |
|---|---|---|
| codex-webui（MIT） | **保留**：静态资源、Markdown/KaTeX 渲染、diff 视图、审批面板骨架、密码/来源校验模块。**替换**：自带实例改为桥托管、node-pty 终端改为协议 PTY。**新增**：项目分组/分区、requestUserInput、elicitation、Git、worktree、通知、草稿、调度、产物预览 | E19 已逐项列缺口 |
| claudecodeui（AGPL-3.0） | **仅阅读参考**，不复制代码、不作为依赖 | 许可与原生依赖 |
| Agmente / CodexBridge | 仅参考协议用法 | 许可 |

## 3. 阶段计划

每阶段都必须产出：可运行代码 + 实际测试记录。模拟数据只用于开发，不计入验收。

> 勾选约定：`[x]` = 有实测证据；`[~]` = **代码已实现、单测通过，但运行时/真机未验证**（不算通过，只是不再计入"未开工"）。

### P0 — 版本与协议基线（已完成大半）

- [x] 生成 v2 类型绑定并归档（E6）
- [x] 核实守护进程与 CLI 的二进制差异（E7）
- [x] 核实审批决策集按类型不同（E13）、两套审批协议（E14）
- [x] 核实 `thread/revert` 语义（E12）
- [x] 核实协议 PTY 能力（E11）
- [x] 核实账户与 remote-control 的阻塞点（E5/E10）
- [x] 补齐：`initialize` 的 `experimentalApi` 开/关对可见方法的影响（同一会话对比）
      —— `probe/experimental-api-ab.mjs`：只挡 `memory/status` 与 `thread/realtime/listVoices`
      两条（其余 13 个候选一致）；桥用 true，两条可用（E125）
- **验收**：`VERIFICATION.md` 的每条都带命令或类型出处。

### P1 — 架构验证（决定成败，最先做）

目标：回答「GUI 与 CLI 到底能共享到什么程度」。

- [x] 按 2.2-1 起一个 WS app-server，用 `codex --remote` 让 TUI 连上去（E25）
- [x] **CLI 建的会话在 GUI 可读**（历史）（E4）
- [x] **GUI 建的会话在 CLI 可续**（机制已验证：服务端持有会话，`--remote … resume <id>` 重连）（E25）
- [x] 两个并发客户端共享同一份实时状态（E24）
- [x] 一侧发消息/跑命令 → 另一侧**实时**看到（E47：同一实例内需先 resume 该线程；完整事件流已实测）
- [x] 并发：两客户端同时连、重复操作 → **不串台**（提交并入同一回合、生命周期只跑一遍）；
      但**服务端不去重**，重复提交会让用户消息出现两次 → 客户端必须自己去重（E49）
- [x] 断线重连：重连后 `thread/resume` 能读到 `active`/`inProgress`，继续收到剩余事件流，
      **全程只有一个回合**（E50）。由此定下恢复规则：**先读状态，正在跑就只订阅、不重发**
- [x] 顺带否掉了一条设想：`clientUserMessageId` **不是**内容去重键（E51，阴性结果）
- **验收**：以上逐条有日志/录屏证据。任一项不通过则回到 2.2 换候选路径，并在 FEATURES.md 降级标注。

> **P1 结论**：三项全部有实测证据（E47 / E49 / E50）。架构路线（桥宿主 + CLI 反连 + 订阅）成立，
> 不需要回退到备选路径。

### P2 — 桥的最小可用内核

- [x] 桥改为**共享实例宿主**：宿主 WS app-server，CLI 经 `~/bin/codex-gui` 反连（E28）
- [x] capability token 落到 `0600` 文件，**不进前端包/URL/日志**；接入信息接口不返回 token（E28）
- [x] RPC 白名单已存在（`server-security.js`，实测拦截 `thread/loaded/list`）
- [x] 扩展白名单到 60+ 个已核实方法（patches 0004）
- [x] Origin 校验强化：15 项断言钉住攻击面；修掉「配置了密钥后回环仍免鉴权」（错误的令牌也被放行）
      并端到端复核（401/401/401/200）；残留风险如实标注（E52）
- [x] 顺带：`/api/health` 增加 `ready`，`start`/`codex-gui` 不再「假成功」；复用实例消失后能自拉起（E52）
- [x] 事件流（`item/*`、`turn/*`、审批）→ 浏览器（E31 实测；`process/outputDelta` 覆盖度待验）
- [x] 审批按钮严格按 `availableDecisions` 生成（E29 / patches/0001 / 14 项断言全过）
- [x] 子进程生命周期：复用已有实例、崩溃退避、端口冲突提示（E33）
- [x] 审批与会话/回合/回调 ID 的关联与去重：新增 `request-registry`（20 项断言）+ 端到端
      验证「第二个客户端被拒 / 迟到应答被拒」（E53）。
      其中 legacy 两套协议的**界面渲染**仍未做（上游对它们回 `-32601`），单独列为待办
- [~] legacy `execCommandApproval` / `applyPatchApproval`：**桥侧已修**（patches/0045：decision 用旧版字符串枚举，原来一律回 `-32601`）。
      真机没触发过 legacy 协议，只有单测覆盖 → 保持 `[~]`，不当成"已验收"
- [x] 未作答请求可恢复：新增 `GET /api/requests/pending`（端到端 ALL PASS）+ 前端连接时
      `restorePendingRequests()` 重建卡片（E54）。**刷新丢卡片导致回合永挂的问题已解**
- [x] `waitingOnApproval` / `waitingOnUserInput` 的**显式状态提示**：侧栏行徽章（patches/0082，读 `thread/list.status.activeFlags`）。
      真机验过「等你回答」（`~/shots/wait-1-band.png`，E125）；审批那一支的文案同一条路径，本机触发不到审批请求
- [x] `item/tool/requestUserInput` 与 `mcpServer/elicitation/request` —— 已在 P5 真机验收（E114 提问闭环、E115 elicitation 表单）
- [x] 副作用请求的幂等与去重：客户端提交闸门（9 项断言）+ 审批去重（E53）+
      **代码核查确认前端没有重发队列**（E55）。未在浏览器实测点击行为
- [ ] 若将来要支持「网络超时后安全重试」，需要桥侧自建幂等键
      （现成的 `clientUserMessageId` 不提供，见 E51）
- **验收**：并发与断线场景不产生重复消息或重复执行。

### P3 — 会话与项目

FEATURES.md 第 1 节全部行：项目添加/切换、列表分页、搜索、新建/继续/重命名/分叉/分区/置顶/归档/删除、未读与运行状态、多会话并行。
**验收**：与 CLI 双向可见（P1 已建的机制上复核）。

- [x] 审计：逐项检索前端调用（E56）——上游已有 列表/分页/继续/删除，**缺** 分叉/归档/重命名/分区/服务端搜索
- [x] 协议层验证全部可用（`probe/p3-thread-ops.mjs` ALL PASS），含意外收获：分区里已有 `Pinned`
- [x] 已实现：线程行「⋯」菜单 → 重命名 / 分叉 / 归档（已归档显示恢复）+ CSS + 简中词条（patches 0014/0015）
- [x] 服务端搜索：搜索框改为防抖调用 `thread/list{searchTerm}`（patches 0016），
      打字时仍先用已加载的页即时渲染，随后用服务端结果替换（E56）
- [x] 已归档视图：侧栏「已归档」行切换进行中/已归档，行菜单随之显示「恢复」而非「归档」（patches 0018/0019，E58）
- [x] 分区/置顶界面：行菜单加「置顶/取消置顶」，侧栏出现「置顶」分组（patches 0020）。
      **实测发现类型与运行时方法名不一致**：类型写 `threadSection/move`，运行时只认
      `thread/section/move`（E59），已按后者修正并放行白名单。
      用户确认**分组已出现**；「不在最上边」的排序问题已修（E60，当前项目优先的规则先截胡）
- [x] 协议面运行时体检：`probe/allowlist-audit.mjs`（E70）——服务端真实 174 个方法 vs
      白名单，清掉 1 个永不成功的条目（`threadSection/move`）、排除桥内部伪方法后**假条目 0**

> **体检的副产品（改变 P3/P4 的认知，已列为待办）**：
> - **`project/*`（7 个方法）是服务端一等概念**——P3 里我按 `cwd` 在客户端聚合分组是**绕路**；
> - **`thread/queue/*`（6 个方法）提供真实的消息排队**——P4 要求区分「追加 / 排队 / 新开回合」，
>   其中"排队"就该用 `thread/queue/*`（现在只实现了 `turn/steer` 的追加）；
> - 另有 `thread/search`、`thread/backgroundTerminals/*`、`memory/*`、`rollout/compress` 等未用能力。
- [x] `thread/compact/start`：行菜单新增「压缩上下文」，非当前会话先 resume 再压缩（patches 0023，E61）

> **P3 完成**（2026-10-14）：审计 + 协议验证 + 行操作 + 服务端搜索 + 已归档视图 + 置顶/分区 + compact。
> 待用户确认的仅是各入口的**视觉效果**（功能已有实测依据）。

### P4 — 对话与工具活动

FEATURES.md 第 2、3 节：流式、过程/最终区分、Markdown/公式、计划步骤、模式、模型与档位、追加/停止/恢复、附件与技能引用；命令/输出/退出码/耗时/diff/搜索/MCP/子代理卡片。
**验收**：`新建任务 → 流式 → 运行中追加 → 停止 → 继续` 全链路通过。

- [x] **验收链路全链路通过**（E64，走桥 API 实测：新建→流式→追加→停止→继续，含命令输出流）
- [x] 审计：上游已实现绝大部分（reasoning/diff/图片/计划/MCP/子代理/搜索卡/退出码/耗时，E65）
- [x] **模式切换（Default/Plan）**：协议层打通（E66）+ UI 已接（composer 模式 chip，
      `patches/0024/0025`）+ **行为已验证**（E69 的 A/B：plan 模式不执行动作、default 模式执行）。
      约束：`settings.model` 必须是字符串，无模型名时不发覆盖（E67）
- [~] 附带发现：`turn/settings/update` 可在回合中途改 `model`/`effort`/`summary`/`serviceTier`
      （字段表由报错问出，E66），可作为「模型与档位切换」的补充入口
- [x] **附件（系统文件选择器）**：`+` 按钮 → 系统选择器 → `POST /api/uploads` 落盘 →
      `localImage{path}` / `mention{name,path}`（patches/0029）。**接口与协议端到端已实测**：
      模型能描述上传截图的内容、历史里保留附件（E82）。选择器入口现为两个 `<label for>`：
      `#attachmentPicker`（图片/视频）与 `#filePicker`（文档，`accept` 限定非媒体类型以强制走文档选择器）。
      真机链路已验收：选择器返回 → 落盘 → 消息里渲染成芯片（E119；图片气泡为 E93/E123）。
      遗留仅英文界面下的两条词条（`Path` / `Collapse path`）未真机切换确认。
- [x] **E86：修好"页面根本不跑"**（`app.js` 里一行 `null.onclick=…` 让 bundle 在求值阶段中断；
      顶层文档走"登录墙"分支时还拿不到构建戳）。修后真机加载指纹齐全、`dcl` 21782ms → 232ms；
      新增护栏 `probe/dom-contract-audit.mjs`。
- [~] `memoryCitation` 已渲染成可点芯片（patches/0084：点击打开文件面板并滚到该行），
      **但本机 provider 不返回 `memoryCitation`**（review 回合里实测是 null），所以只过了单测（E125）
- [x] **消息排队**：composer 在回合运行中提供「追加（`turn/steer`）/ 排队（`thread/queue/add`）」两个选择，
      排队项经 `thread/queue/list` 显示并支持删除/排序（接口形状已探明，E72）——做完才算满足
      「明确追加、排队和新开回合的区别」。**已实现（patches/0026/0027 + E73）**，但
      排队语义已实测（`probe/queue-semantics.mjs` 9 项：排队 → 运行中不抢跑 → 回合结束才跑 → 队列清空，E125）

### P5 — 交互闭环（审批 + 提问 + 表单）✅ 阶段完成（2026-10-16）

**验收**：模型提问时 GUI 能回答且任务继续 ✓；四类审批授权范围不越界（按钮只来自 `availableDecisions` ✓）。

| 项 | 状态 | 证据 |
|---|---|---|
| 按钮按类型/提案动态生成 | ✅ | patches/0001；`probe/approval-model.test.mjs` 14 项 |
| 命令审批真机全链路 | ✅ | E113：提权 → 卡片 →「允许一次」（命令真的以提权身份跑通）/「取消」（模型收到 `aborted by user`） |
| 文件改动审批真机全链路 | ✅ | E115：`item/fileChange/requestApproval` → 允许 → **文件真的被写入**，任务继续 |
| 权限审批 `item/permissions/requestApproval` | ⚠️ 未真机触发 | 同一套接线 + approval-model/wiring 测试覆盖；本机 provider 流程没产生该请求 |
| legacy `execCommandApproval`/`applyPatchApproval` | ✅ | patches/0045（decision 用旧版字符串枚举；原来一律回 `-32601`） |
| 模型提问 `item/tool/requestUserInput` | ✅ 真机 | E114：**门槛=Plan 模式**（Default 下调它会报 unavailable）；单选+描述+「其他」→ 填答 → 模型收到并继续。多选/密文仅单测 |
| MCP 表单/授权 `mcpServer/elicitation/request` | ✅ 真机（form） | E115：夹具发起 elicitation → 表单渲染（下拉+必填文本）→ 提交 → 工具拿到答案。url / `openai/form` 仅单测 |
| 并发/重复/已解决/刷新恢复 | ✅ | E112/E113 + `probe/approval-wiring.test.mjs`；**真正的传输中断**未构造 |
| 卡片中文 / 图标 / 样式 | ✅ | patches/0046/0048/0049；缺一个图标名就会让整卡消失，这类已加 `probe/icon-contract-audit.mjs` |

**本机策略提示**：`config.toml` 是 `approval_policy="never"` + `sandbox_mode="danger-full-access"`，
默认不弹审批；要真机看审批需把 composer 权限 chip 切到 `Ask for approval` / `Approve for me`，
并用联网或越界写入触发（E112 有实测步骤）。

### P6 — 文件、Git、审查、终端

> #### 迭代修复（2026-10-16 凌晨，用户报障后插入）
>
> | 项 | 状态 | 证据 |
> |---|---|---|
> | 附件消息把完整绝对路径铺满气泡（溢出/裁切，读不出是哪个文件） | ✅ 真机 | E119：`overflow-wrap` 兜底 + 桌面端样式的**一行芯片**（文件名折叠成 26 字符，点开是完整路径）；`probe/user-attachment-chip.test.mjs` 15 项 |
> | **桥的 gzip 缓存按长度失效 → 重建 bundle 后仍发旧字节** | ✅ 实测对照实验 | E120 + patches/0058：长度相同的两次构建、不重启桥，桥也换了新字节；静态日志新增 `mt=` 自检 |
>
> 这两条都属于"用户看得见的交付质量"，不改变 P6 的进度；APK 版本随之到 0.1.9（本轮无 APK 侧功能变化）。

FEATURES.md 第 4、5 节。**本轮完成情况（2026-10-16）**：

- [x] 文件树/搜索/读写 —— 侧栏文件面板（协议 `fs/*`）；`probe/fs-api.mjs` 15 项 + 真机 E123
- [x] 真实 diff —— 审查面板渲染模型改动（`world` 那次的 `+1 −0` 与 hunk 见 E122）
- [~] **行内定位**（点击引用跳到文件行号）—— 已实现并单测通过（patches/0084）；缺真实 `memoryCitation` 数据来真机验收
- [x] Git 面板 —— `POST /api/git`（桥执行 git，argv 直传不走 shell）；暂存/提交/推送/丢弃/Fetch 全部真机验过（E123）
- [x] worktree 创建/切换/清理 + 会话关联 —— 建完问一句是否切换工作区（新会话用它）；打开/删除都验过（E123）
- [x] **审查目标：当前改动 / 分支对比 / 指定提交 / 自定义** —— 已接 `review/start`（patches/0084，E125）：
      四种 target 载荷逐变体断言、UI 真机可见（`~/shots/rt-3-top.png`）、`uncommittedChanges` 真跑过一次审查回合
- [x] 文件撤销：基于 Git，**保护用户后续修改并检测冲突** —— `probe/review-patch-conflict.mjs` 12 项（含"用户后来改过 → 拒绝且保留用户内容"）+ 真机撤销成功（E122）
- [x] 终端：协议 PTY、尺寸变化、辅助按键、退出状态；与模型命令卡分离 —— `pty-exec.mjs` 10 项、`terminal-bridge.mjs` 9 项、`terminal-lifecycle.mjs` 7 项 + 真机 Ctrl+C（E123）
- **验收**：
  - [~] `文件修改 → diff → 审查定位 → 安全撤销`：文件修改 → diff → 撤销三段真机跑通；
        审查定位的代码与单测已就绪，但本机 provider 不产出 `memoryCitation`，芯片没被真实数据触发（见上）
  - [x] 终端交互 + Ctrl+C：真机可交互、Ctrl+C 立即中断；**旋转已测**（竖 52x38 / 横 75x12 / 横+键盘 75x7，E125）

**未完成项集中说明**（不许当成"已完成"）：
① 行内定位缺真实 `memoryCitation` 数据（实现与单测已就绪，`[~]`）；
② 分支/提交列表只验了"工作区不是 git 仓库时如实报错"，正例未真机截图（接口自身由 `probe/git-api.mjs` 覆盖）；
③ worktree 的"恢复到某个已删除 worktree"（现在只有创建/打开/删除/清理）。

### P7 — 设置、扩展、产物与系统集成

> **进度（2026-10-16）**：第一批（设置与扩展的后端与页面）已做，见 E126/E127：
> - [x] **权限/沙箱实测**（用户硬性要求）：**本平台沙箱不生效**（四种测法互相印证），
>       设置页把这句话写在最显眼处，并说明"真正生效的是审批门禁"；
> - [x] 配置读取（`config/read`：真值）+ **受控写入**（`POST /api/config/write`，只允许
>       `approval_policy` / `sandbox_mode`，枚举校验、单键写入、保留其它键；浏览器侧的任意
>       keyPath 写入已从白名单摘掉）；
> - [x] 设置页真数据：配置 / 账户（第三方 provider 的真实原因）/ 插件 + MCP / 技能 / 钩子；
>       平台受限页（浏览器自动化、电脑操作、云任务、云环境、连接器）给出原因与替代路径；
> - [x] 第二批 = **产物与系统集成**（§8，见 E128）：
>       图片内联预览；打开/分享/存到 Download 三条动作（`termux-open`，真机验证）；
>       通知点击**直达对应会话**（深链，真机验证：`apk: deep link delivered` + 页面 `deep link -> open thread`）；
> - [x] 实验特性页：**如实只读**——实测 `experimentalFeature/enablement/set` 在本构建上是空操作
>       （返回 `{"enablement":{}}`、状态不变），所以只列真实开关状态并写明原因，不做假开关；
> - [x] 第三批（E129）：HTML 预览（`/api/files/preview` + `CSP: sandbox`，真机在浏览器面板里显示本地页面）、
>       拍照入口（`capture` 属性：真机起系统图片选择器，第一格就是相机）、MCP 配置重载按钮；
>       并更正两处判断：`inlineVisualization` 属于**实时语音**展示层（本机构建没有音频后端）、
>       `browser_use`/`computer_use` 的可用性（静态核实：`computer_use` 只有 macos/windows 子配置；
>       `browser_use` 依赖 CDP 端点，Android 上 Chrome 默认不暴露）；
> - [x] 顺带修掉 P6 遗留：文件面板搜索结果点不开（相对路径被当绝对路径用，patches/0092）
> - [x] 第四批（E130）：
>       ① **插件市场与安装/卸载**：受控出口 `POST /api/plugins`（`marketplace/*` 不在浏览器白名单），
>          整条链路实测通过（加市场 → 安装 → 卸载 → 移除市场），格式（`.agents/plugins/marketplace.json`、
>          `source` 相对市场根、插件需 `.codex-plugin/plugin.json`+`$schema`）都是试出来的；
>          设置页有了安装/卸载/添加移除市场，`settings-live` 19 项全过；测试对象与配置残留已清理；
>       ② **browser_use / computer_use 运行时**：真跑回合证明**工具不在模型手里**
>          （模型自己查 `codex mcp list` → 无 MCP；computer_use 直接回"没有"），
>          并纠正"特性开关≠工具可用"（两者 `enabled` 本来就是 true）；
>       ③ **横屏**：静态核对设置页/文件面板（dvh + flex，OK），发现并修 `.folder-card` 的 min-height
>          在横屏超过可用高度的问题（patches/0094）
> - [ ] P7 仍未做（都记着，不当成已完成）：
>       ① **MCP OAuth 登录流程**：`mcpServer/oauth/login {name}` 需要已配置且支持 OAuth 的 MCP 服务器，
>          本机 `mcpServerStatus/list` 为空 → 没有可登录对象（要在真机上验，需要你先配一个 MCP 服务器）；
>       ② **横屏设置页/产物面板的真机截图**：设备锁屏导致 adb offline；解锁并授权无线调试后
>          跑 `~/bin/adb-connect` 即可补（静态推断是够用的，但没实测就不标 `[x]`）。

FEATURES.md 第 6、8 节：模型/provider、权限沙箱（**实测隔离是否真生效**）、config 安全写入、Skills/MCP/插件、产物查看下载分享、通知深链、拍照与分享入口。
第 4 类能力必须在 UI 中给出真实原因与替代路径。

### P7.9 — 给 MCP 面一个真实对象：ReVa / Ghidra（附加，2026-10-16 完成，E131）

起因：到 E129 为止 `mcpServerStatus/list` 一直是空列表，MCP 面板只有我们自己写的 mock 可测；
用户提出"试试那个能逆向一切的 ReVa，好像有 MCP 服务器"。顺带给 App 补上真实逆向能力。

- [x] Ghidra 12.1.3 在本机跑通：官方发行包**没有** aarch64 原生 decompiler →
      改 `Makefile` 的 arch 分支自编 `decompile`/`sleigh`（另绕开 Termux libc++ 的 `__hash_memory` 解析坑），
      `analyzeHeadless` 实测分析成功（Decompiler Switch Analysis 29.8s）
- [x] ReVa 7.3.1（Ghidra MCP server，86 个工具）装好，`~/bin/reva-server start|stop|status|log`
      （绕开官方 PyGhidra/JPype 启动器，直接起扩展里的 Java 类）
- [x] 接进 app-server **且不重启用户正在用的 daemon**：`codex mcp add reva --url …` + `config/mcpServer/reload`
- [x] 端到端实测：`mcpServerStatus/list`（带 threadId 时 `runtimeStatus=connected`）、
      `mcpServer/tool/call` 真返回、模型真跑回合（`import-file → analyze-program → get-decompilation`，
      反编译出 `int add(int,int){return param_2 + param_1;}`）
- [x] patches/0095：设置页 MCP 行按 daemon 0.160.0 的真实字段（`runtimeStatus`/`tools` map）渲染
- [ ] 未做：ReVa 自启 / APK 内一键拉起、局域网访问与 API key 认证、`mcpServer/oauth/login`（仍无可登录对象）

### P8 — 自动化与后台

FEATURES.md 第 7 节：自建本地调度与持久化（协议无调度接口）、周期跟进、独立任务、运行记录、暂停/恢复/手动运行、漏跑补跑去重、Android 休眠与被杀后的行为说明。
**验收**：到点真实触发；重启后不重复不丢失；说明文档写清 `termux-wake-lock`、服务托管、前台服务各自解决什么，**不承诺进程永不被杀**。

进度（2026-10-16，证据见 E132）：

- [x] **协议核实**：`ClientRequest` 里 0 个 `schedul*` 方法；四种 schedule 形态只存在于插件声明面 →
      调度/持久化/补跑/通知全部自建（schedule 形态对齐桌面端）
- [x] **调度内核** `app/automation-service.js`：时间槽幂等键、先落盘再执行、catchUp 只补最新一个
      （更早的记 skipped）、并发上限、回合超时中断、原子写存储（`~/.codex/codex-webui/automation.json`）
- [x] **同会话周期跟进**（`target.mode=continueThread`）与**独立任务**（`newThread`）两种模式
- [x] **运行记录 / 暂停恢复 / 手动运行**都有真实执行逻辑（`probe/automation.test.mjs` 39 项：
      含"重启后不重复补跑"、"并发满记 skipped 并退回游标"、"超时被中断"）
- [x] **设置页 Automation**（patches/0096）：任务列表 + 创建表单 + 运行记录 + **保活三条说明**
      （`probe/automation-page.test.mjs` 31 项；每个按钮都验证了真的发什么请求）
- [x] **真机到点触发**（`probe/automation-live.mjs`）：不手动干预，20:52 自己起回合、记录 ok、通知发出
- [x] **`termux-job-scheduler` 兜底唤醒**：**其实 2026-10-15 就挂着**（job 4711 →
      `~/bin/codex-gui-watchdog`：补唤醒锁 + 桥不在就拉起），`watchdog.log` 实测 136 次、
      每小时 6~8 拍、21:38:26 真在桥停掉时拉起过（**E136**）。
      这一轮做的是：**别再谎报**——桥的 `GET /api/automation` 给出 `wake` 真值（作业列表 + 最近运行）、
      设置页显示真状态与"最多晚约 15 分钟"的下限、缺注册时一键补装。**限制照旧如实写**：
      JobScheduler 最小周期 15 分钟、无绝对时刻保证，只能"唤醒 + 补账"，不是精确调度器
- [x] 「继续某个会话」的**会话选择器**（patches/0099，E137）：切到该模式时从 `thread/list` 拉最近 50 条，
      显示「标题/预览 · id 前 8 位」；**拉不到就退回手填并写出真实原因**（不给空下拉框）；
      任务行标出「继续会话 <id8>」。`probe/automation-page.test.mjs` 46 项全过
- [x] 定时回合遇到审批/提问时的处置（patches/0100，E138）：请求到达的那一刻就记进运行记录
      （`run.awaiting`）并**立刻发一条带会话深链的通知**，页面运行记录里显示「等待你审批/回答」+
      「打开会话」按钮；`serverRequest/resolved` 或运行结束时清标记。
      **如实标注**：真机这次没能触发审批（`default` 档写工作区外也不问，见 E126），
      所以记账/通知/跳转是单元+DOM 测试钉住的，"后端何时真的发审批"仍未观察到

### P9 — APK 化与发布

> 2026-10-16 起上移为**当前交付形态**（用户决策："构建应用的工作提前到现在"，
> 之后每次迭代产出新 APK 供其在应用内测试）。

- [x] **M1：可安装 APK**（E101）——WebView 壳（深色主题/启动页/返回键）、
      **打开即自动拉起桥**（有权限走 RUN_COMMAND、否则分享通道；**0.3.5 起**：存活判定改成
      HTTP 应答而不是 TCP 端口，HTTP 静默满 8 秒就把 Termux 切前台解冻并重发启动请求，
      就绪后发一条"点回应用"通知 —— 见 E135）、
      **前台服务 + 置顶通知**（含「重新加载」「重启桥」）、
      **设备级 PARTIAL_WAKE_LOCK**（WebUI 做不到的保活）、文件选择、`versionCode` 自增的可复现构建脚本
- [x] 图标已做，**并已重做成自适应图标**（E142）：深色渐变底 + 原创 `>_` 记号，
      自适应图标三层（背景/前景/单色）+ 五档位图兜底 + 通知栏小图标 + 应用名改 `Codex GUI`；
      设计母版 `android/design/icon-master.svg`（带 512/144/72/48 预览）。
      **刻意没用 Codex/OpenAI 的 logo**（商标风险，公开仓库尤其）
- [x] **深链**（2026-10-16 更正：E128 已真机验证。日志 `apk: deep link delivered: 01a14087-…`；
      通知点击直达会话，本文件早先写"未做"是照抄待办、没查证）
- [x] **安全区**（同日更正）：顶栏 `calc(46px + env(safe-area-inset-top))`、输入区
      `padding: 8px max(8px,env(safe-area-inset-right)) max(8px,env(safe-area-inset-bottom)) …`、
      终端按键条底部也吃 inset（`style.css` 三处 `env(safe-area-inset-*)`，E43 + 横竖屏截图核对）
- [~] **拍照**：已实现并真机验证到"选择器里出现「拍照」"这一步（E141，APK 0.3.14）——
      本项目的 APK 没有 AndroidX，所以不用 FileProvider，改走 MediaStore 预插 + `content://` 作为
      `EXTRA_OUTPUT`；改选相册/取消会把预插记录清掉。**未验证**：没人按快门（我不会替你拍周围环境），
      所以"照片落盘并交回 WebView"只有代码路径。**录像**仍未做
- [x] **首次配置引导 = 启动自检**（patches/0101 + APK 0.3.9，E139）：`GET /api/setup` 把
      **两侧事实**合成一张清单（Android 侧由应用 `POST /api/setup` 上报：Termux 装没装、
      RUN_COMMAND 授权没有、通知有没有被禁、版本；Termux 侧由桥现查：`~/bin/codex-gui-web`、
      termux-api 四项、codex 版本、状态目录可写、兜底唤醒作业），设置 → 配置 页显示，
      缺项给具体动作；**查不到就写"还没上报过"**，不猜
- [x] **原生通知出口**（2026-10-16 更正：已落地并有日志证据）：桥的 `/api/notify` 在页面注册了
      原生接口时走应用自己的通知（`apk: native notification posted: Codex ✅ 完成 …`），
      应用不在跑才退回 `termux-notification`；`~/bin/codex-notify` 与定时任务共用这条出口
- [x] **升级/卸载说明**写进交付文档：`/sdcard/Download/codex-gui/INSTALL.md`
      （含覆盖安装为什么可行、哪些数据在 Termux 侧不会丢、回滚为什么要先卸载、
      卸载时要手动清哪些常驻、四类故障分别看哪个日志）
- **验收**：真机安装（非 PWA）后完成 P1 的 6 项与全部端到端场景。

### P9 前置：WebUI 日常化（用户决策后上移为近期目标）

### P9 交付约定：每次更新都发一版（2026-10-16 用户要求，长期有效）

- [x] **发行流程脚本化**：`~/codex-gui-github/scripts/release-apk.sh`
      （构建 → 提交 `AndroidManifest` 的版本号 → 打 tag `v<版本>` → 建 Release → 上传 APK），
      说明里自动写清"这只是壳 / 安装前提 / 自签名与 minSdk"三段，见仓库 `docs/RELEASING.md`
- [x] **首个发行版**：`v0.3.19`（APK 79,520 B）；从 Releases 下回来核对过
      **sha256 与本地构建完全一致**、`application-label: 'Codex GUI'`、图标指向自适应图标
- 以后每次产出新 APK 都要跑一遍这个脚本（APK 不进 git，只作为 Release 资产）

### 交付后修掉的真机 bug（2026-10-17）

- [x] **点模型输出里的文件（.md）没反应**（E143，patches/0102+0103，APK 0.3.20）：
  三种形态各自坏在不同地方——带行号引用**根本没有监听者**、不带行号的绝对路径被当**下载**
  （APK 没接 DownloadListener）、**裸相对路径**不被认成文件（点了导航到 404）。
  现在点开就是侧栏文件查看器，打不开会 toast 真实原因；APK 侧补了 DownloadListener 与外链交给系统。
**教训**：以前只验证了"`<a>` 生成出来了"，没验证"点了之后发生什么"——补的测试跑整条链。

### 附：E140（2026-10-16，用户"按计划进行"之后插入的收尾项）

- [x] **被冻结的桥：恢复时间 35~78 秒 → 5~8 秒**。根因不在 APK 的探测频率，而在 Termux 侧启动脚本：
      它对"冻住的监听"照样 `spawn`，然后 bind 失败白等一轮（脚本里那个"25 秒没就绪才重启"的分支
      是给正常启动留的）。现在用 `curl` 退出码判别（**7=端口空着 = 正在启动 / 28=连上但不应答 = 冻住**），
      28 就跳过等待、直接重启，并且**只收本项目自己的 `server.ts` 进程**（不是我们的只警告）。
      APK 0.3.10 把升级节奏从 20s 收到 10s。夹具与数字见 E140

按用户 2026-10-14 的决策，近期交付形态是 WebUI，因此下列原本属于 P9 的工作上移：

- [x] 一键启停脚本 `~/bin/codex-gui-web`（start/stop/restart/status/log/url，脱离终端运行，E37）
- [x] 模型 chip 可读：通用剥离厂商前缀 + 放宽窄屏宽度上限（E39，10 项断言）
- [x] `turn/steer` 无活动回合时回退为 `turn/start`（E40）
- [x] 空模型目录的真实空状态 + 简中文案（E42）
- [x] 软键盘不遮挡：`interactive-widget=resizes-content`（E42）
- [x] Android 返回键：先关抽屉/覆盖层，不退出应用（E43，11 项断言）
- [x] 安全区顶部：顶栏/网格/抽屉/审查面板统一 `calc(46px + env(...))`（E43，浏览器里等价）
- [ ] 抽屉式会话栏的进一步打磨（分组、未读标记、长按操作）
- [ ] **历史产物缺失的呈现**：会话只存路径不存内容，产物被删后图片必然取不到。
      现状是「破图 + 文件名」，看起来像故障；应改为明确的「文件已不存在」并显示路径（E44）。
      注意带文字的聊天图片已有 `message-image-unavailable` 兜底，缺的是活动缩略图那条路径。
- [ ] 自启与保活说明（`termux-wake-lock` / 前台服务 / 服务托管各自解决什么，不承诺永不被杀）
- [ ] 通知出口抽象化：桥不直接绑 `termux-notification`，APK 阶段改由应用发原生通知（用户 2026-10-14 决策）

## 4. 端到端验收清单（必须本机真机完成）

| # | 场景 | 归属阶段 | 状态 |
|---|---|---|---|
| 1 | 新建任务 → 流式 → 运行中追加 → 停止 → 继续 | P4 | **通过（E64，走桥 API 实测）**；浏览器里逐项点击未做 |
| 2 | 模型提问 → GUI 回答 → 任务继续 | P5 | 未做 |
| 3 | 命令/文件/网络/权限审批 → 允许/拒绝 → 后端状态正确 | P5 | 未做 |
| 4 | CLI 与 GUI 双向会话及**实时状态**同步 | P1 | 未做 |
| 5 | 文件修改 → diff → 审查定位 → 安全撤销 | P6 | 未做 |
| 6 | worktree 创建及会话关联 | P6 | 未做 |
| 7 | 终端交互、控制键、尺寸变化 | P6 | 未做 |
| 8 | 附件上传、产物预览、下载与分享 | P7 | 附件部分：接口 + 协议端到端通过（E82），浏览器界面待验收；产物预览/分享未做 |
| 9 | 后台通知与点击定位 | P7 | 未做 |
| 10 | 断线、重开、进程恢复 | P2/P9 | 未做 |
| 11 | 定时任务执行与记录、休眠/重启限制 | P8 | 未做 |
| 12 | 第三方 provider 正常使用与功能缺失提示 | 全程 | 部分（E3/E5） |

## 5. 安全设计（贯穿）

1. 只绑 `127.0.0.1`；不自动开放局域网或公网。
2. 桥→客户端：独立令牌 + Origin 校验 + 会话 Cookie；令牌不写入前端包、URL、普通日志、截图。
3. 桥→app-server：优先 stdio（无网络暴露）；用 WS 时启用 capability-token。
4. 路径访问控制：可浏览根白名单；拒绝路径穿越。
5. 预览与产物：用与主应用**不同的源/沙箱 iframe**，去掉脚本对桥的访问能力；WebView 关闭不必要的文件访问与 JS 原生接口。
6. 有副作用请求（`turn/start`、审批、提交、删除）走幂等键 + 重放保护。

## 6. 需要你决策或授权的开放项

### 用户决策记录

| 日期 | 决策 | 影响 |
|---|---|---|
| 2026-10-14 | **前期以 WebUI 为交付形态，APK 后置到迭代阶段**（起因：浏览器里模型问「形态」，用户在浏览器作答） | WebUI 成为近期主交付路径；P9 的 APK 阶段后移但**不删除**——原要求「网页能打开 ≠ 最终 App 完成」仍然成立，只是时序调整。移动端适配与中文化的优先级因此上升。 |
| 2026-10-14 | **APK 阶段的通知由应用自己发（原生 Android 通知），不再经过 Termux 的 `termux-notification`** | 影响两处设计：① 目前「回合完成 / 等待审批」的通知是走 `termux-notification` 的约定（也是模型自己会调的工具），APK 阶段改为宿主应用直接投递；② 前台服务 + 通知渠道本来就是 Android 上最可靠的保活手段，与「不承诺进程永不被杀」的诚实边界一致。桥侧需要把「通知事件」抽象成一个出口，而不是硬绑定 `termux-notification`。 |
| 2026-10-14 | **现阶段：打开 Termux 就自动启动桥**（已落地，E63）。**APK 阶段的要求（记下来，到 P9 必须满足）**：① **打开应用即可用**——启动 APK 时自动把桥/app-server 拉起来，不需要用户先开 Termux 敲命令；② **后台跑会话时用「置顶通知」防杀**（前台服务 + 置顶通知），保证后台执行中的会话不被系统回收。目标是「打开就能用、后台跑着不被打断」。 |

### 已记录、暂缓处理的问题

| 日期 | 问题 | 证据 | 为什么暂缓 |
|---|---|---|---|
| 2026-10-14 | **浏览器会话与终端会话是两个 app-server 实例**（互不可见对方进行中的回合；同一条线程可被两边同时写） | **E46** | 用户指示「先记录，之后再说」。它直接影响 P1 的「不串台」验收项，因此在做那项之前需要先决定是否采用「CLI 用 `~/bin/codex-gui` 接入同一个实例」这一布局（代价是改变日常启动习惯）。 |
| 2026-10-14 | ↑ 已按方案 1 处理：启动器改为「桥不在就自动拉起」，并实测出实时共享的完整条件（必须订阅该线程） | **E47** | 已解决。**遗留**：本对话所在实例无法迁移；日常若用普通 `codex` 仍会落在另一个实例上。 |
| 2026-10-14 | 首连时出现一次 `collab modes FAILED: Bridge transport changed`（随后自愈：`collab modes loaded: plan\|default` 正常） | **E86** 启动指纹 | 属 WS 首帧竞态（5s 连接超时后切换传输），当前不影响功能；修它需要动连接状态机，留到 P5「连接断开与重连」一起做。 |
| 2026-10-14 | **WebUI 形态的硬约束：浏览器在前台时 Termux 会被 HyperOS 冻结**（实测 `sleep 45` → 585 秒；持 `termux-wake-lock` 则 40 秒跑完、采样 0 丢拍） | **E87** | 现已在 `codex-gui-web start` 里成对取/放唤醒锁（代价：通知栏多一条 Termux 通知）。**这条也是 P9 的论据**：APK 形态用前台服务 + 置顶通知，正是用户已经提出的要求，不是可选装饰。 |
| 2026-10-14 | 该 app-server build 对某些线程 `thread/read{includeTurns}` / `thread/turns/list` 答 `list_turns is not supported yet`，`thread/read` 不带 turns 时返回 `turns: []` | **E87** 实测（`probe/raw-rpc.mjs`） | 已加 `thread/resume` 回退（resume 会带 turns）。这属于「后端能力缺失 → 需要本项目补充」，记入 FEATURES 时按 B 类处理；`host/thread/live` 是桥自己实现的方法，继续作为运行态来源。 |

| # | 事项 | 为什么需要你 | 我的建议 |
|---|---|---|---|
| 1 | 是否允许重启当前守护进程（PID 12365） | 它在跑旧二进制，且你明确要求不要停它 | 先做 P1 路径 1；路径 2 留到你确认 |
| 2 | 日常是否接受一条常驻通知 | 后台可靠性的代价 | 先做成可开关，实测后再定 |
| 3 | APK 包名与签名 | 影响升级与卸载 | 默认 `dev.termux.codexgui`，自签名 |
| 4 | 是否需要保留英文界面 | 影响 i18n 工作量 | 默认简中 + 英文切换 |
