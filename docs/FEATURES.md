# FEATURES.md — Codex 手机端功能对照表

## 基线（Baseline）

| 项 | 值 |
|---|---|
| 建表日期 | 2026-10-14 |
| 参考 CLI | `codex-cli 0.162.1`（`@mmmbuto/codex-cli-termux` 0.162.1-termux.1） |
| 参考协议 | app-server `[experimental]`，v2 命令面；本机 `generate-ts` 产出 743 个类型文件 |
| 协议类型来源 | 本机 `codex app-server generate-ts`（生成于 2026-10-14），非文档转述 |
| 桌面端功能来源 | ① app-server 协议面（`ServerRequest` / `ServerNotification` / `ClientRequest` 联合类型）；② `codex features list`；③ `codex --help` 子命令面；④ 社区客户端实现交叉印证 |
| 未能取得的来源 | `developers.openai.com` 从本网络返回 **403 Forbidden**（证据 E22）。因此「桌面端功能清单」不含官方文档的逐条对照，需在可访问时补验 |
| 证据库 | 同目录 [`VERIFICATION.md`](./VERIFICATION.md)，编号 E1…E22 |

**基线声明**：本表是当前可得的**最低覆盖范围**，不是封闭清单。官方文档恢复可达后必须重新对照并补行。

## 分类图例

| 代号 | 含义 |
|---|---|
| **A** | app-server 已提供，手机端接入即可 |
| **B** | 桌面客户端自行实现，本项目需补充（本地桥或前端） |
| **C** | 依赖 Android / Termux 的能力，需要适配 |
| **D** | 依赖官方账户、云服务、专有组件或当前 provider 不支持 |

## 状态图例

`未开始` = 尚无代码；`协议已核实` = 后端能力经类型/实测确认，前端未做；`阻塞` = 已确认当前不可用并有证据；`需实测` = 存在实现路径但未跑通。

---

## 1. 项目与会话

| 功能 | 桌面端形态 | 手机端交互 | 后端来源 | 类 | 状态 | 验收方法 | 限制与证据 |
|---|---|---|---|---|---|---|---|
| 项目/目录列表 | 侧栏项目树 | 抽屉首页列表 | `thread/list` 按 `cwd` 聚合；`fs/readDirectory` | A | 协议已核实 | 列出 ≥3 个真实 cwd 分组 | E4、E17 |
| 手动添加项目 | 「添加目录」 | 全屏目录选择器 | `fs/readDirectory` + `defaultBrowseRoots` | A+B | 未开始 | 选任意 Termux 目录后出现在侧栏 | E17；需桥限制可浏览根 |
| 切换项目 | 点击项目 | 抽屉项点击 | `thread/list?cwd=` | A | 协议已核实 | 切换后列表与标题一致 | E4 |
| 会话列表 | 项目下会话项 | 卡片列表 | `thread/list`（分页 `cursor`） | A | 协议已核实 | 分页加载 ≥50 条不卡顿 | E4 |
| 会话搜索 | 搜索框 | 顶部搜索 | `thread/list.searchTerm` | A | 协议已核实 | 关键词命中真实会话 | E4 类型字段 |
| 历史分页 | 无限滚动 | 无限滚动 | `thread/turns/list`、`thread/items/list` | A | 协议已核实 | 旧会话可加载全部回合 | E6 |
| 新建会话 | 新建按钮 | 输入区直接开局 | `thread/start` | A | 未开始 | 新会话出现在 CLI `thread/list` | E6 |
| 继续会话 | 点击历史会话 | 卡片点击 | `thread/resume` | A | 机制已实测、用例未跑 | **GUI 建的会话能在 CLI 继续**（双向） | E25：会话由服务端持有，`--remote … resume <threadId>` 可重连；完整用例待 P1 补 |
| 重命名 | 标题内联编辑 | 长按→重命名 | `thread/name/set` | A | 协议已核实 | CLI 侧看到新名称 | E6 |
| 分叉 | Fork 菜单 | 溢出菜单 | `thread/fork` | A | 协议已核实 | 分叉后原会话不变 | E6 |
| 分组/分区 | Section | 分区折叠组 | `threadSection/list|create|update|delete|move` | A | 协议已核实 | 分区创建后跨重启保持 | E6 |
| 置顶/排序 | 拖拽 | 长按拖拽 | 客户端排序（`sortKey`/`sortDirection`） | B | 未开始 | 顺序持久化 | 协议无置顶字段，需本地持久化 |
| 归档 | 归档菜单 | 滑动归档 | `thread/archive`、`thread/unarchive` | A | 协议已核实 | 归档后默认列表消失 | E6 |
| 删除（区别于归档） | 删除+确认 | 危险二次确认 | `thread/delete` | A | 协议已核实 | 删除需显式确认，不可误触 | E6 |
| 未读/运行状态 | 状态点 | 卡片徽章 | `thread/list.status`；通知 `thread/status/changed` 类事件 | A | 协议已核实 | 徽章与真实状态一致 | 二进制字符串 `ThreadStatusChanged` |
| 多会话并行 | 多标签/多窗格 | 会话切换器 + 后台列表 | 每个 thread 独立 turn | A | 部分实测 | 两个会话同时运行互不干扰 | E24：两个并发客户端共享同一内存状态；「同时运行两个回合」未实测 |

## 2. 对话与任务控制

| 功能 | 桌面端形态 | 手机端交互 | 后端来源 | 类 | 状态 | 验收方法 | 限制与证据 |
|---|---|---|---|---|---|---|---|
| 流式输出 | 正文逐字 | 流式正文 | `item/started`、`item/completed`、`AgentMessageDelta` | A | 协议已核实 | 首字节延迟 <2s | E6、二进制 `AgentMessageDeltaNotification` |
| 过程 vs 最终回答 | reasoning 折叠 | 可折叠「思考中」块 | `ReasoningTextDelta`、`AgentMessagePhase`（`commentary`/`final_answer`） | A | 协议已核实 | 过程更新不混入最终回答 | 二进制 `commentary`/`final_answer`/`phase` |
| Markdown/代码高亮 | 渲染 | 同 | 前端渲染（桥透传原始文本） | B | 未开始 | 表格/围栏/链接点击正确 | codex-webui 已用 marked+highlight 实现，可复用 |
| 数学公式 | KaTeX | 同 | 前端 | B | 未开始 | 行内/块级公式渲染 | codex-webui 已含 katex（E19） |
| 计划与步骤状态 | Plan 块 | Plan 卡片 | `PlanUpdate`/`thread/plan/updated` 类事件、`item/type=Plan` | A | 协议已核实 | 步骤状态实时更新 | 二进制 `PlanDelta`、`ThreadPlanUpdated` |
| Default / Plan 模式 | 模式切换 | 输入区模式 chip | `CollaborationMode{mode: "plan"|"default", settings}` | A | 协议已核实 | 切 Plan 后行为改变 | E6，`ModeKind` 只有这两个值 |
| 模型切换 | 模型下拉 | 底部弹层 | `model/list` → `turn/start`/`thread/start` 参数 | A | 协议已核实 | 列表来自真实发现 | E3（第三方 provider 返回 deepseek 模型） |
| 推理档位 | effort 选择 | 同弹层 | `model/list.supportedReasoningEfforts` | A | 协议已核实 | 档位与后端一致 | E3；**禁止硬编码 OpenAI 档位** |
| 运行中追加指令 | Steer | 输入变形为「追加」 | `turn/steer` | A | 未开始 | 运行中追加不中断回合 | E6 |
| 停止 | Stop | 输入变形为「停止」 | `turn/interrupt` | A | 未开始 | 停止后状态回到可输入 | E6 |
| 失败恢复 | 重试 | 错误卡+重试 | `turn/start` 重发（**须防重复副作用**） | B | 未开始 | 断线后不盲目重发 | 用户硬性要求；见 PLAN 安全章 |
| 附件：图片 | 拖拽/粘贴 | composer「图片」按钮 `<label for="attachmentPicker">` → 系统选择器/相册 | `UserInput.localImage{path}`（字节经桥落盘换路径） | A+C | **已真机验证**（选择器返回、落盘、带进消息）；**上传已改原始字节（E134）** | 图片进入模型上下文 | **E82** 上限/权限/净化；**E86** `<label for>` 是安卓上唯一可靠触发；**E88** 只有图片无文字也合法（实测）；**E89** 之前附件从未进消息（快照顺序 bug，已修）；**E91** chip 背景上的真实进度条；**E133** 假相机按钮已删、图片入口图标 `+`→`image`；**E134** base64+JSON 让体积涨 33% 且进度事件不可用 → 改发 File 原始字节（8.49 MB：425ms→37ms），等桥响应时走条纹动画 |
| 附件：文件 | 拖拽 | composer「文件」按钮 `<label for="filePicker">`（`accept` 限定非媒体类型以强制文档选择器）；消息里渲染成**一行芯片**（文件图标 + 文件名 + 「路径」，点开是完整路径） | `UserInput.mention{name,path}` | A+C | **已真机验证**（zip/PDF 均落盘并随消息发出）；**上传已改原始字节（E134）** | 文件路径被正确引用 | **E82** 非图片走 `mention`；**E90** 上传成功但回执被冻结吃掉时的表现与文案；**E91** 三阶段进度（读取/百分比/等待桥响应）；**E119** 250+ 字符的绝对路径原本横向溢出气泡（`white-space:pre-wrap` 无 `overflow-wrap`）→ 兜底折行 + 芯片化，模型侧文本不变；**E134** 进度条不动的根因是字符串 body 没有 `lengthComputable`，改发 File 原始字节后进度事件可用（DOM 级测试钉住） |
| 技能引用 | @ 菜单 | 斜杠/@ 菜单 | `UserInput{type:"skill",name,path}`；`skills/list` | A | 协议已核实 | 引用后走对应技能 | E6 |
| 文件引用（mention） | @ 文件 | 同 | `UserInput{type:"mention"}`、`fuzzyFileSearch` | A | 协议已核实 | 引用文件出现在上下文 | E6 |
| 输入草稿保留 | 自动 | 自动（本地存储） | 前端 | B | 未开始 | 切换会话/重开 App 草稿不丢 | 用户硬性要求 |
| 不强制拉到底部 | — | 查看旧消息时不跳 | 前端 | B | 未开始 | 上滑阅读时流式不清屏 | 用户硬性要求 |

## 3. 工具活动与完整交互

| 功能 | 桌面端形态 | 手机端交互 | 后端来源 | 类 | 状态 | 验收方法 | 限制与证据 |
|---|---|---|---|---|---|---|---|
| 命令卡片 | 命令+输出 | 折叠卡 | `ThreadItem.CommandExecution`（12 字段） | A | 协议已核实 | 命令、输出、退出码齐全 | 二进制 `CommandExecutionItem` |
| 输出流式 | 实时 | 实时 | `CommandExecutionOutputDelta`、`ProcessOutputDelta` | A | 协议已核实 | 长命令输出逐段出现 | 二进制 |
| 退出码/耗时 | 徽章 | 徽章 | `exit_code`、`started_at_ms`、`completed_at_ms` | A | 协议已核实 | 失败命令显示非 0 | 二进制字段 |
| 文件改动卡 | diff | 卡片+抽屉 | `FileChangeOutputDelta`、`FileChangePatchUpdated` | A | 协议已核实 | 显示 `+/-` 统计 | 二进制 |
| 搜索活动 | 搜索卡 | 卡片 | `WebSearch`、`FuzzyFileSearch*` | A | 协议已核实 | 展示查询与命中数 | E6 |
| MCP 调用 | 卡片 | 卡片 | `ThreadItem.McpToolCall`（13 字段）、`McpToolCallProgress` | A | **真服务器调用已实测（E131）** | 展示 server/tool/结果 | E131：真接 ReVa（Ghidra MCP，86 工具），回合里出现 `mcpToolCall server=reva tool=import-file / analyze-program / get-decompilation`；GUI 卡片渲染本轮未截图（同一 thread 可在 GUI 打开复核） |
| 子代理/协作活动 | Collab 卡片 | 嵌套卡片 | `SubAgentActivity`、`CollabAgent*` 事件（spawn/wait/close/resume/交互） | A | 协议已核实 | 显示子代理角色与状态 | 二进制 `CollabAgentSpawnBegin` 等 |
| 图片查看 | 内联 | 全屏查看器 | `ThreadItem.ImageView`、`ImageView` | A | 协议已核实 | 点击可放大/保存 | 二进制 |
| 错误展示 | 错误块 | 红卡+原始串 | `StreamError`、`ErrorEvent`、`turn/completed` 错误态 | A | 协议已核实 | 原始错误可见且可复制 | 二进制 |
| **模型向用户提问** | 单选/多选/自由文本 | 会话内卡片 | `item/tool/requestUserInput` → `ToolRequestUserInputParams{questions[{header,question,isOther,isSecret,options}]}` | A | **真机全链路验证（E114，Plan 模式）** | 模型提问时 GUI 能答且任务继续 | 客户端已实现 + 22 项单测；**工具受模式门槛限制**，见 E34；上游原本直接回 `-32601` |
| **MCP 表单/授权** | 表单 | 会话内卡片 | `mcpServer/elicitation/request`，mode=`form`/`openai/form`/`openaiForm`/`url` | A | **form 模式真机全链路验证（E115）** | form 模式可提交；url 模式可跳转 | 客户端已实现 + 单测；无 elicitation 型 MCP server 可触发；未类型化表单**拒绝伪造字段**，只给拒绝/取消 |
| 命令审批 | 审批条 | 底部弹层 | `item/commandExecution/requestApproval` | A | **已实测往返** | 允许/拒绝后后端状态正确 | **E31**：decline → `Rejected by user`；accept → 命令执行 |
| 文件改动审批 | 审批条 | 底部弹层 | `item/fileChange/requestApproval` | A | **真机验证（E115：批准后文件真的写入）** | 同上 | E13 |
| 权限审批 | 审批条 | 底部弹层 | `item/permissions/requestApproval`（含 network / fileSystem 追加权限） | A | **未真机触发；接线+单测覆盖（E115）** | 权限追加需明示范围 | E13、`RequestPermissionProfile` |
| 网络审批 | 提示域名 | 卡片显示 host | `networkApprovalContext{host,protocol}` + `proposedNetworkPolicyAmendments` | A | 协议已核实 | 显示真实 host，不可泛化授权 | E13 |
| 审批按钮动态生成 | 按类型 | 按类型 | `availableDecisions`（**实测在 wire 上，但不在生成的类型里**） | A+B | **已修复并测试** | 只发送集合内的值 | **E29**；`patches/0001`；`probe/approval-model.test.mjs` 14 项全过 |
| 审批并发/去重 | — | 同 | 关联 `requestId`+`threadId`+`turnId`+`approvalId` | B | **已验证（E112/E113：重复只出一张卡、resolved 收卡、刷新后恢复）** | 并发审批不串台、重复点击安全 | E31：脚本与浏览器同时作答不冲突；去重未系统验证 |
| 未作答请求可见性 | 等待态 | 会话徽章 | `thread.status.activeFlags: waitingOnApproval / waitingOnUserInput` | A | **已实测** | 有挂起请求时界面必须可见 | **E32**：未作答时线程停在 `active+waitingOnApproval` |
| 工具活动需 full 视图 | — | — | `thread/turns/list{itemsView:"full"}` | A | **已实测** | 命令/输出/reasoning 可见 | **E32**：默认 `summary` 只有用户消息 |
| 请求已解决 | — | 自动收起 | `ServerRequestResolvedNotification` | A | 协议已核实 | 别处已处理后弹层消失 | 二进制 |
| Guardian / 严格复核 | 提示 | 提示卡 | `ItemGuardianApprovalReview*`、`autoApprovalReview/strictReviewRequired` | A | 未开始 | 严格复核事件可见 | 二进制 |

## 4. 文件、Git、审查、worktree

| 功能 | 桌面端形态 | 手机端交互 | 后端来源 | 类 | 状态 | 验收方法 | 限制与证据 |
|---|---|---|---|---|---|---|---|
| 文件树 | 侧栏 | 全屏面板 | `fs/readDirectory` | A | **已真机验证** | 展开真实目录 | E123（`~/shots/p6-53.png`）；目录在前、可上下走 |
| 文件搜索 | 快速打开 | 搜索面板 | 桥的 `searchWorkspaceFiles`（与 @ 补全同一实现） | A | **已实测** | 命中并可打开 | `probe/fs-api.mjs` 的 search 项；`fuzzyFileSearch` 未接（协议里有，未验证） |
| 读文本 | 编辑器 | 只读/预览 | `fs/readFile` | A | **已真机验证** | 中文不乱码 | E123；2 MB 上限、二进制明说不能预览 |
| 基本编辑 | 编辑器 | 轻量编辑 + 保存确认 | `fs/writeFile` | A | **已真机验证** | 保存后 diff 反映 | E123（保存后磁盘与 `git status` 同步） |
| 真实 diff | diff 视图 | 卡片+全屏 | `FileChange`、`gitDiffToRemote`、`FileChangePatchUpdated` | A | 协议已核实 | 行内定位正确 | E6 |
| 文件级统计 | +/- | 徽章 | `FileUpdateChange` | A | 协议已核实 | 统计与 diff 一致 | 二进制 |
| 分支/工作区状态 | 状态栏 | 顶部 chip | `ConversationGitInfo`（branch/sha/commits/uncommittedChanges） | A | 协议已核实 | 与 `git status` 一致 | E6 |
| 暂存/提交/拉取/推送 | 面板 | Git 面板 | **无 app-server 方法** → 桥调用 `git`（`/api/git`） | B+C | **已真机验证** | 操作后状态刷新 | E123；argv 直传、失败带 git 原始 stderr；Fetch 单独一个按钮（ahead/behind 依赖它） |
| 审查：当前改动 | Review 面板 | 全屏审查 | 模型回合的 `fileChange` items（前端合成 diff） | A+B | **已真机验证** | 审查产出真实结论 | E122/E123；`review/start` **未接**（下面一行） |
| 审查目标：当前改动 / 分支对比 / 指定提交 / 自定义 | 面板里选目标 | 审查面板的「审查目标」按钮 → 弹层选四项 | `review/start {threadId, target: ReviewTarget}` | A | **协议路径已实测** | 四种目标都能选、结果出现在对话里 | E125：`uncommittedChanges` 真跑过一次审查回合（模型产出真实意见）；四种 target 载荷逐变体单测；分支/提交列表复用 `/api/git branches|log` |
| 行内审查定位 | 点击引用跳转 | 消息里的引用芯片 → 打开文件并滚到该行 | `agentMessage.memoryCitation.entries[{path,lineStart,lineEnd,note}]` | A | `[~]` **实现+单测，缺真实数据** | 跳转行号正确 | E125：patches/0084 + `probe/review-targets-citations.test.mjs`；**本机 provider 不返回 `memoryCitation`**（review 回合实测 null），未真机验收 |
| worktree 创建/切换/清理 | 工作区分组 | Git 面板的 worktree 段 | **无 app-server 方法** → 桥调用 `git worktree` | B+C | **已真机验证** | 会话与 worktree 关联正确 | E123；建完问"是否切换工作区"（新会话用它）；删除有确认，脏了会问是否强删 |
| **回合回退语义** | Undo | 需明确文案 | `thread/revert` **只改对话历史，不回退文件** | A | 协议已核实 | 文件撤销必须另走 Git 且保冲突检测 | **E12（类型注释原文）** |
| 文件撤销的实现 | Undo/Reapply | 审查面板的撤销/重做按钮 | 桥基于 Git（反向 `git apply`） | B | **已真机验证** | 有后续修改时拒绝或提示冲突 | E122：`--check` 先校验；用户后来改过 → 拒绝并保留用户内容；桥重启后回源重建 diff |

## 5. 集成终端

| 功能 | 桌面端形态 | 手机端交互 | 后端来源 | 类 | 状态 | 验收方法 | 限制与证据 |
|---|---|---|---|---|---|---|---|
| 交互式 PTY | 终端面板 | 侧栏全屏终端 | `command/exec{tty:true}` + `write|resize|terminate`（桥转成 `/terminal` WS） | A | **已真机验证** | 能跑交互程序 | E123：真提示符在工作区目录；`probe/pty-exec.mjs` 10 项（回显/`stty size`/中文分片/Ctrl+C→$?=130/退出码）；node-pty 已弃用 |
| 尺寸变化 | 自适应 | 横竖屏重算 | `command/exec/resize` | A | **协议层已实测** | 旋转后不串行 | `probe/pty-exec.mjs` 里 `resize → stty size` 立刻变（40×120）；**手机旋转本身未测** |
| Ctrl/C 等控制键 | 键盘 | 终端底部按键条 | 作为 stdin 字节发送 | A+C | **已真机验证** | Ctrl+C 能中断前台进程 | E123：`sleep 60` → 点 Ctrl+C → `^C` 立即回提示符；Esc/Tab/Ctrl+D/Ctrl+Z/方向键同条 |
| 进程退出状态 | 提示 | `[Process exited N]` | `CommandExecResponse` | A | **已实测** | 退出码可见 | `probe/terminal-bridge.mjs`（exit 3 → 页面收到 `[Process exited 3]` 后连接关闭） |
| stdin 审批 | — | 弹层 | `CommandExecutionApprovalKind="writeStdin"` | A | 协议已核实 | 写入已存在终端前有审批 | E13 |
| 区分模型命令卡 vs 用户终端 | 两者分离 | 分离 | 前者 `ThreadItem.CommandExecution`（对话里），后者 `command/exec`（终端面板） | B | **已真机验证** | 两者不混在同一容器 | E123：终端面板与对话里的命令卡是两套容器、两条通道 |
| node-pty 备选 | — | — | 仅在 app-server PTY 不可用时启用 | C | 备份方案 | — | **E19/E11：优先用协议 PTY，避免原生编译** |

## 6. 设置与扩展

| 功能 | 桌面端形态 | 手机端交互 | 后端来源 | 类 | 状态 | 验收方法 | 限制与证据 |
|---|---|---|---|---|---|---|---|
| 模型/provider 列表 | 设置页 | 设置页 | `model/list`、`modelProvider/capabilities/read` | A | 协议已核实 | 显示当前 provider 真实值 | E3 |
| 账户信息 | 账户区 | 设置页 → Profile | `account/read` | A/D | **已实测（阻塞已如实呈现）** | 显示真实原因而非转圈 | E127：第三方 provider 下 `account:null` → 页面写明"provider 不提供账户，计费在 provider 那边" |
| 用量与限额 | 用量页 | 设置页 → Profile | `account/usage/read`、`account/rateLimits/read` | A/D | **已实测（真实报错照原样显示）** | 不可用时显示「provider 不支持」 | E127：两个调用直接抛错，页面把错误文本显示出来，不转圈 |
| 权限/沙箱设置 | 设置页 | 设置页 → 配置 | `permissionProfile/list`、`SandboxMode`、`AskForApproval` | A | **已实测：本平台不隔离** | 修改后后端行为改变 | **E126：`readOnly`/`workspaceWrite` 策略下命令照样写工作区外、照样联网；thread 级 `sandbox:"read-only"` + 实例级 `-c sandbox_mode=read-only` 时模型照样写入成功**。设置页写明"当意图声明、不是边界"，真正生效的是审批（E112/E113） |
| 配置读取 | config.toml | 设置页 → 配置（真值） | `config/read` | A | **已真机验证** | 显示有效值与覆盖来源 | E127：`approval_policy` / `sandbox_mode` / provider / 模型 / 档位 / 权限档位都是真值（`~/shots/p7-13.png`） |
| 配置安全修改 | 设置项 | 设置页 → 审批策略（带确认） | `config/value/write`（经桥的受控出口） | A | **已实测** | 改完影响后端；禁全量覆盖 | E127：`POST /api/config/write` 只允许 `approval_policy`/`sandbox_mode`（枚举校验），单键写入保留其它键；**浏览器侧的任意 keyPath 写入已从白名单摘掉** |
| Skills | 列表 | 设置页 → 技能 | `skills/list`、`skills/config/write`、`skills/extraRoots/set` | A | **列表已实测** | 列表来自真实发现 | E127：`probe/settings-live.test.mjs`；写配置（extraRoots/config）未接 |
| MCP | 服务器列表 | 设置页 → 插件 | `mcpServerStatus/list`、`config/mcpServer/reload`、`mcpServer/tool/call`、`mcpServer/oauth/login` | A | **列表 + 重载 + 工具调用已实测（真服务器）**；OAuth 未接 | 状态/工具真实 | E131：接真 ReVa（`--url http://127.0.0.1:8080/mcp/message`）→ `config/mcpServer/reload` 无需重启即生效 → `mcpServerStatus/list` 报 `serverInfo=ReVa`、86 tools、`toolsError=null`，带 `threadId` 时 `runtimeStatus=connected` → `mcpServer/tool/call` 真返回；**daemon 0.160.0 的字段是 `runtimeStatus`/`httpOrigin`/`tools`(map)**，页面据此修过（patches/0095）。`mcpServer/oauth/login` 仍无真实对象可验（ReVa 是 url 直连） |
| 插件/市场 | 商店页 | 设置页 → 插件（加/移除市场、安装/卸载插件） | `plugin/*` + `marketplace/*`（经桥的受控出口 `/api/plugins`） | A/D | **整条链路已实测** | 可装本地插件；远程市场依赖账户 | E130：本地市场 → 安装 → 卸载 → 移除市场全通；`marketplace/*` 不在浏览器白名单，故走受控出口；`plugin/*` 的 share/checkout/upgrade 未接（依赖官方账户） |
| 实验特性开关 | 设置 | 设置 | `experimentalFeature/list`、`experimentalFeature/enablement/set` | A | 协议已核实 | 开关生效 | E6 |
| 钩子（Hooks） | 设置 | 列表 | `hooks/list`、`HookStarted/Completed` | A | 协议已核实 | 钩子运行可见 | 二进制 |

## 7. 自动化与持续任务

| 功能 | 桌面端形态 | 手机端交互 | 后端来源 | 类 | 状态 | 验收方法 | 限制与证据 |
|---|---|---|---|---|---|---|---|
| 定时任务 | 计划任务页 | 设置 → Automation | **协议无调度方法**（`ClientRequest` 里 0 个 `schedul*`；`ScheduledTaskSummary/Schedule` 只在 `PluginDetail.scheduledTasks` 这个声明面） | B+C | **已实测（真机到点触发）** | 到点真实触发 | E132：自建调度内核（时间槽幂等 + 原子写存储）；`probe/automation-live.mjs` 20:52 自己起回合、记录 ok、通知发出；桥不在时**不承诺**到点执行 |
| 同会话周期跟进 | 跟进 | 任务详情（**会话选择器**，不用手抄 id） | `turn/start`（同 thread 重发）+ `thread/list` 拉候选 | B | **已实测（离线单测 + 真机）** | 周期回合进入原会话 | E132：`target.mode=continueThread`，同一个槽只执行一次、重启不重复；**E137**：会话选择器从 `thread/list` 取最近 50 条（`name` 可能为 null，按 name→title→preview 兜底），拉不到列表时退回手填并写出真实原因；任务行标出`继续会话 <id8>`（不反查标题） |
| 独立任务运行 | 后台任务 | 任务列表 | `thread/start` + 独立 turn | B | **已实测** | 并行任务互不阻塞 | E132：`sweep()` 启动后不阻塞等待，并发上限 2（满了记 skipped 并退回游标，不假装跑过） |
| 运行记录 | 历史 | 任务历史 | 桥本地持久化 | B | **已实测** | 重开后记录仍在 | E132：`~/.codex/codex-webui/automation.json` 原子写；记录先落盘再执行；单测覆盖"重启后任务/记录/游标都还在" |
| 暂停/恢复/手动运行 | 控制 | 按钮 | 桥调度器 | B | **已实测** | 每个按钮都有真实执行逻辑 | E132：`probe/automation-page.test.mjs` 逐个验证按钮发出的请求（runNow / disable / remove + 删除确认） |
| 定时回合的审批/提问 | 审批条 | 运行记录徽标 + 「打开会话」 | `ServerRequest`（`item/*/requestApproval`、`item/tool/requestUserInput`） | B | **单元 + DOM 已实测；真机未能触发** | 等审批时立刻通知并可跳转 | **E138**：桥在请求到达那一刻记 `run.awaiting` 并**立刻发带会话深链的通知**（点开就能批），页面显示「等待你审批/回答」+「打开会话」；`serverRequest/resolved` 清标记；30 分钟超时仍作为兜底。真机尝试（`default` 档写工作区外）**后端没有发审批请求**（与 E126 一致），所以"后端何时才真的问审批"未观察到，探针留 `--expect-approval` |
| 漏跑/补跑/重复执行 | — | 任务页说明 | 桥调度器 + 存储 | B+C | **已实测** | 重启后不重复不丢失 | E132：默认只补最新一个槽、更早的记 skipped 并写明原因；`catchUp=skip` 一个不补但照样记账；界面写明"桥不在时到点不会触发" |
| 后台保活说明 | — | 任务页 | `termux-wake-lock` / 前台服务 / JobScheduler | C | **已实测（三条都是真值）** | 分别说明三者解决什么 | E132 页面三条写清各自解决/不解决什么，明确"不是永不被杀"；**E136 更正**：JobScheduler 早就挂着（job 4711 → `~/bin/codex-gui-watchdog`，136 次运行、21:38:26 真拉起过），页面现在显示它的真状态与最近运行时间，缺注册可一键补装；限制照写：最小 15 分钟、无绝对时刻保证 |

## 8. 预览、产物与系统集成

| 功能 | 桌面端形态 | 手机端交互 | 后端来源 | 类 | 状态 | 验收方法 | 限制与证据 |
|---|---|---|---|---|---|---|---|
| 图片/PDF/音视频查看 | 内联预览 | 图片内联显示；其余交给系统应用 | 桥 `/api/images/local` + `termux-open --view` | B+C | **已实测（机制）** | 四类文件均可打开 | E128：图片走内联（与消息缩略图同一条路）；PDF/音视频用 `termux-open --view` 交给系统应用（`probe/files-action.test.mjs` 验的是机制，不是具体某个播放器） |
| 代码/文本产物 | 编辑器 | 查看器+分享 | `fs/readFile` + 桥 | A+B | **已实测** | 大文件不卡 | E127/E128：文本查看器有 2 MB 上限（超出明说）、编辑保存；打开/分享/存到 Download 三条动作都验过 |
| HTML 预览 | 内嵌浏览器 | 文件面板「预览」→ 侧栏浏览器面板 | 桥 `/api/files/preview`（带 `CSP: sandbox`） | A+C | **已真机验证** | 预览无桥权限 | E129：`content-security-policy: sandbox` 让被预览页面拿不到桥的同源数据；真机在浏览器面板里显示本地 HTML |
| 下载与分享 | 保存/分享 | 查看器里的三个按钮 | `termux-open --send` / 复制到 Download | C | **已真机验证** | 分享到外部应用成功 | E128：`termux-open` 返回 0；存到 `/sdcard/Download/codex-gui/` 的内容逐字节核对过 |
| 通知点击直达 | 跳转 | 深链 | 桥 `notification/native` 带 `threadId` → APK PendingIntent extra → 页面 `codexDeepLinkOpen` | B+C | **已真机验证** | 点击落到正确会话 | E128：点通知跳到目标会话，日志两侧都对上；**审批**那一支未单测（沿用同一链路） |
| 文件选择/拍照/分享入口 | 拖拽 | 系统选择器：图片/视频、本地文件、**拍照** | Android file chooser + MediaStore + 桥 | C | **入口已真机验证；快门之后那步未验证** | 每个入口都真的能用 | E133：删掉了假相机入口（`capture` 被宿主忽略）；**E141：真入口做出来了** —— 手写流水线没有 AndroidX，所以不走 FileProvider，而是往 MediaStore 插一条待写图片、把它的 `content://` 交给 `ACTION_IMAGE_CAPTURE`（选择器里出现「拍照」，真机截图确认）；改选相册/取消时会把预插的空记录删掉。**未验证**：没有替你按快门，"照片落盘并交回 WebView"只有代码路径 |
| ~~内嵌可视化~~ | — | — | — | — | **更正：不属于本机** | — | E129：`inlineVisualization` 是**实时语音** UI 的展示层（`ThreadRealtimeBemItemPresentation`），本构建无音频后端（E20）。原判断"图表"是误读 |
| 浏览器自动化 | 浏览器面板 | 受限 | `browser_use*` 特性（`enabled=true`） | A/D | **运行时已核实：工具不提供** | 真能驱动才标注 | E130：真跑回合——模型自己查 `codex mcp list` 得"无 MCP 服务器"，明确说本会话没有该工具，改用 curl。**特性开关 ≠ 工具可用**。要真用需自挂 Playwright/CDP MCP + 可跑的 Chromium/CDP 端点（未验证） |
| 电脑操作（computer use） | — | 无对等 | `computer_use` 特性（`enabled=true`） | D | **运行时已核实：工具不提供** | 列出限制与替代 | E130：模型明确回"没有"，且未用 ADB/CodexBridge 替代；配置结构只有 macos/windows（E129）→ Android 无对等实现 |
| 远程主机 | 远程 | 无对等 | `environmentId`、`EnvironmentConnection` | D | 阻塞 | 说明差异 | 二进制含 `EnvironmentConnectionEvent` |
| 云任务 | Codex Cloud | 无对等 | `codex cloud` 子命令 | D | 阻塞 | 说明差异 | 依赖官方账户 |
| 连接器 | Connectors | 无对等 | `connector_id`/`link_id` 字段 | D | 阻塞 | 说明差异 | 二进制含 connector 元数据 |
| 实时语音 | 语音会话 | 无对等 | `RealtimeConversation*` 事件存在，但 **Termux 构建已移除音频后端** | D | 阻塞 | — | **E20：fork README 明确说 realtime voice 不在本构建内** |
| 图像生成 | image tool | 同 | `ImageGeneration*`、`image_generation` 特性 | A/D | 需实测 | 能真出图 | 依赖 provider 能力 |
| 嵌入式 UI 小应用（MCP app） | 面板 | 面板 | `mcpAppResourceUri`、`mcp_app_*` | A | 协议已核实 | 资源可加载 | 二进制 |

---

## 附：本表已知缺项（不得当作已覆盖）

1. **官方文档对照缺失**：E22 导致无法逐条比对 Codex 桌面端官方功能列表。
2. **未实测项**：PTY 交互（E11）、双向会话同步、多客户端并发、Android 沙箱隔离是否生效。
3. **账户类能力**：E5/E10 显示第三方 provider 下账户与远程控制不可用，属第 4 类，需在 UI 中给出真实原因与替代路径。
4. **调度能力**：协议无调度接口，必须自建，且不得承诺后台保活。
