# VERIFICATION.md — 证据库

记录日期：2026-10-14（除注明外均为本轮实测）
环境：Termux aarch64 / Android 16 / Codex CLI 0.162.1（provider: deepseek）

> 规则：只有本文件内标为「已实测」的条目才能用于「通过」。类型层面的结论标注为「协议已核实（静态）」，并说明未做运行时验证。

---

## E1 — app-server 支持 WebSocket + Bearer 令牌鉴权【已实测】

```sh
codex app-server --listen ws://127.0.0.1:8791 --ws-auth capability-token --ws-token-file token.txt
```

结果：启动成功，输出 `listening on: ws://127.0.0.1:8791`、`readyz`、`healthz`。
带 `Authorization: Bearer <token>` 连接后 `initialize` 返回：

```json
{"userAgent":"gui-probe/0.162.1 (Android 16.0.0.0; unknown) xterm-256color (gui-probe; 0.0.2)",
 "codexHome":"/data/data/com.termux/files/home/.codex","platformFamily":"unix","platformOs":"android"}
```

不存在的令牌 / 不带令牌：连接被关闭，`code=1006`。

## E2 — 浏览器无法直连 app-server【已实测】

同一服务、同一令牌，四种握手对比：

| 方式 | 结果 |
|---|---|
| 不带令牌 | 关闭 1006 |
| `Authorization: Bearer <token>` | **成功** |
| URL 查询参数 `?token=…` | 失败 |
| `Sec-WebSocket-Protocol: ["capability-token", token]` | 失败 |

结论：浏览器 `WebSocket` 无法设置 `Authorization` 头 → **必须有本地桥**。

## E3 — 模型目录来自真实能力发现【已实测】

`model/list` 返回当前 provider 的真实模型：`deepseek-flash`（displayName `DeepSeek-Flash`，`supportedReasoningEfforts: low/high/max`，`inputModalities: text,image`）。未见任何硬编码 OpenAI 模型。

## E4 — 独立 app-server 实例能读到 CLI 会话【已实测】

在**另一个进程**启动的 app-server 上调用 `thread/list{limit:3}`，返回真实会话，包含本轮正在进行的会话：

```
id=01a1367c-… preview=能否为这个codexcli做一个手机gui？… model=deepseek-flash cwd=/data/data/com.termux/files/home
```

结论：会话持久化对独立实例可见（「能读到同一份历史记录」）。**注意：这不等于共享实时运行状态**（用户要求区分的两个验收项）。

## E5 — 第三方 provider 下账户能力为空【已实测】

`account/read` → `{"account":null,"requiresOpenaiAuth":false}`

## E6 — 协议类型绑定可本机生成【已实测】

```sh
codex app-server generate-ts --out ts   # 743 个文件
```

关键联合类型：

- `ClientRequest`：initialize / thread.* / turn.* / review/start / model/list / account.* / skills/* / mcpServer* / fs/* / command/exec* / config* / plugin* / marketplace* / experimentalFeature* …
- `ServerRequest`（服务端→客户端请求）：`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`、`item/tool/requestUserInput`、`mcpServer/elicitation/request`、`item/tool/call`、`account/chatgptAuthTokens/refresh`、`attestation/generate`、`applyPatchApproval`、`execCommandApproval`
- 线程与回合项：`ThreadItem.CommandExecution`（12 字段）、`FileChange`、`McpToolCall`（13 字段）、`SubAgentActivity`、`CollabAgentToolCall`（9 字段）、`ImageView`、`Reasoning`、`Plan`、`ContextCompaction`

## E7 — 版本漂移（守护进程 executable 哈希不一致）【已实测】

> **⚠️ 2026-10-14 更正**：本条的**判定方法有误**。守护进程记录的 `executableIdentity.digest`
> 与 `codex.bin` 的 sha256 **不是同一个东西**：换用当前版本二进制重新拉起的守护进程，其记录
> 摘要为 `4e791ad8…`，与 `codex.bin` 的 `f32288fc…` 依旧不同；逐个比对 `codex.bin`、
> `bin/codex.js`、`bin/codex`、`codex-code-mode-host`、`codex-package.json`、`package.json`
> 的 sha256 均不匹配。因此该摘要是**未知派生方式的完整性指纹**，不能用作版本比对。
>
> **正确的兼容性检查**是 `codex app-server daemon version` 里的 `appServerVersion` 与
> `cliVersion` 两个自报字段。当时实测 `appServerVersion=0.160.0`（旧）、`cliVersion=0.162.1`；
> 现在两者均为 `0.162.1`。下方原始记录保留作为时间线，但结论以本更正为准。

| 项 | 值 |
|---|---|
| 运行中守护进程 PID | 12365（`app-server --listen unix:// --managed-daemon`） |
| `daemon version` 报告 | `cliVersion 0.162.1` / `appServerVersion 0.160.0` |
| 守护进程启动时记录的 executable digest | `ff2506c9f1167d3c2a2581975fd2d69ec512561fed300fb4724d87ae3ea25135` |
| 当前 `codex.bin` 实际 sha256 | `f32288fca29fbecadf410a1a1d6df2bd10a3271ca6be935d12af783df2d2325c` |

**结论：不一致。守护进程跑的是与当前磁盘上不同的（更旧的）构建。**这是用户要求核实的版本差异，且不是标签问题而是二进制差异。

## E8 — `app-server proxy --sock` 无法用于接入【已实测，与报告 v1 相反】

三种场景全部失败：

| 场景 | 结果 |
|---|---|
| 连运行中守护进程的 control socket | `failed to copy data from stdin to socket: Broken pipe (os error 32)` |
| 连全新启动的 `--listen unix://PATH` server | 同样 broken pipe |
| 连**同版本**（0.162.1）隔离守护进程的 control socket | 同样 broken pipe |

结论：这不是版本不匹配导致，`proxy` 路径本身在本环境不成立。报告 v1 中"GUI 可通过 proxy 挂到共享守护进程"属**未经验证的推论，现予撤回**。

## E9 — control socket 不接受普通 JSON-RPC【已实测】

裸 Unix socket 连接后：

| 发送 | 结果 |
|---|---|
| 不发送任何内容 | 连接保持，无 banner |
| `{"method":"initialize",...}\n` | 对端立即关闭，0 字节返回 |
| `{"method":"connection/hello","id":1,"params":{}}\n` | 同样立即关闭 |

守护进程 stderr 日志中**没有**对应的拒绝记录。

## E10 — remote-control 需要官方账户注册【已实测，阻塞项】

在隔离守护进程上启用后：

```sh
codex app-server daemon enable-remote-control   # {"status":"enabled","remoteControlEnabled":true}
codex remote-control pair
# → Error: remoteControl/pairing/start failed: remote control pairing is unavailable until enrollment completes
```

结论：远程控制配对依赖官方注册/账户，属第 4 类能力；当前 provider 下不可用。

## E11 — 协议层支持交互式 PTY【协议已核实（静态），运行时未实测】

`CommandExecParams` 含 `tty?: boolean`（注释：「Enable PTY mode. This implies `streamStdin` and `streamStdoutStderr`」），配套 `command/exec/write`、`command/exec/resize`、`command/exec/terminate`、`CommandExecTerminalSize`。

**结论：集成终端可以基于 app-server 实现，不必依赖 node-pty。** 但"能跑交互程序""Ctrl+C 可用""旋转不串行"三项**尚未运行时验证**。

## E12 — `thread/revert` 只改对话历史，不回退文件【协议原文】

`ThreadRevertParams` 注释原文：

> Replace a paginated thread's durable history with the prefix before one turn.
> **This only changes persisted conversation history. It does not revert local file changes.**

结论：报告 v1 里把回退与文件撤销/Reapply 混为一谈是**错误**，已更正。

## E13 — 审批决策集按请求类型不同【协议已核实（静态）】

| 请求 | 决策类型 |
|---|---|
| `item/commandExecution/requestApproval` | `CommandExecutionApprovalDecision = "accept" \| "acceptForSession" \| {acceptWithExecpolicyAmendment} \| {applyNetworkPolicyAmendment} \| "decline" \| "cancel"` |
| `item/fileChange/requestApproval` | `FileChangeApprovalDecision = "accept" \| "acceptForSession" \| "decline" \| "cancel"` |
| legacy `execCommandApproval` | `ReviewDecision = "approved" \| {approved_execpolicy_amendment} \| "approved_for_session" \| "approved_mcp_policy_amendment" \| {network_policy_amendment} \| {denied:{rejection}} \| "timed_out" \| "abort"` |
| `mcpServer/elicitation/request` | `McpServerElicitationAction = "accept" \| "decline" \| "cancel"` |

附加字段：`kind: "command" | "writeStdin"`、`approvalId`（同一 item 多个回调时用于路由）、`commandActions`、`proposedExecpolicyAmendment`、`proposedNetworkPolicyAmendments`、`networkApprovalContext{host,protocol}`、`additionalPermissions`。

结论：报告 v1 中"统一四个按钮：允许一次/允许同类/本会话/拒绝"是**错误简化**，已更正为按类型与提案字段动态生成。

## E14 — 存在两套审批协议（legacy + 新版）【协议已核实（静态）】

`ServerRequest` 同时包含 `execCommandApproval`/`applyPatchApproval`（legacy，参数为 `conversationId`+`callId`）与 `item/*/requestApproval`（新版）。二进制字符串中另有 `availableDecisions`、`additionalPermissions` 及路径映射 `item/commandExecution/requestApproval.availableDecisions`。

结论：客户端必须同时正确处理两套，按实际收到的请求类型分发。

## E15 — MCP elicitation 的四种模式【协议已核实（静态）】

`McpServerElicitationRequestParams.mode` = `form`（配 `McpElicitationSchema`，含 object/array/boolean/number/string、单选/多选枚举、titled/untitled 等 20+ 类型定义）| `openai/form` | `openaiForm` | `url`（含 `elicitationId`，用于跳转授权）。响应为 `{action, content, _meta}`。

## E16 — 模型向用户提问的协议方法【协议已核实（静态）】

`item/tool/requestUserInput` → `ToolRequestUserInputParams{threadId,turnId,itemId,questions[],isBlocking,autoResolutionMs}`
`ToolRequestUserInputQuestion{id,header,question,isOther,isSecret,options[]|null}`，`ToolRequestUserInputOption{label,description}`
响应：`{answers: {<questionId>: {answers: string[]}}}`

结论：单选/多选/自由文本/密文输入都有协议支持（标注 EXPERIMENTAL）。

## E17 — `fs/*` 的作用域【协议已核实（静态）】

`FsReadFileParams.path: AbsolutePathBuf`，注释「Read a file from the host filesystem」；配套 `fs/readDirectory|writeFile|createDirectory|getMetadata|remove|copy|watch`。服务端进程以 Termux uid 运行，因此**桥可访问 Termux 私有目录**（E4 的 `cwd` 即 Termux home）。

**未验证**：APK 自身能否直接访问（用户要求的重点）。预期不能——APK 与 Termux 是不同沙箱应用；路径应为 APK → 本地桥 HTTP → app-server。

## E18 — 运行时与工具链【已实测】

| 项 | 值 |
|---|---|
| Node | `v26.4.0`（`node t.ts` 直接执行 TypeScript 成功） |
| npm | 存在 |
| bun | 未安装；Termux 仓库有 `bun 1.4.3` |
| 沙箱限制 | `rm -f` 被拒绝（`rm -f style commands are not permitted`） |

## E19 — codex-webui 现状核实【已实测（静态审查）】

| 项 | 值 |
|---|---|
| 许可 | MIT（`LICENSE` 头文件确认） |
| 体量 | 119 文件，解包 1.8 MB |
| 后端启动方式 | `spawn("codex", ["app-server", "--stdio"])` — **自带 app-server 实例，不接共享守护进程** |
| 监听 | `HOST` 默认 `127.0.0.1`，`PORT` 默认 `8899`；非 localhost 时启用密码认证 |
| 原生依赖 | 仅 `node-pty`（`terminal-service.js` / `terminal-worker.js`），其余为纯 JS（`ws`、`marked`、`katex`、`dompurify`、`lottie-web`、`@xterm/*`） |
| 已有能力 | 真实线程/模型/流式、审批面、unified+split diff、Undo/Reapply、KaTeX、文件夹选择器、账户区 |
| 缺口（相对本表） | 项目/会话分组与分区、草稿、requestUserInput、elicitation、Git 面板、worktree、终端基于 node-pty 而非协议 PTY、通知、调度、产物预览 |

**未实测**：在本机完整启动运行（M/P0 阶段目标）。

## E20 — Termux fork 构建说明（官方包 README）【静态来源】

- 明确「Realtime voice/audio is not part of this build」→ 实时语音属第 4 类。
- 携带 `codex-package.json` 变体清单与 `RUNPATH=$ORIGIN` 加固；`remote-control start` 依赖该清单。
- 代码模式通过 `codex-code-mode-host` 外部辅助进程实现。

## E21 — 进程与守护进程关系（未定论）

观察到的现象：

1. 进程树中，本会话 TUI（`node .../codex` → `codex.bin`，PID 13771/13778）与守护进程（PID 12365）是**不同进程**；
2. 但守护进程日志 `~/.codex/app-server-daemon-termux/daemon.stderr.log` 中出现**本会话**工具调用的错误记录。

结论：本会话是否共享守护进程**未确认**，不写入任何结论。这与 E8/E9 一起构成"共享实时状态"路径的未解问题。

## E26 — `app-server proxy --sock` 在新版本守护进程上依然失败【已实测，问题关闭】

会话被重建后，managed 守护进程已被重新拉起（PID 31376，`appServerVersion` 与 `cliVersion` 均为 `0.162.1`）。
对新守护进程重跑同一探针：

```
initialize -> "timeout"
[proxy stderr] Error: failed to relay data between stdio and socket
   0: failed to copy data from stdin to socket
   1: Broken pipe (os error 32)
```

结论：**与版本无关**。`proxy --sock` 在本环境不可用，不再是候选方案；也**无需为了这个目的重启守护进程**。

## E27 — codex-webui 在 Termux 上可运行【已实测，复用决策依据】

```sh
pkg install -y bun            # bun 1.4.3 (Termux 仓库)
cd ~/codex-gui/app
npm install --no-audit --no-fund   # 52 包，18 秒，无原生编译（已移除 node-pty 依赖）
bun run server.ts                  # → Codex WebUI listening on http://127.0.0.1:8899
```

验证：

| 检查 | 结果 |
|---|---|
| `GET /` | 200，31553 字节，`<title>Codex WebUI</title>` |
| `GET /api/health` | `{"ok":true,"codex":true,"version":"0.2.0"}` |
| `POST /api/rpc thread/list` | 返回真实会话数据 |
| `node server.ts` 直接运行 | **失败**：`./password-store.js` 无法解析到 `.ts`（Node 类型剥离不做 `.js`→`.ts` 映射）→ 因此用 bun |
| `node-pty` | 未被安装；`terminal-service.js` 是延迟 `require.resolve`，不影响启动 |

结论：**保留 codex-webui 作为基座**（MIT），无需重写前端。

## E28 — 桥改造成共享实例后，实时状态共享通过【已实测，P2 核心】

改造：`spawn("codex", ["app-server","--stdio"])` → `spawn("codex", ["app-server","--listen","ws://127.0.0.1:8901","--ws-auth","capability-token","--ws-token-file",…])`，桥自身改为 WS 客户端连接同一实例。

产生的配套产物：

| 产物 | 路径 | 权限 |
|---|---|---|
| capability token | `~/.codex/codex-webui/ws-token` | `0600` |
| CLI 接入启动器 | `~/bin/codex-gui` | `0700` |
| 接入信息接口 | `GET /api/appserver/attach`（**不返回 token**） | — |

验证序列：

1. 基线：`thread/loaded/list` → `{"data":[]}`
2. 用启动器打开 CLI：`~/bin/codex-gui`（内部 `codex --remote ws://127.0.0.1:8901/ --remote-auth-token-env …`）→ TUI 正常进入
3. 另一独立客户端再查：`thread/loaded/list` → `{"data":["01a1369d-660d-7b80-8e4e-dcb3db65e90f"]}`
4. 该会话**尚未出现在 `thread/list` 中**，磁盘上也没有对应 rollout 文件 → 精确印证用户要求区分的两件事：
   *`thread/loaded/list` = 服务端内存中的实时状态；`thread/list` = 已持久化的历史。* 新会话要跑过第一个回合才会落盘。
5. TUI 退出提示：`Disconnected from this task. Any running work continues.` + `resume 01a1369d-…`

结论：**「CLI 与 GUI 共享同一 app-server 实例及其实时状态」在桥宿主模式下成立**。
未覆盖：真实回合期间的事件级同步（需跑真实 turn）、多客户端并发写同一会话、断线重连去重。

## E22 — 官方文档不可达【已实测】

```sh
curl -sSL -A "<Chrome UA>" https://developers.openai.com/codex/app-server
# → HTTP 403 "This request was blocked"
```

影响：无法按官方文档核对桌面端功能清单，基线以协议类型与本机实测为准。

## E29 — `availableDecisions` 在 wire 上存在，但生成的 TS 类型里没有【已实测】

用 `readOnly` 沙箱 + `untrusted` 审批策略（逐回合覆盖，未改配置）触发一次命令审批，服务端发来的
`item/commandExecution/requestApproval` 参数键为：

```
kind, threadId, turnId, itemId, startedAtMs, environmentId,
command, cwd, commandActions, proposedExecpolicyAmendment, availableDecisions
```

该请求真实的 `availableDecisions`：

```json
["accept",
 {"acceptWithExecpolicyAmendment": {"execpolicy_amendment": ["/bin/sh","-lc","ls -la …"]}},
 "cancel"]
```

**注意：这一组里没有 `decline`，也没有 `acceptForSession`。**

但在 `codex app-server generate-ts` 生成的类型里检索 `availableDecisions` → **零命中**；类型中也看不到
`networkApprovalContext`。也就是说生成的类型面比实际 wire **少字段**，不能只按类型写客户端（与 E14 的二进制字符串线索一致）。

同时确认：`ExecPolicyAmendment = Array<string>`（argv 前缀），与 wire 上看到的一致；
`CommandExecutionRequestApprovalResponse = { decision }`。

**结论**：审批按钮必须由「请求类型 + 提案字段 + `availableDecisions`」共同推导，且只能发送集合内的值。

## E30 — steer / interrupt 的必填参数【已实测，含真实报错】

先按直觉调用，服务端明确拒绝：

```
turn/steer:    Invalid request: missing field `expectedTurnId`
turn/interrupt: Invalid request: missing field `turnId`
```

类型定义确认：

- `TurnSteerParams = { threadId, clientUserMessageId?, input, expectedTurnId }`，
  注释原文：「Required active turn id precondition. The request fails when it does not match the currently active turn.」
- `TurnInterruptParams = { threadId, turnId }`

补齐后重跑：`steer=true interrupt=true`，且 interrupt 后 **125ms 内**收到 `turn/completed`——
说明 `sleep 20` 被真正中止，而不是等它跑完。

**结论**：UI 必须持有当前活动 turn 的 id（来自 `turn/start` 响应或 `turn/started` 通知），否则「运行中追加/停止」无法实现。

## E31 — 审批往返 + 双客户端同时作答【已实测】

链路：服务端请求经 SSE `/api/events` 以 `codex/request` 推给浏览器 → 浏览器用
`POST /api/codex/respond {requestId, result}` 回传 → 服务端 `serverRequest/resolved`。

- 我的脚本应答 `{"decision":"decline"}` → HTTP 200；随后 app-server 日志出现
  `exec_command failed: CreateProcess { message: "Rejected(\"rejected by user\")" }` ×2
  → **decline 语义生效**（命令被拒）。
- 用户同时在浏览器里点了几次 **Allow once**，与该链路并行工作，未互相干扰。
- 副作用核实：`probe/approval-test.txt` 内容为 `hello`，写入**真的发生**。

**结论**：审批请求/响应经桥的往返可用；同一实例上多个客户端可同时作答。

## E32 — 未作答的审批会让回合挂起（重要）【已实测】

脚本只回答了第一个请求，随后查询线程状态：

```json
{"type": "active", "activeFlags": ["waitingOnApproval"]}
```

回合状态为 `inProgress`，一直等待直到有人作答或被打断（我用 `turn/interrupt` 收尾，之后状态变为 `idle`）。

附带发现：`thread/turns/list` **默认 `itemsView: "summary"`**，只返回用户消息；要拿到命令、输出、reasoning
必须显式传 `itemsView: "full"`（或改用 `thread/items/list`）。GUI 必须用 full 视图，否则工具活动不可见。

**结论**：GUI 必须把「有未作答请求」当成一等状态展示（`waitingOnApproval` / `waitingOnUserInput`），且**不得丢弃**服务器发来的请求。

## E33 — 子进程孤儿与端口冲突【已实测，已修复】

现象：某次桥退出后，其 `app-server` 子进程（PID 14058，PPID=1）仍占着 8901 端口；新桥无法绑定，
以 ~1.3 秒周期崩溃重启并刷屏。

修复（`app/server.ts`，见 PATCHES.md 0002）：
1. 启动时先探测端口上是否已有可用实例，有则**复用**（第二次实测：同一 app-server 上再起一个桥，未产生新实例）；
2. 子进程反复快速退出时**指数退避**重启（1s→30s），避免刷屏；
3. 捕获 `Address already in use` 并打印可操作的排查命令。

## E34 — `request_user_input` 工具有模式门槛【已实测，阻塞】

把 `item/tool/requestUserInput` 的渲染与响应实现好之后，用两条路径尝试触发真实请求：

1. 通过桥宿主实例启用实验特性 `default_mode_request_user_input`（`experimentalFeature/enablement/set`，运行时、已还原），再让模型用该工具提问。
   结果：没有请求到达客户端，但 app-server 日志明确记录
   `ERROR codex_core::tools::router: error=request_user_input is unavailable in Default mode`，
   模型随后用自己的话把问题写成了普通消息（原文：「`request_user_input` 在当前会话的 Default 模式下不可用（工具返回 "unavailable in Default mode"）」）。
2. 用临时实例加 `-c tools.experimental_request_user_input=true`（端口独立、不碰正在跑的桥）。
   结果：见 E36。

结论：该工具的可用性受**协作模式（Default vs Plan）**与工具级配置共同约束，不是客户端能单方面打开的。
客户端这一侧（渲染 + 应答）已完成并有单测；**真实触发仍未走通**，因此该项在 FEATURES.md 中记为「实现完成、运行时未验证」。

## E35 — 浏览器端「无法发送消息」【已实测现象，根因待定位】

用户实测反馈：在浏览器里**能**回答审批/提问卡片，但**发不出普通消息**。

已排除的猜测（均有证据）：

| 猜测 | 证据 | 结论 |
|---|---|---|
| 有回合卡在 `active`/`waitingOnApproval` 把输入框锁住 | `thread/list` 最近 6 条状态为 `systemError` / `notLoaded`，无 `active` | 排除 |
| 我新增的提问卡片没清除等待态（`setApprovalWaiting`） | 该函数只切 CSS 类与文案，不影响输入框 | 排除 |
| `#effortSelect` 在手机上不存在导致取值抛错 | `index.html:108` 存在（`sr-only`） | 排除 |
| 参数不被服务端接受（`model:""`、`permissions` 字段等） | 直接重放该 RPC，均返回 `rpc/result` 并真的起了回合 | 排除 |

下一步：桥已加入浏览器 RPC 观测日志（失败打 `browser rpc failed: <method> -> <error>`，
`turn/start`/`thread/start` 打到达记录）。用户重试后即可判定「请求到达了服务端但失败」还是「请求根本没离开浏览器」。

**在拿到该证据前，不对此问题下结论。**

### E35 结案（2026-10-14）：根因是硬编码的 OpenAI 模型过滤器

用户给出关键症状：界面上提示 **no model available**。定位链条：

1. `public/ui-core.js` 的 `filterAppModels` 用正则 `/^gpt(?:[-_.\s]|$)/i` 过滤模型目录，
   只保留 `gpt` 开头的模型；本机 provider 是 DeepSeek，目录为
   `deepseek-flash` / `deepseek-v4-pro`，**全部被过滤掉**。
2. `selectModelState` 在空目录下回退为 `{ model: "" }`，前端建会话时把空模型名发给服务端。
3. 服务端原样报错（复现命令与原文）：

```
thread/start {"model":""}
-> {"type":"rpc/error","error":"No models are available. Set `model` explicitly or check your model catalog configuration."}
```

对照：`thread/start {"model":"gpt-5-codex"}` → 正常返回 thread（说明不是别的问题）。

这正违反了「模型从真实能力发现获取、不硬编码 OpenAI 模型列表」的要求。

**修复**：`filterAppModels` 改为按真实能力发现筛选——排除 `hidden === true` 与无 id 的条目，
不再做 provider 前缀过滤。回归测试 `probe/model-catalog.test.mjs`（**8 项断言全过**，
夹具为本机真实 `model/list` 载荷）：空目录问题消失、`isDefault` 正确解析为 `deepseek-flash`、
真实推理档位 `low/high/max` 被采用、记住的模型被尊重、未知模型回退到真实模型、
`hidden` 仍被排除、真正为空时仍为空（由界面给出空状态）。

并全仓检索确认没有其它 OpenAI 模型硬编码（仅剩 `state.account?.type === 'chatgpt'` 这类账户判断）。

**遗留**：修复效果需要用户在浏览器刷新后确认（这是唯一能验证渲染层的途径）。

## E36 — 旧会话被「空模型」毒化，以及救回方式【已实测】

用户在浏览器里实测反馈（截图证据，2026-10-14 03:21 / 03:22）：

- 03:21：模型 chip 已显示 `Deep…`、档位 `最大`，但在**那个旧会话**里发送仍报
  `No models are available...`（界面显示为错误卡片 + 重试按钮）。
- 03:22：**新建任务**后发送「你好」→ 22 秒内正常流式返回，模型可用。

服务端数据核对（`thread/list`）确认存在 `model: ''` 的会话——都是在硬编码过滤器生效期间创建的：

```
model='deepseek-flash'  preview=你好
model=''                preview=hi
model=''                preview=我要做一个移动端的 Codex 界面…
```

复现与救回（均实测）：

| 调用 | 结果 |
|---|---|
| `thread/resume {threadId}`（旧会话） | **失败**：`No models are available. Set \`model\` explicitly or check your model catalog configuration.` |
| `thread/resume {threadId, model:"deepseek-flash"}` | **成功**：thread.model 变为 `deepseek-flash`，`status=idle`，3 个回合可读 |
| 紧随其后的 `turn/start` | 成功，回合正常开始 |

顺带确认一个协议细节：**对未加载的历史会话，`turn/start` 之前必须先 `thread/resume`**，
否则报 `thread not found`（我第一次直连测试就踩了这个，与业务无关）。

**修复**：前端 `resumeActiveThread` 在会话自身 `model` 为空时，用当前选中的模型做覆盖
（`thread/resume` 的 `model` 字段本就是「resumed thread 的配置覆盖」，见 `ThreadResumeParams` 注释）。
这样被毒化的旧会话可以在界面上被救回，而不是永久打不开。

## E37 — 一键启停脚本（脱离当前终端）【已实测】

产物：`~/bin/codex-gui-web`（`start` / `stop` / `restart` / `status` / `log` / `url`）。
在此之前，桥是我在会话里起的进程，我这一轮结束就可能把它带走 —— 用户无法自行运维。

实测：

| 检查 | 结果 |
|---|---|
| `start` | 起在独立会话：`PID 7665 PPID 1 SID 7665`（真脱离，不是当前 shell 的子进程） |
| `status` | 报运行中、健康检查通过、打印地址 |
| `stop` | 桥与其 app-server 一起收干净；用 `pgrep -f "…:89[0]1"`（括号技巧）复核残留为 **0** |
| 重复 `start` | 已在跑时直接返回地址，不起第二个 |

实现中踩到的两个坑（已写进脚本注释，防止改回去）：

1. **不能用 `$!` 记 PID**：`setsid` 会先 fork，`bun run` 也可能再 exec，记下来的是已退出的中间进程，
   导致 `status` 误报「未运行」。改成按「进程 `cwd` == 本项目 app 目录」发现桥进程。
2. **`pgrep -f` 会匹配调用方自己的命令行**：我手敲的验证命令里含同样的字符串，
   结果脚本把自己的 shell 一起杀了（`exit 143`）。脚本内一律排除 `$$` 与 `$PPID`。

## E38 — 观测日志立刻抓到两个前端问题【已实测】

给桥加日志后，一次用户操作就把下面的东西打出来了（这正是加日志的目的）：

1. `browser rpc failed: turn/steer -> no active turn to steer` **连续 6 次**。
   说明界面上仍处于「追加指令（steer）」态时，活动回合已经结束，于是重试全部失败。
   → 需要在客户端加兜底：steer 失败且无活动回合时回退为 `turn/start`，或提前把输入框切回发送态。
2. `browser thread/start thread=(new) model=gpt-5-codex`。
   全仓检索（含大小写不敏感）确认 **`public/` 下不存在 `gpt-5` 字样**，只在上游的 `tests/` 里出现。
   因此这更像是浏览器 localStorage 里残留的旧模型名（`codex-webui-model`）。
   影响已被 E35 的修复覆盖：未知模型会回退到真实模型（`probe/model-catalog.test.mjs` 有对应断言）。
   **仍未定论**：需要一次带 localStorage 值的诊断才能确认来源。

## E39 — 模型 chip 在手机上不可读【已实测（截图）+ 已修】

截图证据：composer 里模型 chip 只显示 `DeepS…` / `Deep…`，看不出选的是哪个模型。

根因两条叠加：

- `modelDisplay(model, true)` 只剥 `^GPT-` 前缀（OpenAI 专用），对 `DeepSeek-Flash` 不做处理；
- CSS 在窄屏把标签宽度压到 54px / 78px。

修复（`patches/0008`）：改成通用剥离首个厂商段（`DeepSeek-Flash` → `Flash`、`DeepSeek-V4-Pro` → `V4-Pro`、
`GPT-5-Codex` → `5-Codex`），且**剥完不足 2 字符就保留原名**（`gpt-5` 不会被削成 `5`）；
同时把窄屏标签上限提到 76px / 104px、触发器上限提到 136px。模型菜单仍显示全名（`stripPrefix=false`）。

验证：`probe/model-display.test.mjs` —— **从构建产物里抽出真实的 `modelDisplay` 函数**再断言（10 项全过），
不是测试复刻副本。

## E40 — `turn/steer` 在回合已结束时不回退【已实测（日志）+ 已修】

桥的观测日志连续记录 6 次 `browser rpc failed: turn/steer -> no active turn to steer`。
根因：界面用 DOM 状态（发送按钮的 `dataset.turnId`）判断「是否处于运行中」，
上游在 `turn/completed` 里清这个状态时有线程与回合的双重匹配条件，界面一旦错过该事件就会**一直停在「追加指令」态**；
而 `submitPrompt` 的 steer 分支只对 `THREAD_NOT_FOUND` 有兜底，对「没有活动回合」只弹一个错误提示。

修复（`patches/0008`）：捕获该错误后清掉活动回合状态、把文本放回输入框并重新走一次提交流程
（此时会走正常的 `turn/start`），不再让用户面对一个永远失败的发送键。

## E41 — 断言要写成格式无关的（踩坑记录）

`probe/model-display.test.mjs` 最初用原始子串匹配 bundle（如 `if(!state.selectedModel){toast(`），结果全 FAIL——
因为 **bun 打包时会重新排版**（加空格、换行、改引号）。修正为空白容错的正则后通过。
教训：对构建产物做断言时不要假设压缩格式。

## E42 — 空模型目录的用户可见提示【已修，待浏览器确认】

以前目录为空时 chip 显示 `Select model`（其实没得选），第一次发送直接把服务端原文
（`No models are available. Set \`model\` explicitly or check your model catalog configuration.`）
抛给用户。改为（`patches/0009`）：发送前拦下并给出中英说明，chip 显示真实空状态；
i18n 增加对应简中条目（「没有可用模型」/「当前 provider 没有返回任何模型，请检查 Codex 的模型目录配置。」）。

另：`viewport` 增加 `interactive-widget=resizes-content`，避免软键盘直接盖住输入区。
顶部的 `env(safe-area-inset-top)` 留给 PWA/独立窗口那一轮（浏览器标签页里无意义，且改动会影响网格行高，
不做无验证的改动）。

## E43 — 安卓返回键与安全区【已修 + 逻辑已测，浏览器待确认】

**问题**：应用注册的 `popstate` 只处理设置页路由，所以**抽屉打开时按返回键会离开应用**，而不是关抽屉。

**实现**：把「覆盖层与历史记录配对」抽成纯状态机 `createOverlayBackGuard`（`ui-core.js`，
`history` 由外部注入所以可测），再接到抽屉的开关上：打开时压入一条历史、返回键消费它并关抽屉、
从界面自己关闭时再弹掉这条历史以保持平衡。

`probe/overlay-back.test.mjs` —— **11 项断言全过**，覆盖：打开只压一条、返回关闭、返回之后不吞掉下一次返回
（不能把用户困住）、界面自关时历史平衡且不重复回调、嵌套覆盖层逐个关闭、未打开时关闭是空操作、
没有 `history` 的环境不抛错。

> 测试自身也踩过一次坑：嵌套用例忘了注册 popstate 监听，断言失败后一度看起来像实现有问题——
> 实际是测试脚手架的问题（已修正并在文件里注明）。

**安全区**：顶部此前完全没有 `env(safe-area-inset-top)`，而且移动端网格预留 48px、顶栏实际 46px（差 2px）。
现在统一为 `calc(46px + env(safe-area-inset-top,0px))`，用在顶栏高度/上内边距、`.app-shell` 网格行、
抽屉的 `top`、移动端审查面板的 `inset` 四处。**浏览器里 inset=0 时只有那 2px 修正生效**，其余不变。

**未做（诚实标注）**：`env(safe-area-inset-top)` 的效果只能在 PWA/独立窗口下看到，本轮无法验证；
返回键行为也需要你在手机上按一次才算通过。

## E44 — 历史会话里的图片打不开：不是界面坏了【已实测】

用户反馈并截图（2026-10-14 03:41）：打开历史会话时图片显示为「破图」。

实测结论：**是文件本身已不存在，不是渲染管线坏了。**

| 请求 | 结果 |
|---|---|
| `build/stills/still_0006.00.png`（仍存在） | HTTP 200，259 587 字节 |
| `build/poster.png`（仍存在） | HTTP 200，438 416 字节 |
| `build/junction.png`（截图里那张） | **HTTP 404** `{"error":"Image unavailable"}` |
| 磁盘复核 | `build/` 目录还在（含 `poster.png`、`weapons-history.mp4`、`stills/` 17 个文件），但 `junction.png`、`contact.png`、`crop_0154.00.png` 等**已被删除** |

为什么会删：那个会话在收尾时清理了自己的中间产物——app-server 日志里能看到原始命令
（`rm -f … junction.png … contact.png crop_0044.00.png …`）。历史记录引用的是绝对路径，
文件后来被删，界面自然取不到。

**这是当前阶段的已知限制**：会话记录只保存路径、不复制内容，所以「引用的产物后来被删」必然表现为取不到图。

**仍待改进（已列入计划）**：界面把这种情况显示成「破图 + 文件名」，看起来像故障。
带文字的聊天图片已有 `message-image-unavailable`（简中：图片不可用）这条兜底，
但**活动缩略图（`imageView`）这条路径没有等价兜底**——这是本轮观察到的现象，尚未逐一验证代码路径。
应该改成明确的「文件已不存在」并显示路径与文件是否被删的说明。

## E45 — 工具卡片中文不一致【已修】

同一张截图里，同类命令卡片一次显示「已运行 /bin/sh -lc '…'」、一次显示「Ran /bin/sh -lc '…'」。

根因两条叠加：

1. 折叠态标签是**字符串拼接**产生的（`` `${interrupted?'Stopped':'Ran'}${command?` ${command}`:' command'}` ``），
   完全没走 `t()`；
2. 词表里**根本没有 `"Ran"` 这一项**（只有 `"Ran command"` / `"Ran commands"`），
   所以即使包一层 `t()`，这个词也会回落到英文——正好对上截图里那种「一半中文一半英文」。

修复（`patches/0011`）：折叠态标签改走 `t()`，并补上 `"Ran": "已运行"`；
无命令的场景直接用已存在的 `"Ran command"` / `"Stopped command"` 词条。
回归断言加进 `probe/model-display.test.mjs`（引号容错，因为打包器会把单引号改成双引号，见 E41）。

## E46 — 浏览器与会话不共享实时状态：两个 app-server 实例并存【已实测，重要】

用户在浏览器里对**当前这个会话**发消息，然后问"状态如何"。核实结果：

**那条消息没有到达用户正在对话的这个会话**，而是被另一个独立会话接走了。

证据链：

1. 桥日志：`browser turn/start thread=01a1367c-51b8-7332-a158-9a1bad9b2953 model=deepseek-flash`，
   而 `01a1367c` 正是这个会话的线程 id。
2. 进程拓扑（`ps`）显示**两个 app-server 实例**：

| 实例 | 进程 | 用途 |
|---|---|---|
| 桥宿主 | `bun run server.ts`(7665) → app-server `ws://127.0.0.1:8901` | 浏览器走这个 |
| 用户会话 | TUI(31343) → managed daemon(31376, `--listen unix://`) | 当前对话走这个 |

3. 桥侧读到的该线程：`status = idle`、`turns = 0`（未在本实例水合），但 `thread/turns/list` 能读到磁盘上的历史。
4. 那个回合（`01a136cc…`）的完整内容显示：它跑了约 **153 秒**的真实工作——
   读了 `PLAN.md`、执行了 `rg`/`sed` 命令、**修改了文件**、写了 `probe/p1-event-sync.mjs`，
   最后状态是 `interrupted`。

**结论（对用户要求的直接回答）**：

- 「读同一份历史」成立——两边读的是同一份落盘 rollout；
- 「共享实时运行状态」**在当前布局下不成立**——浏览器与 TUI 是两个实例，互相看不见对方的进行中回合；
- 更严重的副作用：**两个会话可以同时改同一个工作区而且互相看不见**，
  这正是用户要求验证的「多客户端同时连接、切换或重复操作时不会错配请求」被打破的情形。

**该会话留下的改动（经核实为增量、未覆盖既有实现，保留）**：

- `PLAN.md`：新增 `[~]` 勾选约定（代码已实现 + 单测通过、但运行时/真机未验证，不算通过），
  并把若干项从 `[ ]` 改为 `[~]`——与我一直坚持的"未验证不标通过"一致；
- `probe/p1-event-sync.mjs`：P1 事件级验收脚本（两个独立 WS 客户端接同一实例，A 驱动、B 观察），
  是 E24 的"事件级"对照（E24 只证明了内存线程列表共享）。

**可行缓解（按代价排序）**：

1. 用 `~/bin/codex-gui` 打开 CLI——它会 `codex --remote` 接到**桥的那个实例**，
   于是浏览器与 CLI 共享同一个 app-server（E25 已实测）。代价：需要养成用启动器的习惯。
2. 同一时间只从一处驱动（浏览器观察历史、CLI 驱动，或反过来）。
3. 桥侧加"该线程已被别的实例占用"的拦截——**目前做不到可靠检测**：
   `thread/list.status` 是"本实例是否加载"，不是"别处是否在跑"，所以这条只能标注为已知限制。

**未做**：没有去停用或改写那个会话留下的文件；没有尝试合并它们（属于用户/另一会话的工作）。

## E47 — E46 的处理：共享实例 + **订阅**才是实时共享的完整条件【已实测】

用户决定采用方案 1。实施与验证结果：

### 1. 启动器改为「桥不在就自动拉起」

`~/bin/codex-gui` 是**桥每次启动时由 `installLauncherScript()` 重新生成**的，
所以直接改文件会被覆盖——改的是 `app/server.ts` 里的生成模板（已改并重启桥重新生成）。
现在的行为：健康检查不通过 → 调用 `codex-gui-web start`；仍不通过 → **明确报错并退出**，
而不是悄悄给用户一个「看不见浏览器」的独立实例。

### 2. 事件级同步的真实条件：订阅

先跑 `probe/p1-event-sync.mjs`（另一个会话写的）：客户端 B 只收到 **2 个事件**，
看不到 A 那个回合的 `turn/started` / 流式文本 / `turn/completed` —— **失败**。

于是写 `probe/p1-subscribe-sync.mjs` 验证「B 必须先打开该线程」：

1. A 建线程并跑完**第 1 个回合**（此时线程才落盘）；
2. B 调 `thread/resume`（就是浏览器打开一条会话时做的事）→ 成功；
3. A 跑第 2 个回合，B 观察。

结果 **ALL PASS**，B 收到该线程的完整事件流：

```
thread/status/changed, turn/started, item/started, item/completed,
item/reasoning/textDelta, thread/tokenUsage/updated,
account/rateLimits/updated, item/agentMessage/delta, turn/completed
```

**结论（这是 P1「另一侧实时看到」的通过证据）**：

- 同一实例内，「实时看到对方的回合」**成立，但前提是那条线程在本地客户端是打开的（已 resume）**；
- 没打开时只收到极少数全局事件（`thread/status/changed` 之类），这与「订阅模型」一致；
- 附带发现：**刚创建、还没跑过任何回合的线程不能被另一个客户端 resume**
  （报 `thread not found`）——要先有一个已完成的回合把它落盘（与 E36 同类现象）。

### 3. 对「浏览器能否接上你的对话」的准确回答

- **当前这个对话：不能**。它跑在 managed daemon 实例上，实时状态无法迁移；浏览器只能读它的历史。
- **用 `codex-gui` 开的会话：能**。浏览器打开同一条线程即可看到实时状态与逐字输出。
- 也可用 `codex-gui resume <threadId>` 把某条历史线程在桥的实例里续起来，
  那样浏览器能实时接上——但**不能同时在终端也写同一条线程**，否则回到 E46 的双写者局面。

## E48 — 纠正 E46 的一处读数：`interrupted` 不等于"真被打断"【已实测】

在观察本对话时发现：桥侧读到的**最新回合**（正是本会话正在进行中的那一个）状态显示为 `interrupted`。
但直接查 rollout 文件尾部，该回合正在被写入（有 `token_usage_record`、`function_call` 等），
**并没有完成事件**。

结论：`interrupted` 是**读取方在看不到完成事件时的兜底标记**（回合正在进行中、或写入被截断都会落到这个值），
**不能作为"这个回合真的被中断了"的证据**。

据此**下调** E46 中的一处表述：那个跑了 153 秒、改了 PLAN.md 与新建脚本的会话回合，
「最后状态是 interrupted」只能说明**读取时它没有完成事件**，不能断言它被中断过——
它也可能只是当时仍在进行中，或写入尚未落盘完成。其余关于"两个实例互不可见"的结论不受影响
（那部分有进程拓扑与日志两重证据）。

---

## E23 — 桥自建 WS app-server 可创建会话并处于实时状态【已实测】

```sh
codex app-server --listen ws://127.0.0.1:8891 --ws-auth capability-token --ws-token-file probe/ws-token.txt
WS_TOKEN=… node probe/p2-live-share-probe.mjs --create      # 客户端 A
```

结果：

```
[A] initialize: ok
[A] thread/start: 01a13695-6ab1-7631-b47f-2609961c4743
[A] thread/loaded/list: {"data":["01a13695-6ab1-7631-b47f-2609961c4743"]}
[A] thread/list: 5 threads   # 含真实历史会话
```

## E24 — 两个并发客户端共享同一份实时状态【已实测】

客户端 B 独立连接同一 app-server，无需重新加载即可看到 A 创建的会话：

```
[B] thread/loaded/list: {"data":["01a13695-6ab1-7631-b47f-2609961c4743"]}
```

结论：`thread/loaded/list` 反映的是**服务端内存中的活动状态**，A、B 看到同一份 → 「共享实时运行状态」在桥自建实例模式下成立。

## E25 — CLI TUI 可用 `--remote` 反连桥自建实例【已实测，P1 关键结论】

```sh
CODEX_WS_TOKEN=… codex --remote ws://127.0.0.1:8891 --remote-auth-token-env CODEX_WS_TOKEN
```

1. TUI 正常启动（显示 `OpenAI Codex (v0.162.1)`、模型 `DeepSeek-Flash`、reasoning `high`）。
2. **反证**：第三方客户端（C）随后查询 `thread/loaded/list`，发现多出一个由 **TUI 创建**的会话：

```
[C] thread/loaded/list: {"data":["01a13695-6ab1-…","01a13695-9792-7c01-a7ee-d5a00dd1722e"]}
```

3. TUI 退出时打印：

```
Disconnected from this task. Any running work continues.
To reconnect, run:
  codex --remote ws://127.0.0.1:8891/ --remote-auth-token-env CODEX_WS_TOKEN resume 01a13695-9792-7c01-a7ee-d5a00dd1722e
Stop the current turn: run codex --remote ws://127.0.0.1:8891/ --remote-auth-token-env CODEX_WS_TOKEN agents, select this task, and press x.
```

结论：

- CLI TUI 与 GUI 客户端**可以共享同一个 app-server 实例及其实时状态**（用户要求的核心验收项）。
- 客户端断开后**任务在服务端继续运行**，并可用 `resume <threadId>` 重连 → 这正是「GUI 建的会话能在 CLI 继续」的机制。
- 限制：`--remote` 是 **TUI 专用**参数，`codex exec` 无此选项（`codex exec --help` 无 remote 相关项）。

补充：整个实验使用桥自建的临时实例，**未触碰用户的 managed 守护进程**（PID 12365 全程存活）。

---

## 本轮撤回/更正的报告 v1 结论

| v1 结论 | 状态 | 依据 |
|---|---|---|
| GUI 可通过 `app-server proxy --sock` 挂到共享守护进程 | **撤回** | E8 |
| 审批统一四按钮（允许一次/允许同类/本会话/拒绝） | **更正** | E13 |
| `thread/revert` 可作文件撤销/Reapply | **更正** | E12 |
| 终端需 node-pty，可能得砍掉 | **更正** | E11 |
| 「Codex 桌面端 46px 头部」应照搬 | **更正** | 用户要求按手机尺寸与安全区调整 |
| M0—M4 可作为项目完成标准 | **更正** | 仅为基础阶段 |
| 守护进程 0.160.0 疑似仅标签差异 | **更正** | E7 哈希不一致，确为旧二进制 |

---

## E49 — 并发与重复提交：回合不重复，但**内容会重复**【已实测，P1 第二项】

`probe/p1-concurrency.mjs`：两个客户端都先订阅同一条线程（E47 的前提），然后做两组重叠写。

| 场景 | 响应 | 结果 |
|---|---|---|
| A、B **同时**对同一线程发 `turn/start`（同样文本） | **两个请求都被接受**（各返回一个 turn） | 事后**只多出 1 个回合**，但该回合里**同一条用户消息出现了 2 次** |
| 同一客户端**连发两次** `turn/start`（同样文本，不等待） | 两个请求都被接受 | 同样**只多出 1 个回合**，**用户消息 2 次** |

`thread/turns/list`（full 视图）逐回合核对：

```
turn ...dcbd  status=completed  用户消息=['只回答一个字：一']
turn ...eb86  status=completed  用户消息=['只回答一个字：二', '只回答一个字：二']
turn ...1a76  status=completed  用户消息=['只回答一个字：三', '只回答一个字：三']
```

**结论（把「不串台」拆开说）**：

- ✅ **不会串台**：没有出现「两个客户端各自开出互相干扰的回合」，提交被并进同一个活动回合，
  回合生命周期只跑一遍（也解释了为什么不会并行执行两次）；
- ❌ **不做去重**：被并进去的那份输入**会作为第二条用户消息写进历史**，模型也会看到两遍。
  对界面来说就是**双击发送 = 消息出现两次 + 模型收到两次**。

**由此产生的硬要求**：去重必须由**客户端**做（提交中禁用按钮 / 去抖 / 幂等键），不能指望服务端。
这正是 `PLAN.md` 里 P2「副作用请求的幂等与去重」那条，现在有了实证依据。

**尚未验证**：切换会话时正在跑的回合是否受影响；两个客户端同时**审批**同一请求；
断线期间的重叠提交（属 P1 第三项）。

### 过程中修正的一次测试设计

第一版事件同步测试（另一个会话写的 `probe/p1-event-sync.mjs`）判定"B 看不到 A 的回合"为失败，
但那是**测试设计的问题**：B 没有订阅那条线程。补上订阅后（`probe/p1-subscribe-sync.mjs`）全部通过（E47）。
教训：测这类东西必须先把「B 已打开该线程」当前提，否则测出来的是假失败。

## E50 — 断线重连：状态可恢复，且不该重发【已实测，P1 第三项 通过】

`probe/p1-reconnect.mjs`：起一个要跑约 15 秒的回合（`sleep 15`），3 秒后**直接断开连接**，
再重连并重新订阅，检查能否恢复真实状态。

结果 **ALL PASS**（13 项断言）：

| 检查 | 结果 |
|---|---|
| 断开前回合已启动 | ✅ |
| 重连后能重新打开该线程 | ✅ |
| **回合仍在服务端运行**（`thread/resume` 返回 `status: "active"`） | ✅ |
| 进行中的回合在历史里可见（`status: "inProgress"`） | ✅ |
| 重连后**能继续收到该回合剩余的事件流**（含 `turn/completed` 与逐字文本） | ✅ |
| 回合最终在服务端正常完成，内容可回读 | ✅ |
| 全程**只有一个回合**，重连没有造成重复执行 | ✅ |

**由此得到客户端的恢复规则（重要）**：
断线重连后**先 `thread/resume` 读真实状态**；若返回 `active`/`inProgress`，
就**只订阅、不重发** `turn/start`——因为服务端不会去重（E49），重发会造成重复的用户消息与重复执行。

## E51 — `clientUserMessageId` 不是内容去重键【已实测，阴性结果】

E49 发现服务端不去重，于是测试协议里现成的 `clientUserMessageId` 是否是官方的幂等钩子
（`probe/p1-idempotency.mjs`）：

| 组 | 提交 | 结果 |
|---|---|---|
| 控制组 | 两次相同 `turn/start`，不带键 | 用户消息 **2 条**（与 E49 一致） |
| 实验组 | 两次相同 `turn/start`，**带同一个 `clientUserMessageId`** | 用户消息 **仍是 2 条** |

附带观察：实验组两次调用**返回了同一个 turn id**（`sameTurnIdReturned: true`），
控制组也是同一个活动回合——说明该字段的作用是**客户端关联**（把本地乐观消息对上服务端的回合/消息），
**不是抑制重复提交**。

**结论**：没有任何服务端去重机制可用，去重必须在客户端做。

### 现有 UI 已经有一层保护（代码级判读，未在浏览器运行时验证）

`submitPrompt` 的执行顺序是：先读 `text = input.value.trim()`，`if(!text)return`，
**然后同步清空输入框**。因此真实的「双击发送」第二次调用时读到的是空字符串，会直接返回。
也就是说 E49 那个「消息出现两次」需要的是**两个各自独立的客户端/脚本**，
而不是界面上的双击。

仍然建议在桥层加幂等（见 `PLAN.md` P2），因为 UI 这层保护依赖「输入被同步清空」这一实现细节，
一旦以后改成乐观渲染或异步提交就会被绕过。**此判读未经浏览器实测**，标为代码级结论。

---

## E52 — P2 第一项：Origin/鉴权复核与硬化【已实测】

**威胁模型（本项的前提）**：在 Android 上**「回环」不是应用之间的边界**。
手机上任一 App 都能连 `127.0.0.1:8899` 并伪造任意请求头。而这个桥能驱动 agent 执行 shell，
所以「回环免鉴权」等于把执行能力暴露给同机其它应用。

新增 `probe/security-auth.test.mjs`（**15 项断言，全过**），先把现状钉住：

| 已正确拒绝（无需改动） | 结果 |
|---|---|
| DNS 重绑定：回环 socket + `Host: evil.example` | 拒绝 ✅ |
| 跨站 `Origin: https://evil.example` | 拒绝 ✅ |
| `sec-fetch-site: cross-site` | 拒绝 ✅ |
| 局域网来客冒充 `Host: 127.0.0.1:8899`（socket 源地址不可伪造） | 拒绝 ✅ |
| 回环 socket 但带 `x-forwarded-for`（经代理） | 拒绝 ✅ |
| `::ffff:127.0.0.1` 映射地址 + 外部 Host | 拒绝 ✅ |

**发现并修复的缺口**：一旦配置了密码或令牌，**回环仍走免费通道**——
实测连**错误的令牌**都被放行（`isRequestAuthorized` 在免费通道判断里没有考虑已配置密钥）。

修复（`app/server-security.js`）：免费通道改为**仅在未配置密钥时生效**。
单元验证：设令牌后，回环无凭据 → 拒绝、错误 Bearer → 拒绝、正确 Bearer → 通过。

**端到端复核**（另起一个设了 `CODEX_WEBUI_ACCESS_TOKEN` 的实例，端口 8898）：

```
无凭据 /api/health -> 401      无凭据 /api/rpc -> 401
错误 Bearer        -> 401      正确 Bearer     -> 200
GET /（登录页）    -> 200
```

**默认体验未受影响**：未设密码时 `authSecret` 为 `null`（`storedPasswordSessionSecret(null)` 返回 `null`），
免费通道照旧；主实例复核 `GET / -> 200`、`/api/rpc -> rpc/result`。

### 顺带修掉的一个「假成功」

重启后立刻验证时发现：`/api/health` 在 app-server **尚未连上**时就返回 `ok:true`，
于是 `codex-gui-web start` 会报「已启动」，但此刻任何 RPC 都会失败
（实测拿到 `Codex app-server is not connected`）。

修法：`/api/health` 增加 `ready` 字段（= 已连接且未在关停），
`codex-gui-web` 与 `~/bin/codex-gui` 都改为等 `"ready":true`。复核：启动后**立即**可用。

另加一条防御：若桥当初是「复用」了别处已有的 app-server（自身没有子进程），
而那个实例随后消失，现在会**自己拉起一个**，而不是永久停在未连接状态（此前会因 `codex` 为空直接 return）。

### 残留风险（如实标注，未解决）

**未配置密码时，同机其它应用仍可驱动这个桥。** 这是「本地免密」模型的固有代价：
浏览器能拿到的东西（页面、cookie），本机其它客户端同样能拿到，因此只有**用户掌握的密钥**才能形成边界。

可行的缓解（用户可选）：

1. 设 `CODEX_WEBUI_PASSWORD` 或 `CODEX_WEBUI_ACCESS_TOKEN` 启动——修复后**回环也会强制校验**；
2. 不用桥时 `codex-gui-web stop`（不留常驻）；
3. Unix socket 不适用：浏览器连不上它。

**尚未验证**：浏览器在设了密码后的完整登录流程（需要你实际登录一次才算通过）。

---

## E53 — P2 第二项：审批请求的关联与去重【已实测，通过】

**问题**：桥把服务端请求（审批/表单/提问）广播给**每个**浏览器客户端。
两个标签页、同一次双击、或服务端已 resolve 之后的迟到应答，
都会把决定转发进一个服务端已经关闭的 request id。

**实现**：新增纯状态机 `app/request-registry.js`（`createRequestRegistry`），
由协议自己的两个信号驱动清账：

- `serverRequest/resolved { threadId, requestId }` → 该请求服务端已了结；
- `turn/completed { threadId, turn }` → 整个回合不再可能有待答请求。

桥在转发请求前登记、在应答时**认领**（claim 成功才转发），认领失败即拒绝。

**单元**：`probe/request-registry.test.mjs`，**20 项断言全过**——含
第二个客户端被拒、未知 id、非法 id、`resolve` 后迟到应答、
按回合清账、无 `turnId` 的请求按 thread 清、同一 item 多回调按 `approvalId` 区分、TTL 兜底。

> 测试当场抓到一个真缺陷：`Number(null)` 等于 `0` 且 `Number.isSafeInteger(0)` 为真，
> 于是 `null` 会被当成「id 0」。**而实测中服务端发起的请求 requestId 恰恰就是 0**
> ——所以一个 `null` 会误认领真实的 0 号请求。已改为只接受真正的数字（或纯数字字符串）。

**端到端**（`probe/p2-approval-dedup.mjs`，真触发一次命令审批）：

| 动作 | 结果 |
|---|---|
| 第一个客户端应答 `{"decision":"accept"}` | HTTP 200 `{"type":"ack"}` ✅ |
| 第二个客户端应答**同一 requestId** | HTTP 400「这个请求已经被处理或已失效（可能由另一个客户端回答过）」 ✅ |
| 服务端已 resolved 之后的迟到应答 | 同样被拒 ✅ |
| SSE 中观察到 `serverRequest/resolved` | ✅ |

**尚未覆盖**：legacy 两套协议（`execCommandApproval` / `applyPatchApproval`）的界面渲染——
上游前端目前对它们仍回 `-32601`；本项只保证桥侧请求生命周期与去重正确。

---

## E54 — P2 第三项：未作答请求可恢复 + 一次「半死不活的实例」事件【已实测】

### A. 待答请求可被新页面取回（通过）

新增 `GET /api/requests/pending`（桥的登记表原样吐出未应答的请求，含完整 `params`）。
这正是「刷新后卡片消失、回合永远挂着」的解法（E32 的失败形态）。

`probe/p2-pending-requests.mjs`，**ALL PASS**：

| 步骤 | 结果 |
|---|---|
| 初始 | 待答列表 0 条 |
| 真触发一次命令审批 | 列表出现 **1** 条，`requestId` 与事件里的**一致（=0）**，且带 `availableDecisions`（够渲染卡片） |
| 应答后 | 列表回到 0 条 ✅ |

前端（`patches/0012`）：连接建立时调用 `restorePendingRequests()`，把仍待答的请求重新走
一遍 `onServerRequest` —— 与实时事件**共用同一条渲染路径**，因此审批卡片、提问卡片、MCP 表单都能恢复。
**这一层是代码级结论**：浏览器里的实际效果需要你在「有审批待答时刷新页面」来确认。

### B. 一次真实事故：draining 的孤儿实例

现象：重启后 `/api/rpc` 报 **`Server is draining; retry after reconnecting`**，而 `/api/health`
仍然返回 **`ready:true`**（具有误导性）。排查发现：上一轮留下的 app-server（**PPID=1**）还占着 8901，
新桥既**没能干净接管**它、又**绑不上端口**（`Address already in use`）。

有趣的是它是**瞬时**的：同一个孤儿实例稍后又能正常服务（RPC 返回了数据），
所以「draining」不是永久状态，而是收到过信号、还在收尾的窗口期。

处置：杀掉旧桥与该孤儿，干净重启；重启前确认 8901 无占用者，重启后 `ready:true` 且真实 RPC 可用。

据此加了两处防御（`app/server.ts`）：

1. 关停时 **SIGKILL 升级**：`terminateCodex` 发信号后 3 秒仍未退出则向进程组发 SIGKILL；
2. 端口被占时**清理自家死实例**：`killStaleAppServerOnOurPort()` 只在
   「同端口 + 同 token 文件」都匹配时才杀，避免误伤同端口的无关服务。

**如实标注**：这次事故里**升级与清理路径都没有被真正触发**（桥是「接管成功」而不是「绑定失败」），
所以这两处是**防御性改动，尚未由这次事件证明有效**。

**尚未解决**：`/api/health` 的 `ready` 只反映 WS 是否连上，**不反映实例是否处于 draining**。
要真正可靠，需要在请求失败时把 `connected` 置回 false 并触发重建——已记入待办。

---

## E55 — P2 第四项：副作用请求的幂等与去重【已实测 / 代码级】

分三块，逐块给出依据。

### 1. 重连后不重发（代码级核查，通过）

前端**没有**任何重发队列：检索 `retryQueue|resend|replay|pendingRpc|outbox` 零命中；
`silentTransportSwitch` 只用于**抑制错误提示**（传输层切换时不想弹 toast），
不会重新发送请求。因此「断线重连不重发有副作用请求」在客户端这一侧成立，
与 E50 定下的规则（重连先 `resume` 读状态、正在跑就只订阅）一致。

### 2. 审批去重（已实测，见 E53）

桥侧登记 + 认领，第二个客户端与迟到应答都会被拒。

### 3. 提交去重（新增，纯逻辑已测）

服务端不去重（E49），`clientUserMessageId` 也不去重（E51），所以只能在客户端做。
新增 `createSubmitGate()`（`ui-core.js`，纯逻辑）：同一时刻只允许一次提交。

`probe/submit-gate.test.mjs`，**9 项断言全过**，含三个关键场景：

- 双击：第二次返回 `undefined`、实际只执行一次；
- 跨事件循环的连击（第二次在第一次结束前到达）：同样被拦；
- **失败不会卡住闸门**（抛错后仍能再次提交）——否则用户之后再也发不出消息；
- 串行提交互不影响。

接线（`patches/0013`）：`submitPrompt` 包一层闸门，原函数体改名为 `submitPromptInner`，
**函数体逐字未动**。

> **接线时避开的自锁陷阱**：E40 的「追加失败回退为发送」是在提交**内部**递归调用 `submitPrompt` 的。
> 若那次调用也走闸门，会被自己正在持有的 in-flight 状态拦住，
> 结果就是 E40 那个修复**静默失效**。因此该处改为直调 `submitPromptInner`。
> 这一点值得记住：给一个存在自调用的函数加单飞保护，必须同时处理内部调用。

**未在浏览器实测**：闸门的实际点击行为（我用纯逻辑测试覆盖了语义，
但「手机上连点两次发送」这一动作需要你在浏览器里确认）。

### 剩下没做的

- 提交的**幂等键**：目前靠闸门拦住并发，但如果一次提交失败后用户重试，
  服务端仍会产生第二条用户消息（这是**预期**的重试语义，不是缺陷）。
  若将来要做「网络超时后安全重试」，需要真正的幂等键——而 E51 表明现成的
  `clientUserMessageId` 不提供这个能力，得自己在桥侧做（记入待办）。
- `git` 提交等写操作尚未实现（属 P6）。

---

## E56 — P3 审计与已落地的部分【协议层已实测，界面层代码级】

### 审计：前端实际调用了哪些会话操作

逐个检索 `public/app.js` 对 P3 相关 RPC 的调用次数：

| RPC | 次数 | 结论 |
|---|---|---|
| `thread/list` / `thread/resume` / `thread/turns/list` / `thread/delete` | 有 | 上游已实现（含 cursor 分页） |
| `thread/fork` | **0** | 缺 |
| `thread/archive` / `thread/unarchive` | **0** | 缺 |
| `thread/name/set` | **0** | 缺 |
| `threadSection/*` | **0** | 缺 |
| `thread/compact/start` | **0** | 缺 |
| `searchTerm` | **0** | 缺——侧栏虽有搜索框（`#threadSearch`），但只对**已加载的页**做本地过滤 |

### 协议层先验证，再动界面

`probe/p3-thread-ops.mjs`，**ALL PASS**：

| 操作 | 结果 |
|---|---|
| `thread/name/set` | 接受，且 `thread/list` 里能读到新名称 |
| `thread/archive` | 默认列表消失；`archived:true` 能查到 |
| `thread/unarchive` | 恢复后重新出现 |
| `thread/fork` | 返回新线程，**继承 1 个回合**，原线程不受影响 |
| `thread/list{searchTerm}` | 能命中刚重命名的线程（服务端搜索可用） |
| `threadSection/list` | **已有一个 `Pinned` 段**——置顶在协议层是现成的 |
| `thread/compact/start` | 报 `thread not found`：**未加载的线程要先 `resume`**（与 E36/E47 同因，不是缺陷） |

### 已实现（代码级，需浏览器确认）

`patches/0014` + `0015`：线程行新增「⋯」菜单，含 **重命名 / 分叉 / 归档**（已归档的行显示「恢复」）；
配套 CSS 与简中词条（用 `createI18n` 实例化后逐条验证：会话操作/重命名/分叉/归档/恢复/已重命名 全部解析为中文）。

接线时修正一处：我最初用了 `codexIcon('moreHorizontal')`，而图标集里实际叫 **`ellipsis`**
——用错名字按钮会是空的，已改。样式追加到 `style.css`、词条追加到 `i18n.js` 末尾，
并通过真实实例化验证追加位置有效（追加到模块作用域之外会整块失效）。

### P3 尚未完成的部分（如实列出）

1. **服务端搜索**：把搜索框接到 `thread/list{searchTerm}`（现在只过滤内存里的页）。
2. **已归档视图**：菜单里已有「恢复」，但目前没有地方列出已归档会话，所以恢复入口实际不可达。
3. **分区/置顶**：协议层已有 `Pinned` 段与 `threadSection/*`，界面未做。
4. **compact**：未做（且需要先 `resume`）。

**P4 尚未开始。**

## E57 — 我自己引入的一处显示缺陷（截图发现，已修）【代码级，待确认】

用户截图（2026-10-14 04:48）：线程行菜单**只显示出「重命名」一项**，分叉/归档被下一行盖住。

**根因**：这个弹出菜单是我在 `patches/0014` 里加的，用的是
`.thread-actions{position:relative}` + `.thread-actions-menu{position:absolute;top:100%}`——
即**绝对定位在行内**。而侧栏的行/滚动容器有 `overflow` 裁剪，
比行高的浮层就会被切掉。属于**我引入的回归**，不是上游问题。

**修复**（`patches/0017`）：让菜单彻底脱离裁剪上下文——
打开时 `document.body.append(menu)`，用 `getBoundingClientRect()` 定位并夹在视口内（`position:fixed`）；
关闭时从 body 摘除；外部点击判定同时排除菜单自身（否则点到菜单也会把它关掉）。
这样将来侧栏再怎么改 `overflow` 都不会重现。

**验证**：bundle 内 `document.body.append(menu)` 存在、CSS 已改为 `position:fixed`。
**视觉效果需要你在浏览器确认**（我这边看不到渲染结果）。

## E58 — P3：已归档视图（补齐我自己留下的半成品）【代码级，待确认】

`patches/0014` 给行菜单加了「恢复」，但 `thread/list` 只有在 `archived:true` 时才返回已归档会话，
而界面没有任何地方用它——**恢复入口实际不可达**。这是我自己留下的半成品，本轮补齐（`patches/0018`）：

- 侧栏新增「已归档」行（`aria-pressed` 表示当前视图），点击在「进行中 / 已归档」之间切换；
- `refreshThreadList` 按视图带上 `archived` 参数，并给已归档的行打上 `archived:true`
  （这样行菜单显示的是「恢复」而不是「归档」）；
- 切换时用 toast 明确告知当前在看哪一类，避免用户以为会话丢了。

### 过程中的一个教训：幂等标记撞上了上游已有的词条

`patches/0018` 用 `"Archived": "已归档"` 作为 i18n 追加的幂等标记，
但**上游本来就有这一条**（`i18n.js` 约 117 行），于是整个追加被判定为「已应用」跳过，
连带另外两个键也没写进去。

发现方式：用 `createI18n` 真实实例化后逐条翻译，`Archived` 能译、另两个原样返回 → 立刻暴露。
修复：`patches/0019` 改用只属于自己的标记（`"Showing archived threads"`）。

**教训**：幂等标记必须选**本次改动独有**的字符串，不能拿一个可能与上游重合的通用词条当标记，
否则会静默跳过整块追加。

**验证**：三个键实例化后分别为 已归档 / 正在显示已归档会话 / 正在显示进行中的会话；
bundle 内 `toggleArchivedView`、`archived: showArchived` 均存在。
**界面效果需你在浏览器确认**。

### P3 剩余

- 分区/置顶界面（协议层已有 `Pinned` 段与 `threadSection/*`）
- `thread/compact/start`（须先 `resume`）

## E59 — 分区/置顶：生成的类型与实际运行时**方法名不一致**【已实测】

接入置顶时按类型里写的 `threadSection/move` 调用，被服务端拒绝：

```
Invalid request: unknown variant `threadSection/move`, expected one of `initialize`, …
```

但这句报错**把服务端接受的方法名列了出来（171 个）**，里面同时有 `threadSection/move`
和 `thread/section/move`。改试后者时，先被**我自己桥的白名单**挡住
（`RPC method is not available to browser clients`）——说明白名单也需要放行它。

放行后实测：

| 调用 | 结果 |
|---|---|
| `threadSection/move {threadId, sectionId}` | ❌ `unknown variant` |
| `thread/section/move {threadId, sectionId: <Pinned id>}` | ✅ `{"type":"rpc/result","result":{}}` |

**结论**：`Pinned` 段在 `threadSection/list` 里就有，但**移动线程的方法名在运行时是
`thread/section/move`**，与 `generate-ts` 产出的类型不一致。这与 E29 是同一类问题的**反方向**：
那次是「wire 上有、类型里没有」，这次是「类型里有、运行时名字不同」。

**产物**：白名单补上 `thread/section/move`（两个名字都留，兼容不同 revision）；
`patches/0021` 把置顶调用改成运行时接受的名字。

**尚未验证**：置顶后线程的 `section` 字段（测试用的新会话没跑过回合、还没落盘，
`thread/list` 里找不到它——与 E36/E47 的「新会话要先有一个完成的回合」同因）。
因此**界面上的「置顶」分组是否正确渲染，仍未验证**。

### 顺带得到一个可复用的核验手法

**用服务端的「unknown variant」报错可以列出它真正接受的方法名**（本次拿到 171 个）。
这比只信 `generate-ts` 可靠：后续可以拿这份列表与我扩到 60+ 的白名单逐条比对，
找出「类型里有、运行时没有」的条目。已记入待办。

## E60 — 置顶分组出现在最上边【用户已确认存在，排序已修】

用户反馈：**置顶分组出现了，但不在最上边**。这本身是 E59 里「分组渲染未验证」的确证——
功能通了，只是位置不对。

**根因**：分组排序的第一条规则是「当前项目优先」——
`(a.key===currentKey?-1:b.key===currentKey?1:b.recency-a.recency)`——
它**先于**按 recency 排序生效，所以我给置顶组设的 `recency: MAX_SAFE_INTEGER` 永远赢不过
「这正是你当前打开的项目」。

**修复**（`patches/0022`）：比较函数里先判 `__pinned__`，让它无条件排在第一个，
其余仍按「当前项目优先、再按最近使用」。

**教训**：往一个已有的多重排序规则里插一个新优先级时，要动**比较函数本身**，
而不是只把新条目的排序键调到极端值——原来的规则会先把它截胡。

## E61 — `thread/compact/start`：P3 最后一项【协议层已实测】

实测两条路径**都成功**：

| 调用 | 结果 |
|---|---|
| 未 resume 直接 `thread/compact/start` | ✅ `{"type":"rpc/result","result":{}}` |
| 先 `thread/resume` 再 compact | ✅ 同上 |

**顺带更正 E56 的一处表述**：那里我写「未加载的线程要先 resume」。这次测试说明并非普遍规则——
E56 里那次 `thread not found` 出现在一个**被归档又恢复过、当时未加载**的会话上。
准确说法是：**具体取决于该线程当时的状态**，而一个正常跑过回合的线程两条路径都可以。

**产物**：置顶之外，行菜单新增「压缩上下文」（`patches/0023`），
非当前会话会先 `resume` 再 compact；简中词条经实例化验证（压缩上下文 / 已开始压缩上下文 / 压缩失败）。

### P3 收尾

| 项 | 证据 |
|---|---|
| 审计：逐项核对前端调用 | E56 |
| 协议层验证（重命名/归档/恢复/分叉/搜索/分区） | E56 |
| 行菜单：重命名 / 分叉 / 归档 / 恢复 | E56、E58 |
| 服务端搜索 | E56 |
| 已归档视图 | E58 |
| 置顶 / 分区（含方法名不一致与排序修复） | E59、E60 |
| compact | E61 |

**P3 的验收条件**「与 CLI 双向可见」由 E4（读同一份历史）、E25（`--remote resume` 续接）、
E47（订阅后实时共享）覆盖。

## E62 — 隔夜后浏览器端消失：取证与结论【已实测】

用户反馈：过了一夜，浏览器打不开。取证结果：

| 检查 | 结果 |
|---|---|
| 桥进程 / 8899 / app-server | 全部不存在 |
| `bridge.log` 最后写入时间 | **05:02**（当前 11:19，中间约 6 小时无写入） |
| 日志末尾 | **没有任何报错**，最后几行是正常的浏览器请求日志 |
| 我当前会话的进程 | TUI `26203`，其 managed daemon `26241` 是它的**子进程**——说明**这是新起的会话进程**（昨晚那套是 31343/31376） |
| 数据 | 完好：重启后 `thread/list` 正常，历史会话都可读 |

**结论（证据链）**：

1. 日志干净地停在 05:02、没有任何异常 → **不是桥自己崩溃**，是被外部终止；
2. 我的会话进程也是新的 → **消失的是整个 Termux 应用进程**（隔夜被系统回收，或设备重启），
   不是只有桥被杀；
3. 桥是**手动**用 `codex-gui-web start` 起的，**没有任何机制在开机/重开 Termux 时把它拉起来**
   → 于是「Termux 活过来了、桥没活过来」；
4. 桥是无状态的，**会话与历史都在磁盘上，没有丢失**（重启即可恢复）。

**这不是 bug，是 Android 上「Termux 里的普通进程」的固有行为**：
它不在 Android 的服务/前台服务体系里，应用进程一被回收就跟着走。

### 可选的持久化方案（各有代价，未擅自改用户环境）

| 方案 | 效果 | 代价 |
|---|---|---|
| 每次要用时 `codex-gui-web start` | 现状 | 需要手动一条命令 |
| `.bashrc`/`.profile` 里自动 `start` | 打开 Termux 就有 | 每次开 shell 都会尝试启动；不是常驻保证 |
| `termux-wake-lock` | 显著降低被回收概率 | **会留一条常驻通知** |
| `termux-services`(runit) | 崩了自动重拉 | 需要额外配置与常驻 |
| Termux:Boot 插件 | 设备重启后自动起 | 需装插件，且仍需 wake-lock 才稳 |

**尚未做**：以上方案都还没落地，等用户选。

### 顺带发现的一个真实缺陷（待修）

日志末尾重复出现：

```
[codex-webui] browser rpc failed: host/thread/live -> Thread rollout is outside the Codex sessions directory
```

这是界面打开会话时调用的「读实时状态」接口在报错（`readLiveThread` 的路径守卫拒绝了该 rollout）。
**已列入待办**：这会让某些会话在界面上打不开实时状态（历史仍可读）。

## E63 — 打开 Termux 自动启动桥【已实测】

用户决定：现阶段「打开 Termux 就 start」，APK 阶段再改成「打开应用即可用 + 后台置顶通知防杀」。

**实现**：写入 `~/.bashrc`（`.profile` 已 source 它）——
若桥已在运行则秒退，否则后台 `codex-gui-web start`。

**关键细节：带 60 秒限流**。因为 `.profile` 会 source `.bashrc`，
**非交互的 login shell 也会走到这段**（例如工具调用用的 `sh -lc …`），
不限流的话每条命令都会尝试拉起一次。限流用 stamp 文件实现；且这段刻意写成 **POSIX 语法**，
以免被 `sh` 读到时报错。

**实测**：

| 检查 | 结果 |
|---|---|
| 停掉桥、清掉限流戳后，模拟打开 Termux（`bash -ic true`） | 桥自动启动，pid 30649，健康检查通过 ✅ |
| 紧接着连开 3 个 shell | pid **不变**（未重复拉起） ✅ |

## APK 阶段的既定要求（用户指示，待 P9 满足）

已记入 `PLAN.md` 的决策表，这里复述以便接手者不遗漏：

1. **打开应用即可用**——启动 APK 时自动拉起桥与 app-server，不要求用户先开 Termux 敲命令；
2. **后台跑会话用「置顶通知」防杀**——以前台服务 + 置顶通知保证执行中的会话不被系统回收。

一句话目标：**打开就能用，后台跑着不被打断。**

## E64 — P4 验收链路：新建 → 流式 → 追加 → 停止 → 继续【已实测，ALL PASS】

`probe/p4-acceptance.mjs`，**走桥的 API**（浏览器用的同一条路径，不是私有 harness）：

| 步骤 | 结果 |
|---|---|
| 新建任务 | ✅ |
| 回合开始 + **流式输出**（reasoning delta / agentMessage delta / **commandExecution/outputDelta**） | ✅ |
| 运行中追加指令（`turn/steer` + `expectedTurnId`） | ✅ |
| 停止（`turn/interrupt` 后收到 `turn/completed`，即真的中止） | ✅ |
| **继续**（停完再发一个回合并跑到完成） | ✅ |
| 会话历史可读且含两个回合 | ✅ |

期间观察到的通知类型：`turn/started`、`item/started`、`item/completed`、
`item/reasoning/textDelta`、`item/commandExecution/outputDelta`、`thread/tokenUsage/updated`、
`turn/completed` 等——即 P4 要求的那些「过程/工具活动」在协议层都真的在推。

**P4 的验收条件（PLAN 里写的全链路）由此通过。**

## E65 — P4 审计：上游已实现绝大部分；**模式切换未打通**【审计 + 未解决项】

逐个检索前端对 P4 相关能力的引用：

| 能力 | 前端引用 | 结论 |
|---|---|---|
| reasoning / 过程展示 | 47 | 已实现 |
| 文件改动 / diff | 24 / 1 | 已实现 |
| 图片查看 | 32 | 已实现 |
| 计划（Plan/plan） | 11 / 19 | 已实现 |
| commentary 阶段 | 9 | 已实现（用于区分过程与最终） |
| 子代理 / 协作活动 | 5 / 4 | 已实现 |
| MCP 调用 / 服务器 | 1 / 3 | 已实现 |
| Web 搜索卡 | 5 | 已实现 |
| 退出码 / 耗时 | 5 / 13 | 已实现 |
| **模式切换 `collaborationMode`** | **0** | **未实现** |
| 附件（localImage/attachment） | 3 / 2 | 薄，待补 |
| `memoryCitation` | 0 | 未渲染 |

### 模式切换：尝试了但**没打通**（如实记录）

发现运行时接受 `thread/settings/update`（**生成的类型里没有**——这是类型与运行时不符的第三例，
前两例是 E29 与 E59）。用 `probe/raw-rpc.mjs` 直连服务端逐步探它：

| 探测 | 结果 |
|---|---|
| `thread/settings/update {}` | `missing field 'threadId'` → 说明 `threadId` 必填 |
| 先 `resume` 再 `{threadId}` / `{threadId, settings:{}}` | 返回 `{}`（接受） |
| 加 `collaborationMode:{mode:"plan",settings:{…}}`（camel） | 返回 `{}`，但**读回仍是 `null`** |
| 换成 `collaboration_mode`（snake） | 同样返回 `{}`，读回仍是 `null` |
| 故意传未知字段 `__bogus` | 返回 `{}`——**该接口不拒绝未知字段**，所以错字段被静默丢弃 |

**结论**：这个接口存在且可调用，但**我没能确定切换 Default/Plan 的正确字段**；
它静默忽略未知字段，也拿不到「期望字段列表」这条线索。
**该项保持未完成**，并记下已排除的路径，避免下次重复试错。

下一步可试：反查 `codex.bin` 字符串中该请求结构体的字段名（E14 用过这招）；
或在 TUI 里执行 `/plan` 并对比 `thread/read` 的前后差异，看它到底改了哪个字段。

## E66 — 模式切换其实可用（E65 的续）：四个可复用发现【已实测】

E65 里我判「没打通」，随后按记录下来的思路继续，**打通了**，并把方法记下来。

### 发现 1：存在 `collaborationMode/list`（生成的类型里没有）

从 `codex.bin` 的字符串里发现这个方法名，直接调用成功：

```json
{"data":[
  {"name":"Plan","mode":"plan","model":null,"reasoning_effort":"medium"},
  {"name":"Default","mode":"default","model":null,"reasoning_effort":null}]}
```

对应生成的 `CollaborationModeMask` 结构——所以模式是一等概念，而且**可以枚举**。

### 发现 2：`turn/start` **接受 `collaborationMode`**（类型里没有）

在同一连接里 `resume` 后调用：

```
turn/start {threadId, input, collaborationMode:{mode:"plan",settings:{model,reasoning_effort,developer_instructions}}}
→ 返回正常 turn（没有被拒，也没有 "unknown field"）
```

**结论：Default/Plan 的切换是 `turn/start` 上的 `collaborationMode`**，
不是 `thread/settings/update`。E65 的失败是因为我猜错了载体。
这是**类型与运行时不一致的第四例**（前三例：E29 `availableDecisions`、E59 `thread/section/move`、E65 `thread/settings/update`）。

### 发现 3：`turn/settings/update` 的真实字段表（靠报错问出来的）

故意传错字段，服务端回了完整期望列表：

```
expected one of `threadId`, `turnId`, `approvalsReviewer`, `model`, `effort`, `summary`, `serviceTier`
```

即：**它是用来在回合中途改模型/推理档位/复核者的**——这本身也是 P4「模型与档位切换」缺的一块能力
（`thread/settings/update` 则静默忽略未知字段，问不出字段表）。

### 发现 4：app-server 会**卸载空闲线程**，所以串联调用必须同一连接

多次单独调用时反复遇到 `thread not found`：`resume` 在一个连接里做完，
连接一关线程就被卸载（`thread_unload_delay_secs`），下一个连接再操作就找不到了。

据此给 `probe/raw-rpc.mjs` 加了 `RAW_CHAIN`（同一连接内按序执行多个调用），
这也是发现 2 能被验证的前提。**这个坑对写客户端同样成立**：长连接不要断，断了要重新 `resume`。

### 对 P4 的结论修正

「模式切换未打通」**更正为「协议层已打通，UI 未接」**。剩余工作是把
`collaborationMode/list` 的结果渲染成切换控件，并在 `turn/start` / `thread/start` 上带上所选模式。
（UI 部分本轮未做，属未完成项。）

## E67 — 模式切换的 UI 已接 + 一个新约束：`settings.model` 必须是字符串【已实测】

**UI 已实现**（`patches/0024`）：侧栏之外，在 composer 里加了「模式」chip
（`#collabModeButton`——**不能复用 `#modeButton`，那是权限控件**）：启动时拉
`collaborationMode/list` 渲染，点一下在 Plan/Default 间切换，`turn/start` 与 `thread/start`
都带上所选模式；服务端只给一个模式时该 chip 自动隐藏。

**新约束（实测）**：`collaborationMode.settings.model` **传 null 会被拒**：

```
Invalid request: invalid type: null, expected a string
```

（此前那次"成功"是因为我传的是 `"deepseek-flash"` 字符串。）已修（`patches/0025`）：
**没有已知模型名时干脆不发这个覆盖**，而不是发一个 null。

**行为验证未成立（如实记录）**：设计了一个 A/B——同样要求写文件，plan 模式应当先规划不动手。
结果 plan 那一侧因上面的 null 报错没跑起来；**默认模式那一侧虽然被接受、但也没有写文件**，
所以两侧行为相同，**无法据此判断模式是否生效**。

**结论**：模式切换「接口可用 + UI 已接」已确认；**"切到 Plan 后模型行为确实改变"仍未验证**。
下次要做的话，A/B 的题目要换成模型一定会动手的任务（例如明确要求"运行这条命令"），
否则模型只是回话、造不出差异。

## E68 — 归档会话会让「读实时状态」报错（已修，真因：路径守卫范围太窄）

**现象**：用户报「127.0.0.1 拒绝连接」；查服务端却一切正常（桥连续运行两小时、
`/` 返回 200、`localhost` 与 `127.0.0.1` 都通）。但日志里反复出现：

```
browser rpc failed: host/thread/live -> Thread rollout is outside the Codex sessions directory
```

**根因（实测定位到具体会话）**：报错的是会话 `01a128de-8953-71b2-9542-1bf08118e3ed`，
它的 rollout 在

```
~/.codex/archived_sessions/rollout-2026-10-11T10-50-35-01a128de-….jsonl
```

——**归档过的会话被移到了 `archived_sessions/`**，而 `readLiveThread` 的包含性检查只认
`~/.codex/sessions/`，于是**任何归档会话都会被判成"外来的 rollout"**。
用户刚用上归档视图（P3），正好把它踩出来。

**影响**：打开归档会话时界面会收到错误（历史仍可读），观感上很像"浏览器端坏了"。

**修复**（`app/server.ts`，两处）：

1. 包含性检查的根从 `sessions/` 放宽到 **整个 Codex home**（`codexHomeRoot`），
   既覆盖 `sessions/` 与 `archived_sessions/`，又依然出不了 `.codex`；
2. 万一仍有别的路径，**降级为"实时状态未知"**并记一行日志，而不是把错误抛给界面。

**验证**：重启后对该归档会话调 `host/thread/live` 返回
`{"active":false,"lastEventAt":"2026-10-11T05:32:15.246Z","turn":null}`（正常，且能读到归档 rollout 的最后事件时间）。

### 关于「拒绝连接」本身

服务端这一侧**无法复现**：桥进程连续运行约 118 分钟未重启，`127.0.0.1:8899` 与
`localhost:8899` 从 Termux 内均返回 200。已用显式 `http://127.0.0.1:8899/` 重新打开页面。
最可能的解释是**浏览器把地址升级成了 https**（「始终使用 HTTPS」），而桥只提供 http。
待用户确认地址栏里的 scheme 后收口。

## E69 — 模式切换**行为验证通过**（E67 的重做，A/B 成立）

E67 的 A/B 无效（两端都没动手）。这次改两处后重做：

1. **题目改成明确要求执行动作**：`请运行 shell 命令 \`echo hello > <file>\`，然后只回一个字：好`
   ——上次只让它"写文件"，模型回了话但没动手；
2. **`settings.model` 传字符串**（上次传 null 直接被拒，E67）。

结果（同一台机器、同一模型、两个新会话，唯一差别就是 `collaborationMode`）：

| 组 | 回合被接受 | 是否真的创建了文件 |
|---|---|---|
| **plan** | ✅ | **false**（先规划、不动手） |
| **default** | ✅ | **true** |

**结论：`collaborationMode` 确实改变模型行为**，不只是"被接受"。
P4 的「Default/Plan 模式」这一项至此**协议 + UI + 行为三层都验证过**。

**方法论记一笔**：验证一个"开关"是否生效，要用**该开关本应改变的行为**做 A/B，
而且要选对方**一定会做**的动作。两次实验的差别只在这里——第一次是"接口返回 OK 但结论悬空"，
第二次才有真结论。

## E70 — 协议面运行时体检：白名单已与真实方法集对齐【已实测，通过】

类型与运行时不一致已经撞到四次（E29/E59/E65/E66），所以不再等它自己暴露，而是**主动体检**。

`probe/allowlist-audit.mjs` 的做法：

1. 给服务端发一个不存在的方法，它会回一句「expected one of …」，里面列出**真实接受的全部方法名**；
2. 从 `server-security.js` 解析出桥放行的白名单；
3. 两边 diff。

**首次结果**：

| | 数量 |
|---|---|
| 服务端接受 | **174** |
| 桥放行 | 82 |
| 放行但运行时不存在 | **2** |

两个命中逐一处理：

- `threadSection/move` —— **真问题**（运行时只认 `thread/section/move`，E59）。已从白名单移除：
  一个永远不可能成功的条目只是噪音。
- `host/thread/live` —— **误报**：这是**桥自己处理**的伪方法，从不转发给服务端。
  已让脚本排除 `host/*`。

**修复后复跑：服务端 174 / 放行 81 / 假条目 0 ✅**

### 顺带发现的缺口（重要，改变 P3/P4 的认知）

「服务端接受但白名单没有」的列表里有几个**成体系的 API**，说明我之前的实现是**绕路**的：

| 发现 | 数量 | 意义 |
|---|---|---|
| `project/list`、`project/read`、`project/create`、`project/import`、`project/update`、`project/move`、`project/delete` | 7 | **项目是服务端一等概念**。P3 里我是按 `cwd` 在客户端聚合分组的——**有正规 API 没用** |
| `thread/queue/add`、`list`、`update`、`delete`、`reorder`、`start` | 6 | **消息排队**是真实能力。P4 要求「明确追加、排队和新开回合的区别」——这正对应 `turn/steer`（追加）与 `thread/queue/*`（排队） |
| `thread/search`、`thread/searchOccurrences` | 2 | 除 `thread/list{searchTerm}` 之外还有专门的搜索接口 |
| `thread/backgroundTerminals/list|clean|terminate` | 3 | 后台终端管理（P6 终端相关） |
| `memory/status`、`memory/reset`、`rollout/compress` | 3 | 记忆与归档压缩 |
| `thread/inject_items`、`thread/prediction/request`、`thread/approveGuardianDeniedAction` | 3 | 注入条目 / 轨迹预测 / Guardian 审批 |

**结论**：白名单本身现在是干净的；但**功能实现上有两处是绕路的**（项目分组、排队语义），
应改用上面的正规 API。已记入 P3/P4 的待办。

> 方法论价值：这个体检**一条命令**就能回答「我放行的方法运行时到底存不存在」，
> 而且顺带把「服务端有、我没用」的能力一次性列出来。建议每次升级 Codex CLI 后复跑。

## E71 — 「127.0.0.1 又炸了」的真因：我自己引入的**启停抖动**【已实测，已修】

用户第二次报连不上。这次日志给了硬证据：

```
--- 2026-10-14 15:28:19 start ---
--- 2026-10-14 15:28:41 start ---   ← 相隔 22 秒
```

**机制（我自己造成的）**：`codex-gui-web start` 见到「进程在、但健康检查不过」就
**杀掉重建**。而桥重启后要几秒才 `ready`；这段时间里只要有任何 shell 被打开
（我在 E63 加的**自动启动会在每个 shell 触发**，限流 60 秒）就会把它再杀一次——
于是抖动，浏览器正好撞进这个窗口就是「拒绝连接」。

上一轮我结尾自己 `restart` 过一次（16:56），用户刚好在那几秒打开页面，
所以现象是「突然又炸、过会儿自己好」。

**修复**（`~/bin/codex-gui-web`）：遇到已在运行的桥，**先等它就绪（最多 25 秒）**，
只有等满仍不就绪才判定卡死并重启。

**验证**：

| 步骤 | 结果 |
|---|---|
| 重启后立刻再调 `start`（旧逻辑会杀掉它） | 输出「已经在跑（pid 4109）」，**等待而非杀** ✅ |
| 前后 pid | **不变**（4109 → 4109） ✅ |
| 启动标记数量 | 只多 1 条（16→17），没有抖动 ✅ |
| 健康状态下 `start` | 立即返回，不重启 ✅ |

**教训**：给「进程在但没就绪」这种情况写自愈逻辑时，**必须先区分"启动中"与"卡死"**，
否则自愈会变成抖动；而当这个逻辑还会被自动触发（每个 shell）时，抖动会被放大。

## E72 — 消息排队（`thread/queue/*`）的真实形状【协议层已探明】

E70 的体检发现 6 个 `thread/queue/*` 方法，而 P4 要求「明确**追加、排队、新开回合**的区别」——
这其中"排队"这一档此前完全没实现（只有 `turn/steer` 的追加）。用「报错即文档」的办法探明：

| 调用 | 结果 |
|---|---|
| `thread/queue/add {}` | `missing field 'threadId'` |
| `thread/queue/add {threadId}` | `missing field 'input'` → 说明与 `turn/start` 一样收 `input` 数组 |
| `thread/queue/list {threadId}` | ✅ 返回 `{"data":[],"nextCursor":null}` |

同族方法：`thread/queue/update`、`delete`、`reorder`、`start`。

**语义（据此确定 UI 应当怎么区分三件事）**：

| 用户意图 | 对的接口 | 现状 |
|---|---|---|
| **追加**到正在跑的回合（立刻影响它） | `turn/steer`（需 `expectedTurnId`） | 已实现（E30） |
| **排队**，等这一轮结束后自动执行 | **`thread/queue/add`** | **未实现** |
| **新开回合**（当前回合已结束时） | `turn/start` | 已实现 |

**下一步**：给 composer 在"回合运行中"时提供**追加 / 排队**两个选择
（现在只有追加/停止），排队项通过 `thread/queue/list` 显示、可 `delete`/`reorder`。
这一项做完，P4 里「明确追加、排队和新开回合的区别」才算真正满足。

## E73 — 排队的两个实测约束（其中一个让我刚写的 UI 是坏的）【已实测】

### 1. `thread/queue/add` **要求 `clientUserMessageId`**

第一次实现只传了 `threadId` + `input`，服务端直接拒绝：

```
Invalid request: missing field `clientUserMessageId`
```

即形状是 `{ threadId, input, clientUserMessageId }`，而且这个 id 就是删除时用的
`queuedSubmissionId`（`thread/queue/delete {threadId, queuedSubmissionId}`——字段名也是问出来的）。

**这说明 E51 的结论要补一句**：`clientUserMessageId` 在 `turn/start` 上不去重，
但**在排队接口上它是必填的、用于标识这条排队项**。同一个字段在两个接口上职责不同。

**已修**（`patches/0027`）：UI 用 `crypto.randomUUID()` 生成并传入。

### 2. 没有回合在跑时，`queue/add` 会**立即执行**，不是"存着"

实测：在一个空闲会话上 `queue/add` 一条文本 →
`add` 返回成功并给出 `queuedSubmission.id`；但紧接着

```
thread/queue/list  -> {"data":[]}
thread/queue/delete -> {"deleted":false}
```

查该会话的历史，**多出一个包含这条文本的回合**（`01a139aa-b71f-…`）。

**结论**：队列是「当前回合结束后要跑的东西」；**没有正在跑的回合时，提交会立刻变成回合**，
所以列表是空的、也删不掉（不是 bug，是语义）。

**对 UI 的意义**：排队入口只在**回合运行中**出现（`mode==='steer'`）是对的；
但**"回合运行中排队 → 真的被挂住、等结束再跑"这条路径我还没验证**——
那需要在一个正在跑的回合上排队，属下一步。

**副作用说明**：测试留下的那条已变成一个回合，保留在测试会话里，设备上没有残留的待执行排队项。

## E74 — 我能自己操作手机了，但**够不到浏览器**（能力与阻塞点）【已实测】

用户授权「可以自己控制手机测试，不必等我」。实测结论分开说清楚：

### 可用的能力（无障碍桥 `~/bin/codex-bridge`，服务已连接、a11y=true，屏幕 1280×2772）

| 命令 | 实测 |
|---|---|
| `status` | 返回前台包名/Activity、屏幕尺寸 ✅ |
| `shot <png>` | 截图成功（1–3 MB） ✅ |
| `find <文字>` | 返回节点、`onScreen`、`bounds`、`center` ✅ |
| `tapText <文字>` | 找到并点击（返回坐标） ✅ |
| `swipe x1 y1 x2 y2` | 桌面翻页成功（我把 Edge 图标从 x=-1318 滑到可见） ✅ |
| `key home` / `key recents` | 有效 ✅ |

### 阻塞点：**够不到浏览器**

四种办法都试了，都没能把 Edge 拉到前台：

| 办法 | 结果 |
|---|---|
| `codex-bridge open com.microsoft.emmx` | `intent ignored (background activity start blocked)`（Android 10+ 限制后台启动 Activity）；且桌面 5 页里没找到名为 Edge 的图标 |
| `termux-open http://127.0.0.1:8899/` | 广播发出（rc=0），但**前台仍是 Termux**，浏览器没上来 |
| 桌面翻页 + 点 Edge 图标 | 点击成功（x=1091,y=1234），但前台变成 `com.android.systemui` |
| `key recents` + 点「Edge,**已加锁**」卡片 | 点击成功（x=1149,y=1440），前台仍是 `com.android.systemui` |

**最可能的原因**：recents 里那张卡片标注是「**已加锁**」——Android 要求在解锁状态下才能切到被锁定的任务，
而我这边的点击**无法完成解锁**。这解释了为什么四种办法都停在 systemui。

**结论**：桥的能力是够的，卡在**任务被锁定**这一步，属于需要用户一次性处理的事。

### 如果要让我能自测界面（对后续 P5/P6 的验证很有用）

1. 在 recents 里**取消那张 Edge 卡片的锁定**（或让它不要被锁）；
2. 把浏览器切到前台一次（之后保持屏幕不灭即可）。

这样我就能自己点按钮、截图、核对界面，不必每次让你替我看。

## E75 — 自测界面：一张截图换来两个真 bug【已修，最终确认未完成】

用户解锁后，我把浏览器切到前台并截图（`probe/ui-now.png` / `ui-after.png`）。**截图当场暴露两个真缺陷**：

### bug 1：队列按钮一直显示（我引入的）

发送键左边多出一个深色圆形列表图标——本该**只在回合运行中**出现。
原因：`hidden` 属性只被 UA 样式表的 `display:none` 兜底，而我的 `.send-button{display:grid}`
**优先级更高**，把 `hidden` 压掉了。经典陷阱。
**修**：`style.css` 加 `.queue-button[hidden]{display:none}`。**截图复核已消失** ✅

### bug 2：模式 chip 从来没出现过（我引入的 + 体检漏项）

composer 里只有 `任务 / 盾牌 / Flash 高`，**没有模式 chip**。两层原因：

1. 前端调用 `collaborationMode/list`，但**我忘了把它加进桥的白名单**——E70 的体检只比对了
   「白名单 vs 服务端」，**漏了「前端实际调用 vs 白名单」这一层**。已补进白名单；
2. 更隐蔽的一层：启动时的 `loadThreadSections()` / `loadCollaborationModes()` 都是**一次性调用**，
   桥重启那几秒内失败就**永不重试**，界面永久降级（日志里成片的
   `browser rpc failed: … -> Codex app-server is not connected` 就是证据）。已改为挂到
   **「桥已连接」事件**上，重连后自愈。

### 最终确认：**未完成**

修完后我尝试刷新页面复验，但**浏览器已退到后台**（前台是 `com.android.systemui`），刷新点击落在了别处
——证据是日志在我点击之后**没有新的页面活动**（最后写入仍是 17:15）。
所以「chip 现在是否显示」**仍未确认**。

**下一步**：等浏览器在前台时复验；并给体检脚本加一项「前端调用过的方法是否都在白名单里」
——这一项如果早有，bug 2 的第一层就不会发生。

## E76 — 补上体检的第三项检查，它立刻抓到两个我刚引入的 bug【已实测】

给 `probe/allowlist-audit.mjs` 加了第三项：**扫描前端源码里的 `rpc('…')` 调用，与白名单比对**。
（前两项分别是「白名单 vs 服务端」和「服务端有、白名单没有」。）

**首次运行就抓到：**

```
=== 前端调用但白名单没放行（会静默失败）===
（前端共调用 23 个方法）
  thread/queue/add   (app.js)
  thread/queue/list   (app.js)
```

也就是说，我刚做的**排队功能在浏览器里会静默失效**——前端调了、桥不放行，
和 E75 那个模式 chip 是**完全相同的毛病**，而且这次是**同一天内第二次犯**。

**修复**：两个方法加进白名单并重启桥。复跑：

```
[1/3] 白名单里的方法运行时都存在 ✅
=== 前端调用但白名单没放行 ===（无）
体检结论：白名单与服务端一致，且覆盖了前端所有调用 ✅   （退出码 0）
```

**这条检查的价值**：它把「前端调了但桥不放行」这类**静默失败**变成了一条命令就能查出来的事。
同一类错误当天犯两次，说明这不是偶然，而是缺检查——现在补上了，并建议**每次改动前端或白名单后都复跑**。

**同时暴露一个流程问题**：我加前端功能时只验证「协议能通」，没验证「桥放不放行」。
今后新接一个 RPC，三件事要一起做：白名单 + 前端调用 + 复跑体检。

## E77 — 自测浏览器 UI：能点到、能截图，但 chip 仍未出现（排查进行中）

用户解锁后复测。**确认我能操作浏览器**：`find` 返回的「刷新」节点属于
`com.microsoft.emmx`（`onScreen: true`，`id=com.microsoft.emmx:id/refresh_button`），
说明浏览器确实可见、点击也命中了。（系统 API 报的 `com.android.systemui` 是上层窗口，不代表页面不在前台。）

但模式 chip **仍不在可访问性树里**（`find "Default"` / `find "Plan"` / `find "对话模式"` 都 not found）。
逐一排除：

| 假设 | 结论 |
|---|---|
| 白名单没放行 `collaborationMode/list` | 已修，且 `/api/rpc` 直调正常 ✅ 排除 |
| 启动加载一次性失败后不重试 | 已改为挂在「桥已连接」事件上 ✅ 排除 |
| **浏览器缓存了旧 bundle** | 静态资源本来就带 `cache-control: no-store` → **不是缓存** ❌ 假设不成立 |
| 按钮不在 HTML 里 | 服务端发出的 HTML 与 `index.html` 都含 `collabModeButton` ✅ 排除 |
| CSS 把它默认隐藏 | `.composer-text-button` 是 `inline-flex`，我的 `[hidden]` 规则只在属性存在时生效 ✅ 排除 |

**结论**：chip 在 DOM 里、白名单也通了，但**没有被显示出来**——最可能是
`loadCollaborationModes()` 没跑到 / 跑到了但 `renderCollaborationModes()` 没把 `hidden` 摘掉。
**具体是哪一种，我现在看不到**。

### 根因是「我看不见前端」这件事本身

桥有观测日志，但只记录**浏览器 RPC 的失败**；**前端 JS 自己的异常与分支我完全看不到**
（`console.error` 落在我读不到的地方）。这次排查之所以慢，就是因为这个盲点。

**下一步（明确）**：给桥加一个极小的 `POST /api/client-log`，让前端把关键诊断写到桥日志里；
再让 `loadCollaborationModes()` 上报它的结果（拿到几个模式、是否渲染）。
有了这个，这类「界面元素没出现」的问题就能自己闭环，不必再猜。
**这属于开发期诊断设施**，用完可以关掉。

## E78 — 诊断通道已加，并且立刻把问题定位到「页面根本没重新加载」【已实测】

用户批准后加了 `POST /api/client-log`（开发期诊断，鉴权与其它接口一致，不落盘），
前端加 `clientLog()` 并上报三处：应用启动、模式列表加载结果、渲染时的隐藏状态。

**实测结果（关键）**：

| 检查 | 结果 |
|---|---|
| 端点自检（curl） | **204 且日志出现 `client: curl 自检`** ✅ 端点没问题 |
| 服务端发出的 bundle 是否最新 | 含 `app boot` ✅ |
| bundle 的响应头 | `cache-control: no-store` ✅ **不是缓存问题** |
| 页面是否上报过 `app boot` | **从未出现** ❌ |

**结论**：**浏览器页面根本没有重新加载**——它还在跑修改前的 bundle，
所以模式 chip 依旧不显示。我之前的两个修复（白名单、连接后自愈）**很可能是对的，但在浏览器里仍未证实**。

**为什么刷新没生效**：`find "刷新"` 能找到浏览器自己的刷新按钮（`id=com.microsoft.emmx:id/refresh_button`，
`onScreen: true`）且点击返回成功，但页面没有重新加载；改走地址栏也失败——
**地址栏的文字不对可访问性树暴露**（`find "127.0.0.1:8899"` not found），所以"清空并输入 URL"这条路走不通。
`key enter` 也返回 `{"ok":false,"action":"global"}`。

**这暴露了自测能力的边界**：能点、能滑、能读页内节点，但**无法可靠地让浏览器重新加载页面**。

**下一步（最快）**：请你在浏览器里**手动下拉刷新一次**（或在地址栏回车一次）。
之后我不需要你做别的——页面一加载，`app boot` 与模式列表的上报就会进桥日志，
我据此立刻能判定 chip 的问题在哪并修掉。

## E79 — 诊断通道第一次用：证实两个修复、抓到一个行为 bug，并推翻我自己的验证方法

用户手动刷新后，日志与截图同时给出答案。**先说最重要的：我前面基于 `find` 的判断是错的。**

### 纠正：`find` 查不到 composer 里的小 chip，所以「找不到」不能当证据

实测 `find "任务"`、`find "高"` —— 这两个 chip **在截图里明明可见**，但**同样 not found**。
也就是说 composer 里这排小 chip 的文字**根本不进入可访问性树**。

→ **E75 里「chip 不在可访问性树里 ⇒ 它没显示」这条推论不成立**；E77/E78 中据此展开的排除过程也失去意义。
`find` 只适合查**页面里的大块文本**（如会话正文），不能用来判断小控件的存在与否。

### 确诊：刷新后日志显示修复其实是**有效的**

```
client: app boot /
client: collab modes loaded: plan|default
client: renderMode: modes=2 current=plan
```

- `collab modes loaded` ⇒ **白名单补项 + 挂到「桥已连接」事件这两个修复都生效了**；
- `renderMode: modes=2` ⇒ 渲染分支确实执行、`hidden` 已被摘掉；
- 所以「chip 没显示」此前**主要是页面从未重新加载**造成的假象。

### 我为什么一直刷不动页面

截图显示前台是 **Termux**（连键盘都开着）。`find "刷新"` 能返回 Edge 的刷新按钮节点
（`id=com.microsoft.emmx:id/refresh_button`、`onScreen:true`），**因为背景窗口也在可访问性树里**；
但**点击落在前台——也就是 Termux 上**。所以我的刷新从头到尾点在了别处，
页面始终没重载，`app boot` 自然从未出现。**是我的操作方式错，不是产品错。**

→ 结论：**在浏览器不在前台时，我不能对它做任何操作**（点、输入都会被前台应用吃掉）。
以后要么请用户把浏览器切到前台并停留，要么请用户手动刷新。

### 诊断通道抓到真 bug：默认模式变成了 Plan（已修）

`current=plan` —— 我的默认值取的是**服务端返回的第一个模式**，而服务端把 **Plan 排在前面**，
于是默认落到 Plan；更糟的是 `collaborationModeParam()` 会把它**带上每一个 `turn/start`**，
即**用户那段时间发的每条消息都在 Plan 模式下执行**。

**已修**：默认固定取 `mode==='default'` 的那一项（找不到才退回第一个）。
这正是加诊断通道的价值——**纯靠"猜"是查不出这种静默行为偏差的**。

**仍未确认**：chip 在界面上的**视觉呈现**（需要一张前台为浏览器的截图）。
现有证据只到"渲染分支执行了、hidden 已摘掉"，**布局是否被挤掉仍未知**。

### 视觉确认（截图，本轮完成）

用户把浏览器切到前台后截图（`probe/ui-chip.png`），composer 实际渲染为：

```
[+] [任务 ▾] [🛡 ▾] [默认] [Flash 高 ▾] [🎤] [⬆]
```

| 项 | 结论 |
|---|---|
| **模式 chip** | **已显示**，文案「默认」 ✅ |
| 队列按钮 | **已隐藏**（回合未运行） ✅ |
| 默认模式 | 显示为「默认」而非「计划」 ⇒ 默认值修复生效 ✅ |

**顺带一个发现**：我在代码里写入的是服务端给的英文名 `Default`，界面上却显示「默认」——
说明上游有一套 **DOM 级 i18n 自动翻译**（`createDomI18n`）会把文本节点按词表替换。
这对以后加控件是好消息：**只要写英文原文，中文会自动跟上**（但也意味着我给的文案可能被意外替换，需留意）。

至此 E75/E76 里那两个 UI 缺陷**全部闭环**：队列按钮不再常显、模式 chip 正常出现且默认值正确。

## E80 — `project/*` 探明后，需要**修正我自己的"绕路"判断**【已实测】

P4 收尾第 1 项原本是「项目改用 `project/*`，替掉按 `cwd` 聚合的绕路」。探明接口后，这个判断要改：

| 调用 | 结果 |
|---|---|
| `project/list {}` | ✅ 返回 `{"data":[],"nextCursor":null}` —— **一个项目都没有** |
| `project/create {}` | `missing field 'name'` → 需要 `name`（多半还要 cwd/roots） |
| `project/read {}` | `missing field 'projectId'` |

**修正后的判断**：`project` 是**用户自定义的集合**，而不是 `cwd` 的替身。当前 `project/list` 为空，
如果我按原计划把侧栏改成"按项目分组"，结果会是**空的**——**比现在的按 cwd 分组更差**。

所以正确的做法不是"替换"，而是**叠加**：

1. `project/list` 非空时 → 按项目分组（并在项目上显示其目录）；
2. 为空时 → **保留现有的按 `cwd` 分组**（这是没有项目时的合理默认视图）；
3. 另外需要给用户一个**创建/指定项目**的入口（`project/create`），否则功能永远用不上。

**这属于设计判断，不是"改错"** —— 我把 E70 里那句"按 cwd 聚合是绕路"的说法收窄为：
「在有项目的场景下才是绕路；没有项目时它是对的默认」。

**尚未实现**：叠加逻辑与项目创建入口。**不打算在没想清楚交互前先写**，因为按原计划直接替换会立刻让侧栏变空。

## E81 — 项目 API 全生命周期验证 + 叠加分组已实现（体检第二次抓到同类漏项）

### `project/*` 的真实形状（全部用「报错即文档」问出来）

| 调用 | 形状 / 结果 |
|---|---|
| `project/list {}` | `{"data":[…],"nextCursor":null}` |
| `project/create {name}` | → `missing field 'roots'` |
| `project/create {name, roots:[{}]}` | → `roots` 要的是 **`ProjectRoot` 结构体**，缺 `path` |
| `project/create {name, roots:[{path}]}` | → `missing field 'idempotencyKey'` |
| **完整**：`project/create {name, roots:[{path}], idempotencyKey}` | ✅ 返回新项目（含 id/name/roots/metadata/position） |
| `project/delete {projectId, idempotencyKey}` | ✅ `{}` |

**全生命周期实测通过**：建 → 列（能看到）→ 删 → 列表回到空。
期间还观察到 **`project/changed` 通知**（说明界面可以据它实时刷新）。

> **顺带修正 E55 的说法**：那里我写「将来要支持安全重试，需要桥侧自建幂等键」——
> 其实**协议自带 `idempotencyKey`**（`project/create`、`project/delete` 都要求）。
> 所以正确做法是**用协议给的键**，而不是自己造。这条已记入待办（`turn/start` 上没有这个字段，
> 但写操作类接口普遍有）。

### 叠加分组已实现（patches/0028）

- `loadProjects()` 在连接时拉 `project/list`（空则 `state.projects=[]`）；
- 分组键：**有项目时用 `project:<id>`，没有时用原来的 `cwd`**——即 E80 说的叠加而非替换；
- 分组标题能把项目 id 解析成项目名。

### 体检第二次抓到同类漏项

我前端新调了 `project/list`，**又忘了加白名单**（这是第三次犯同类错误）。复跑体检立刻报出：

```
=== 前端调用但白名单没放行（会静默失败）===
  project/list   (app.js)
```

补进白名单后复跑：**体检全绿（退出码 0）**，八套单测也全过。

**这条检查现在的战绩**：上线以来抓到 `thread/queue/add`、`thread/queue/list`、`project/list`
三个「前端调了但桥不放行」的静默失败。**建议固化进日常流程**（改前端或白名单后必跑）。

### 仍未做

项目的**创建入口**（`project/create` 形状已完全掌握，需要一个"输入名称 + 用当前目录当 root"的交互）。

## E82 — 附件上传：`picker.showPicker()` 在安卓上「能弹不返回」【已定位，待真机复验】

浏览器端实现了附件（`patches/0029`），单测全过，但**真机不可用**。用开发期诊断通道逐层定位：

| 观察 | 结论 |
|---|---|
| curl 直打 `POST /api/uploads` | **HTTP 200**，返回 `{path,name,bytes,kind}` ⇒ **后端正常** |
| 用户选完图片后，日志里 `attachment ready` / `attachment failed` **都没有** | 文件**根本没进上传函数** |
| 加了诊断后：`attachment picker opened` ×2、**`attachment picked` ×0** | 选择器弹出了，但 **`onchange` 从未触发**（文件没回来） |

**两层原因**：

1. 输入框原先用 `picker.hidden=true`（`display:none`）— 安卓上这类输入框"能弹不返回"，已改为**放在布局内、移到屏幕外**（`position:fixed;left:-10000px`，透明）；
2. 我随后改用的 **`picker.showPicker()`** 在 Chrome/Android 上对 file input 同样有"能弹但不返回结果"的问题
   （`showPicker` 是较新 API，file input 这条路不成熟）。**已改回 `click()` + 屏幕外输入框**。

**用户提供的截图还暴露一个独立问题**：安卓选择器**只有「拍照 / 录像 / 照片和视频」三项，没有「文件」**——
即当前路径够不到本地文件。我们的 input **没有设置 `accept`**，按理应出现「文件」入口；
因此要么是 Chrome 走了相册选择器，要么需要**另设一个入口专门走文档选择器**。
这条**待附件链打通后再处理**（用户明确要求「本地文件上传也得做」）。

## E83 — 「重载为什么这么慢」：量过之后才动手【已实测，已优化】

先量化，不猜：

| 测量 | 结果 |
|---|---|
| `app.bundle.js` 传输 | 1,583,421 字节，**4.5 ms** |
| `thread/list`（侧栏） | 51 ms；带 `useStateDbOnly:true` → 29 ms |
| `/`、`/auth-bootstrap.js`、`/style.css`、`/api/auth/status`、`/api/config`、`/api/account` | 全部 **2–3 ms** |
| `/api/workspace/context`、`/api/folders` | 21 ms / 29 ms |

**结论：服务端不是瓶颈**（回环传输都是毫秒级）。慢在**浏览器端**：
**1.58 MB 未压缩的 JS 每次都要重新下载并重新解析**，而且静态资源带的是
`cache-control: no-store`（我为了"改完立刻生效"加的）→ **连缓存都用不上**。

### 已优化：静态资源 gzip

`app/server.ts` 的静态处理增加 gzip（按 `accept-encoding` 协商），
压缩结果按文件路径缓存（带大小校验，改文件即失效）：

| | 字节 | 耗时 |
|---|---|---|
| 原先（identity） | 1,583,361 | 3.9 ms |
| **现在（gzip）** | **337,925（-79%）** | 34 ms（首次含压缩，之后走缓存） |

### 还没查的两条（如实列出）

1. **无障碍服务本身的开销**：我用 `codex-bridge` 自测界面依赖 Android 的无障碍服务；
   它会让浏览器（Chrome/Edge）构建大得多的可访问性树，**对重内容页面有明显拖慢**。
   如果"重载变慢"是在启用该系统之后才明显，这一条很可能是主因之一。
   验证办法：临时关掉无障碍服务再对比一次加载时间。
2. **长会话的渲染量**：一次打开回合很多的会话时，DOM 规模会很大。

**未验证**：手机端的实际解析耗时，我这边量不到；-79% 是真实但**部分的**改善。

## E84 — 刷新慢的真正差异 + 附件选择器第三次尝试【已改，待复验】

### 用户的关键线索：「第一次进浏览器可以，之后刷新才慢」

这个差异本身就是答案：**刷新时应用会自动恢复上次打开的会话并渲染其全部历史**
（`localStorage` 里的 `ACTIVE_THREAD_STORAGE_KEY` → `openThread`），
而首次进入通常落在空的「新任务」页。所以慢的不是"加载"，是**恢复长会话并渲染**。

**已改**：把「恢复上次会话」**推迟到首屏绘制之后**（`setTimeout(...,0)`），
并加一条 `restoring remembered thread (deferred)` 上报，便于下次从日志确认顺序。
界面先出来，历史随后补上——体感会明显不同。

### 附件选择器：第三次尝试

前两次都不行，且都**不在视口内**：第一次用 `picker.hidden=true`（`display:none`），
第二次改到屏幕外（`left:-10000px`）。两者的共同点是**输入框没有真正参与布局**，
而安卓在这种情况下会"弹出选择器但不把结果交回来"（日志只出现 `picker opened`、没有 `picked`）。

第三次改为**留在视口内的 1×1 透明输入框**（`left/top:50%`、`opacity:0`、`z-index:-1`）。

**三条路的后备方案**：若这次仍不行，就用 **`<label for>`** —— 把「+」直接做成标签绑定输入框，
由浏览器**原生**触发选择（不经过 JS `click()`），这是安卓上最可靠的形态。

**另外**：本地文件入口待办**未变**——用户截图显示选择器只有「拍照/录像/照片和视频」，
没有「文件」；计划是**单独加一个文档入口**（`accept` 限定为非媒体类型以强制走文档选择器），
而不是指望同一个按钮兼顾两者。

## E85 — 附件上传的真根因：**HTML 里早有一个 hidden 的同 id 输入框**（我四次改动全被它吃掉）

用户的关键补充：「**刚开始不传图片能发文本；点过图片之后就什么也发不出去**」。

### 真根因（终于找到）

`index.html` 里**早已存在**：

```html
<input type="file" id="attachmentPicker" multiple hidden aria-hidden="true">
```

而 `openAttachmentPicker()` 的逻辑是 `document.getElementById('attachmentPicker')`，
**「没有才创建」**。于是：

1. `getElementById` 返回的是**文档里第一个** —— **那个 `hidden` 的**；
2. 所以代码里"没找到就创建一个"的**分支永远不会执行**；
3. **我三次改「把输入框放在哪」的改动，根本没有被用到** ——代码用的是那个 hidden 的；
4. 后来我改用 `<label for="attachmentPicker">`，**它同样指向那个 hidden 输入框**；
5. 并且我自己的补丁还**新增了第二个同 id 的元素**，造成 id 重复。

**安卓对 `display:none` 的 file input 就是"能弹不返回"** —— 与日志完全吻合
（`picker opened` 有、`picked` 从来没有）。**这解释了我前后四次尝试为何全部无效。**

### 修复

- **删掉**那个预先存在的 `hidden` 输入框；
- 保留我加的**带 `label for` 的静态输入框**（视口内 1×1、`opacity:0`），并**保证 id 唯一**；
- 同时补上用户要求的**独立本地文件入口**：`#filePicker`，`accept="application/*,text/*,.pdf,.md,.json,.csv,.zip,.apk"`
  —— 用非媒体类型**强制走文档选择器**，解决"只有拍照/录像/照片和视频、没有文件"的问题；
- `openAttachmentPicker()` 改为仅上报（JS `click()` 路径不再使用）。

**教训（值得记）**：`getElementById` + "没有才创建" 这种写法，会在**存在同名隐藏元素**时静默失效；
排查"元素行为不对"时，**先确认代码实际拿到的是哪一个元素**，而不是先怀疑自己的摆位方案。
我为此白改了三次。

---

## E82 — 附件（系统文件选择器 → 桥落盘 → 模型真的收到）【协议层 + 端到端已实测】

用户 2026-10-14 决策：**走系统文件选择器**，因此附件要经过桥中转（浏览器只给字节，不给路径）。

### 新增的形状

| 位置 | 形状 |
|---|---|
| 桥 | `POST /api/uploads {name, dataBase64}` → `{ok, path, name, bytes, kind}`；`kind` = `image`/`file` |
| 落盘 | `~/.codex/codex-webui/uploads/`，权限 0600；文件名净化后加时间戳 + 随机前缀 |
| 前端 | 图片 → `UserInput{type:"localImage", path}`；其它文件 → `UserInput{type:"mention", name, path}` |

**为什么落盘目录选在 `~/.codex/codex-webui/`**：`homeDir` 本来就是 `/api/images/local`
的允许根之一，上传的截图因此**不需要放宽任何路径白名单**就能在会话里渲染。

### 证据

```sh
node probe/upload-service.test.mjs        # 36 项断言 ALL PASS
BASE_URL=http://127.0.0.1:8893 node probe/p4-attachments.mjs    # ALL PASS
BRIDGE_URL=http://127.0.0.1:8893 node probe/p4-attachment-turn.mjs   # ALL PASS
```

单测覆盖：穿越文件名（`../../etc/passwd` → `passwd`、`..\..\tmp\x` → `x`）、控制字符、
中文名保留、超长名截断但保留扩展名、`data:` 前缀剥离、空/非 base64/超限拒绝（**解码前**就拦）、
同名不覆盖、0600 权限、过期清理与节流。

HTTP 探针覆盖：真实 PNG 往返字节一致 → **同一路径 `/api/images/local` 返回 200 `image/png`
且字节一致**（否则界面只能给破图）→ docx 走 `file` + 中文名可读 → 超限 400 且文案可读 →
非 base64/空载荷 400 → 穿越名仍落在上传目录内、`/tmp` 下没有写出文件。

### 最关键的一条：模型真的"看见"了图

`probe/p4-attachment-turn.mjs` 把一张真实截图（`probe/ui-chip.png`）经上传接口送进
`turn/start`，模型回答（原文）：

> 这是 Codex GUI 的新任务页：顶部是「新任务」标题栏和四个布局/信息图标，中间是云朵图标加
> 「我能帮你做些什么？」的欢迎语，底部是写着「交给 Codex 处理」的输入区（含加号、任务与权限
> 下拉、默认/Flash 高等选项、麦克风与发送按钮），最下方是浏览器地址栏 127.0.0.1:8899 与导航栏。

这不是"接口返回 200"级别的证据：它只可能来自图片内容本身。同时校验了
`thread/turns/list{itemsView:"full"}` 里那条用户消息**确实带着 `localImage{path}`**，
即刷新页面后附件仍在（不是只在乐观气泡里出现过）。

### 一个自己踩的坑（探针，不是产品）

探针第一版断言写的是 `part.type.includes("image")`，而线上类型是 **`localImage`**（大写 I），
于是把"历史里带着附件"误判成失败。界面侧用的是 `/image/i`，所以产品那一侧从一开始就是对的。
**教训**：对 wire 上的类型名做匹配要大小写不敏感，否则会自造一个假失败。

### 仍未做

**浏览器里的视觉验收**：`+` 按钮弹出系统选择器、chip 出现、发送后气泡里显示图片——这一条
需要先重启一次桥（新路由才存在）；而当前这个会话就跑在那台桥的 app-server 上，所以留给用户
决定重启时机。在重启之前，这一项只能算"代码 + 接口 + 协议三层已验证，界面未亲眼看"。

## E83 — 临时实例会**改掉用户的启动器**（已实测，已修）

为了不碰用户正在用的桥（本会话就跑在它的 app-server 上，重启等于自杀），端到端测试起了
第二个实例：`PORT=8893`（其 app-server 在 8895）。跑完发现：

```
~/bin/codex-gui 的 sha256 从 93a4c609… 变成 e79a77e5…
其中 URL 从 127.0.0.1:8899/8901 变成了 127.0.0.1:8893/8895
```

原因：`installLauncherScript()` 无条件写 `~/bin/codex-gui`，模板里带着**当前实例的端口**。
即"起一个测试实例"会**静默改掉用户日常敲 `codex-gui` 时接入的实例**。

**已修**：启动器只由默认端口（未设置 `PORT`）那个实例安装，测试实例不再插手。

**已恢复**：按 `app/server.ts` 的模板重新生成（port=8899、token 路径、`ws://127.0.0.1:8901/`），
sha256 与改动前**逐字节一致**（`93a4c609e9689451fd1feadcecfbb72b75af58e300746cafe8e99d3201834ad8`）。

**顺带记录**：第二个实例启动后约 **30 秒**才 `ready`——因为第一个实例留下的 app-server 还占着
8895（日志原文 `port 8895 is held by another app-server that this bridge could not adopt`），
新实例先杀掉它再重试。这与 E71 的"抖动"是同一类现象，但这次是**预期行为**（端口被自己的旧实例占住）。

## E84 — 体检加了第 4 项：前端引用的 `/api` 路由是否存在（含自检）

E75/E76/E81 三次都是"前端调了、桥不认"的**静默失败**。RPC 方向已有体检（第三项），但 HTTP
路由这一层没有——而附件功能正是新增了一个 `POST /api/uploads`，同类风险照旧存在。

新增第 4 项：扫前端（含 `index.html`）里出现的所有 `/api/...` 路径，与 `server.ts` 里的
`url.pathname === "..."` 比对。

**并且给它加了自检**：拿一段伪造的前端文本（含一个必然不存在的 `/api/definitely-not-a-route`）
喂给同一个函数，必须恰好抓出那一个。**一个从没见过它失败的检查不算检查**——这条自检就是为了
让这个断言本身可验证。

当前结果：

```
[1/4] 白名单里的方法运行时都存在 ✅
（前端共调用 24 个方法）    （无）
[4/4] 自检：这个检查能抓到不存在的端点 ✅
（前端共引用 15 个 /api 路径）  （无）
```

---

## E86 — 「页面根本没跑起来」的两个真根因（已定位、已修、已实测恢复）

这一条取代了前面所有关于**缓存/旧 bundle** 的推测。E82–E85 假设"浏览器执行了旧代码"，
**假设本身是错的**：浏览器一直在执行当次下载的代码，是代码在模块求值阶段就崩了。

### 症状

- 页面能刷出来、静态标记（发送框、`+` / 文件按钮）都在，但**发消息、传附件全部无反应**；
- 刷新有时很慢（`dcl=21782ms`）、有时"刷不出页面"；
- 桥日志里 `static /app.bundle.js …` 每次都证明文件被重新取过，但**只有** `collab modes FAILED`，
  没有 `app boot`、没有 `build:`。

### 根因 A：一行 `null.onclick = …` 让整个 bundle 在求值阶段中断

`patches/0029` 保留了上游的接线句
`document.querySelector('[data-composer-control="add"]').onclick=…`，
但 `+` 控件后来被换成两个 `<label for=…>`（安卓上唯一可靠的选择器触发方式），
**属性随旧按钮一起没了** → 查询结果为 `null` → `TypeError: Cannot set properties of null (setting 'onclick')`
→ 模块求值终止。

该接线块（`app.js:548-549`）在 `clientLog("app boot …")`（`app.js:886`）**之前**，
所以表现就是：静态页面在、JS 全死。**`<label for>` 渲染不需要 JS，所以用户仍能看到"文件按钮"**，
这也是此前误判"前端已经加载了新代码"的原因。

日志原文（加了 beacon 之后才拿到）：

```
[codex-webui] client: bootstrap start build=(none) ua=… EdgA/153.0.0.0
[codex-webui] client: bundle import FAILED: Cannot set properties of null (setting 'onclick')
[codex-webui] client: bootstrap FAILED: Cannot set properties of null (setting 'onclick')
```

**修**：`patches/0030-fix-composer-wiring.mjs`（幂等）把两处接线改成
`const el=…; if(el) el.onclick=…`，并在文件末尾追加一行**启动指纹**
`clientLog('bundle evaluated to end; controls wired, attachments bound')`
——以后"bundle 是否跑到结尾"从日志一眼可判。

### 根因 B：文档请求被当成 cross-site，走「登录墙」分支且**不带构建戳**

从外部应用打开页面（`termux-open-url`、通知、别的 App 的链接）时，
浏览器给**顶层文档**请求带 `Sec-Fetch-Site: cross-site`，
而 `isRequestAuthorized()` 第一条就拒它；HTML 于是走"未授权也能拿到的登录资源"分支
（直接 `readFileSync` 原样返回，**没有 `?v=`、没有 `<meta name="codex-build">`、也没有访问日志**）。
子资源（css/js）是 `same-origin`，因此正常授权、正常打日志——这就是"同一个页面里
HTML 没有构建戳、JS 有"的原因。

```
[codex-webui] doc /?probe=1791978282 authorized=false dest=document site=cross-site ua=… EdgA/153
[codex-webui] auth-wall / 32971B stamped
```

**修**：抽出 `stampIndexHtml()`，两个分支都注入 `?v=<build>` + `codex-build` meta + 内联 beacon；
顶层文档的授权结果、`sec-fetch-site`、UA 都进日志。

### 修好之后的完整启动指纹（同一次真机加载，日志摘录）

```
doc /?probe=… authorized=false dest=document site=cross-site
auth-wall / 32971B stamped
client: html-boot build=1791978446080
client: bootstrap start build=1791978446080 ua=… EdgA/153.0.0.0
client: app boot /
client: bundle evaluated to end; controls wired, attachments bound
client: attachment inputs bound: 2
client: restored local state: codex-webui-model=deepseek-flash | codex-webui-project=/data/data/com.termux/files/home | …
client: bundle import ok build=1791978446080
client: build: 1791978446080
client: timing: nav dcl=232ms load=240ms; firstPaintAt=361ms; domNodes=840
client: timing: loadInitial 271ms
```

`dcl` 从 **21782ms → 232ms**（同一台手机、同一个浏览器、同一份 1.58MB bundle）。
顺带确认：`loadInitial` 一直是 270–306ms，**桥和协议从来不是慢的原因**。

### 新增护栏：`probe/dom-contract-audit.mjs`

扫描 `app/public/*.js` 里所有 `$('#id')` / `getElementById` / `querySelector('#id')` /
`querySelector('[data-…="…"]')`，与 `index.html` 的 `id=` / `data-*` 对照：

- 有声明 → ok；
- JS 自己创建（`.id='…'`）→ ok（`queueTray` / `modelSubmenuButton` / `modelMenuBack`）；
- `?.` 或 `const el=…; if(el)` → ok（记 `optional`）；
- 其余（**立刻 `.` 解引用**）→ FAIL，退出码 1。

**自检（反向对照）**：把修好的 `if(addControl)` 改回裸解引用后重新跑，必须 FAIL——

```
MISSING  [data-composer-control=add] referenced by app.js but never declared
FAIL — a null lookup here aborts the bundle at module evaluation (E86)
negative-control rc=1 (expected 1)
```

### 仍然未验证

- **手机上的文件选择器 → `change` 事件**：`attachment inputs bound: 2` 只证明监听器挂上了；
  真机点一次后应出现 `attachment picked (attachmentPicker): 1 file(s)` → `attachment ready: …`。
  这一条需要用户在手机上点一次（我无法自动化系统选择器）。
- `collab modes FAILED: Bridge transport changed` 在首连时仍出现一次（随后自愈、模式正常加载），
  属连接首帧竞态，**未定位**。

---

## E87 — **根因 C：你在浏览器里用页面时，Termux 进程被系统冻结了**（已实测定量）

这一条解释了 E86 之后剩下的全部「慢 / 无反应 / 拒绝连接」：**不是代码慢，是桥那段时间根本没在跑。**

### 怎么发现的

E86 让每条前端日志带上自己的时间戳（客户端 `at`），桥把到达时间与它相减打印成 `+Δms`。
一次真机加载里出现：

```
[codex-webui] event loop blocked for ~54194ms
[codex-webui] client: +130229ms transport switched to sse
[codex-webui] client: +129368ms visibility: hidden
[codex-webui] client: +54401ms visibility: visible
[codex-webui] client: +25760ms visibility: visible
```

浏览器**发出**这些消息到桥**收到**之间隔了 25–130 秒，且延迟在递减（典型的"解冻后排队涌出"）。
再往前翻日志，桥自己的心跳检测报过 `event loop blocked for ~569229ms`、`~6660028ms`（≈1.85 小时）。
1.85 小时不是"代码卡住"，只有一种解释：进程被挂起。

### 定量 A/B（同一台手机、同一个会话，60 分钟内）

| 条件 | 测量 | 结果 |
|---|---|---|
| 浏览器在后台上，**不持唤醒锁** | 2 秒采样器跑 50 秒 | 29 拍，**0 丢拍**（正常） |
| **把浏览器切到前台**，不持唤醒锁 | `sleep 45` | 实际 **585 秒**（漂移 +540s）；桥的日志随后涌入几十秒前的请求 |
| **把浏览器切到前台**，`termux-wake-lock` | `sleep 40` | 实际 **40 秒**（漂移 0s）；2 秒采样器 28 拍，**0 丢拍** |

结论：**只要你在前台用这个网页，HyperOS 就会冻结整个 Termux 应用**（连我在 Termux 里的 shell 也被冻结——
上面那条 `sleep 45 → 585s` 就是我自己的 shell 被测出来的）。唤醒锁能完全消除该现象。

### 为什么之前一直没看出来

1. 冻结不产生任何日志、任何错误，`pgrep` 也照常能查到进程；
2. 解冻后所有排队请求会**成批**涌出，日志看上去只是"顺序有点乱"，不像故障；
3. 我自己的命令同样被冻结，于是"测量工具"和"被测对象"一起停摆。

### 已做的应对

1. `~/bin/codex-gui-web`：`start` 成功后取 `termux-wake-lock`，`stop` 时 `termux-wake-unlock`（成对，脚本头部写清了代价：
   通知栏会多一条 Termux 的通知，这是 Android 的机制）。不想要就 `termux-wake-unlock`，代价是回到上表第二行。
2. 每次启动不再无条件重建前端 bundle（见下），启动时间 8–13s → **5s**，并且不再出现 `event loop blocked for ~8329ms`。
3. 前端：每条日志带 `pid/at/vis/transport`；`visibilitychange / pagehide / freeze / resume` 全部上报；
   WS 上的 RPC 超过 20s 直接判超时并切 SSE（半死 socket 之前会**永远**不回，把发送闸门卡死 45 秒）；
   上传立即显示「（上传中…）」占位 chip，并逐步上报 `upload start / read / http 200`；
   提交闸门吞掉发送时会弹出提示（原来什么都不显示）；打开会话在 `thread/read{includeTurns}` 失败时回退到
   `thread/resume`（有些线程这个 app-server build 会答 `list_turns is not supported yet`，界面就会显示空会话）。

### 仍未验证

- 冻结期间浏览器侧的 `fetch` 什么时候被判失败（Chrome 自己的超时），因此"上传请求会不会在冻结中被丢弃"
  仍要看一次真机点击：期望 `attachment picked` → `upload start` → `upload http 200` → `attachment ready`。

---

## E88 — 真机点击附件：**上传其实到了，响应被冻结吃掉；而"发送"是因为文本框为空被静默忽略**

用户 2026-10-15 02:5x 的实测：「图片出现在发送框里，显示上传中。我又点了发送，没有发出去。」

### 日志证据（同一页面 `a7ynww2`，全部带 `pid/at/vis/transport`）

```
client: +7790ms upload read in 46ms                              ← 本地读文件成功（206KB jpg）
client: +23102ms upload start: 3467.jpg (206370 bytes, image/jpeg) ← 之前那一轮的同一动作
client: +6127ms submit: entered
client: +6132ms submit: finished in 0ms (gate released)          ← 空文本，直接 return
[codex-webui] event loop blocked for ~43252ms                    ← 这 43 秒就是"上传中"卡住的真正原因
```

上传目录（服务器侧）说明**请求体和落盘都是成功的**，失败的是响应回程：

```
-rw------- 206370 Oct 15 02:54 …185400-586b92eb-3467.jpg
-rw------- 206370 Oct 15 02:55 …185559-39327ae5-3467.jpg
-rw------- 206370 Oct 15 02:56 …185619-466c5e82-3467.jpg
```

即：**图片上传成功（桥已落盘），只是响应在冻结期间耗尽/被浏览器判失败**（旧标签页那条是
`attachment failed: 3467.jpg -> Failed to fetch`），于是 chip 永远停在「（上传中…）」。

### 第二个 bug：附件在、文本为空时，发送被静默丢弃

`submitPromptInner` 的 `if(!text)return;` 在**文本框为空**时直接返回，哪怕 composer 里已经有附件。
日志里的 `submit: finished in 0ms (gate released)` 就是这个分支；界面上表现为"点了发送没有任何反应"。

### 协议层验证：只有图片、没有文字的回合是合法的（已实测）

```
$ node probe/raw-rpc.mjs thread/start '{"cwd":"/data/data/com.termux/files/home","model":"deepseek-flash"}'
  → threadId 01a13bc5-e987-7342-b585-14fde9904c21
$ node probe/raw-rpc.mjs turn/start '{"threadId":"01a13bc5-…","input":[{"type":"localImage","path":"…/uploads/20261014185619-466c5e82-3467.jpg"}],"model":"deepseek-flash"}'
  → {"turn":{"id":"01a13bc5-f153-…","status":"inProgress", …}}      ← 接受，无 serde 报错
```

对应 rollout 里模型确实拿到了图片：`<image name=[Image #1] path=…>`。

### 修复（patches/0032）

1. **允许"只有附件没有文字"的发送**：四处出站 `input` 与乐观气泡改用 `textPart(text)`，
   文本为空时就不生成 `{type:'text'}` 这一段；
2. 文本为空但**还有附件在上传**时给出提示（`Still uploading — wait a moment.`），不再静默 return；
3. 上传加 **45 秒超时 + 一次自动重试**（`AbortController`），失败才落 `attachment failed` ——
   chip 不会再永远停在「（上传中…）」。

### 尚未消除的环境因素

同一次尝试里仍有 `event loop blocked for ~43252ms`：唤醒锁挡住了"浏览器前台"那一档，
但**熄屏/Doze 仍会冻结**（见 E87），需要把 Termux 的省电策略设为「无限制」。
另外当时浏览器里有 **6 个仍然活着的旧标签页**（`u2c749i/obm7b0l/t2px63r/9w9hwvm/k4dtdk4/a7ynww2`），
每个都在轮询，会额外增加负载——建议只留一个。

---

## E89 — **附件从来没进过消息**：快照顺序写反（浏览器侧会话定位，终端侧复核并修复）

E88 修的是"点了发送没反应"；这一条是更根上的：**即使发送成功，附件也没有进消息**。

### 代码事实（`app/public/app.js` 的 `submitPromptInner`）

```js
const mentions=state.composerMentions,attachments=state.composerAttachments;  // ① 快照
input.value='';state.composerMentions=[];state.composerAttachments=[];        // ② 清空
…
input:[...textPart(text),...attachmentInputs()]                               // ③ 读的是②之后的空数组
```

`attachmentInputs()` 读的就是 `state.composerAttachments`，第②步已经把它清空，于是每次发送都
**只带上文字**；快照 `attachments` 只被用于出错回滚。表现：chip 消失、文件留在磁盘、模型只收到 `user.text`。

### 会话记录里的证据（用户 02:59 那一轮）

```
exported/sent user items: user:input_text,input_text | user:input_text
                          ^^^^^^^^^^^^^^^^^^^^^^^^^ 只有文本，没有任何 mention/localImage
```

而同一时刻桥的日志是 `upload: …m.pdf (43246 bytes, file)` + `client: attachment ready: …`——
**字节落盘了，路径没进消息**。

### 这条 bug 的直接代价：27 条终端命令

用户问"为什么看一个 PDF 要跑这么多次终端指令"。同一份会话记录里 27 次调用，其中约 20 次是模型
**在找那个被丢掉的附件**：翻 `MEMORY.md` 的收件箱约定、列 `~/codex-inbox`、翻 `/sdcard/Download`、
按修改时间 `find` 最近文件、列 `~/.codex/codex-webui/uploads`、`tail` 桥日志、
`grep 28dfcbed5 bridge.log`、最后靠 `find … -newermt` 才定位到那张 PDF；剩下几步才是真正读 PDF
（先 `view_image` 试了一下、再抽文本到 `~/tmp/pdfx/out.txt` 后 `sed -n 1,200p`）。

**所以那串命令不是 GUI 在刷指令，是模型在为前端丢数据买单。** 修好之后附件以
`mention{name,path}`（图片是 `localImage{path}`）随消息一起送出去，模型不需要再找文件。

### 修复与护栏

- `patches/0033-send-the-snapshot-not-the-cleared-state.mjs`：`attachmentInputs(list=…)` /
  `attachmentContent(list=…)` 接收要编码的列表，四处出站 `input` 与乐观气泡改传**快照** `attachments`。
- 新增 `probe/attachment-payload-audit.mjs`：静态检查"出站 payload 必须来自快照"，
  并且**自带反向自检**（把快照换回裸调用后必须报 4 处 FAIL，实测 rc=1）。
- 协议侧真实风险已确认：`turn/start` 只带 `localImage` 无文本是合法的（E88 实测）。

### 两条操作事实（避免无谓中断）

1. **改前端不需要重启桥。** 静态文件是逐个请求 `readFileSync` 的，`app.bundle.js` 落后于
   `public/*.js` 时只有**桥启动那一刻**才会重建（0031 的跳过逻辑）；改完重新 `bun build` 之后，
   浏览器刷新即可生效（实测：重建后 `curl /app.bundle.js` 立刻是新版，桥的 pid 没变）。
   重启桥会打断正在跑的会话，因此**不要**为了前端改动去重启它。
2. **不要用字面串去断言 bundle。** bun 会把调用点的变量名重命名（本次 `attachments` → `attachments2`），
   所以断言要打在源码上（如上面的 audit），或在 bundle 里用容错正则。

---

## E90 — 上传失败截图（03:08）：文件其实**落了两次盘**，报错文案是引擎术语

用户截图显示：`上传失败: campus-network-auto-login-main.zip — signal is aborted without reason`，
会话正文停在 `Loading conversation…`。日志（页面 `h2t3fzs`）还原：

```
client: attachment picked (filePicker): 1 file(s)
client: upload start: campus-network-auto-login-main.zip (20830 bytes, application/zip)
client: upload read in 34ms
upload: …zip (20830 bytes, file) -> …/uploads/20261014190557-75f735b0-….zip      ← 第一次已落盘
event loop blocked for ~50389ms                                                   ← 50 秒冻结
client: +50555ms rpc TIMEOUT after 20000ms: thread/list
client: +50561ms upload retry: …zip (signal is aborted without reason after 119031ms)
upload: …zip (20830 bytes, file) -> …/uploads/20261014190842-4c3d2c0c-….zip      ← 重试也落盘
event loop blocked for ~1447522ms                                                 ← 同一窗口里还有 24 分钟的设备休眠
```

结论：**上传本身没问题**（两次都成功落盘），是响应回程被冻结吃掉；`submit: SKIPPED — gate busy`
说明用户又点了几次发送。会话正文卡在 `Loading conversation…` 是同一个冻结打的（历史加载的 RPC 一起超时）。

### 修复（patches/0034）

1. 失败文案从引擎术语换成能指导行动的句子：
   `桥没有响应（手机可能休眠了），会自动重试一次`（`AbortError / timeout / Failed to fetch` 统一映射）；
2. 失败时记住那个 `File`（不复制 base64），**页面重新可见时自动重试一次**——设备醒来的时刻正是该重试的时刻；
3. 历史加载失败写一条 `history load FAILED for <threadId>: …`，不再只留下一个转圈占位。

### 仍未消除的环境因素（重要）

这次 50 秒冻结发生时**唤醒锁是持有的**（桥从 22:23 起未重启）。也就是说：
唤醒锁挡住了"浏览器在前台、App 被冻结"那一档（E87 实测），但**拦不住熄屏/Doze**——
同一窗口里还有一次 `event loop blocked for ~1447522ms`（24 分钟）和 +1491868ms 的消息延迟。
不把 Termux 放进电池白名单，就还会出现这种几十秒到几十分钟的空窗；`/proc` 与 `pgrep` 看不出来。

---

## E91 — 上传进度条画在文件 chip 自己的背景上（用户要求的功能，已实现）

需求原话：「给上传加一个进度条吧，就在文件的背景上」。

### 为什么不能用假动画

`fetch()` **没有**上传进度事件，做成"一直在转"的动画等于假数据。改用
`XMLHttpRequest`：`xhr.upload.onprogress` 给出真实字节比例（body 是我们自己拼的 JSON，
`content-length` 必然是已知的，所以 `lengthComputable` 为真）。返回对象套了一层
`{ok,status,json()}` 外壳，调用点无需改动。

### 三个阶段（都是真实状态，不是装饰）

| 阶段 | chip 上的显示 | 来源 |
|---|---|---|
| 读取 | `（读取中…）` | `FileReader` 还没读完 |
| 上传 | 背景填充条 + `42%` | `upload.onprogress`（真实字节） |
| 等待 | 满格 + `等待桥响应…` | 字节发完、桥还没回（E90 里出问题的正是这一段） |

配套：待上传的 chip 用虚线边框区分；进度条是 chip 的背景层
（`.composer-context-fill`，`position:absolute` + chip `overflow:hidden` 贴合圆角）；
进度用**原地更新**（`updateAttachmentProgress`）——整块 tray 重渲染会在用户编辑时抖掉其他 chip。

### 护栏

`probe/upload-progress-contract.mjs`：检查「markup 有 fill/phase 层 + CSS 真的把 fill 定位了 +
传输用 XHR 且 progress 接到了 chip 上」，并带反向自检（把 `.composer-context-fill` 的定位规则去掉后必须 FAIL）。
这一条专门防"进度条写了但看不见"——CSS 缺失时 JS 完全正常、界面毫无反馈。

---

## E92 — 「上传瞬间完成，等桥响应很久」= 等的是冻结，不是桥（已量化）

用户反馈：进度条一闪即满，然后长时间停在「等待桥响应…」。这正是进度条想暴露的东西。

### 三段实测（用户 03:39 的那张 199809 字节照片）

| 环节 | 耗时 | 出处 |
|---|---|---|
| 客户端读文件 | 52 ms | `client: upload read in 52ms` |
| **等桥响应** | **12718 ms** | `client: upload http 200 in 12718ms` |
| 桥被挂起 | 27045 ms | `event loop blocked for ~27045ms`（同一窗口） |

### 同样的请求从 Termux 直接打，只要几毫秒

把**同一个文件**的 266453 字节 JSON body 用 curl 连打三次：

```
attempt 1: http 200 total 0.007867s
attempt 2: http 200 total 0.005502s
attempt 3: http 200 total 0.015800s
```

即：**桥醒着的时候，这条请求 5–16 ms 就结束了**。12.7 秒不是服务器处理慢，
是这十几秒里整个 Termux 进程没有被系统调度（E87/E90）。

### 修复（patches/0036）

「等待桥响应…」后面开始**数秒**（每 500ms 刷新：`等待桥响应… 12s`），
响应/失败/超时/中止四条路径都会停表。一个在动的数字和"卡死的 App"是两种体验，
而且它同时回答了"它是不是还活着"和"已经等了多久"。

### 结论（不可绕过的部分）

字节本地传输 50ms 级；只要 Termux 处于被系统冻结/休眠的状态，**任何**请求都要等它醒来。
前端能做的只有把这段等待说清楚（已做），以及醒来自动重试（0034）。真正的解法仍然是
电池白名单，或 P9 的前台服务。

---

## E93 — 自己发的图片在聊天框里不显示（已修，含真形渲染测试）

用户 03:44 反馈并截图：**模型能准确描述照片内容，但自己的气泡里看不到那张图**。

### 原因（两处，互相叠加）

用户消息的渲染只有一行：

```js
if(item.type==='userMessage')el.querySelector('.user-message').textContent=textFromInput(item.content);
```

1. `textFromInput` 只认 `x.type==='text'`，而**服务端回声的形状是 `input_text`**
   （见 rollout：`{input_text:"<image name=[Image #1] path=\"…3403.jpg\">"}` +
   `{input_image: "data:image/jpeg;base64,…"}`）→ 带图的消息渲染成**空气泡**；
2. 乐观气泡用的是 `localImage{path}`，同样没人管 → 只剩文字，图静默丢掉。

模型侧一直是好的：rollout 里 `<image name=[Image #1] path=…>` 与 `input_image` 都在。

### 修复（patches/0037）

- `textFromInput` 同时接受 `text` / `input_text`，并**剔除服务端注入的 `<image …>` 标记**
  （它不进正文，也不进"乐观气泡↔回声"配对用的文本）；
- 新增 `renderUserMessage`：正文用转义文本，图片用 `renderImagePreview`（复用既有的全屏查看器），
  以 `dataset.renderKey` 做缓存，避免每次 upsert 都重建 DOM、打掉正在加载的缩略图；
- 图片来源优先级：**路径 > 内联 data URL**——路径走 `/api/images/local`（几字节），
  data URL 是整张图进 DOM；两者都存在时只画路径那张，避免同一张图画两遍；
- 非图片附件（如 PDF 的 `mention{path}`）用 `isImageReference` 挡掉，不会渲染成破图。

### 验证：`probe/user-message-image.test.mjs`（8 项，含自检）

把 `app.js` 里真实的 `textFromInput` / `userMessageImageSources` / `userMessageHtml` 取出来，
配 `rendering.js` 真实的 `isImageReference` / `renderImagePreview`，跑四种真实形状：

```
ok  optimistic image renders a thumbnail
ok  optimistic image keeps the caption
ok  echoed image renders from the path, not the base64     ← 不吃 200KB base64
ok  the raw marker never leaks into the bubble
ok  a non-image attachment is not rendered as an image
ok  plain text still renders
ok  an attachment without a caption still shows something
ok  self-check: with no image detection the thumbnail disappears
ALL PASS
```

---

## E94 — 「新对话里发文件发不出去」：两件事叠在一起（都已修）

用户 03:55 反馈。日志里**整条链路其实是成功的**（`upload http 200` → `attachment ready: …(2).pdf`
→ `submit` → `thread/start` → `turn/start`），但新线程的 rollout 里只有一句：

```
USER: ["input_text:这个能看到吗"]        ← 没有任何 mention{path} / localImage
```

### 根因 A：发送时附件**还在上传**，附件被静默丢掉

用户打完字就按了发送，此刻 composer 快照里只有**占位 chip**，而 `attachmentInputs()` 会过滤
`pending`（0031 加的），于是消息发了出去、文件没跟上、而且一句话都没说。同一段日志里的
`submit: finished in 15191ms` 是叠在上面的冻结。

**修（patches/0039）**：快照里有 pending 时就**等它们传完**（上限 60s，弹提示「正在等待附件上传完成…」，
chip 自己的进度条同时在动），再把 `attachmentsForSend(snapshot)`（快照 ∪ 之后完成的，去重、去掉占位）
放进 `input`。

### 根因 B：新对话要等 `thread/start` 回来才画气泡

`submitPromptInner` 的顺序是 `await rpc('thread/start')` → 清空会话区 → **然后**才
`upsertItem(optimistic)`。新对话里 `thread/start` 撞上冻结要 15 秒，于是：输入框已清空、
屏幕全白、什么都没发生——用户看到的就是"发不出去"。**已有对话里 `state.active` 早就在了，
气泡先画**，所以同一个操作在新旧对话里表现不同。

**修（patches/0038）**：气泡在 `thread/start` **之前**画；`thread/start` 之后不再 `innerHTML=''`
（那会把刚画的气泡一起抹掉），改为只移除占位状态节点，必要时把气泡补回去。

### 验证

- `probe/attachments-for-send.test.mjs`：占位不上路 / 快照里已完成的要上路 / **发送后才传完的也要上路** /
  去重后保序 / 仍在传的跳过——**这个测试当场抓出了我第一版的重复 bug**（快照内部重复没有去重）。
- `probe/attachment-payload-audit.mjs` 相应放宽为"接受快照或快照合并体"，负向对照仍然 rc=1。

---

## E95 — 04:06 截图：5KB 的 .md 等了 42 秒（等待期间页面自己的计时器也被冻住）

截图里 chip 显示 `宝石分类实验汇… 等待桥响应… 20s`（进度条已满格、虚线边框），
这正是 E91 设计的状态——它现在**如实显示**了等待。日志同一时刻：

```
event loop blocked for ~336097ms      ← 5.6 分钟
client: +29244ms upload read in 21ms
upload: 宝石分类实验汇总记录表.md (4620 bytes, file) -> …/uploads/20261014200626-aa443f58-….md
client: +11ms upload http 200 in 41930ms        ← 4.6KB 文件，回执等了 41.9 秒
client: +14ms attachment ready: …md (4620 bytes, file) in 41931ms
event loop blocked for ~41606ms、~12702ms、~18700ms
```

### 新发现：设备挂起时**页面自己的计时器也停**

这解释了一个之前想不通的点：我给上传加了 45 秒超时 + 自动重试（0032/0034），
但 41.9 秒的等待里它们并没有"提前救场"——因为挂起的是**整台设备的 App CPU**，
浏览器的 `setTimeout` 同样被推迟。所以"设备睡着时，双方的安全网都失效"。

### 修复（patches/0040）：只在**等待期间**持有屏幕唤醒锁

`navigator.wakeLock.request('screen')`：上传在途或提交在途时持有，等待结束立即释放，
页面隐藏时浏览器自动释放、回到前台若仍在等待则重新获取。
好处是精准覆盖"睡着会出事"的那段窗口，空闲时零代价（屏幕照常自动熄灭）。
日志里会有 `screen wake lock held (N wait(s))` / `bridge wait begin (upload), 1 active`。

**边界（必须说清）**：屏幕唤醒锁挡的是"设备自动进入 Doze"，挡不住用户主动熄屏，
也挡不住 HyperOS 对后台应用的强制冻结。若这次仍不见效，就说明属于后两者，
那只有电池白名单或 P9 的前台服务能解决。

---

## E96 — **我自己引入的回归**：发送全线崩在 TDZ 上（已修 + 加护栏）

用户反馈"现在我发一个文件需要等很长时间桥响应"。日志里同时看到两件事：

```
client: +12937ms bridge wait begin (upload), 1 active [w2jzi9i]
client: +12947ms screen wake lock held (1 wait(s)) [w2jzi9i]        ← 0040 生效
upload: PLAN.md (24264 bytes, file) -> …/uploads/20261015151154-de6ec53c-PLAN.md
client: +5ms upload http 200 in 13100ms                            ← 13.1s（此前同类是 42s）
client: +7ms attachment ready: PLAN.md (24264 bytes, file) in 13102ms
…
client: +3283ms submit CRASHED: Cannot access 'attachments2' before initialization
  @ at submitPromptInner (app.bundle.js?v=1792077082973:39602:25)   ← 每一次发送都当场死掉
client: +1831ms submit CRASHED: Cannot access 'attachments2' before initialization
```

### 原因（我的错）

0039 为了"等附件传完再发"，把等待块插在了
`const mentions=…,attachments=state.composerAttachments;` **之前**，
而块里用了 `attachments.filter(...)`。`const` 有 TDZ，于是 `submitPromptInner` 每次都在第一行就抛异常，
**一条消息都发不出去**。日志里 `submit CRASHED` 是我之前特意加的上报，这次救了自己。

### 修复

那一处改读 `state.composerAttachments`（快照是紧随其后的几行才取的，中间没有任何东西会改动它），
于是**不再依赖声明顺序**，而不是"把顺序摆对"。bundle 侧已核对：`const pendingAtSend = state.composerAttachments.filter(…)`
在前、重命名后的 `attachments2` 在后。

### 护栏（这次的教训）

`probe/attachment-payload-audit.mjs` 增加一条**顺序检查**：在 `submitPromptInner` 内部，
任何对快照（`attachments.xxx` / `attachmentInputs(attachments…)`）的使用都必须晚于它的声明。
负向对照：把那行改回 `attachments.filter(...)` → 必须 FAIL（实测 rc=1）。
之所以值得单列：TDZ 是**运行期**错误，打包和此前所有静态检查都过得去——
这次是"补丁过了全部自检，却在真机上让发送全挂"，护栏必须覆盖"顺序"这一维。

---

## E97 — 23:15 那一轮：**没有崩溃，但消息根本没发出去**（判断顺序写反，已修）

日志（页面 `mttrw3p`）：

```
screen wake lock held (1 wait(s))                     ← 0040 生效
upload: PATCHES.md (27214 bytes, file) -> …/uploads/20261015151503-d0bfe104-PATCHES.md
client: +26508ms bridge wait begin (upload), 1 active
client: +37ms upload http 200 in 26535ms              ← 26.5 秒（冻结）
client: +36ms attachment ready: PATCHES.md (27214 bytes, file) in 26536ms
event loop blocked for ~17970ms
client: +12417ms submit: finished in 4736ms (gate released)
```

**关键点：整个窗口里没有任何 `browser rpc >> turn/start` / `turn/steer`** ——
消息压根没发出去，但闸门报"正常结束"（因为 0ms 就早退了，4.7s 是跨过冻结的墙钟时间）。

### 原因：判断在"等待"之前

```js
if(!text&&!hasContext){ … toast('还在上传中') … return }      // ★ 空文本 + 附件仍在传 → 直接 return
…
const pendingAtSend=…; if(pendingAtSend.length){ … 等它们传完 … }   // 0039 加的等待，在这之后 → 永远不会执行
```

用户没打字、只挂了附件就按发送 → 那一刻 `hasContext` 为 false（附件还是占位）→ 早退，
**而"等待附件"这段被放在早退之后**，所以对"空文本"这一路完全没生效。
表现就是：按了发送没反应，要等传完再按一次。

### 修复（patches/0041）

顺序改为：**中断判断 → 模型判断 → 等附件传完 → 再判断可不可以发 → 取快照 → 清空 → 发送**。
因为快照现在取在"等完之后"，`attachmentsForSend()` 的合并只是兜底。

护栏：`probe/attachment-payload-audit.mjs` 增加"等待块必须早于 hasContext 判断"的顺序检查，
负向对照实测 FAIL。

### 本轮其它测量（都属于环境）

同一会话内：`event loop blocked` 分别为 26.5s / 12.4s / 7.2s；页面加载 `dcl=11531ms`、
`firstPaintAt=28913ms`、`domNodes=1846`。即设备本身在冻结与负载之间反复，代码侧已无异常上报。

---

## E98 — 23:20 「还是在等待桥响应」：**同刻实测桥 2.9 毫秒**，等待全在传不到的那一段

在用户页面还在等待的时候，从 Termux 直接打同一份文件（27880 字节的 PATCHES.md，36324 字节请求体）：

```
health 0.002870s
upload 27KB -> http 200 in 0.002940s
```

**2.9 毫秒。** 而同一时刻浏览器侧：`+5053ms`、`+36706ms`、`+52885ms`、`+33272ms` 的到达延迟，
以及桥自己报的 `event loop blocked for ~21299ms / ~24287ms / ~63292ms / ~42849ms`。
日志里这样的挂起累计 **73 次**，最近的量级是 15.7s / 21.3s / 24.3s / 42.8s / 63.3s。

### 关键否证：两侧唤醒锁都持有，挂起照旧

- Termux 侧：`codex-gui-web start` 取的 `termux-wake-lock`（本次 23:10:58 重启后重新取过）；
- 页面侧：0040 的 `screen wake lock held (1 wait(s))`。

两者都在，21–63 秒的挂起依然发生 → **不是（或不只是）Doze**，更像 HyperOS 在浏览器位于前台时
对后台应用做的强制冻结。这一条是本次最确定的结论：前端再无手段可施。

### 顺带发现：桥在 23:10:58 被重启过（pid 29102 → 9361）

重启会打断正在跑的回合，也会重置唤醒锁。若那是浏览器侧会话自己做的，值得知道代价。

### 新增（patches/0042）：等待超过 8 秒就说清原因

页面在等待超过 8 秒时，用中文提示一次：
「等待桥响应已超过 8 秒：Termux 很可能被系统挂起了。把 Termux 的省电策略设成「无限制」就能改善。」
日志同时写 `bridge wait exceeded 8s — the app is probably suspended`。
它不缩短等待，只是把"莫名其妙地卡"变成"明确地告诉你卡在哪里、怎么改"。

---

## E99 — 用户纠偏：省电策略**一直是「无限制」**；真正的开关是 `termux-wake-lock`

用户指出 E98 的建议是错的（那条建议我给了三次）。于是重新做对照实验，
**结果指向唤醒锁，而不是省电策略**：

### 对照实验（就在刚才，浏览器在前台）

| 条件 | 测量 | 结果 |
|---|---|---|
| 刚补过 `termux-wake-lock`，浏览器切前台 | `sleep 80` + 2 秒采样器 | **漂移 0s，采样 42/42 拍，桥 0 次挂起上报** |
| 23:10–23:20（23:10:58 重启之后） | 桥自己的心跳 | **73 次挂起**，最近量级 15.7s / 21.3s / 24.3s / 42.8s / **63.3s** |

时间线对得很齐：**23:10:58 桥被重启**。`codex-gui-web stop` 会 `termux-wake-unlock`，
新实例要靠 `cmd_start` 里那句 `termux-wake-lock` 重新取——**那句失败了只会往 stderr 打一行警告**，
没人看就等于静默丢失。之后所有挂起都发生在这一窗口。

补回唤醒锁之后：日志里最后一次挂起在第 6298 行，而实验窗口是 6384→6687 行，**其间 0 次**。

### 结论（写进 HANDOFF）

- 省电策略「无限制」**不是**充分条件（用户实测一直是它）；
- `termux-wake-lock` 是必要条件，而且它会在**桥重启时被释放**；
- 长时段（例如整夜熄屏）仍可能被挂起（历史上出现过一次 24 分钟），这一档只有 P9 的前台服务能解；
- 因此加看门狗（下一条）把"锁在不在"这件事从"靠运气"变成"每 15 分钟自愈"。

### 新增：看门狗（`~/bin/codex-gui-watchdog` + `termux-job-scheduler` Job 4711）

每 15 分钟（`--period-ms 900000 --persisted true`）做两件幂等的事：
① `termux-wake-lock`（失败会记日志）；② `/api/health` 的 `ready` 不为真就 `codex-gui-web start`。
它自己写 `~/.codex/codex-webui/watchdog.log`（自动截断到 200 行）。
卸载：`termux-job-scheduler --cancel-all` 或 `--cancel --job-id 4711`。

---

## E100 — 挂起与"没人在动手机"强相关（修正 E99 的单一归因）

E99 把挂起全归给"唤醒锁丢了"，但随后的数据不支持单一归因：**唤醒锁与省电策略「无限制」都在**，
23:30–23:37 仍然出现：

```
[codex-webui] event loop blocked for ~158222ms   ← 2.6 分钟
[codex-webui] event loop blocked for ~167694ms   ← 2.8 分钟
[codex-webui] event loop blocked for ~230164ms   ← 3.8 分钟
[codex-webui] event loop blocked for ~5263ms
```

同一时间窗里我自己的命令也被拖慢（`codex-gui-web start` 一次跑了 ~170 秒），
而**我主动操作手机的那几段**（`sleep 45`、`sleep 80` + 2 秒采样器）漂移全是 0。

### 结论：真正的相关变量是"屏幕是否熄灭"

被挂起的不是"后台的 Termux"本身，而是**没人动手机时设备进入的睡眠**：
HyperOS 在这种状态下连持唤醒锁的进程一起挂起（省电策略已是最宽松的一档）。
这也解释了最能气人的那种现象——**消息发出去了，你盯着页面等回答、手不动屏幕，
屏幕超时熄灭 → 设备睡着 → 流式输出断在半路**，回来就是"加载不出来"。

### 修复（patches/0043）

屏幕唤醒锁从"只在请求在途时持有"改成**只要页面可见就持有**，页面隐藏（切走/熄屏/关标签）立即释放
（浏览器自己也会释放）。代价说清楚：**你看着这个页面时屏幕不会自动熄灭**；离开页面即恢复。
日志里会写 `screen wake lock held (page visible)`。

### 与 E99 的关系

E99 那条（唤醒锁在桥重启时被静默释放、需要看门狗）依然成立且已修；
E100 补上的是第二条独立成因。**两条都要同时成立才不会卡**：锁要在，屏幕也不能睡。

---

## E101 — P9 起步：**可安装的 APK（M1）已构建**，并带上 WebUI 做不到的那一件保活

用户 2026-10-16 00:1x 决策：**APK 工作提前到现在**，之后每次迭代重新产出一个 APK 供其在应用内测试。

### 产物

```
~/android-build/codexgui/build/codexgui-<version>-<yyyymmdd-HHMMSS>.apk      （已签名）
/sdcard/Download/codex-gui/codexgui-<version>-<yyyymmdd-HHMMSS>.apk         （点击安装）
```

`dev.termux.codexgui`，minSdk 30 / targetSdk 35，自签名（复用既有 debug.keystore，SHA-1 `195d5ef0…`）。
构建走**既有手工流水线**（aapt → javac --release 11 → d8 → zip → apksigner），本机没有 Gradle/AGP：

```
sh ~/android-build/codexgui/build.sh --install
```

`versionCode` **每次构建自动 +1**（Android 只认更高的 versionCode，这样才能"盖"上去更新），
文件名带秒级时间戳，便于区分迭代。

### M1 做了什么

| 能力 | 说明 |
|---|---|
| WebView 壳 | 深色主题、启动页（"正在启动桥… 3s"）、目标 `http://127.0.0.1:8899` |
| **打开即用** | 启动时检查 `/api/health` 的 `ready`；不为真就通过 Termux 的 `RUN_COMMAND` 执行 `codex-gui-web start`，最多等 40 秒 |
| 失败可操作 | 超时/加载失败给明确面板：重试、打开 Termux、**缺 `Run command` 权限时另有"打开本应用设置"按钮** |
| 前台服务 + 置顶通知 | `dataSync` 类型；通知带「重新加载」「重启桥」两个动作；服务每 60 秒检查桥并自动拉起（比 job-scheduler 的 15 分钟快一个数量级） |
| **设备级 PARTIAL_WAKE_LOCK** | 这是 WebUI 形态做不到的事：E100 实测屏幕熄灭后整台设备会睡、连持锁的 Termux 一起挂起。前台服务应用拿的锁不会被当成"缓存应用的锁"忽略，且 10 分钟自动续期 |
| 文件选择 | `onShowFileChooser` 接系统选择器（附件用得到） |
| 返回键 | 走 WebView 历史（页面自己用 history 管抽屉/弹层，E86） |

### 还没做（后续迭代）

- 拍照/录像入口（需要 FileProvider + `ACTION_IMAGE_CAPTURE`）；
- 把「回合完成 / 等待审批」做成原生通知（PLAN 里已决策：APK 阶段通知由应用自己发）；
- 深链（点通知直达某会话/审批）、分享入口、edge-to-edge 安全区细化；
- 首次配置引导页面（目前是失败面板里给指引）。

### 运行依赖（不变）

APK 不含 Codex 运行时：仍需 Termux + `~/bin/codex-gui-web` + `allow-external-apps=true`，
并且**用户手动授予一次** `com.termux.permission.RUN_COMMAND`（应用会检测并在失败面板明确提示）。

### 顺带发现

CodexBridge（无障碍）当前**没有在运行**：`codex-bridge ensure` 提示需要在
设置 → 无障碍 → 已下载的应用 里手动重新开启。要我用 a11y 驱动应用界面做自测，需要先把它打开。

---

## E102 — 应用内首测：**整个页面在 WebView 里死掉**（`Notification is not defined`）+ 安全区被压

用户 2026-10-16 00:26 装机首测，两张截图 + 桥日志一起定位到两个问题。

### 主因：WebView 里 `Notification` 不存在 → bundle 求值即崩

```
client: bundle import FAILED: Notification is not defined claimed-build=1792077058462
client: bootstrap FAILED: Notification is not defined claimed-build=1792077058462
（同一个 UA：Mozilla/5.0 (Linux; Android 16; 2602BRT18C …; wv) …）
```

`syncTaskNotifySettings()` 里那句 `Notification.permission` 没有任何存在性检查，
而它被顶层接线块调用，且 localStorage 里 `codex-webui-task-notify=true` 让 `&&` 不会短路 →
模块求值抛异常 → **页面只剩静态标记**。这解释了截图里的全部现象：

- 模型 chip 一直写着「正在加载…」；
- 空状态显示「我能帮你做些什么？」——
  这两句其实都来自 `i18n.js`，是 `auth-bootstrap.js`（在 bundle **之前**执行）把静态 HTML 翻译过来的，
  动态部分一个都没跑起来。

**修（patches/0044）**：新增 `notificationSupported()`，四处调用点统一；并加静态自检
（不允许再出现裸的 `Notification.permission`）。

**护栏**：新增 `probe/webview-compat-audit.mjs` —— 逐行检查 WebView 里不存在/可能不存在的 API
（`Notification`、`navigator.sendBeacon`、`navigator.wakeLock`、File System Access、`navigator.share`）
是否都在守卫之内（守卫允许在同一行或紧邻前两行）。它当场又抓出一处 `navigator.wakeLock` 的"疑似裸用"，
核对后确认守卫在前一行。

### 次因：targetSdk 35 的强制 edge-to-edge 把输入区压到手势条下面

截图里输入区底行与手势条重叠。原因是 targetSdk 35 起系统强制 edge-to-edge，
而 `env(safe-area-inset-*)` 在 WebView 里恒为 0，壳又没补安全区。

**修**：`MainActivity` 在根布局上 `setOnApplyWindowInsetsListener`，
把 `systemBars | displayCutout` 与 `ime` 的边距取最大值作为 padding（键盘弹出时输入区自动抬起）。
新 APK：`codexgui-0.1.0-20261016-002808.apk`（versionCode 自增）。

### 自测能力的边界（重要）

用户授权我"控制手机自测"，但两条通道都不通：

- CodexBridge（无障碍）**没在运行**（`/ping` 无响应，`codex-bridge ensure` 需要用户手动去设置里开启）；
- `termux-am` 报 `Could not connect to socket: No such file or directory`（Termux 的 am 套接字不可用），
  所以连"打开无障碍设置页"这种辅助动作也做不了。

目前只能：`termux-open`（可拉起安装器/打开链接）+ 读桥日志 + 静态体检。
要真正点应用界面，需要用户重新开启一次 CodexBridge。

---

## E103 — **`mention` 到不了模型**：文件的真正断点（已在桥侧兜住）

应用内首测（E102 修完之后）我直接驱动界面发了一条"只有附件、没有文字"的消息，
模型回答：**"我这边准备好了，但这一轮没有收到具体任务——消息里只有环境上下文和工作约定。"**

### 证据：回合里的用户消息是**空的**

```
USER: [{"t":"input_text","s":"# AGENTS.md instructions …"},{"t":"input_text","s":"<environment_context>…"}]
USER: []                     ← 第二次发送：一个内容片段都没有
```

对照实验（raw-rpc，绕开前端）：向新线程 `turn/start { input:[{type:"mention",name,path}] }`
→ 返回成功，rollout 里用户消息同样是 `[]`。

而 `localImage` 是好的（E88：会变成 `input_text` 标记 + `input_image`）。
所以问题是：**`mention` 是这套 app-server 接受的变体（错误信息里列了
`text | image | localImage | audio | localAudio | skill | mention`），但它不会进入模型上下文。**

这也顺带解释了 E89 那 27 条命令：模型根本没拿到路径，只能自己翻目录找文件。

### 修复：桥侧显式兼容层（`rewriteMentionsForModel`）

非图片附件在桥里改写成一行文本：`附件（本地路径，可直接读取）：<abs path>`。
模型有文件读取工具，拿到路径即可工作；会话记录里也能看到实际发出去的内容（不偷偷改）。

验证（同一条 raw-rpc 路径 + 经桥的 HTTP RPC）：

```
USER: [{"t":"input_text","s":"附件（本地路径，可直接读取）：/data/data/…/2026…pdf"}]
```

**这是对当前后端能力的显式兼容**，不是"协议兼容"的声称：该 build 真正支持 mention 时，这一层要删掉。

---

## E104 — 保活手段全上齐，**仍然发生 5.2 分钟挂起**（对 E99/E100 的重要修正）

驱动应用界面时（点"文件"按钮拉系统选择器）实测到：

```
[codex-webui] event loop blocked for ~314793ms          ← 5.2 分钟
client: +314553ms visibility: hidden [q8kk1xx …]        ← 浏览器的消息晚了 5.2 分钟才到桥
（同一时刻我的 `codex-bridge shot` 卡了 315 秒；选择器界面自己也只是黑屏 + 转圈）
```

此时**下列手段全部在位**：

| 手段 | 状态 |
|---|---|
| Termux 省电策略「无限制」 | 用户确认一直是 |
| `termux-wake-lock`（含看门狗每 15 分钟续） | 在位（watchdog.log: `wake-lock ok`） |
| 页面 `navigator.wakeLock('screen')`（页面可见期间） | 在位（`screen wake lock held (page visible)`） |
| APK 前台服务（`dataSync`）+ 置顶通知 | 在位 |
| APK 侧 `PARTIAL_WAKE_LOCK`（10 分钟续期） | 在位 |

**结论**：这些都是必要条件，但在这台设备上**不是充分条件**。HyperOS 仍会在某些窗口
（本次是"应用退到后台、系统选择器刚起来"）把整套进程挂起数分钟。我此前把成因归给
单一变量（先唤醒锁、后屏幕），都不完整——如实记录，并停止在前端继续追这一条。

**对用户的实际影响**：任何依赖"后台进程还能被调度"的交互都可能突然停几分钟；
这不是代码可以修的，需要在系统层把应用放进真正的白名单（用户已做无限制，未见效），
或接受这种偶发停顿。

---

## E105 — 应用启动"转圈 30 秒"的真因：启动检查太急 + 拿不到启动权，且我远程看不见

用户报告"启动桥用了 30 秒还没起来"。查桥日志（当时桥**已经**在运行）：

```
--- 2026-10-16 00:50:10 start ---            ← 桥在跑，health 一直 ready
client: bootstrap start build=1792083010974 ua=…; wv)   ← 应用页面确实加载了两次
```

即：桥本来就 ready，**是应用的启动检查自己放弃了**——`isReady()` 单次调用只有 1.2 秒超时，
撞上 E104 那种十几秒的挂起窗口就会判成"没起来"，接着发一条"请 Termux 启动桥"的意图
（桥已在跑时这一步是多余的；而且若 `com.termux.permission.RUN_COMMAND` 没授予，
这个意图会被静默忽略）。等 40 秒超时给出失败面板；之后设备解冻、桥应答，页面才加载成功。

### 三个结构性改进（APK 侧）

1. 启动等待 40 秒 → **90 秒**，并把每一步显示出来：
   「正在启动桥… 12s（桥已监听，正在等 app-server）」/「（还在等 Termux 执行启动命令）」；
2. 端口已开但未 ready 时**不再叠加 start**（那是桥自己在起 app-server）；
3. **把启动判断写进桥日志**：`apk: boot: port=… ready=… termux=… runCommand=granted|denied`。
   从此我能在 Termux 这侧诊断应用的启动过程，不必靠截图——应用按钮点不出来的问题也能定位。

### 一个操作限制（如实记录）

`termux-open <apk>` 在当前状态下**拉不起安装器**（前台是 Termux，Android 阻止"后台启动 Activity"；
第一次装机成功是因为用户自己在文件管理器里点的）。所以"每次迭代自动装包"这条我还做不到，
需要用户点一次安装。

### 第 3 条改进当场起了作用（结论）：**`runCommand=denied`**

用户随后装上了带日志的版本，桥日志里立刻出现：

```
[codex-webui] client: apk: boot: port=open ready=true termux=true runCommand=denied
[codex-webui] client: apk: boot: already ready, loading page
[codex-webui] client: apk: boot: port=open ready=false termux=true runCommand=denied
[codex-webui] client: apk: boot: port open but not ready yet, waiting for the app-server
[codex-webui] client: apk: boot: ready after 16s, loading page        ← 新逻辑按设计工作
```

**根因确认**：应用没有 `com.termux.permission.RUN_COMMAND`（denied）→
"桥没在跑时让 Termux 启动桥"这条路径**根本不可能成功**，Termux 会静默忽略该意图；
用户看到的就是等到超时的转圈。这是**一次性授权**能解决的问题，不是代码问题。

顺带验证了两件事：① 新的"端口开着就只等、不叠 start"逻辑正确（16 秒后 ready）；
② "把启动判断写进桥日志"这个决定当场兑现——不用截图，Termux 这侧直接读到了原因。

新增（`-010533`）：权限缺失时在页面顶部常驻一条**可点的提示条**（点击跳本应用设置页），
给完权限回来即消失——静默失败变成可见可操作。

### 版本号策略（用户 2026-10-16 要求："下次迭代记得修改 apk 版本号"）

已自动化为构建脚本的一部分（`build.sh`）：每次构建 `versionCode` 与 `versionName` 补丁位同时自增
（`8/0.1.0` → `9/0.1.1`），产物名 `codexgui-<versionName>-<yyyymmdd-HHMMSS>.apk`。

**并且让用户能自己确认装的是哪一版**（否则每次都要靠问）：

| 位置 | 显示 |
|---|---|
| 前台服务通知标题 | `Codex 0.1.1` |
| 启动页（等待桥时） | `正在启动桥… 3s（…） v0.1.1` |
| 应用信息页 | 系统自带 versionName |

---

## E106 — 应用里"选了图但什么都没发生"：**ClipData vs getData** + 选择结果完全静默（已复现并修）

用户报告"现在还不能传图片"。我用无障碍控制应用自己复现：

1. 点 composer 左侧的 `+`（图片入口）→ **HyperOS 的「安全访问」图片选择器正常弹出**（不是没反应）；
2. 点一张照片的勾选框 → 点「确认」→ 选择器关闭；
3. 桥日志里**没有** `attachment picked (attachmentPicker)`；前台回到 Termux；
4. `ps` 里 **Codex 应用进程已经不存在**（选完图之后应用直接没了）。

对照：同一次会话里走**文档**入口（`filePicker`）完全正常——`upload http 200 in 84ms`
（顺便证明 APK 的前台服务 + 唤醒锁确实把冻结压住了，之前同类操作要 20–42 秒）。

### 两个问题

| 问题 | 说明 |
|---|---|
| 结果拿不到 | HyperOS 的图片选择器把选中项放在 `ClipData` 里，而 AOSP 的 `FileChooserParams.parseResult()` **只读 `getData()`** → 返回 null → WebView 收不到文件、`change` 不触发。这与浏览器里 E82–E87 那一串"能弹不返回"是同一类，只是这次在壳里 |
| 彻底静默 + 应用消失 | 既没有日志也没有崩溃信息，我只能靠 `ps` 反推"进程没了" |

### 修复（0.1.2 / versionCode 10）

1. `deliverFileChooserResult()`：自己解析结果——先 `ClipData`（多选），再 `getData()`（单选），
   并把 `resultCode / clip 数 / data 有无 / uris 数` **写进桥日志**；
2. `fileCallback.onReceiveValue()` 包 try/catch，异常写日志；
3. 安装**未捕获异常上报**（`reportSync`）：闪退时把异常类名 + 消息 + 前 4 帧栈写进桥日志。
   从此应用崩溃在 Termux 这侧可见，不再需要"请你描述一下当时发生了什么"。

---

## E107 — 图片选择**修好了**（截图为证）；剩下的失败是冻结；顺带解决"自动弹安装界面"

用户 01:13 的截图里两条关键信息：

1. **顶部黄色提示条**（我上一轮加的）正常显示：
   「缺 Termux「Run command」权限：桥没在跑时应用无法自动拉起它。点这里去授予。」
   → 与 `apk: boot: … runCommand=denied` 一致，权限确实是缺的。
2. **Toast**：`上传失败: 3470.jpg — 桥没有响应（手机可能休眠了），会自动重试一次`

第 2 条其实说明**图片选择已经修好**：文件带着自己的名字（3470.jpg）走到了页面的上传逻辑里
——这正是 E106 的 ClipData 修复要解决的问题。失败发生在**上传阶段**：查同一时刻的桥日志，
挂起为 26.1s / 16.4s / 27.0s / **37.8s**，45 秒超时预算被吃掉，于是判超时并按 0034 的设计报错+待重试。

### 自动弹安装界面：根因是"必须先让 Termux 在前台"

最初几次我 `termux-open <apk>` 之后屏幕毫无变化，查前台包名始终是 `com.termux` ——
Android 的"后台启动 Activity"限制把安装器意图忽略了。一旦**先把 Termux 拉到前台**
（`codex-bridge open com.termux`）再执行，安装器立刻出现（截图可见
「Codex / 版本：0.1.2 -> 0.1.3 / 安装来源：Termux」），点「继续更新」后对话框变成「完成 / 打开」。

**这条打通后，"每次迭代我自己装包"成为可自动化的一步**（流程写进 HANDOFF 1.5）。

另外 0.1.3 起，服务每 60 秒把自身状态（版本 / ready / 唤醒锁是否握上）在状态变化时写进桥日志
（`apk: service: v0.1.3 ready=true wakeLock=true fg=true`）——"前台服务到底还在不在"
这件事以前只能猜。

---

## E108 — 桥又拉不起来（截图自证）+ **让权限变成不必要**，而不是去点设置

用户 01:16 截图：桥没在跑，应用停在
`正在启动桥… 81s（还在等 Termux 执行启动命令） v0.1.3`
——这行字正是 0.1.3 加的"说出在等什么"，所以不用猜就知道：**应用请求了 Termux，Termux 没执行**，
也就是 `RUN_COMMAND` 权限缺失那条路（日志里 `runCommand=denied` 一致）。

### 处理方式：改通道，而不是去点授权

用户说"你帮我搞定权限"。我选择了**让这个权限变得不必要**：

Termux 除了 `RUN_COMMAND`，还有一条**不需要任何权限**的入口——"分享文本给 Termux"会执行
`~/bin/termux-url-opener <payload>`。于是：

1. `~/bin/termux-url-opener` 增加两个**完全等值匹配**的字面量分支
   （`codex-gui://start` / `codex-gui://restart` → 调 `codex-gui-web start|restart`）。
   **绝不把 payload 拼进命令**——那是命令注入面，所以只做字面量判断；
2. APK 侧 `BridgeClient.startBridge()` 改为**先走分享通道**（`ACTION_SEND` + `setPackage("com.termux")`），
   `RUN_COMMAND` 仅作退路；
3. 0.1.5 起，原来那条"缺 Run command 权限"的常驻提示**删掉**（已过时且会误导），
   只有"根本没装 Termux"时才提示。

Termux 侧已验证：`bin/termux-url-opener 'codex-gui://start'` 会打印/写入桥的启动输出并返回
（当时桥已在跑，输出 `已经在跑（pid 14897）`）。

### 自动安装仍然不稳定（如实记录）

同一套顺序（Termux 到前台 → `termux-open <apk>` → 点「继续更新」）在 01:14 成功过一次
（0.1.2→0.1.3，对话框走到「完成 / 打开」），但随后的几次有的弹出 Termux 自己的
"Save file in ~/downloads/" 对话框、有的干脆没反应（前台仍是 `com.termux`）。
**结论：能自动装但不保证**，所以每次迭代仍以"把 APK 放好 + 让用户点一次"为兜底。

---

## E109 — 「打开 Codex 会自动跳转 Termux」：分享通道是"可见入口"，我选错了优先级

用户 01:2x 的问题。原因就是 E108 那次的改动：`ACTION_SEND` 给 Termux 在 Android 上
**必须拉起 Termux 的 Activity**，所以界面被切走。安静的那条（`RUN_COMMAND`）走的是
`startService`、完全不打扰界面，但需要那条权限——而用户没授予。

于是流程变成：打开 Codex → 健康检查没 ready（可能正撞上冻结）→ 发分享 → **Termux 弹到前台**。
通知栏里也能看到同一时刻应用自己的状态是 `Codex 0.1.5 / 正在启动桥…`。

### 修复（0.1.6）

1. `BridgeClient.startBridge()` 优先级反转：**有权限就走 `RUN_COMMAND`（安静、不跳转）**，
   没有权限才用分享，并且**界面提前说明**：
   「桥没在运行，正在请 Termux 启动它——会短暂切到 Termux（授予 Run command 权限后不再跳转）」；
2. 失败面板增加按钮「授予 Termux『Run command』权限」→ 直达本应用的应用信息页；
3. `restartBridge()`（通知上的"重启桥"）走同一套优先级。

### 我为什么没能替用户点完授权

三条通道都不可用，如实记录：

| 通道 | 实测结果 |
|---|---|
| 无障碍桥 `open com.android.settings` | `intent ignored (background activity start blocked); icon '设置' not found in 5 pages` |
| `termux-am` | `Could not connect to socket: No such file or directory` |
| 通知栏里的设置齿轮 | 当前 HyperOS 通知面板里没有该入口（只有勿扰铃铛） |

所以"授予 `com.termux.permission.RUN_COMMAND`"这件事**必须用户点三下**：
设置 → 应用 → 应用管理 → Codex → 权限 → 其他权限 → 打开「Run command」。
0.1.6 的按钮能把用户直接送到该页，剩下的是两下（权限 → 开关）。

### 自动安装再记一笔

这次安装器对话框确实弹出来了（`Codex, 版本：从0.1.5更新到0.1.6`），
但被 **Termux 自己的 "Save file in ~/downloads/" 对话框**盖住，取消它之后安装器也一起消失。
即"能弹出、不稳定"。

---

## E110 — adb 在 Codex 会话里起不来：**Codex CLI 自己的 libc++ 把系统的遮住了**

为了用 `adb shell pm grant` 直授权限（用户选择这条路），先要修 Termux 里坏掉的 adb：

```
CANNOT LINK EXECUTABLE "adb": cannot locate symbol "_ZNSt6__ndk113__hash_memoryEPKvm"
```

排查（都不是猜测，逐条验证过）：

| 检查 | 结果 |
|---|---|
| 符号在不在 `$PREFIX/lib/libc++_shared.so` | **在**（`nm -D --defined-only` 有 `_ZNSt6__ndk113__hash_memoryEPKvm`） |
| adb 是否确实需要它 | 需要（`nm -D --undefined-only bin/adb` 显示 `U`） |
| adb 的 RUNPATH | `$PREFIX/lib` ✓，而且 `ldd` 该目录下也没别的 libc++ |
| 会话环境里的 `LD_LIBRARY_PATH` | **`/data/data/com.termux/files/usr/lib/node_modules/@mmmbuto/codex-cli-termux/bin`** ——Codex CLI 加的 |
| 那个目录里有什么 | **一个 1.25MB 的 `libc++_shared.so`，`grep hash_memory` = 0（没有该符号）** |

**根因**：链接器按 `LD_LIBRARY_PATH` 顺序先找到 Codex CLI 自带的旧 libc++，于是 adb 缺符号直接死。

**这不只影响 adb**：任何"在 Codex 会话里跑、又依赖较新 libc++ 符号"的 Termux 二进制都会中招
（在普通 Termux 里手动跑同样命令却是好的）——排查这类"我的会话里不行、你自己跑就行"的怪现象时先看这一条。

**修法**：`~/bin/adb` wrapper，把自己的 lib 目录**前置**（不是追加）：

```sh
export LD_LIBRARY_PATH="/data/data/com.termux/files/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec /data/data/com.termux/files/usr/bin/adb "$@"
```

验证：`adb version` 正常输出，daemon 能起 ✓。

### 还差最后一步：无线调试没开

```
adb connect 127.0.0.1:38443  → Connection refused
adb connect 127.0.0.1:5555   → Connection refused
adb mdns services            → mdns is not supported by this version of adb
```

即当前没有可连的调试端口，且本版 adb 不支持 mDNS 自动发现。需要用户打开
**开发者选项 → 无线调试** 并把端口（页面上 `IP 地址和端口` 那行）告诉我。
打通之后一次解决三件事：`pm grant` 授权、`am start` 拉应用信息页、以及 **`adb install -r` 稳定装包**
（替换掉现在这个时灵时不灵的 termux-open 流程）。

---

## E111 — adb 打通 → **权限已授予** → 端到端验证"应用自己安静启动桥"（无跳转）

用户打开无线调试后，`adb mdns services` 在本版不可用，于是**扫回环端口**找 adbd：

```
scanned 35536 ports in 17.9s
open: 38037 43795 52938

adb connect 127.0.0.1:38037  → connected
adb devices                  → 127.0.0.1:38037  device  model:2602BRT18C
```

（另两个端口连不上或 offline，38037 即无线调试端口。无需重新配对——Termux 的 adb 密钥已被信任。）

### 授权

```
adb -s 127.0.0.1:38037 shell pm grant dev.termux.codexgui com.termux.permission.RUN_COMMAND
```

验证（`dumpsys package`）：

```
runtime permissions:
  com.termux.permission.RUN_COMMAND: granted=true
```

**这一条正是 HyperOS 界面里找不到的那个开关**——用户截图里 Codex 的权限页压根没有这一项，
所以"UI 里点不到"≠"不可授予"：它是 `dangerous` 级，`pm grant` 可以授。

### 端到端验证（这次是真正的目标）

```
codex-gui-web stop                  → 桥下线（health 无响应）
adb shell am force-stop dev.termux.codexgui
adb shell am start -n dev.termux.codexgui/.MainActivity
```

结果（桥日志）：

```
--- 2026-10-16 01:31:03 start ---            ← 应用自己把桥拉起来了
client: apk: boot: ready after 3s, loading page
```

并且**前台仍是 `dev.termux.codexgui`**（不是 Termux）——说明走的是 `RUN_COMMAND`
（安静通道），E109 那个"打开应用跳 Termux"的问题就此消失。

### 附带收益（后续迭代要用）

| 能力 | 说明 |
|---|---|
| `adb install -r` | 稳定装包，替换时灵时不灵的 `termux-open` 流程 |
| `adb shell am start/force-stop` | 精确控制应用重启，用于复现启动路径 |
| `adb shell input` / `screencap` | 第二套 UI 自动化通道（不依赖无障碍服务） |

**注意**：无线调试端口每次重新开启都会变（本次 38037），端口要重新扫一次；
扫描脚本在 `$TMPDIR` 里，逻辑已记在本条。

---

## E112 — P5 第一块：旧版审批 + 请求生命周期；**并发现本机永远不会弹审批**

### 代码（patches/0045）

| 改动 | 之前的行为 |
|---|---|
| 旧版 `execCommandApproval` / `applyPatchApproval` 走同一张卡片 | 它们不在白名单里 → 前端回 `-32601 Unsupported request`（模型侧等到失败，界面上什么都不显示） |
| 旧版 decision 用**字符串枚举** `approved / approved_for_session / denied / abort` | 新版是 `{decision:"accept"}`；写成新版字面量旧服务端不认 |
| 旧版 patch 卡片列出待改文件 | 没有 turnId → `diffForTurn` 拿不到东西，卡片会空 |
| 同一 requestId 重复送达只出一张卡 | 重连/多客户端会重复插卡 |
| 服务端广播 `serverRequest/resolved` → 卡片标记"已在别处处理"并移除 | 之前完全忽略，用户会对着已被回答的卡片点 |

### 验收：`probe/approval-wiring.test.mjs`（把 bundle 真跑在 jsdom 里，14 项断言）

用页面自带的调试钩子 `__codexWebuiDebug.request/notify/state` 喂请求，检查 DOM 与**实际发出去的 HTTP**：

```
ok   卡片出现 / 标题去问用户 / 只出现 offered 的按钮
ok   发出 POST /api/codex/respond
ok   载荷 result.decision=accept、requestId=101
ok   旧版也出卡片（原来会回 -32601）、显示命令、发出 approved_for_session
ok   重复请求被忽略（只留一张卡）
ok   服务端说已解决时卡片收掉
ALL PASS
```

**这个测试第一次跑就纠正了我的一个错误假设**：回应走的是 `POST /api/codex/respond`
（`{requestId, result}`），不是我原先以为的 `/api/rpc`。断言打在"实际请求"上而不是"我以为的请求"上，
才有这个价值。

### 关键发现：**这台机器按配置永远不会弹审批**

```
~/.codex/config.toml:
  sandbox_mode   = "danger-full-access"
  approval_policy = "never"
```

所以"在应用里点一下审批"这条验收路径**在本机无法触发**（我实测：发一条需要联网的命令，
48 秒内 `/api/requests/pending` 始终为空，rollout 里那轮直接跑完了 `echo p5-check` 并回 `done`）。

想真机看到审批，得让**该会话的策略**变成"会问"：

- composer 的权限 chip 里有 `Ask for approval`（`approvalPolicy:"on-request"` + `workspaceWrite`，
  `networkAccess:false`）与 `Approve for me`（on-request + auto_review）两种模式；
- 用这两种模式时，**联网类命令**才会触发审批（工作区内只读命令不会）。

这是用户的选择项（要不要让 GUI 开始问），不是 bug——所以 P5 的"四类审批真机逐类验收"
需要先确认策略，否则只能用上面的接线测试覆盖。

---

## E113 — P5 真机验收：审批从弹出到回答到任务继续（全链路）+ 两个当场发现的问题已修

用户确认"可以让 GUI 开始问"（虽然平时不开审批）。查代码发现**GUI 的 `default` 模式本来就是
`Ask for approval`**（`approvalPolicy:'on-request'` + `workspaceWrite`，`networkAccess:false`）——
也就是不需要改任何默认值，之前没弹审批只是因为**那条测试消息根本没发出去**。

### 触发方式与实测结果

用桥的 `/api/rpc` 起一个回合（消息：让模型 `curl https://example.com`），策略与前端一致。
模型先按沙箱跑 → 卡住 → 主动请求提权（rollout 里可见 `"sandbox_permissions":"require_escalated"`），
于是审批出现。三个动作逐一验证：

| 动作 | 结果 |
|---|---|
| 弹出 | `GET /api/requests/pending` 里有 `item/commandExecution/requestApproval`；应用里出现卡片，**只给 offered 的两颗按钮**（取消 / 允许一次） |
| **允许一次** | pending 变空；rollout 里那条命令真的以提权身份跑出了 example.com 的 HTML（`exit=0`）；`task_complete` 带着输出 → **任务继续** ✓ |
| **取消** | pending 变空；模型收到的是 **`aborted by user`** ✓（拒绝路径也通） |

### 现场发现的两个问题（都已修）

1. **卡片说英文**（界面是中文）：`Allow ChatGPT to run this command?` / `Reason` / `Allow once`。
   model 里的标签是硬编码英文，渲染时没过 `t()` → **patches/0046** 在渲染处包 `t()` + 补词条，
   真机复验变成「允许运行这条命令？/ 原因 / 取消 / 允许一次」✓
2. **刷新后待答卡片不回来**：恢复函数其实跑了，但顺序是
   `restorePendingRequests()` 插卡片 → `openThread()` 重建会话把卡片抹掉，
   而 `state.requestCards` 里还留着 id → 再恢复时被"已经有"跳过 → **永远补不回来**。
   **patches/0047**：恢复前清掉"已不在 DOM 里"的记录 + 会话渲染完再恢复一次；
   真机复验：重启应用后卡片回来了，而且是中文 ✓✓

### 仍未覆盖（如实记）

- `item/tool/requestUserInput` 的**运行时**验证仍被工具模式门槛挡着（E34），目前只有单测；
- `mcpServer/elicitation/request` 无 elicitation 型 MCP server 可触发，只有单测；
- 带变量的标题（如 `Allow ChatGPT to connect to <host>?`）保持英文——i18n 是精确匹配，
  插值串硬套等于没翻译，这条限制写在 0046 的注释里；
- "断线中途"只覆盖到"刷新后恢复"，真正的传输中断（WS 断在请求发送后）未单独构造。

---

## E114 — 模型提问：**卡片被一个不存在的图标吃掉**（已修 + 真机全链路验证）

P5 剩下的第一项是"模型提问时 GUI 能回答"。Plan 模式下模型真的发来了
`item/tool/requestUserInput`（`/api/requests/pending` 里能看到完整 questions），
但应用界面上**什么都没有**，刷新后也没有。

### 真因：`codexIcon('question')` 抛异常

把这条链路搬进 jsdom（`probe/user-input-wiring.test.mjs`）后立刻现形：

```
Error: Unknown Codex icon: question
  at codexIconSvg (…) / renderUserInputRequest (…)
```

`codexIconSvg()` 对未知名字**抛异常**，而 `renderUserInputRequest()` 第一行就要这个图标 →
整张卡片渲染中断。图标表里其实已经有 `circleHelp`，只是调用点写的是 `question` ✗。
同一处还发现 `renderElicitationRequest()` 用的 `plug` 也没定义——
**两个 P5 交互面（提问、MCP 表单）都因此完全不可用**。

### 修复

| 补丁 | 内容 |
|---|---|
| `patches/0048` | 补 `question`（复用 circleHelp 路径）与 `plug`（Lucide plug）；**未知图标不再抛异常**，退化成问号 + console.error（图标缺失是外观问题，不该升级成功能故障） |
| `patches/0049` | 补这两张卡片的 CSS（此前 markdown/类名都在，**一条样式都没有**：选项挤成一段流式文本） |
| `probe/icon-contract-audit.mjs` | 新增：前端引用的图标名必须都有定义（负向对照实测 FAIL） |

### 真机验证（Plan 模式，问题由模型自己发起）

```
卡片渲染：今天做什么 / 今天想做什么工作？ / 三个单选（含描述）/「其他（可留空）」/「提交回答」
我填「P5 finish」→ 提交 → /api/requests/pending 变空
模型侧：task_complete  last_agent_message = "done"     ← 说明它真的收到了回答并继续
```

顺带验证了重连恢复：提问挂起时重启应用，卡片**自己回来了**（依赖 0047 的修复）。

---

## E115 — MCP 表单（elicitation）：三个叠加的缺陷，全都真机验证过

`mcpServer/elicitation/request` 是**服务端→客户端**的请求（客户端无法自己发起），
所以没有 elicitation 型 MCP server 就永远验证不到。为此写了一个最小夹具
`probe/mcp-elicitation-server.mjs`：它的 `tools/call` 会向客户端发 `elicitation/create`
（MCP 的 elicitation 就是这个方向），再把用户的回答当工具结果返回。

### 真机跑通之前，先修掉三个缺陷

| 缺陷 | 现象 | 修复 |
|---|---|---|
| 缺 `plug` 图标 | 卡片整个渲染不出来（同 E114） | `patches/0048` |
| 按钮组没有样式 | 三个按钮挤在一行、溢出卡片 | `patches/0049`（`.approval-body>.approval-actions-main` 的 flex/换行/胶囊）+ 卡片内部统一 `box-sizing:border-box` |
| **空表单永远提交不了** | `canAccept: fields.length > 0 && …` → 无字段的表单（MCP 工具授权就是这种）`canAccept=false` → 提交按钮**从渲染起就是禁用的** | `patches/0052`：允许 0 字段（无输入可填＝确认），仍挡住"含无法识别字段"的表单 |

**顺带的诊断能力**（`patches/0050`）：`window` 的 `error` / `unhandledrejection` 与
每次交互应答的 requestId+载荷都写进桥日志——上面那个"按钮禁用"如果不是显式日志，
光看现象（点了没反应）根本判不出来。

### 真机全链路（两段 elicitation，一次跑完）

```
① MCP 工具授权（mode=form，requestedSchema 无字段）
   → 卡片「MCP · elicitation_probe / MCP 请求输入 / Allow … run tool "ask_me"?」→ 点「提交」
   → pending 从 id=4 变成 id=5（请求被接受、工具开始执行）
② 夹具自己发的 elicitation/create（requestedSchema 有 name/mode 两个字段）
   → 卡片渲染出「模式」下拉（fast/careful）与「你的名字 *」（含描述）
   → 我填 codex + 提交 → pending 变空
   → 工具结果回到模型： elicitation 返回：{"action":"accept","content":{"mode":"fast","name":"codex"}}
   → 模型 task_complete
```

**注意**：这个夹具 server 是测试用的，验证完已经从 `~/.codex/config.toml` 里摘掉
（`config/value/write` + `config/mcpServer/reload` 全程通过协议完成，用户的其它配置没动）。

### 仍未逐类真机触发

`item/permissions/requestApproval`（权限档位申请）没有在本机触发到——它由 provider 的
权限档位流程产生，与前面三类共用同一套渲染与提交接线，目前由
`probe/approval-model.test.mjs`（14 项）与 `probe/approval-wiring.test.mjs`（14 项）覆盖。

---

## E116 — 通知改由应用自己发（用户 2026-10-16 要求）

原状：APK 里页面的 Web Notification API 不存在（`Notification is undefined`，E102），
所以"任务完成 / agent 有话要说"这些提醒只能靠 agent 自己调 `termux-notification`——
**通知来源是 Termux，不是应用**。

### 设计

```
agent / CLI ──> ~/bin/codex-notify ──POST /api/notify──> 桥
                                                         ├─ 应用在跑 → 广播 → 页面 → CodexNative.notify() → 原生通知
                                                         └─ 应用不在 → termux-notification 兜底
页面自己（turn/completed）──────────────> CodexNative.notify() ──> 原生通知
```

| 部件 | 位置 |
|---|---|
| 原生出口 | `app/NativeNotifier.java`（`@JavascriptInterface notify(title,body,tag)`，渠道 `codex-app`、IMPORTANCE_HIGH、同 tag 覆盖） |
| JS 注入 | `MainActivity` 里 `webView.addJavascriptInterface(new NativeNotifier(this), "CodexNative")` |
| 页面接线 | `nativeNotify()` 原生优先、浏览器退回 Web Notification；`maybeNotifyTaskCompleted()` 与桥的 `notification/native` 事件都走它 |
| 桥出口 | `POST /api/notify`（`{title,body,tag}`）+ `POST /api/notify/register`（应用注册） |
| CLI 入口 | `~/bin/codex-notify -t … -c … -i …`（参数对齐 `termux-notification`，失败自动退回它） |
| 约定 | `~/.codex/AGENTS.md` 与 `~/AGENTS.md` 两层都改成调用 `codex-notify`（更具体的那层优先，所以必须都改） |

### 实测

| 场景 | 结果 |
|---|---|
| 应用在跑，`~/bin/codex-notify` | 桥日志 `notify: native(app)` → 页面收到 → **应用发出原生通知**（`apk: native notification posted: …`） |
| 应用被 force-stop（等租约过期） | `notify: termux` —— 退回兜底，**不会静默丢失** |
| 回合在应用隐藏时完成 | `apk: native notification posted: 任务完成 — 任务完成`（页面自己发的，与 agent 无关） |
| 另一个会话（浏览器侧）按新约定发的完成提醒 | 同样变成应用原生通知（日志里能直接看到内容） |

### 过程中修掉的两个自身缺陷

1. **广播信封写错**：第一版直接广播 `{type:"notification/native"}`，而页面是按
   `codex/notification` → `payload.method` 分派的 → 通知静默丢掉。实测（通知没出现）才发现。
2. **"应用在跑"用了计数器**：桥重启归零、同一页面注册三次就虚高，最坏情形是"应用已关掉、
   桥仍以为它在，于是通知发给空气、Termux 兜底也不触发"。改成 **租约**：页面 30 秒续一次，
   桥侧 90 秒过期（上面第 2 行实测就是这个机制）。
   顺带修掉 `server.ts` 里一处作用域错误：`rpcStartedAt` 声明在 `try` 内却在 `catch` 里使用，
   导致**任何浏览器 RPC 失败都会显示成 `rpcStartedAt is not defined`**，真实原因被顶掉。

---

## E117 — 又一次"等待桥响应"：这次主要是**我自己重启桥**造成的

用户 02:22 报"又有等待桥响应的 bug，等了一小会"。查日志：

```
--- restart ---  02:10:28 / 02:11:28 / 02:13:00 / 02:17:12   ← 7 分钟内四次，全是我在改通知链路
event loop blocked: 11717ms / 4186ms / 129616ms / 13256ms / 5344ms / 5774ms
```

也就是说这段等待里有两种完全不同的原因混在一起：

| 原因 | 表现 | 处置 |
|---|---|---|
| **桥被重启**（我在改 `server.ts`） | 页面与桥断开、WS 回退 SSE、几秒内自愈 | 什么都不用做——但**用户看到的就是"等待桥响应"** |
| **设备把 Termux 挂起**（12.9s / 129s） | 几十秒到几分钟 | 前端修不了；需电池白名单或接受 |

两种在日志里长得一样，用户无从分辨，我自己也差点把它当成环境问题。

### 修复（patches/0055 + `/api/health` 增加 `startedAt`/`uptimeMs`）

页面在"等待超过 8 秒"时先读一次 `/api/health`：

- `uptimeMs < 120000` → 提示**「桥刚刚被重启过（N 秒前），页面正在重连——几秒内会自己恢复」**；
- 否则 → 保留原来的「Termux 很可能被系统挂起了…」+ 日志记下 uptime。

### 一条工作纪律（写进 HANDOFF）

**改 `server.ts` 要重启桥，而重启会打断用户**。所以：把需要重启的改动**攒到一起**、
重启前确认用户没有正在跑的回合；能在启动时自愈的（前端改动）就不要重启。

---

## E118 — 常驻通知永远停在"正在启动桥…"：健康检查跑在主线程上被系统拒绝

用户 02:25 反馈：应用那条常驻（前台服务）通知**一直显示"正在启动桥…"**，而应用本身用得好好的。

### 证据链（先看日志，不猜）

桥日志里服务自己上报的状态**每一条**都是 `ready=false`：

```
client: apk: service: v0.1.7 ready=false wakeLock=true fg=true     ← 反复出现
```

而同一时刻桥的 `/api/health` 一直是 `ready:true`、`page` 加载正常——也就是**只有服务那一侧看不到桥**。

### 成因

`BridgeService.checkTask` 是 `handler.post` 调度的（**主线程**），里面直接调
`BridgeClient.isReady()` → 那是**阻塞网络调用** → Android 抛 `NetworkOnMainThreadException`
→ 被 `BridgeClient.health()` 的 `catch (Exception)` 吞掉 → 返回 null → `isReady()` **永远 false**
→ `applyBridgeState(false)` 把通知设成"正在启动桥…"（`startingSent` 之后不再更新）→
**通知从此定格**。

同一个坑没影响应用启动路径，因为 `MainActivity.boot()` 本来就把它放在 `new Thread(...)` 里跑
——所以"应用能用、通知却说没连上"这种自相矛盾的现象是这么来的。

### 修复（0.1.8）

服务里的健康检查挪到工作线程（`new Thread(this::runCheck)`），主线程只负责更新通知；
间隔与租约逻辑不变。

### 验证

```
安装 0.1.8 前的最后一条：client: apk: service: v0.1.7 ready=false wakeLock=true fg=true
安装 0.1.8 后第一条：    client: apk: service: v0.1.8 ready=true  wakeLock=true fg=true
```

即状态源第一次如实反映"桥连上了"；通知文案随之从"正在启动桥…"变成"已连接"。

---

## E119 — 附件消息把完整绝对路径铺满气泡：溢出卡片 + 读不出是哪个文件【已实测】

用户 2026-10-16 02:26 报「传文件时候，文件路径太长，文字渲染出现问题」并截图。

### 现场（先复现，再动手）

桥给文档附件生成的文本是固定句式（`app/server.ts:568`）：

```
附件（本地路径，可直接读取）：/data/data/com.termux/files/home/.codex/codex-webui/uploads/20261015182428-c6806975-e3de59e0f685a04073e622f937_1815965615135601443_m.pdf
```

用 `adb exec-out screencap -p` 翻到那条气泡（`~/shots/e119-a.png` → 逐次上滑到 `~/shots/e119-h.png`）：
**整串没有空格**，而用户气泡是 `.user-message{white-space:pre-wrap}` 且**没有** `overflow-wrap`
（助手侧 `.message-text` 早就带 `word-break:break-word`，用户侧漏了）→ 文本横向冲出卡片、右半边被裁掉。

### 修复（patches/0056 + 0057）

1. **CSS 兜底**：`.user-message{overflow-wrap:anywhere;word-break:break-word}`、
   `.user-message code{overflow-wrap:anywhere;word-break:break-all}`（这条先单独上，真机确认不再溢出，
   见 `~/shots/e119-h.png`：气泡内正常折行、没有裁切）。
2. 但折行后气泡被拉成 **7 行**、每行只放得下几个字符，仍然读不出是哪个文件 → 按桌面端的样子
   渲染成**一行芯片**：文件图标 + 文件名 + 「路径」；点一下展开完整路径（提示变「收起路径」）。
3. 折叠态文件名再收短成「头 12 + … + 尾 13」（26 字符，尾部保留扩展名）——33 字符时真机仍会折两行
   （`~/shots/e119-m.png`），26 字符正好一行（`~/shots/e119-r.png`）。完整路径点开即得，不丢信息。
4. **纯渲染层**：发给模型、写进历史的文本仍是完整路径，`server.ts:568` 一个字没动。
5. 顺带修一个隐患：`claimOptimisticUser` 用 `textContent` 认领本地气泡，芯片会改 `textContent`
   → 原文存进 `dataset.rawText`，认领时优先用它（否则"自己发的那条"会重复渲染成一个新气泡）。

### 证据

| 项 | 结果 |
|---|---|
| 溢出（修复前） | `~/shots/e119-a..h.png`（真实会话里的附件气泡） |
| 兜底折行（只上 CSS） | `~/shots/e119-h.png`：7 行、无裁切 |
| 芯片折叠态（终态） | `~/shots/e119-r.png`：`202610151824…5601443_m.pdf` + 「路径」，**一行** |
| 芯片展开态 | `~/shots/e119-s.png`：完整路径 + 「收起路径」，展开时不再重复文件名 |
| 点击展开/收起 | `adb shell input tap` 两次，状态与提示语都跟着变（上表两张图） |
| 单测 | `node probe/user-attachment-chip.test.mjs` 15 项全过（含"原文没有重复成文本""路径只在芯片里出现两次""中段提到路径不当芯片"） |
| 回归 | `probe/user-message-image.test.mjs`（图片气泡）与 `probe/dom-contract-audit.mjs` 均全过 |

**未验证**：英文界面下 `Path` / `Collapse path` 两条词条只在 i18n 表里（默认简中已真机可见），英文态未真机切换确认。

---

## E120 — 桥的 gzip 缓存只按长度失效：重建 bundle 后桥一直发旧字节（"改动没到浏览器端"的真凶）【已实测】

查 E119 时冒出来的真问题：**代码改了、bundle 重建了、桥也确实读了新文件，但桥发出去的还是上一次构建的字节。**

### 现场

```
$ node -e '…比较磁盘文件与 curl 到的字节…'
disk len 1601596 served len 1601596
disk has26 true served has26 false      ← 磁盘是新的，桥发的是旧的
disk has36 false served has36 true
first diff at 1594468
disk  : "unction shortAttachmentName(name) {\n  return name.length <= 26 ? …
served: "unction shortAttachmentName(name) {\n  return name.length <= 36 ? …
```

（`curl -s --compressed http://127.0.0.1:8899/app.bundle.js`；磁盘文件 `app/public/app.bundle.js`。
另一条独立证据：`grep -rl "name.length <= 36" ~/` 只命中我自己的 curl 输出——旧字节**不在磁盘上**，是桥内存里的。）

### 成因

静态处理器把 gzip 结果缓存在 `gzipCache`，判断条件是

```ts
if (!compressed || compressed.size !== body.length) { …重新压缩… }
```

注释写的是"cached by (path, mtime, size)"，但 **mtime 从没进过判断**。而这两次构建的**字节数完全相同**
（只改了两个两位数字：`<= 26` / `<= 36`、`12` / `14`、`13` / `18`）→ 长度校验永远通过 → 一直重放旧 gzip。

这条回头解释了 E86/E117 里几次"我怀疑你的更改根本没到浏览器端"：**不是浏览器缓存，是桥自己发的旧字节**
（页面侧 `auth-bootstrap.js` 给 bundle 带了 `?v=Date.now()`，WebView 又设了 `LOAD_NO_CACHE`，
所以嫌疑其实一直在桥这一侧）。

### 修复（patches/0058）

- 缓存条目加 `mtimeMs`，长度或 mtime 任一变化即重新压缩；
- 静态访问日志加 `mt=<mtimeMs>`，以后"发的是哪一份文件"可直接与 `stat -c %Y` 对照。

### 验证（决定性对照实验：**同长度**改动、**不重启桥**）

```
# 应用补丁 + 重启桥之后
$ curl -s --compressed …/app.bundle.js | grep -o "name.length <= [0-9]*"
name.length <= 26                     ← 与磁盘一致

# 把阈值 26 改成 24（字节数不变），只重建、不重启桥
$ ls -la app/public/app.bundle.js → size 1609406          ← 与上次完全相同
$ curl -s --compressed …/app.bundle.js | grep -o "name.length <= [0-9]*"
name.length <= 24                     ← 桥跟着换成了新字节（修复前这里会是 26/36）

# 改回 26 再重建
$ curl -s --compressed …/app.bundle.js | grep -o "name.length <= [0-9]*"
name.length <= 26
$ grep -o "static /app.bundle.js.*" ~/.codex/codex-webui/bridge.log | tail -1
static /app.bundle.js 1609406B mt=1792089145400 enc=gzip ua=curl/8.22.0
```

### 影响面与残留风险

- 只影响 **gzip 分支**（页面与浏览器都走 gzip；`identity` 分支直接发读到的字节，一直是新的）。
- `/style.css`、`index.html` 走同一份缓存，所以这次修的也是"改 CSS 有时看不到效果"的那一类现象。
- 残留：**不同长度**的构建本来就会刷新，所以这个 bug 只在"构建产物长度恰好相同"时咬人——
  概率低但完全静默。以后改前端仍按 0058 的日志 `mt=` 自查一次再断言"改动已生效"。

### 同轮交付

APK **0.1.9**（本机 aapt/javac/d8/apksigner 流水线，`--install` 已复制到
`/sdcard/Download/codex-gui/codexgui-0.1.9-20261016-023702.apk`，并用 `adb install -r` 装到设备）。
本轮改动全在桥侧（前端资源 + `server.ts`），APK 侧只有版本号跟进——这点如实说明，不当作 APK 功能更新。



---

## E121 — Git 面板在真机才暴露的三个缺陷【已实测】

侧栏 Git 面板（patches/0060–0062、0064、0065）在真机上连撞三次，都不是"逻辑错"，而是"手机上才看得见"：

| 现象 | 根因 | 证据 / 修法 |
|---|---|---|
| 提交按钮白底白字，字看不见 | 我写的 `color: var(--app-bg)`，而这个应用里根本没有 `--app-bg`（主按钮用的是 `background:var(--app-text); color:var(--app-main)`）→ color 变无效值、继承成浅色 | `~/shots/p6-02.png`（坏）→ `~/shots/p6-23.png`（好）；patches/0063 |
| Git 面板**一直显示**，和 launcher 列表叠在一起 | `.side-panel-git{display:flex}` 追加在 style.css 末尾，把前面的 `[hidden]{display:none}` 盖掉了（同特异度、后写的赢） | 诊断日志写着 `gitPanel(hidden)` 而屏幕上它就在那儿；patches/0064（补 `[hidden]` 规则） |
| 行内动作按钮显示英文 `stage` / `discard` | 我把动作名（stage/unstage/discard）直接当词条键用了，词条表里是首字母大写的 `Stage`… | `~/shots/p6-23.png`（英文）→ `~/shots/p6-28-top.png`（中文）；patches/0065 |

同轮还踩到一个**补丁自己的坑**：patches/0067 用 `kind==='files'` 当幂等标记，而上游底部面板里本来就有这个字符串，
于是 `edit()` 一进门就判定"打过补丁了"、四步接线全被跳过——代码追加进文件了，但点「文件」还是走老分支
（真机日志 `side panel view=utility`）。PATCHES.md 里 0018/0019 记过同一类坑，这次自己又踩了一遍。
修法：标记必须是**本补丁引入**的字符串（patches/0068 + 0067 的标记已改）。

## E122 — 文件撤销链路：三处都堵着，一处处通才撤得动【已实测】

目标：手机上按「撤销」要能把模型刚改的文件安全地退回去。真机上按下去**没有任何反应**，
一路挖出来三个独立原因（每一个单独存在都足够让功能失效）：

1. **合成出来的 diff 根本不能用**（patches/0070）
   本机 app-server 给的 `changes` 是这样（`thread/read` 原样数据）：
   ```json
   {"path":"…/mobile-probe.txt","kind":{"type":"add"},"diff":"hello\n"}
   {"path":"…/mobile-probe.txt","kind":{"type":"update","move_path":null},"diff":"@@ -1 +1,2 @@\n hello\n+world\n"}
   ```
   `add` 给的是**整份内容**（没有 `@@`、没有 `+` 前缀），`update` 给的是**没有头部的 diff 主体**。
   原来的合成只补 `--- /dev/null` / `+++ b/<path>` 两行 → `add` 的补丁既过不了 `git apply`，
   前端 `parseUnifiedDiff` 也数不出增删行（`hasChanges=false`）→ **审阅面板是空的、撤销按钮永远禁用**。
   修法：add/delete 自己补 `new file mode` + `@@ -0,0 +1,N @@` + 每行 `+`/`-` 前缀；补丁必须以换行结尾
   （少这一行 git 报 `corrupt patch`）。验证：`probe/file-change-diff.test.mjs` 15 项全过（含真 `git apply` → 内容对 → 反向 apply 还原）。

2. **允许根只有桥自己的默认目录**（patches/0073）
   直接打接口才看到真正的原因：`{"error":"outside allowed roots"}`——`reviewRoots` 只取了 `defaultCwd` 一个目录，
   而用户真实工作区可以在任何项目里（这次是 `~/tmp/git-demo`）。失败是闭的（不会乱改文件），但功能等于没有。
   修法：`reviewRoots` = 显式配置根 + 家目录 + 文件面板额外根，与文件面板/终端同一套边界。

3. **fileChange 的 path 是绝对路径**（patches/0074/0075）
   修完前两条仍然报 `Review diff contains an unsafe path`：`git apply` 只认仓库内相对路径，
   而 path 是 `/data/data/com.termux/files/home/tmp/git-demo/mobile-probe.txt`。
   修法：桥在合成前按"该会话工作区所属 git 仓库的根"裁成相对路径（每个 thread 的根只查一次）。
   **同一条事实有三条入口**（实时通知 `item/completed`、读会话补录 `recordReviewDiffsFromRpc`、回源重建），
   我改了两条才发现第三条才是真凶——加日志（`DEBUG record diff … a//data/data/…`）才定位。

另外补了一条健壮性：桥重启后内存里的 diff 就没了（页面还能显示，因为它的 diff 来自实时通知），
现在 `ReviewDiffStore` 未命中时会**回源重建**（`thread/read{includeTurns}` → 同一套合成）再重试（patches/0072）。

### 真机结果（`~/shots/p6-76.png` → `p6-77.png`）

审阅面板显示 `mobile-probe.txt +1 −0`、hunk `@@ -1 +1,2 @@`、`+ world`（绿色）→ 按撤销 →
磁盘文件从 `hello\nworld` 回到 `hello\n`，`git status` 同步。

## E123 — P6 各面板的真机验收【已实测】

| 功能 | 真机证据 | 结论 |
|---|---|---|
| Git 面板：状态/分支/上游/ahead-behind | `~/shots/p6-23.png`（master · origin/master ↑1） | ✅ |
| 暂存 → 提交 → 推送（本地 bare 远端） | `~/shots/p6-28.png`；`git log` 出现 `7ad8cc1 mobile commit test`；远端已收到 | ✅ |
| 丢弃改动（危险动作确认弹层） | `~/shots/p6-29.png`（确认弹层）→ 文件内容真的回退 | ✅ |
| worktree 创建 / 打开（切工作区）/ 删除 | `~/shots/p6-34.png`（切换确认）→ `p6-36-band.png`（两个 worktree）→ `git worktree list` 只剩主库 | ✅ |
| 非仓库工作区 | `~/shots/p6-10.png`：明说 `Workspace is not inside a Git repository`，不装样子 | ✅ |
| 文件面板：列表 / 打开 / 编辑 / 保存 | `~/shots/p6-53.png`（列表）→ `p6-55.png`（查看器独占）→ `p6-61.png`（保存确认）→ 磁盘与 `git status` 同步 | ✅ |
| 终端：真提示符 + 工作区目录 | `~/shots/p6-46-band.png`（`~/tmp/git-demo $`） | ✅ |
| 终端：键盘输入到 pty | 两次回车 → 两行新提示符（`~/shots/p6-47-band.png`） | ✅ |
| 终端：手机辅助按键 Ctrl+C | `sleep 60` → 点 Ctrl+C → `^C` + 立即回到提示符（`~/shots/p6-49-band.png`） | ✅ |
| 终端：桥侧契约 | `probe/terminal-bridge.mjs` 9 项全过（二进制帧=输入、JSON=resize、退出码、关闭） | ✅ |
| 终端：PTY 语义 | `probe/pty-exec.mjs` 10 项全过（回显、`stty size` 24×100、resize 40×120、Ctrl+C→$?=130、中文分片、退出码 7） | ✅ |
| 终端：断开不留残骸 | `probe/terminal-lifecycle.mjs` 7 项全过（断开后 app-server 下 shell 数归零） | ✅ |
| 文件/Git 后端接口 | `probe/fs-api.mjs` 15 项、`probe/git-api.mjs` 25 项、`probe/git-service.test.mjs` 27 项全过 | ✅ |
| 撤销 + 冲突保护 | `probe/review-patch-conflict.mjs` 12 项（真机撤销见 E122） | ✅ |
| **终端旋转（竖↔横）** | 未测 | ⚠️ |
| **审查目标：分支对比 / 指定提交** | 未实现（`review/start` 未接） | ❌ |
---

## E124 — "启动桥又变得很慢，一直等待"：三个独立原因【已实测】

用户 2026-10-16 03:36 报："启动桥又变得很慢，一直等待了。"（"又"= 早前 E117 那次是**我**反复重启桥造成的）

### 先量化，别猜

App 自己上报的 boot 记录给了第一手证据：

```
apk: boot: port=open ready=false termux=true runCommand=granted version=0.2.1
apk: boot: port open but not ready yet, waiting for the app-server
apk: boot: ready after 14s, loading page
apk: boot: ready after 23s, loading page
```

**HTTP 端口早就开了，卡在 `/api/health` 的 `ready:false`**（`ready = connected && !shuttingDown`，即 app-server 还没握上手）。
而单独起一个 app-server 只用 **615 ms**（同一台机器实测：`readyz` 615ms、WS 连接 163ms + `initialize` 响应 167ms）。
所以慢的不是 app-server，也不是 initialize，而是**桥自己的启动路径**。

### 三个原因（都在启动路径上）

**① 一个桥会并发 spawn 多个 app-server**（patches/0076）
临时加了一行 `new Error().stack`，三次 spawn 的调用栈完全相同——都来自 `startCodex()` 里
`adoptExistingAppServer(token).then(...)`。原因是 adopt 有 1.2 秒等待窗口，这期间 `codex` 仍是 null，
而**页面重连时会不断发 RPC**，`sendRaw()` 发现没连上就调一次 `startCodex()` → 每个 RPC 开一轮
"adopt → spawn"。用户点开 App 的那一刻正是这种状态。
日志长相：`listening on: ws://127.0.0.1:8901` → `Error: Address already in use` →
`killed 2 stale app-server(s) holding port 8901; will retry` → 再 `listening on`
（桥把自己刚起的那个杀了再重起）。
修法：模块级单飞闸门 `bridgeStartInFlight`（并发的调用直接返回，RPC 会照旧失败并由页面重试）。
验证：并发 3 次 `start` → 只有 1 个 start 标记、1 次 spawn、0 次端口冲突、0 次杀进程。

**② 桥在等孩子 stdout 那句 "listening on"，而管道 stdout 是块缓冲**（patches/0078/0079）
给桥加了启动打点后（patches/0077，`START +Nms <阶段>`）看得一清二楚：

```
START +1215ms spawning the app-server
[codex app-server] listening on: ws://127.0.0.1:8901     ← 和下面同一毫秒才出现
START +7237ms bridge↔app-server socket open; sending initialize
```

孩子其实 ~600ms 就能服务，但那行字**在缓冲区里躺了 6 秒**才被桥读到（`spawn(..., stdio:['ignore','pipe','pipe'])`）。
另外 adopt 那次必然失败的 WS 连接会把重连退避拉到 2s/4s，桥即使读到也还要再等。
修法：spawn 之后每 200ms 探端口（忽略退避），端口可用即连；不再把 stdout 文本当就绪信号。

**③ adopt 窗口固定 1.2 秒，冷启动每次都要付**（patches/0080）
adopt 的本意是"上一轮桥留下的实例还在就复用它"，实现却是拿 WebSocket 去等满 1.2 秒才认输。
修法：先用 HTTP `GET /readyz`（超时 500ms）问一句"这儿有人吗"，没人立刻 spawn。

### 结果（同一台手机，可重复）

| 阶段 | 修复前 | 修复后 |
|---|---|---|
| adopt 判定 | 1210ms | **5ms** |
| spawn → 连上 app-server | 6027ms | **~350ms** |
| 桥 `ready` | **7241ms** | **~353ms** |
| `codex-gui-web start` 返回 | 8720ms | **~1.5s** |
| App 的 boot 记录 | `ready after 14s / 23s` | **`ready after 1s`** |

连续 3 次重启：start 1.62/1.65/1.64 秒，`connected` 分别 +561/+571/+571ms，零端口冲突。

### 另外补的一个并发源（`~/bin/codex-gui-web`，非仓库文件）

有三个来源会同时喊"把桥拉起来"：App 前台服务每 60 秒巡检、`~/.bashrc` 每个新 shell 都后台跑一次、
以及手动 start/restart。脚本原先没有锁，三者可以各自 spawn 一个桥去抢同一个端口。
现在加了 `start-lock` 单飞锁（陈旧锁 2 分钟自动失效），并且**拿到锁后再确认一次是否已就绪**
（否则等锁的进程会在拿到锁后接着起第二个）。

**未做**：没有缩短 `codex-gui-web start` 里 1 秒粒度的轮询（现在总时长 1.5s，收益不大）。
---

## E125 — P0–P6 残项收口（2026-10-16 下午）【已实测 / 逐条标注】

用户要求"先把前边能修的修了，然后给我审批"。这一批逐项：

### 1. P0：`experimentalApi` 开/关的影响【已实测】

`probe/experimental-api-ab.mjs`：同一条 app-server 上开两条连接（`experimentalApi` true / false），
对 15 个候选方法逐一发请求并对比：

| 方法 | true | false |
|---|---|---|
| `thread/realtime/listVoices` | ok | `requires experimentalApi capability` |
| `memory/status` | ok | `requires experimentalApi capability` |
| 其余 13 个（`experimentalFeature/list`、`thread/queue/*`、`command/exec`、`review/start`、`plugin/list`、`marketplace/add` 等） | 与 false **完全一致** | |

结论：这个开关只挡这两条（至少在这批候选里），**桥初始化用的是 `experimentalApi: true`**，
所以两条对页面可用。副产品：`memory/status` 可用（`{"v2ConsolidatedThreads":0,"v2Ready":false}`），
P7 做"记忆/设置"时可以接。

### 2. P6：终端旋转【已实测】

`terminal resize` 现在会进桥日志（patches/0081），真机三次读数：

| 场景 | PTY 尺寸 | 结论 |
|---|---|---|
| 竖屏（键盘收起） | `52x38` | ✅ |
| 横屏（键盘收起） | `75x12` | ✅ 按键条完整（`~/shots/rot-4.png`） |
| 横屏 + 键盘弹出 | `75x7` | 修前被压到看不见（`~/shots/rot-3.png`）→ 修后按键条挪到上方、终端保底 7 行（patches/0081） |

### 3. P2：会话级等待提示【已实测】

`probe/waiting-flags.mjs`：Plan 模式下让模型调用 `request_user_input`（真回合），
轮询 `thread/list` → `status.activeFlags` 出现 **`waitingOnUserInput`**；
答完题后同一线程状态回到 `{"type":"idle"}`（徽章随之消失）。
侧栏据此渲染徽章（patches/0082），真机截图 `~/shots/wait-1-band.png`：那一行显示「等你回答」。

### 4. P4：排队语义【已实测】

`probe/queue-semantics.mjs`（9 项全过，自己建会话、跑完自动删除）：
运行中 `thread/queue/add`（必须带 `clientUserMessageId`，否则 `missing field`）→ 出现在 `queue/list`
→ **运行期间没有变成新回合** → 回合结束后它成为第 2 个回合、内容与顺序正确 → 队列清空。

### 5. P2：`ready` 反映 draining【部分实测，如实标注】

patches/0083：请求错误里一旦出现 draining → `connected=false` + 广播 disconnected + 抄掉旧实例重建（10 秒抖动保护）。
故障注入实测（给真实服务进程发 SIGTERM）：请求失败、`/api/health` **立刻 `ready:false`**、
**568ms 后自动重建完成**。但这次注入是"连接被关掉"而不是"端口还在却一直答 draining"，
所以 **draining 那条分支本身没被触发**（老实例排空的行为在本机 build 上复现不出来）→ 记 `[~]`，不当成已验证。

### 6. P6：审查目标 + 行内定位【协议路径已实测；芯片渲染仅单测】

- `review/start` 真跑过一次：临时 git 仓库 + 未提交改动 → `{type:"uncommittedChanges"}`
  → 模型产出真实审查意见（提到 `div()` 缺零除保护）→ 路径通。
- 四种 target 的载荷形状：`probe/review-targets-citations.test.mjs` 逐变体断言（uncommittedChanges / baseBranch / commit / custom），
  并断言"没有活动会话时不发请求"。UI 见 `~/shots/rt-3-top.png`（四项中文选项）。
- 分支/提交列表复用 `/api/git branches|log`；工作区不是 git 仓库时对话框如实报
  `Workspace is not inside a Git repository`（`~/shots/rt-4-band.png`）。
- **行内定位未拿到真实数据**：本机 provider 的 review 回合里 `memoryCitation` 是 `null`
  （`thread/read` 实测），所以芯片渲染只过了单测（`citation-chip` 那 6 项）→ 记 `[~]`。

### 7. 顺带清理

测试产生的 3 个会话已删除（含队列与提问测试），临时仓库与脚本已移除；设备上无残留会话/进程。
---

## E126 — Android/Termux 上沙箱**没有生效**（用户点名的硬要求）【已实测】

用户要求"核实 Android 上权限和沙箱是否真的生效，不能仅凭配置字段宣称已隔离"。结论是：
**本平台不隔离**，四种测法互相印证。

### 测法一：按请求 `sandboxPolicy`（不碰用户配置）

`probe/sandbox-enforcement.mjs` 用 `command/exec` 的 `sandboxPolicy`（协议允许按请求指定）跑同一批命令：

| 策略 | 写工作区内 | 写工作区外（文件真的出现？） | 联网（curl） |
|---|---|---|---|
| `dangerFullAccess` | 成功 | **出现** | 通（200） |
| `workspaceWrite`（writableRoots=[工作区]，networkAccess=false） | 成功 | **出现** | 通（200） |
| `readOnly`（连工作区都不许写） | 成功 | **出现** | 通（200） |

### 测法二：thread 级 `sandbox` + 实例级 `-c sandbox_mode`

起一个**独立实例**（`codex app-server -c sandbox_mode="read-only"`，只读方式共用 `~/.codex`），
`thread/start {sandbox:"read-only"}`，让模型用 shell 写一个文件：

```
文件是否真的被写入: true
命令: {"command":"/bin/sh -lc \"printf 'hello\\n' > …/written.txt && cat …\"","status":"completed","exit":0}
```

即：**策略字段被后端接受，但命令照样执行**。

### 为什么（平台侧，尽力核实到的部分）

内核 `Linux 6.6.118-android15`；`/sys/kernel/security/` 对应用**不可读**（unrooted Android 正常），
`/sys/kernel/security/lsm` 不存在 → 无法确认 Landlock/seccomp 是否可用，但行为上就是没生效
（Codex 的 Linux 沙箱依赖这些 LSM；Termux 侧也不具备 user namespace 等条件）。
app-server 侧**没有**任何"沙箱不可用"的告警——静默降级，这正是危险之处。

### 产品结论（写进设置页，见 E127）

- 把权限 chip / `sandbox_mode` 当**意图声明**，不要当安全边界；
- 真正生效的是 `approval_policy` 的审批门禁（E112/E113 实测：不批准就不执行、拒绝后模型收到 `aborted by user`）；
- 真要隔离得靠 Android 应用沙箱（不同 UID）或外部容器。

## E127 — P7（设置与扩展）第一批：真数据 + 受控配置写【已实测】

### 配置写：只许逐项、且只许两个键

上游把 `config/value/write` / `config/batchWrite` 放进了**浏览器白名单**（页面能写任意 keyPath）。
本轮从白名单摘掉，改由桥的受控出口 `POST /api/config/write {keyPath,value}`：
只允许 `approval_policy` / `sandbox_mode`，值过枚举校验。实测（对着用户真实配置）：

```
$ curl -X POST …/api/config/write -d '{"keyPath":"model","value":"gpt-5"}'
{"error":"This build only writes approval_policy / sandbox_mode from the app (asked for model)"}
$ curl … -d '{"keyPath":"approval_policy","value":"whatever"}'
{"error":"Invalid value for approval_policy: whatever"}
$ curl … -d '{"keyPath":"approval_policy","value":"never"}'      ← 写回它本来就有的值
{"ok":true,…,"status":"ok","filePath":"…/.codex/config.toml"}    ← 文件 md5 前后一致（没动用户的配置）
```

单键写入保留其它键：另起一个一次性 `CODEX_HOME` 验证过——改 `approval_policy` 后
`model` / `sandbox_mode` 原样保留（`config/value/write{mergeStrategy:"replace"}`）。

### 设置页填真数据（不是 "Not configured" 占位）

真机截图 `~/shots/p7-13.png`（配置页）：沙箱警告在最上面，下面是
`approval_policy=never` / `sandbox_mode=danger-full-access` / 模型 / provider / 思考强度 /
权限档位（`:read-only, :workspace, :danger-full-access`）/ 审批策略选择器 + 保存。
确定性验证：`probe/settings-live.test.mjs`（jsdom，16 项全过）覆盖
配置页（含"沙箱不生效"必现）、账户页（第三方 provider 的真实原因 + usage 的真实报错）、
插件页（`plugin/installed` + `mcpServerStatus/list`）、技能页（`skills/list`）、钩子页（0 条空状态）、
平台受限页（浏览器自动化/云任务给原因与替代）。

### 顺带修掉上游一个手机端缺陷（patches/0086）

手机上在设置里点条目**只改高亮、不切到内容页**（`setSettingsPage` 没切 `dialog.dataset.mobilePage`），
表现就是"点了没反应"。修后真机可直接从列表切到配置页（`~/shots/p7-13.png` 就是切过去的）。
---

## E128 — P7 第二批：产物与系统集成【已实测】

### 产物动作：打开 / 分享 / 存到 Download（patches/0087）

桥新增受控出口 `POST /api/files/action {action,path}`，路径照旧过允许根校验：

| 动作 | 实现 | 实测 |
|---|---|---|
| `open` | `termux-open --view <path>` | 200 + `{ok:true}`（交给系统应用） |
| `share` | `termux-open --send <path>` | 200 + `{ok:true}`（走分享面板） |
| `saveToDownloads` | 复制到 `/sdcard/Download/codex-gui/` | 目标文件真的出现、内容一致 |
| 未知动作 / 越界路径 / 传目录 | —— | 各自被拒（`Unsupported file action` / 允许根 / 非文件） |

`probe/files-action.test.mjs` 8 项全过。图片走桥既有的 `/api/images/local`（与消息缩略图同一条路）
在文件面板里内联显示；其余二进制仍如实说"不能预览"，但可以打开/分享。

### 通知点击直达会话（深链，patches/0089/0090）【已真机验证】

链路：桥的 `notification/native` 载荷带 `threadId` → 页面 `CodexNative.notify(..., threadId)`
→ APK 的 PendingIntent 带 extra → `MainActivity` 在 `onPageFinished`/`onNewIntent` 里回调
`window.codexDeepLinkOpen(id)` → 打开那条会话。

真机过程（截图 `~/shots/deeplink-3-band.png` → `deeplink-4.png`）：
发一条带 `threadId` 的通知 → 展开通知栏点它 → 应用跳到目标会话，日志两侧都对上：

```
apk: deep link delivered: 01a14087-65cc-74d2-b272-209cf45c2b7d
client: deep link -> open thread 01a14087-65cc-74d2-b272-209cf45c2b7d
```

**踩到的坑**：第一版页面用 `api.notify.length>=4` 判断"新 APK 支持第 4 个参数"，
而 Java 桥接对象的方法 `length` 实测是 **0** → 一直走 3 参分支、深链静默失效。
改成"先按 4 参调用，抛异常再退回 3 参"后成功。

### 实验特性页：如实只读，不做假开关（patches/0088）

实测 `experimentalFeature/enablement/set` 在本机构建上是**空操作**：调用返回 `{"enablement":{}}`
（什么都没更新），切换后 `enabled` 状态不变——试过 `analytics_plan_history`(beta)、
`daemon_auto_start`(stable)、`shell_tool`(underDevelopment) 三个都一样。
所以这页**只列出真实开关状态**（名称/阶段/当前值/默认值，共 30+ 项），并写明"本构建忽略该调用"，
不放一排点了没用的开关（用户明确禁止空按钮）。`probe/settings-live.test.mjs` 断言了"没有提供开关按钮"。

### 本轮附带

`experimentalFeature/list` 的实测结果顺带说明：`memory/status`、`thread/realtime/listVoices`
这类方法在 `experimentalApi:true` 下可用（E125），但**开关**类接口是另一回事——能列、不能改。
---

## E129 — P7 收尾：HTML 预览、拍照入口、MCP 重载，以及两处更正【已实测】

### HTML 预览（patches/0091）

新增 `GET /api/files/preview?path=…`：按扩展名给 content-type + `content-disposition: inline`，
并**强制 `Content-Security-Policy: sandbox`**——被预览的本地页面拿到不透明源，摸不到桥的同源数据
（这是这个接口敢存在的前提：否则"预览"等于把桥的 API 交给任意本地 HTML）。

实测（`curl -i`）：
```
HTTP/1.1 200 OK
content-type: text/html; charset=utf-8
content-disposition: inline
content-security-policy: sandbox
x-content-type-options: nosniff
```
真机：文件面板里搜到 `~/tmp/preview.html` → 打开 → 头部出现「预览」（monitor 图标）→
点击后侧栏浏览器面板显示该页面（`~/shots/p7b-14-small.png`）。

**过程中修掉两个真问题**：① 直接写 `#browserFrame.src` 会被浏览器面板随后的渲染覆盖掉
（面板停在"输入网址开始浏览"）→ 改用面板自己的 `navigateBrowser()`；② 传相对 URL 会被
面板的地址解析器当成主机名（变成 `https://api/files/…`）→ 必须给 `location.origin` 拼绝对 URL。

### 拍照入口（patches/0091）

输入区新增相机按钮：`<input type="file" accept="image/*" capture="environment">` +
`<label for>`。**不改 APK**：安卓上这会让系统文件选择器直接起相机/图片选择器。
真机实测：点它 → 前台变成 `com.android.photopicker`（HyperOS 的图片选择器，**第一格就是相机**）
→ 拍照/选图后走既有的 `change → POST /api/uploads → localImage` 链路（E82/E119 验过）。
**没有实际按下快门**（会拍到你周围的环境，我不替你做这个动作）。

> **更正（2026-10-16，E133）**：这个按钮**已删除**。用户实测"没用"，代码层面也证实了：
> APK 的 `onShowFileChooser` 用 `Intent.createChooser(params.createIntent(), …)`，
> 页面上的 `capture="environment"` **被忽略** → 它起的就是同一个图片/视频选择器，
> 比普通入口**没有多做任何事**。上面那段"起的是系统图片选择器"是真的，但那不是"相机入口已实现"。
> 真正的相机入口需要 APK 侧 `FileProvider` + `ACTION_IMAGE_CAPTURE`（仍在本文件 2877 行的待办里）。

### MCP 重载（patches/0091）

设置 → 插件页新增「重新加载 MCP 配置」按钮 → 协议 `config/mcpServer/reload`
（实测返回 `{}` = 接受；本机 `mcpServerStatus/list` 是空列表，所以按钮现在是"改完 config.toml 立刻生效"的入口）。

### 两处更正（原来的判断是错的）

1. **`inlineVisualization` 不是"图表"**：它属于 `ThreadRealtimeBemItemPresentation`
   ——**实时语音**那套 UI 的展示层（`{type:"inlineMarkdown"|"inlineVisualization"}`），
   而本构建没有音频后端（E20）。所以 FEATURES 里"内嵌可视化 = 前端渲染图表"这条是误判，已改。
2. **`browser_use` / `computer_use` 的可用性**：`experimentalFeature/list` 确有这两个特性
   （167 个特性里的 `browser_use`、`browser_use_full_cdp_access`、`browser_use_external`、`computer_use`），
   配置结构也真实存在（`BrowserUseConfigToml` 有 `default_origin_policy`/`origins`/`full_cdp_access`…；
   `ComputerUseConfigToml` **只有 `macos` / `windows` 两个子配置**，`aumids`/`bundle_ids` 都是桌面概念）。
   → `computer_use` 在 Android 上**没有对等实现**；`browser_use` 依赖 CDP 端点
   （桌面 Chrome/Chromium 带 `--remote-debugging-port`），Android 上的 Chrome 默认不暴露。
   这两条现在是**静态核实**（配置结构 + 特性表），运行时未试——按 `[~]` 记，不当成已实现。

### 顺带修掉一个 P6 遗留 bug（patches/0092）

文件面板里搜到结果后**点不开**（`No such file or directory (os error 2)`）：
桥的 `searchWorkspaceFiles()` 返回的是**工作区相对路径**，面板却当绝对路径用。
修法：搜索映射时按工作区根补成绝对路径，并区分 `kind==='folder'`（点目录进目录）。
真机复现 → 修复 → 打开成功（`~/shots/p7b-9-band.png` → `p7b-10-band.png`）。
---

## E130 — P7 三件收尾：插件市场/安装卸载、browser_use·computer_use 运行时、横屏【已实测 + 两处如实标注】

### 1. 插件市场与插件安装/卸载（实测整条链路）

`marketplace/*` **不在浏览器白名单**（实测：`{"error":"RPC method is not available to browser clients"}`），
所以按本项目一贯口径加了受控出口 `POST /api/plugins`（patches/0093）：
`marketplaceAdd`（只接受「允许根内的本地目录」或 `https://` 来源）/ `marketplaceRemove` / `install` / `uninstall`。

**格式不是猜的，是试出来的**（官方市场 schema 没公开、github.com 在本机 DNS 不可达，只能靠解析器的报错逐个收敛）：

| 项 | 结论 | 怎么确定的 |
|---|---|---|
| 市场清单位置 | `<root>/.agents/plugins/marketplace.json` | 放别处一律 `marketplace root does not contain a supported manifest` |
| 插件项字段 | `{name, source}`，`source` **相对市场根** | 只有 `source` 时…缺字段；带上后报 `plugin source path is not a directory: <root>/hello`，据此定位相对关系 |
| 插件目录 | 需 `.codex-plugin/plugin.json`，且**必须带 `$schema`** | `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`（该 schema 可访问，字段与内置校验一致） |

**整条链路实测**：

```
marketplaceAdd → {"marketplaceName":"local-test","installedRoot":"…/mk-test/market","alreadyAdded":false}
plugin/install → {"authPolicy":"ON_INSTALL","appsNeedingAuth":[]}
plugin/installed → "id":"hello-plugin@local-test","installed":true,"localVersion":"0.0.1","enabled":true
plugin/uninstall → {}
marketplaceRemove → {"marketplaceName":"local-test","installedRoot":null}   ← 参数名是 marketplaceName（不是 name，第一次写错被拒）
```

**清理**（测试对象是我自己造的本地市场，用完必须撤）：
配置里 `[marketplaces]` 计数回落 0、`plugin/list` 空、`~/.codex/plugins/cache/local-test` 删除；
另外把测试期间被写进配置的两个信任项 `[projects."…/tmp/git-demo"]`、`[projects."…/tmp/review-probe"]` 也删掉了
（`config/read` 复查仍可解析）。

UI：设置 → 插件页（市场列表 + 添加/移除市场 + 每个插件「安装/卸载」）。`probe/settings-live.test.mjs` 现在 19 项全过，
含"列出市场名与已安装状态""有安装/卸载按钮""有添加市场输入框""没有市场时给出明确说明"。

**仍未做**：MCP 的 OAuth 登录流程。`mcpServer/oauth/login {name}` 需要一个**已配置且支持 OAuth 的 MCP 服务器**，
本机 `mcpServerStatus/list` 是空的——没有可登录对象。MCP 那页目前只有列表 + 重新加载配置。

### 2. browser_use / computer_use：特性是开的，**工具不在模型手里**（真跑回合）

先纠正上一轮的推断：`experimentalFeature/list` 里 `browser_use`、`browser_use_full_cdp_access`、`computer_use`
**本来就是 `enabled=true`**（带不带 `-c features.*=true` 都一样）——**特性开关 ≠ 工具可用**。

于是用一次真实回合问模型："有就用、没有就说原因"。结果（独立实例、未污染主会话，测试会话已删除）：

```
browser_use  → 模型自己跑 `codex mcp list` → "No MCP servers configured yet."
               明确回答：本会话工具清单里没有 browser_use，改用 curl 取回页面标题（Example Domain）
computer_use → 模型回答"没有。"，并说明它没有用 ADB/CodexBridge 之类去替代
```

结论（运行时实测）：在本机（第三方 provider + 无 MCP 服务器 + 无 CDP 后端）**这两个工具不会提供给模型**。
要真用浏览器自动化，需要自挂 MCP（Playwright / Chrome DevTools MCP）并具备可用的 Chromium + CDP 端点——
**Termux aarch64 上这条路未验证**，不当作可行结论。

### 3. 横屏/平板

- **已实测**：横屏对话视图（`~/shots/p7c-1-small.png`）、横屏终端（E123：75×12，键盘弹出 75×7，按键条在上方）。
- **静态核对**：`.settings-dialog` 用 `calc(100dvh - 46px)` + 两栏 grid（横屏够用）；
  `.side-panel-files` 是 flex 列 + `height:100%`（跟着面板高走）。
- **发现并修**：`.folder-card` 桌面规则 `min-height:430px` 在手机横屏（≈412 CSS px 高）下会**大过可用高度**
  （CSS 里 min 赢过 max）→ 卡片比屏幕高、底部按钮跑到屏外；patches/0094 在横屏把 min 也夹进 `100dvh`。
- **未做（设备原因）**：设置页/产物面板的横屏真机截图。设备锁屏后 adb 显示 `offline`（需要它解锁并授权无线调试），
  为此写了 `~/bin/adb-connect`（扫回环端口自动重连）——解锁后一条命令即可补齐。

> **补拍（2026-10-16 22:1x，用户开了无线调试之后）**：
> `~/shots/p9-landscape-chat.png` —— 横屏对话视图（2772×1280）：消息区、底部输入区（图片/文件图标、
> 权限「完全访问权限」、模型档位、发送按钮）全部正常，没有溢出或错位；
> `~/shots/p9-landscape-sidebar2.png` —— 横屏**软键盘弹出**时的样子：系统键盘带 ESC/CTRL/ALT/HOME/方向键那一排，
> 把下半屏占掉，输入区被顶上去（这正是移动端最难受的一种排布，值得留档）。
> **仍然没拍到的**：设置对话框在横屏下的样子——我用 `adb shell input tap` 找侧栏按钮时，
> 坐标偏了一格，连续两次都点空；第三次 `keyevent 4`（BACK）直接把应用退到 Termux 了。
> 我没有继续戳屏幕，因为这台手机是用户正在用的真机（而且强制横屏本身就该尽快恢复）。
> 结论：横屏的**对话/键盘**有真机截图；**设置页/产物面板**仍是静态核对（`.settings-dialog` 用
> `calc(100dvh - 46px)` + 两栏 grid，横屏够用）。

---

## E131 — ReVa（Ghidra MCP server）在本机真跑通：自编 aarch64 原生 decompiler → 真 MCP server 接进 app-server → 模型真调用【已实测】

背景：到 E129 为止 `mcpServerStatus/list` 一直是空列表，设置页的 MCP 面板**没有真实对象**可验证
（只有我们自己写的 mock elicitation server）。用户提出"试试那个能逆向一切的 ReVa，好像有 MCP 服务器"
（`cyberkaida/reverse-engineering-assistant`，ReVa = Ghidra 的 MCP server，Apache-2.0，875★）。
于是把它真装到手机上，作为 MCP 面的真实验证对象，同时给这个 App 补上"逆向工程"这类真实能力。

### 1. 先核实可行性：Ghidra 官方发行包**没有** aarch64 的原生 decompiler（证据）

只取发行包尾部（HTTP Range，最后 12 MB）读 zip 中央目录，`Features/Decompiler/os/` 下只有：

```
Ghidra/Features/Decompiler/os/linux_x86_64/decompile
Ghidra/Features/Decompiler/os/linux_x86_64/sleigh
Ghidra/Features/Decompiler/os/win_x86_64/decompile.exe
Ghidra/Features/Decompiler/os/win_x86_64/sleigh.exe
```

但两边都支持 arm64，所以"自己编"是可行路径，不是绕过：

- `Ghidra/Features/Decompiler/buildNatives.gradle` 的 `targetPlatform` 里有 `linux_arm_64`；
- 运行时枚举也认：`javap -p -c -cp Ghidra/Framework/Generic/lib/Generic.jar ghidra.framework.Platform`
  有 `LINUX_ARM_64 → linux_arm_64`（`Architecture.ARM_64`）。
  → **把自编的二进制放进 `Features/Decompiler/os/linux_arm_64/` 就会被认**。

### 2. 自编 decompiler（`~/tools/decompiler-build/`）

从发行包解出 `Features/Decompiler/src/decompile/cpp`（238 个文件），改一处 Makefile：

```makefile
ifeq ($(ARCH),x86_64)
  ARCH_TYPE=-m64
  OSDIR=linux_x86_64
else ifeq ($(ARCH),aarch64)   # ← 新增（原文件写着 TODO: need to revise to support arm64/aarch64）
  ARCH_TYPE=
  OSDIR=linux_arm_64
else
```

两个坑：

1. **`make` 的目标必须一个一个传**。`DEPNAMES` 是按 `$(MAKECMDGOALS)` 精确匹配的：
   `make ghidra_opt sleigh_opt` 两个一起传时匹配不上，会退化成 `com_*/depend`，
   而那组源文件包含 `loadimage_bfd.cc` → `fatal error: 'bfd.h' file not found`。
   分开跑 `make ghidra_opt`、`make sleigh_opt` 就正常（`ghi_opt`/`sla_opt` 两组不碰 bfd）。
2. **Termux libc++ 的 `std::__ndk1::__hash_memory` 在 Android linker 下解析不了**。最小复现（与本项目无关的 30 行程序）：

   ```
   $ clang++ -std=c++11 t.cpp -o t && ./t
   CANNOT LINK EXECUTABLE "./t": cannot locate symbol "_ZNSt6__ndk113__hash_memoryEPKvm" referenced by ".../t"
   ```

   `libc++_shared.so` 里这个符号明明是 `GLOBAL DEFAULT`（`readelf --dyn-syms` 可见），
   `LD_PRELOAD=/data/data/com.termux/files/usr/lib/libc++_shared.so ./t` 又能跑；
   头文件里它是 `_LIBCPP_EXPORTED_FROM_ABI`（`#if _LIBCPP_AVAILABILITY_HAS_HASH_MEMORY`
   在非 vendor 配置下恒为 1），没有 `#ifndef` 保护，没法用 `-D` 关掉。
   **对策**：`hash_memory_shim.cc` 用 libc++ 自己的 murmur2/cityhash 补一个定义，链接进可执行文件。
   一致性已核对：`std::hash<std::string>("abc")` 在 dylib 版与 shim 版都是 `4220206313085259313`。

链接（把 shim 一起链进去，`sleigh` 还要 `-lz`）：

```sh
clang++ -std=c++11 -O2 -Wall -Wno-sign-compare -o ghidra_opt ghi_opt/*.o ../hash_memory_shim.o
clang++ -std=c++11 -O2 -Wall -Wno-sign-compare -o sleigh_opt sla_opt/*.o -lz ../hash_memory_shim.o
```

装到 `<ghidra>/Ghidra/Features/Decompiler/os/linux_arm_64/{decompile,sleigh}` 后，**Ghidra 真跑起来了**：

```
./support/analyzeHeadless ~/tools/ghidra-proj TestProj -import /data/data/com.termux/files/usr/bin/ls
  Decompiler Switch Analysis   29.797 secs      ← 原生 decompiler 真的在工作
  Total Time                   83 secs
  REPORT: Import succeeded
```

### 3. ReVa 扩展 + 不用官方 Python 启动器的理由

- 扩展：`ghidra_12.1.3_PUBLIC_20260903_reverse-engineering-assistant.zip`（9.9 MB）→
  解到 `<ghidra>/Extensions/Ghidra/reva`。ReVa 是 **Java** 扩展（内含 `mcp-core-2.0.0.jar` + Jetty 12）。
- 官方 headless 启动器（PyPI `mcp-reva`）走 **PyGhidra/JPype**；本机 Python 是 3.14.6，
  PyGhidra 的 `jpype1==1.5.2` 在本机只带 cp39–cp313 的 aarch64 wheel → 要走源码编译，风险高。
  而服务端逻辑本来就在扩展 jar 里（`reva.headless.RevaHeadlessLauncher`），于是**直接用它**：
  自写 `reva.local.RevaServerMain`（`~/tools/reva-server/RevaServerMain.java`，构造 `RevaHeadlessLauncher(config, true, false, projectDir, projectName, null)` → `start()`），
  用 `java -cp <Ghidra 全部 jar>` 直接起。
  （用 `support/launch.sh` 那条路不行：它走 `ghidra.Ghidra`，扩展类不在 classpath 里，实测报
  `IllegalArgumentException: "reva.local.RevaServerMain" class was not found`。）
- 启动器 jar 放在 `<ghidra>/Extensions/Ghidra/reva/lib/reva-server.jar`；管理脚本 `~/bin/reva-server`（start/stop/restart/status/log），
  监听 `127.0.0.1:8080/mcp/message`（streamable HTTP），日志 `~/.codex/reva-server.log`。实测**约 45 秒内就绪**（Ghidra 初始化）。
- 手工探针：`initialize` 返回 `{"serverInfo":{"name":"ReVa","version":"1.0.0"}}`、`Server: Jetty(12.1.12)`；
  `tools/list` = **86 个工具**（`get-decompilation`、`find-cross-references`、`import-file`、`analyze-program` …）。

### 4. 接进 app-server：**不重启用户正在用的 daemon**（protocol 里就有）

```sh
codex mcp add reva --url http://127.0.0.1:8080/mcp/message
# config.toml 只多 3 行：`[mcp_servers.reva]` + `url = "…"`（diff 已核对，其余 31 行未动）
```

`probe/reva-mcp-live.mjs`（新增）走桥/app-server 实测：

- `config/mcpServer/reload` → 被接受（不重启进程）；
- `mcpServerStatus/list` → `reva` 出现，`serverInfo.name=ReVa`、`httpOrigin=http://127.0.0.1:8080`、**tools=86**、`toolsError=null`；
- **字段名与 `proto-ts` 里的类型不一致**（daemon 0.160.0）：
  `runtimeStatus`（不是 `status`）、`httpOrigin`、`serverInfo`、`tools` 是 **map**（`{name: Tool}`）而不是数组；
  且**不带 `threadId` 时 `runtimeStatus` 恒为 null**（它标的是"thread 运行时的连接态"）；
  带 `threadId` 再查 → `runtimeStatus=connected`。→ 顺带修了设置页那行（patches/0095）；
- `mcpServer/tool/call`：
  第一次漏传 `folderPath` → ReVa 回 **tool 级**校验错误（`isError:true, "required property 'folderPath' not found"`），
  这本身已证明 app-server→MCP→ReVa→Ghidra 全链在跑；补上参数后返回
  `{"folderPath":"/","items":[],"itemCount":0}`（`isError:false`）。

### 5. 模型真调用（关键：连接/特性 ≠ 工具可用，E130 的教训）

`probe/reva-model-turn.mjs`（新增）新建 thread 并起一个回合，要求模型用 `mcp__reva__*` 分析一个自建的 6.1 KB aarch64 ELF
（`~/tools/reva-test/target`，含 `add()` 与一个 djb2 `checksum()`）：

```
thread 01a144af-6ae7-7623-8f95-7529eb0e0732
  [item] mcpToolCall server=reva tool=import-file
  [item] mcpToolCall server=reva tool=analyze-program
  [item] mcpToolCall server=reva tool=get-decompilation
turn status: completed            （约 29 秒）
```

模型给回的 add 反编译结果（真来自手机上跑着的 Ghidra）：

```c
int add(int param_1,int param_2)
{
  return param_2 + param_1;
}
```

### 6. 限制与未做（如实标注，不当作已实现）

- **不随开机/前台服务自启**：JVM + Ghidra 常驻内存不小（`-Xmx4G`），要手动 `~/bin/reva-server start`；
  "APK 内一键拉起 ReVa"没做，也没验证。
- 冷启动约 45 秒；分析速度取决于二进制大小（本项目 6 KB 目标 ≈ 2.3 s，`/usr/bin/ls` 的 coreutils 全量分析 83 s）。
- 端口只绑 `127.0.0.1`，**没有开 API key 认证**（仅本机可连）。要给局域网别的设备用需自己加
  `reva.server.options.api.key`（ReVa 自己的配置项）。
- `mcpServer/oauth/login` 仍未接——ReVa 是 url 直连，不涉及 OAuth，所以这条**依然没有真实对象可验**。
- GUI 的 MCP 面板本轮只验证了**数据面**（`mcpServerStatus/list` 真值 + 新增的补丁 0095 渲染），
  **没有重新截图**；`probe/settings-live.test.mjs` 23 项仍全过。
- 原生 decompiler 是**本机自编**（与 12.1.3 发行包的 cpp 源码同版本），sha/大小：
  `decompile` 3,667,784 B、`sleigh` 957,080 B。

---

## E132 — P8 定时任务：自建本地调度 + 漏跑补跑 + 设置页，真机到点触发【已实测】

### 0. 先核实协议：**确实没有**调度面（不是"没找到"，是查过了）

- `proto-ts/ClientRequest.ts` 全量搜 `schedul*` → **0 个方法**；
- 二进制里有 `ScheduledTaskSummary` / `ScheduledTaskSchedule`（hourly / daily / weekdays / weekly 四种形态）/ `ScheduledTaskWeekday`，
  但它们只出现在 `PluginDetail.scheduledTasks` 里 —— 那是**插件的声明面**，
  没有对应的 client 方法去建/跑/暂停，也没有任何通知回传执行结果；
- `codex --help` 无 schedule/automation 子命令（只有 `cloud`，依赖官方账户）；
  `codex features list` 里 `in_app_local_automation: stable true`，但"谁执行"在桌面端是宿主应用自己 —— 在本项目里就是桥。

结论：调度、持久化、补跑、通知**全部自建**；schedule 的形态对齐上面那四种，语义上跟桌面端一致。

### 1. 调度内核 `app/automation-service.js`（新增）

| 设计点 | 做法 | 为什么 |
|---|---|---|
| 幂等键 | **时间槽** `<jobId>@<本地 YYYY-MM-DDTHH:MM>` | 一个槽只执行一次；桥被杀/重启后不会重复执行同一个槽 |
| 落盘时机 | 记录**先落盘再执行**（`status:"running"`） | "执行到一半进程没了"也在历史里留痕，不是石沉大海 |
| 补跑 | 默认 `catchUp:"runOnce"`：只补**最新**那个错过的槽，更早的记 `skipped` 并写明原因；可选 `skip`（一个不补，但**照样记账**） | 离线八小时不该一口气补八个回合；"不执行"不等于"不记账" |
| 到点判定 | 槽时间与当前差 ≤2 分钟算"按时"（trigger=schedule），否则算补跑（trigger=catchup） | 扫描 30s 一次，晚一点是正常的；差了几小时才是真补跑 |
| 并发 | 全局并发上限（默认 2），每个任务同时只跑一个 | 满了**不假装跑过**：记 skipped + 把游标退回一格，下次扫描再试 |
| 并行 | `sweep()` 启动后**不阻塞等待**回合结束 | FEATURES 要求"并行任务互不阻塞"；长回合也不会拖住别的任务的槽 |
| 卡死保护 | 每个回合有 `turnTimeoutMinutes`（默认 30），超时 → `turn/interrupt` + 记 `timeout` | 无人值守的回合不能永远挂在那里 |
| 存储 | `~/.codex/codex-webui/automation.json`（原子写 tmp+rename；解析失败改名留档 `.broken-<ts>`） | 不碰用户的 config.toml / 凭据 / 历史 |

离线单测 `probe/automation.test.mjs`（假时钟 + 假 request，**39 项全过**）覆盖：
时间表推进（daily 跨日 / weekdays 跳到周一 / weekly / hourly 对齐与限星期）、到点触发、
`turn/start` 带上的提示词与权限策略、完成后 ok+摘要+通知、**同一个槽不重复执行**、
**重启后任务/记录/游标都还在且不重复补跑**、补跑只补最新一个、`catchUp=skip` 全记账、
暂停/恢复/手动运行、执行失败如实记原因、回合超时被中断、并发上限记 skipped 并退回游标。

### 2. 桥端的出口（`server.ts`）

```
GET  /api/automation   → { now, lastSweep*, jobs[], runs[], limits{concurrency,tickMs,background,…} }
POST /api/automation   → action: create | update | remove | enable | disable | runNow | clearRuns | sweep
```

- 桥自己的受控出口（不是 app-server 方法），和 `/api/plugins`、`/api/config/write` 一样在全局鉴权之后；
  `runNow` 立刻回执（不等回合跑完，回合可能跑几分钟）。
- `initialize()` 成功后跑一次 `sweep("startup")`：桥刚起来先把"重启/离线期间错过的槽"结清。
- 回合结束靠 `turn/completed` 通知驱动（`handleCodex` 里挂钩），不轮询。
- 通知走与 `/api/notify` 同一条出口：应用在跑→原生通知，否则退回 Termux 通知。

### 3. 设置页「Automation」（patches/0096）

侧栏 Coding 组新增入口；页面给：任务列表（下次运行 / 上次结果 / **运行一次** / 暂停恢复 / 删除，删除有确认）、
创建表单（名字、提示词、工作目录、四种时间表、运行在新会话或继续某会话、补跑策略、审批策略、回合超时）、
运行记录（最近 10 条：状态、时间、摘要或跳过原因），以及**写清楚的三条保活说明**
（wake-lock / 前台服务+置顶通知 / JobScheduler 各自解决什么、不解决什么，明确写"不是『永不被杀』"）。

DOM 级验证 `probe/automation-page.test.mjs`（jsdom + 假 fetch，**31 项全过**）：
空状态不是空白、保活三条都在、创建表单字段齐全、切 weekly 才出现星期多选、
"运行一次"真的发 `runNow`、"暂停"发 `disable`、删除先确认再发 `remove`（取消则不删）、
创建请求带对名字/提示词/目录/`weekly days`、桥出问题时显示真实错误原因。
回归：`probe/settings-live.test.mjs` 26 项仍全过。

### 4. 真机端到端：**到点自己触发**（`probe/automation-live.mjs`）

在真桥上建一个"两分钟后"的任务，不做任何手动运行，等调度器自己到点：

```
20:50    创建任务 08410fd0-… 计划 20:52（daily 20:52）
20:52:22 运行记录出现：status=ok slot=08410fd0-…@2026-10-16T20:52
         trigger=schedule、threadId/turnId 齐全、摘要="自动化冒烟 ok"
         随后删除任务与记录（现场清理），14 项断言全过
```

桥日志（`~/.codex/codex-webui/bridge.log`）同一时刻的原始行：

```
[codex-webui] automation create ok
[automation] 运行 自动化冒烟（probe，跑完自动删） trigger=schedule slot=08410fd0-…@2026-10-16T20:52
[automation] 自动化冒烟（probe，跑完自动删） → ok
[codex-webui] automation notify: termux Codex ✅ 定时任务完成 — …：ok — 自动化冒烟 ok
[automation] 删除任务 …（历史记录保留） / automation remove ok / automation clearRuns ok
```

（通知走 termux 通道，因为当时 APK 没在跑、页面没注册原生通知出口 —— 这正是设计的兜底路径。）

### 5. 实测中发现并修掉的两处

1. **hourly 算不出下一次**：第一版按分钟步进 48 步，`intervalHours>1` 时根本走不到下一个整点对齐点，
   直接返回 `null`（单测第一条就抓到了）。改成从"当前小时整点"按小时步进。
2. **sweep 串行等待**：原来 `await runSlot(...)`，同一轮里第二个任务要等第一个跑完（长回合会拖到
   FEATURES 里"并行任务互不阻塞"那条）。改成启动后不等待；并发上限在 `execute()` 里**同步**占位，
   所以下一个任务立刻能看见；单测用 `concurrency:1` 钉住了"满了记 skipped 并退回游标"。

### 6. 限制与未做（如实标注）

- **不承诺"到点一定执行"**：桥是 Termux 应用进程里的普通进程（E62/E87 实测会被冻结/回收），
  桥不在时没有东西能触发。桥回来后会按上面的规则结账（不漏账、不重复），这一点界面里写明了。
- **`termux-job-scheduler` 尚未接入**：现在"把桥唤醒"仍然依赖用户打开 Termux/APK。
  JobScheduler 最小周期 15 分钟、无绝对时刻保证，适合当"兜底唤醒"，**未实现、未验证**。
- 页面里"继续某个会话"要**手填 threadId**：会话选择器没做（P3 的会话列表里已有数据，只是没接过来）。
- 定时回合**不会自动回答审批**：`default` 档下模型请求审批时回合会等到超时（记 `timeout`），
  所以无人值守通常要选"完全访问"档 —— 页面把这两档写在一起了。
- 通知带 `threadId` 深链可直达会话，但**没有**"这条通知来自哪个定时任务"的额外标识。

---

## E133 — 输入区：删掉假的相机按钮，图片入口换成图片图标（patches/0097）【已实测】

用户报告："新加的图片按钮没用，删掉它；把左边的加号图标换成图片的图标。"

**为什么确实没用（代码证据，不只是复述用户）**：APK 的
`MainActivity.WebChromeClient.onShowFileChooser`（`~/android-build/codexgui/…/MainActivity.java:115`）：

```java
Intent chooser = Intent.createChooser(params.createIntent(), getString(R.string.choose_file));
startActivityForResult(chooser, REQUEST_FILE_CHOOSER);
```

它只用 `params.createIntent()`（页面 `accept` 的映射），**忽略 `capture="environment"`** ——
没有 `ACTION_IMAGE_CAPTURE`、没有 FileProvider。所以第三个按钮和第二个"图片/视频"入口
**行为完全一样**，属于"看起来是相机、其实什么也没多做"的假入口。E129 当时写的
"起的是系统图片选择器（第一格是相机）"是真的，但**不能**当成"相机入口已实现"。

改动（patches/0097，纯 `index.html`）：

1. 删除相机 label 与 `#cameraPicker` input（页面上不再有任何 `capture=`）；
2. 图片/视频入口的图标 `plus` → `image`（"+"表达不了它是图片入口）；
   侧栏 `New chat` 的 `+` 不受影响。

验证（`probe/composer-attach-contract.mjs`，**13 项全过**）：输入区只剩两个附件入口、分别指向
`attachmentPicker`/`filePicker`、图标是 `image`/`file`、`image/*,video/*` 多选仍在、
页面上没有 `cameraPicker`、输入区没有 `capture`、输入区没有残留 `+`、侧栏 `+` 没被误伤、
图标表里 `image`/`file` 都存在、没有脚本引用已删元素、`app.js` 仍绑着两个 picker。
回归：`dom-contract-audit` / `interaction-surfaces` / `attachments-for-send` / `upload-progress-contract` /
`user-input-wiring` / `settings-live` / `automation-page` / `automation` 全部照旧通过。
真机侧（服务端渲染）核对：`curl /` 得到 `data-icon="image"` ×1、`plus` ×2（都在侧栏）、
`cameraPicker` 0 次。**未做**：真正的拍照入口（要动 APK：FileProvider + `ACTION_IMAGE_CAPTURE`）。

---

## E134 — 上传慢 + 进度条不动：根因是 base64/JSON，改成原始字节（patches/0098）【已实测】

用户报告："上传图片和文件好慢，而且没进度条了。"

### 1. 先量，别猜：桥侧根本不是瓶颈

同一份 8.49 MB 的 jpg，按旧协议（`{name,dataBase64}` 的 JSON，11.87 MB body）POST：

```
http=200 total=0.104880s upload=0.003432s
http=200 total=0.082828s upload=0.002109s
```

**桥接收 8.5 MB 只要 0.08–0.10 秒**。所以慢不在服务端，在浏览器侧那两步：
`FileReader.readAsDataURL`（整份文件 → data URL 字符串）+ `JSON.stringify`（再变成一个 11.3 MB 的
JS 字符串）——这两步都在 **WebView 主线程同步**执行，而且都会在传输前先把体积放大 33%。

### 2. "没有进度条"的机制（不是玄学）

进度条靠 `xhr.upload.onprogress` 的 `loaded/total` 更新芯片背景宽度，而代码里有个早退：

```js
xhr.upload.onprogress=(event)=>{if(!event.lengthComputable||!event.total)return; ...}
```

**字符串 body 的进度事件拿不到 `lengthComputable/length`** → 每次事件都在这里早退 →
背景层永远停在 0% → 用户看到的就是"没有进度条"。（这与 E91 记录的"三个阶段"并不矛盾：
阶段文字会变，但百分比那条进度永远不动。）

### 3. 改法

| 位置 | 改动 |
|---|---|
| `public/app.js` | `xhr.send(file)`：直接发 File 原始字节；请求头带 `content-type`（文件自身 MIME）与 `x-upload-name`（URL 编码）；删掉 `readFileAsDataUrl()`；占位芯片按 MIME 显示图片/文件图标；等桥响应时给芯片加 `.waiting` |
| `public/style.css` | `.composer-context-chip.waiting .composer-context-fill` 走条纹位移动画——本机最长的等待必须看得出"在动"而不是"卡死" |
| `upload-service.js` | 新增 `saveUploadStream()`：边收边写盘、逐块计数、**超限/空文件/中途断流都会删掉半截文件**、路径逃逸照旧拒绝 |
| `server.ts` | `/api/uploads` 按 `content-type` 分流：有 `x-upload-name` 走原始字节，否则走旧的 base64+JSON（**保留兼容**旧页面与探针） |

### 4. 实测结果

`probe/upload-raw-live.mjs`（真桥，同一份 8.49 MB）：

```
ok   旧路径（JSON+base64）仍然可用
ok   新路径（原始字节）成功
ok   新路径落盘内容与源文件逐字节一致
ok   新路径识别成 image
   同一份 8.49 MB：JSON+base64 425ms ／ 原始字节 37ms（桥侧接收）
ok   超过 25 MB 被拒且给出可读文案
ok   空文件被拒
ok   路径逃逸被清洗（落在上传目录内）
ok   没有文件名的原始上传会被当成 JSON 路径（返回可读错误而不是崩）
```

约 **11 倍**（425ms → 37ms），而且客户端还省掉了两个主线程同步操作（读 data URL、拼 11.3 MB 字符串）。

`probe/upload-stream-service.test.mjs`（离线 14 项）：内容一致、扩展名定 kind、逃逸清洗、
空文件/超限/断流都抛错、**失败不留半截文件**、5 MB 流式写入 5ms。

`probe/upload-client.test.mjs`（DOM 级 17 项，假 XHR 驱动真代码）：
`xhr.send()` 收到的是 **File 对象本身**、请求头正确、进度 50% 时背景层宽度就是 50%、
相位文字跟着变、字节发完进入 `waiting` 并显示秒数、成功后占位芯片被真附件替换、
5xx 会用同一个 File 重试一次、重试仍失败则报错并清理。

> 这个 DOM 级测试当场抓到一个我自己写坏的 bug：改完签名后 `xhr.send(body)` 里的 `body`
> 已经不存在（ReferenceError），上传会**直接失败**。只跑"桥侧能不能收"是发现不了的。

回归：`upload-service.test` / `upload-progress-contract` / `attachments-for-send` /
`p4-attachments`（走旧 JSON 路径）/ `dom-contract-audit` / `interaction-surfaces` /
`settings-live` / `automation-page` 全过。

### 5. 仍未解决的部分（不在本次范围）

- 桥**被系统冻结**时（E87，日志里 `event loop blocked for ~37206ms` 那种）上传仍然会卡在
  "等待桥响应"，客户端会重试一次并给出「no answer from the bridge (the phone may have slept)」。
  这次改动只是把"我们自己能控制的那段时间"从十几秒压到几十毫秒。
- 旧路径（base64+JSON）刻意保留，没有删除；它现在是兼容入口，不再是页面默认路径。

---

## E135 — "点开应用一直转圈，打开 Termux 就好了"：APK 把僵尸监听当成桥活着（0.3.5 修）【真机现象已解释 + 修复待用户复测】

用户报告：点开应用一直转圈加载；点开 Termux 之后立刻就好了。

### 1. 先从桥日志把现象读出来（不需要再问用户）

```
client: apk: boot: port=open ready=false termux=true runCommand=granted version=0.3.1
client: apk: boot: port open but not ready yet, waiting for the app-server
client: apk: boot: gave up after 90s (port=open)
client: apk: boot: port=open ready=false ... → ready after 4s, loading page   ← 用户打开 Termux 之后
```

同一条日志里还有桥自己的打点：`START +766ms connected (ready=true)` —— 桥真跑起来只要 **0.77 秒**。
也就是说：**不是桥慢，是那 90 秒里桥压根没在跑。**

### 2. 根因：`isPortOpen()` 把"内核 backlog 完成握手"当成了"桥活着"

`BridgeClient.isPortOpen()` 只做一次 TCP connect，注释还写着"能连上 socket 就说明进程还在"。
**这一条在进程被冻结时是假的**：Android 的 cached-app freezer 冻住 Termux 进程后，
监听 socket 还在内核里，握手由 backlog 完成 —— 端口"开着"，但没有任何代码去 accept，
HTTP 永远不会有应答。于是 `MainActivity.boot()` 走进这个分支：

```java
if (!startedBridge && !portOpen) { 启动桥 }        // portOpen=true → 不进这里
else if (portOpen) { "boot: port open but not ready yet" }   // 只上报，什么都不做
```

既不重试、也不叫醒 Termux，就在原地把 90 秒耗光。用户手动打开 Termux（= 把进程切到前台解冻）
之后，排队的意图才被执行、`.bashrc` 那条自动启动也才跑起来，于是"一点开 Termux 就好了"。

### 3. 修法（APK 0.3.5）

| 改动 | 内容 |
|---|---|
| 存活判定 | 用 **HTTP 应答**（`GET /api/health`，1.2s 超时）判断桥活没活；`isPortOpen()` 保留但注释写明"连得上 ≠ 活着" |
| 不再跳过启动 | 端口开着也照常发启动请求（僵尸监听的情况就是这样救回来的） |
| 自动解冻 | HTTP 静默满 8 秒 → **把 Termux 切到前台**（`openTermux()` + 再发一次分享启动），之后每 20 秒一次，界面显示"正在把它切到前台解冻并重新启动…" |
| 不误伤慢启动 | 只在 **HTTP 完全没应答** 时抢前台；"桥已应答、只是 app-server 还没连上"（日志里 `ready after 13s/15s` 那种）继续安静等待 |
| 回得来 | 抢过前台后，就绪时发一条原生通知「Codex 已经就绪，点这里回到应用」—— Android 12+ 禁止应用从后台把自己拉到前台，所以给一条通知，而不是硬闯或假装没这回事 |
| 失败文案 | 超时面板补一句"应用已经自动尝试唤醒过 Termux" |

### 4. 状态（如实）

- **已构建并放到** `/sdcard/Download/codex-gui/codexgui-0.3.5-20261016-212824.apk`（versionCode 自增，可直接覆盖安装）。
- **未做真机复测**：adb 现在是 `offline`（设备锁屏），装不上也点不了。这一条**不能标"已修复"**，
  只能标"根因已用日志与代码坐实、修复已构建"。请装 0.3.5 后复现一次：期望是——打开应用时若 Termux 被冻结，
  8 秒内自动把 Termux 切到前台并启动桥，界面从"正在把它切到前台解冻…"变成正常页面（或点通知回来）。

### 5. 真机复测（用户开了无线调试之后，**已实测**，0.3.5 → 0.3.7）

复现手法：`probe/zombie-listener.mjs`（新增夹具）占用 8899 但**永不回答 HTTP** ——
这正是被冻结进程对外表现出的样子（`--check` 自证：`TCP connect 成功` + `HTTP 无应答`）。
然后 `am force-stop` + `am start` 应用，观察它的判断与动作。实测链（桥日志原文，含补发标记）：

```
apk: boot: http=silent port=open ready=false termux=true runCommand=granted version=0.3.6
apk: boot: asked termux to start the bridge, intent=sent
apk: boot: no ready after 9s (http=silent) -> waking Termux        ← 认出"僵尸监听"，而不是干等
apk: escalate: launched Termux + share start (share=sent)
apk: boot: no ready after 30s (http=silent) -> waking Termux
apk: escalate: launched Termux + start requests (share=sent runCommand=sent)
apk: boot: ready after 37s, loading page                            ← 恢复（0.3.1 是 90 秒后放弃）
apk: native notification posted: Codex 已经就绪 — 刚刚唤醒了 Termux；点这里回到应用。
```

另外两项实测：

- **前台确实被切到 Termux**（`dumpsys activity activities` → `topResumedActivity=com.termux/.filepicker.TermuxFileReceiverActivity`），
  这就是"解冻"那一下；
- **正常路径没被误伤**：Termux 活着、只是桥没跑时，`http=silent port=closed` → 一次请求 → **3 秒就绪** ✓。
- **0.3.7 又加了两件事**：① `wakeTermux()` 除了分享通道**同时**发一次 RUN_COMMAND（Termux 已被我们切到前台，
  那条静默通道这时多半能生效）；② **启动阶段的日志先排队、桥起来后补发**（日志里带 `[queued while the bridge was down]` 后缀）——
  之前最该留下的那段日志恰恰因为桥没起来而丢失，这次排查就是被它坑的。

**如实说明两处不足**：

1. 被冻结时的恢复时间是 **9 秒（发现）+ 20~30 秒（恢复）**，不是一个漂亮的数字：第一次升级送出的意图
   在实测里没有立刻被执行，直到第二次升级（+30s）桥才起来；这也可能是 Termux 自身的
   `TermuxFileReceiverActivity` 需要一次交互/被系统延迟所致（**未进一步定位**）。
2. 上面 37 秒那次，我的"撤掉僵尸"时刻正好撞上应用第一次启动尝试（`Failed to start server. Is port 8899 in use?`），
   所以那一次「首次升级」是被我的测试时序搞掉的，不是应用的锅 —— 但这说明**恢复时间对时序敏感**，
   真实数字应该在 10~40 秒之间，取决于第一次尝试有没有被别的东西挡住。

---

## E136 — P8 的"兜底唤醒"其实早就在跑：先纠正我写错的结论，再把它做成界面里的真值（patches/0096 增补）【已实测】

### 1. 先纠错：我在 PLAN/FEATURES/页面里写的"JobScheduler 未接入、未验证"是**错的**

我上一轮写那条结论时**没有去查** `termux-job-scheduler -p`，只是照着"待办"抄了下来。实际一查：

```
$ termux-job-scheduler -p
Pending Job 4711: /data/data/com.termux/files/home/bin/codex-gui-watchdog
  (periodic: 900000ms) (persisted) (battery not low) (network: … NONE …)
```

这个作业是 **2026-10-15 就挂上的**（`~/bin/codex-gui-watchdog`：补 `termux-wake-lock` + 桥不在就拉起）。
它不只是"注册了"——`watchdog.log` 里 **136 次运行**，每小时 6~8 拍，而且真救过场：

```
2026-10-16 21:38:26 wake-lock ok
2026-10-16 21:38:26 bridge not ready — starting     ← 我当时正把桥停掉做复现测试
```

（那次它跑起来时桥已经由我的测试启动了，所以输出是"已经在跑（pid 30826）"。）

### 2. 于是改法不是"实现它"，而是"别再谎报"（patches/0096 增补）

| 位置 | 改动 |
|---|---|
| 桥 `GET /api/automation` | 新增 `wake` 字段（真值）：`termux-job-scheduler -p` 的作业列表 + `watchdog.log` 里**带时间戳**的最近两次运行 + 总次数。30 秒缓存，避免页面轮询时反复 spawn |
| 桥 `POST /api/automation {action:"wakeInstall"}` | 作业丢了/没注册时一键补装（复用 job id `4711`，脚本必须是 `~/bin/codex-gui-watchdog`） |
| 设置 → Automation | 保活那三条里的 JobScheduler 改成**真状态**（已注册/未注册/脚本缺失 + 最近一次运行时间），未注册且脚本在时给「立即注册」按钮；已注册时补一条说明写清"最多晚约 15 分钟，这是 Android 对周期作业的下限" |

真机数据面（刚跑的）：

```
wake.installed = True
wake.lastRun   = 2026-10-16 21:38:26 wake-lock ok ／ 2026-10-16 21:38:26 bridge not ready — starting
wake.runCount  = 136
```

页面侧 `probe/automation-page.test.mjs` 增到 **37 项**：已注册时显示真值与时间、"15 分钟下限"如实写出、
未注册时给补装按钮且真的发 `wakeInstall`、连脚本都没有时**不显示补装按钮**（不假装能装）、
并且断言页面上不再出现"尚未接入"。

### 3. 又修了一次同一类坑（第 7 次）：幂等标记跨文件共用

重跑 `patches/0096-…mjs` 时发现它把整块中文字典**又追加了一遍**（`i18n.js` 里没有 `automation-settings`
这个标记串）。已截掉重复块，并给 0096 换成**一个文件一个标记**（和 0098 一样的做法）。
现在重跑是四个 `skip`。

---

## E137 — P8 收尾：定时任务的「继续某个会话」改成真选择器（patches/0099）【已实测】

上一轮剩下的那条：定时任务选「继续某个会话」时要**手抄 threadId** —— 全界面唯一一个还在要人抄 id 的地方。

改法：切到该模式时用页面已有的 `rpc('thread/list',{limit:50,sortKey:'recency_at',sortDirection:'desc'})`
（`thread/list` 本来就在浏览器 RPC 白名单里，`server-security.js:46`）拉最近 50 条会话，显示成
**「标题/预览 · id 前 8 位」**；提交时用选中的 id 组装 `target:{mode:'continueThread',threadId}`。

失败路径是这次的重点：**拉不到列表就退回手填，并把真实原因写出来**——
空下拉框会让用户以为"我没有会话"，那是另一种谎报。UI 测试里专门给了一条"bridge said no"的用例。

验证（`probe/automation-page.test.mjs`，**46 项全过**，其中 13 项是本轮新增）：

```
ok   表单里有「继续某个会话」这个选项
ok   切过去之后弹出会话选择器，选项来自 thread/list
ok   选项是「标题/预览 · id 前 8 位」
ok   选项也覆盖只有预览的会话（无标题时不显示未命名）
ok   选择器可见 ／ 拉得到列表时手填框是隐藏的
ok   创建请求带上选中的会话 id
ok   拉不到列表时退回手填 ／ 并把真实原因写出来
ok   没选会话就提交会被拦下（并提示先选）
ok   手填的 id 也能提交
ok   任务行标出「继续会话 <id8>」
```

真机数据面核对（`POST /api/rpc {"method":"thread/list","params":{"limit":3,…}}`）：

```
会话条数: 3
 -id: 01a1367c | name: 调研可复用项目并设计 Codex CLI 手机 GUI | preview: 能否为这个codexcli做一个手机gu
 -id: 01a144cb | name: None                                   | preview: 这是什么车？
 -id: 01a144c5 | name: None                                   | preview: 只回复这几个字：自动化冒烟 ok…
```

**`name` 可能是 null**（实测三条里两条是 null）→ 选择器按 `name → title → preview → 未命名` 兜底，
上面那条断言就是钉这个的。未做：任务行只显示 id 前 8 位，**没有**把会话标题反查出来（要额外 RPC，
而且标题会变；等"任务详情页"一起做）。

---

## E138 — P8 收尾：定时回合遇到审批/提问时的处置（patches/0100）【单元+DOM 已实测；真机**没能触发**审批，如实记录】

### 1. 原来的行为（就是问题本身）

`default` 权限档（`approvalPolicy=on-request`）下，定时回合碰到审批请求时**没有任何提示**：
它一直等到 `turnTimeoutMinutes`（默认 30 分钟）超时 → `turn/interrupt` → 记录成 `timeout`。
用户既不知道有东西在等他，也不知道等的是哪条任务。

### 2. 改法

| 位置 | 改动 |
|---|---|
| `app/automation-service.js` | 新增 `onServerRequest(request)`：请求参数里都带 `threadId`（协议已核实），拿它找到**正在跑的那次运行** → 记 `run.awaiting={kind,method,requestId,at}` 并**立刻发一条带会话深链的通知**；新增 `onRequestResolved(requestId)` 清标记；运行结束时也清 |
| `app/server.ts` | `handleCodex` 里 server→client 请求到达时调 `automation.onServerRequest(message)`；`serverRequest/resolved` 时调 `automation.onRequestResolved(...)` |
| 设置 → Automation（patches/0100） | 运行记录里标出「等待你审批 / 等待你回答」；带 `threadId` 的运行多一个**「打开会话」**按钮（先关设置、再 `openThread()` 跳到那条会话去处理） |

深链是现成的：通知里带 `threadId`，点它就直接进那条会话（E128 真机验证过这条路）。

### 3. 验证

`probe/automation.test.mjs`（**48 项全过**，本轮 +11）：

```
ok   审批请求会被记到那次运行上（kind=approval, requestId=77）
ok   运行状态仍然是 running（没被当成失败）
ok   立刻发了一条带会话深链的通知（threadId=th-1，标题含"等审批"）
ok   通知里写着是哪条任务在等
ok   别的线程的请求不会误挂到定时任务上
ok   提问型请求记成 question
ok   请求解决后会清掉等待标记
ok   未知 requestId 的解决事件被安全忽略
ok   批准之后回合照常跑完
```

`probe/automation-page.test.mjs`（**53 项全过**，本轮 +3）：运行记录标出「等待你审批」、
带 `threadId` 的运行有「打开会话」按钮、点它**先关设置再打开那条会话**（断言的是真的调用了 `openThread`）。

### 4. 真机端到端：**没能触发审批**（这条要如实写）

`probe/automation-approval-live.mjs` 建了一个 `default` 档任务，让它写工作区之外的
`~/tmp/codex-approval-probe.txt`。结果：

```
ok   任务创建成功（default 权限档）
note  这次没有触发审批（本平台/本后端不为"写工作区外"发审批请求，见 E126）
ok   回合在批准后真的结束了（不是等到超时）
ok   被批准的命令真的执行了（探针文件出现）
```

模型自己也在回复里点出了这件事："这条路径在工作区之外，但这次没有触发审批就被允许执行了"。
这与 E126 的结论完全一致：**本平台沙箱不生效，后端也不为这类写入发审批请求**。

所以这条能力的**真实验证边界**是：

- `awaiting` 记账 / 通知内容 / 深链 / 清除 / 页面展示 —— **单元测试 + DOM 测试钉住**（上面两组，确定性）；
- "真实回合里后端到底在什么条件下才会发审批请求" —— **本轮没观察到**，
  探针带 `--expect-approval` 参数：等我们找到可靠触发条件（例如某个真的会问审批的 policy / provider），
  它就会把这个观察升级成硬断言。**不把"没触发"说成"已验过"。**

### 5. 限制

- 通知走与其它通知同一条出口：应用在跑 → 原生通知（可点）；不在跑 → Termux 通知兜底。
- 30 分钟超时**仍然保留**（作为兜底）：如果没人处理，回合还是会超时中断并记 `timeout`——这是有意的，
  否则一次定时任务会永远挂着。

---

## E139 — P9：首次配置引导（启动自检）+ 升级/卸载说明【已实测（真机数据面）】

### 0. 先纠错：P9 里三个"未做"其实有两个早已完成

按上一轮的教训（E136），这次先查证再动笔：

| PLAN 里写的 | 实际 |
|---|---|
| `[ ]` 原生通知出口"未做" | **已完成**：桥日志里有 `apk: native notification posted: Codex ✅ 完成 …` —— 页面注册了原生接口时通知由应用自己发，应用不在跑才退回 `termux-notification` |
| `[~]` "深链未做" | **已完成**：`apk: deep link delivered: 01a14087-…`（E128 真机验证过） |
| `[~]` "安全区细化未做" | **基本完成**：`style.css` 三处 `env(safe-area-inset-*)`（顶栏 `calc(46px + …)`、输入区四边、终端按键条底部），竖/横屏截图核对过 |
| `[ ]` 首次配置引导 | 真·未完成 → **本轮做** |
| `[ ]` 升级/卸载说明 | 真·未完成 → **本轮做**（`INSTALL.md`） |

### 1. 启动自检：两侧事实合成一张清单

一次成功启动取决于**两侧**，而没有任何一侧能单独看到全部：

- Android 侧（Termux 装没装、RUN_COMMAND 授权没有、通知有没有被禁）只有应用知道；
- Termux 侧（`~/bin/codex-gui-web` 在不在、termux-api 有没有、codex 版本、状态目录能不能写）只有桥知道。

所以：`POST /api/setup` 由应用上报它那半（内存里存 30 分钟，带时间戳）；`GET /api/setup` 现查 Termux 那半，
合成一张清单；设置 → 配置 页在最上面显示「启动自检」，缺项给**具体动作**而不是"未知"。
**App 没上报过时如实写"打开一次应用就会上报"**，不猜。

### 2. 第一次跑自检就抓到一个"静默失败"（值得记下来）

第一版用 `which <cmd>` 判断 termux-api 是否存在。结果四项**全**显示 MISSING ——
而 `termux-job-scheduler` 明明正在跑（job 4711）、`termux-notification` 刚发过通知。
原因：**本机根本没有 `which` 这个命令**，`execFileSync("which", …)` 抛错被 `catch` 吞掉 → 每项都 null。

改成直接按 Termux 的两个 bin 目录解析（`~/bin/<name>` 与 `$PREFIX/bin/<name>`）后：

```
$ curl -s http://127.0.0.1:8899/api/setup | …
bridge.ready      = True port 8899
bridgeScript      = {'path': '…/bin/codex-gui-web', 'exists': True}
termux-api        = {'wakeLock': 'termux-wake-lock', 'notification': 'termux-notification',
                     'jobScheduler': 'termux-job-scheduler', 'toast': 'termux-toast'}
codex version     = codex-cli 0.162.1
state dir writable= True
wake installed    = True runs 142
```

**教训**：`catch { return null }` 让"检查本身坏了"看起来像"被检查的东西不存在"。自检这种东西，
检查手段自己出错时必须能看出来——所以清单里现在同时给出**路径**（看得见它解析到了哪儿）。

### 3. 应用侧上报（APK 0.3.9）

`BridgeClient.reportSetup()` + `MainActivity.boot()` 里上报四项**能真查证的**事实；
查不到的不报（页面会显示"还没有上报过"）。真机验证（装 0.3.9 后启动应用）：

```
android.at      = 1792160780815
android.facts   = {"termuxInstalled": true, "runCommandGranted": true,
                   "notificationsAllowed": true, "version": "0.3.9"}
```

页面侧 `probe/settings-live.test.mjs` 增到 **32 项**（+6）：自检段落存在、启动脚本真路径、
Termux:API 三项、Codex CLI 版本、兜底唤醒的注册状态与最近运行时间、以及"应用还没上报时如实写
打开一次应用"。`patches/0101` 幂等（重跑四个 `skip`）。

> **补丁（APK 0.3.11）**：上报原本只在 `onCreate` 触发。实测发现一个漏洞：桥被重启后（上报存在桥的
> 内存里，随之消失），用户只是"切回应用"、不会冷启动 → 清单一直显示"应用还没上报过"。现在
> `onResume()` 也会报一次（很便宜，失败就算了）。真机复核：冷启动后 `/api/setup` 立刻有
> `{"termuxInstalled":true,"runCommandGranted":true,"notificationsAllowed":true,"version":"0.3.11"}`。

### 4. 升级/卸载说明（交付文档）

`/sdcard/Download/codex-gui/INSTALL.md`（新增）：包含包里有什么、首次安装的 Termux 侧前提、
**覆盖安装**（签名不变 + `versionCode` 自增；哪些数据在 Termux 侧因此不会丢；回滚为什么要先卸载）、
**卸载**（不影响 Termux 与 `~/.codex`；附上要手动清的常驻：`codex-gui-web stop`、
`termux-job-scheduler --cancel --job-id 4711`、可选的 `reva-server stop`），
以及"出问题怎么办"的对照表（转圈/等待桥响应/上传/定时任务分别看哪个日志）。

### 5. 仍未做（如实）

- 相机/录像入口：还是需要 APK 侧 `FileProvider` + `ACTION_IMAGE_CAPTURE`（E133 已删掉假入口）。
- 设置页在横屏下的截图（E130 备注里的那条）：仍未拍到。
- 自检清单里的 Termux 事实是**桥在场**时才能查；桥不在时页面读不到 `/api/setup`（会显示自检失败原因）。

---

## E140 — 被冻结的桥：恢复从 35~78 秒压到 5~8 秒（E135 遗留的尾延迟）【已实测】

### 1. 问题不是"发现得慢"，是"发现了也起不来"

E135 修好"认出僵尸监听"之后，实测恢复仍要 35~37 秒。这轮量到更难看的一个数：
用夹具（`probe/frozen-bridge-lookalike/server.ts`，文件名与 cwd 都像真的桥、端口只听不应答）跑
`~/bin/codex-gui-web start`，**78 秒**才起来。原因有两层：

1. 端口被"冻住的旧桥"占着 → 真正的桥 `spawn` 时 `Failed to start server. Is port 8899 in use?`；
2. 脚本里**已有的**分支是"进程在但 25 秒内没 ready 才判定卡死重启" —— 这个 25 秒是为
   "刚重启还没绑上端口"的正常情况留的，用在冻住的监听上纯属白等。

### 2. 改法：用 curl 的退出码把两种情况分开

**7 = 连接被拒**（端口空着，桥还没起来 —— 正常启动途中）
**28 = 连上了但没回应**（有监听、没代码 accept —— 冻住的监听，等多久都不会好）

| 位置 | 改动 |
|---|---|
| `~/bin/codex-gui-web`（`start`） | 发现有桥进程但 `health` 不就绪时，先 `curl` 一次：**退出码 28 → 跳过 25 秒等待，直接按卡死处理**；再看一眼端口是否"有人在 listen 却完全不应答"，是的话**只收掉属于本项目的 `server.ts` 进程**（按 cmdline + cwd 双重匹配），收完再 spawn |
| 同上（安全边界） | 端口被**别人的**进程占着时不杀：打印警告 + 往日志写 `port … is occupied by a silent listener that is not ours`，然后如实失败 |
| APK 0.3.10 | 升级节奏 20 秒 → **10 秒**（第一次仍在 8 秒）：第一次升级没生效时别让用户多等 20 秒 |

### 3. 实测（同一台真机）

| 场景 | 改前 | 改后 |
|---|---|---|
| `codex-gui-web start`（端口被冻住的监听占着） | **78s** | **5s** ✓（日志：`port 8899 answers nothing (curl exit 28) — treating the existing bridge as wedged`） |
| 打开应用（桥被冻住 = 桥日志里 `event loop blocked for ~117647ms` 那种） | **35~37s** | **8s**（应用自己的日志：`apk: boot: ready after 6s, loading page`） |
| 安全边界：端口被**非本项目**进程占着 | — | **不杀**，只报 `… is occupied by a silent listener that is not ours`（夹具进程事后仍在跑 ✓） |

端到端这一步特别值得记：**应用侧其实不需要"等"** —— 它开机就发启动请求，Termux 那边的脚本自己
把冻住的监听收掉再起来，6 秒就绪。所以这个尾延迟的根因一直在 Termux 侧的启动脚本，而不是 APK 的探测频率。

### 4. 仍未做

- 冻住的进程如果是 `kill -9` 也收不掉的 D 状态（IO 卡死），这条兜底无效；没遇到过，也没造出来验。
- 桥的 app-server 子进程如果自己卡住（HTTP 会应答、只是 `ready:false`），现在仍走"等 25 秒"那条正常分支
  —— 那种情况重启桥确实可能自愈，所以保留等待是有意的。

---

## E141 — 真相机入口：不用 AndroidX 也能拍照（patches 无，APK 0.3.14）【入口已真机验证；未按快门】

E133 删掉了那个"看起来是相机、其实只是图片选择器"的假入口（`capture="environment"` 被宿主忽略）。
这一轮把真的做出来。

### 1. 为什么不能用常见做法

常见做法是 `FileProvider` + `ACTION_IMAGE_CAPTURE` + `EXTRA_OUTPUT`。但本项目的 APK 是**手写流水线**
（aapt → javac → d8 → apksigner，**没有 Gradle/AGP、没有 AndroidX**），拿不到
`androidx.core.content.FileProvider`；而 `file://` 形式的 `EXTRA_OUTPUT` 在 Android 7+ 会直接抛
`FileUriExposedException`。

### 2. 改法：MediaStore + content://

1. 页面请求 `image/*` 时，往 MediaStore 插一条"待写"图片
   （`DISPLAY_NAME=codex-<时间戳>.jpg`、`RELATIVE_PATH=Pictures/Codex`，Q+ 不需要任何权限），
   拿到它的 `content://`；
2. 用 `Intent.createChooser(picker, …)` + `EXTRA_INITIAL_INTENTS` 把这个
   `ACTION_IMAGE_CAPTURE`（带 `EXTRA_OUTPUT`）挂上去 —— 选择器里就多了「拍照」；
3. 回来的结果：**选择器会给 URI，相机不给**（照片按 `EXTRA_OUTPUT` 落盘）。
   所以判据是"`uris` 为空且 `resultCode == RESULT_OK`"→ 交付我们预插的那条 `content://`；
   其它情况（改选相册 / 取消）→ **把预插的空记录删掉**，别在相册里留 0 字节垃圾。

### 3. 真机验证（做了什么、没做什么）

```
ok  输入区图标 → 选择器里出现两项：「拍照」（相机图标）+「照片和视频」   ← 截图 shots/eval-camera-chooser.png
ok  改选相册 / 取消后，日志有 apk: camera capture not used (resultCode=0, pickerUris=0)
ok  相册里没有残留：/sdcard/Pictures/Codex/ 为空（预插记录已被清掉）
```

**没有做**：我没有替你按快门 —— 那会拍到你周围的环境。所以"照片真的落盘并交回 WebView"这一段
**只有代码路径与清理分支被验证，快门之后那一步未验证**。要补这个验证很简单：你自己点一次
「拍照」拍张无关紧要的东西（比如桌面），然后看对话里有没有出现那张图。

### 4. 顺带修的两处

- `FileChooserParams` 在 Activity 里需要显式 import（匿名 `WebChromeClient` 内可直接解析，方法里不行）
  —— 编译期就报 `cannot find symbol`，没有静默。
- 同一次改动还确认了 `bin/codex-gui` 里唯一一处硬编码家目录（发布前自查时发现，已改成 `$HOME`）。

---

## E142 — 应用图标：自适应图标 + 主题化单色层 + 通知栏小图标（APK 0.3.17，设计稿 0.3.18 复建）【真机验证（系统 UI 渲染）】

原来的图标是一张 192×192 的 `res/drawable/ic_launcher.png`（`>_` 圆角方块），在 Android 12+ 上
会被系统**当成普通位图再套一层圆角**——边上多一圈、看着糊。

### 1. 设计（原创，刻意不用任何厂商 logo）

用户建议"直接用 Codex 的图标"，**没有照做**：那是 OpenAI 的商标，而这个仓库是公开的，
把厂商 logo 当自家应用图标是实打实的商标风险（可能被要求下架）。改成同气质但原创的记号：

> 深色竖向渐变底（`#1B1B20 → #050507`）+ 终端提示符 **`>_`**，青→蓝渐变描边（`#5EEAD4 → #22D3EE`），
> 圆头笔画、居中于安全区。

设计母版是 `android/design/icon-master.svg`（带 `preview-sheet.png`，一眼能看 512/144/72/48 四种尺寸）。

**第一版踩的坑**：SVG 里给两条笔画共用一个渐变，而 `_` 是**零高度**的横线 →
`objectBoundingBox` 渐变在退化包围盒上无效，整条光标不可见。改成 `gradientUnits="userSpaceOnUse"`
就正常了（这种错只有渲染出来看才发现）。

### 2. Android 侧资源（minSdk 30 → 系统一定走自适应图标）

| 文件 | 作用 |
|---|---|
| `res/mipmap-anydpi-v26/ic_launcher.xml`、`ic_launcher_round.xml` | **自适应图标**：背景+前景+单色三层 |
| `res/drawable/ic_launcher_background.xml` | 渐变底色（用 `shape` 而不是 vector 内联渐变，避开旧 aapt 的兼容问题） |
| `res/drawable/ic_launcher_foreground.xml` | 记号本体（108×108 画布，落在中央 66dp 安全区内） |
| `res/drawable/ic_launcher_monochrome.xml` | **Android 13+ 主题化图标**用；同时被通知栏小图标复用 |
| `res/mipmap-{m,h,x,xx,xxx}dpi/ic_launcher{,_round}.png` | 传统位图兜底（48/72/96/144/192） |
| `BridgeService.java` | 状态栏小图标从系统自带的 `stat_notify_sync` 换成自己的单色 `>_` |
| `strings.xml` | 应用名 `Codex` → **`Codex GUI`**（这是个第三方界面，名字别看着像官方应用） |

### 3. 验证

```
ok  aapt dump badging：application-icon-{160,240,320,480} 全部指向 res/mipmap-anydpi-v26/ic_launcher.xml
ok  application-label: 'Codex GUI'
ok  aapt list：三种 drawable + 两组 anydpi-v26 + 五档 mipmap 都在 APK 里
ok  真机「应用信息」页截图（shots/icon-appinfo.png）：圆角遮罩下居中、无裁剪、渐变正常
ok  发布树 android/ 单独构建成功（0.3.18）—— 图标资源是自包含的
```

**没做**：把启动器桌面本身截下来看（那会把用户手机切到桌面）；用系统「应用信息」页 + `aapt`
两处交叉确认渲染与打包。通知栏小图标只核对了资源与代码路径（翻用户通知栏不合适）。

---

## E143 — 点模型输出里的文件（.md）没反应：三种形态全挂，逐一堵上（patches/0102、0103 + APK 0.3.20）【真机验证】

用户报："我在 codex 应用里点它给我输出的 .md 文件，没有反应。"

### 1. 根因：三种链接形态各自坏在不同地方

| 形态（模型输出） | 渲染成什么 | 点了会怎样 | 定位 |
|---|---|---|---|
| `[x.md](/abs/path.md:12)`（带行号） | `<a data-file-reference>` | 点击处理器 `preventDefault()` 后**派发 `codex-webui:file-reference` 事件 —— 全前端没有任何监听者** → 什么都不发生 | **patches/0102** 补监听 |
| `[x.md](/abs/path.md)`（不带行号） | `<a data-file-download download>` | 点击处理器**放行**（当下载），而 APK 的 WebView **没有 DownloadListener** → 静默无反应 | **patches/0103** 改渲染 + 点击处理器；APK 侧补 `setDownloadListener` |
| `[x.md](docs/x.md)`（**裸相对路径**） | 普通 `<a href="docs/x.md">` | `parseFileReference` 只认 `/`、`~/`、`./`、`../`、`C:\` 开头 → 这种**不是引用**，点了会去导航 `http://127.0.0.1:8899/docs/x.md`（404），整个应用像被"点坏" | **patches/0103** 扩展 `parseFileReference` |

值得一提的是：**以前只测到"`<a>` 生成出来了"**（渲染层确实生成了引用），没测"点了之后发生什么"——
所以这个 bug 一直没被发现。这次补的测试专门跑整条链。

### 2. 改法

| 位置 | 改动 |
|---|---|
| `public/app.js`（0102） | 补上缺失的监听：`resolveFileReferencePath()` 负责绝对路径 / `~/` / 相对路径按会话 cwd 拼接；打开方式复用侧栏 **Files 面板**（`openFilesPanel()` + `openFilesFile()`）；**打不开就把桥返回的真实原因 toast 出来并写进桥日志**，不静默；有行号时标题标 `: 12-18` 并按比例滚到附近 |
| `public/rendering.js`（0103） | 本地路径**一律**渲染成 `data-file-reference`（不再给 `download` 链接——查看器里本来就有下载/分享/打开按钮，E128）；`parseFileReference` 接受**文件形状的裸相对路径**（要求最后一段带扩展名，避免把 `settings`、`page/2` 这种路由当文件） |
| `public/app.js`（0103） | `a[data-file-download]` 不再放行，也按"打开文件"处理（兜住旧页面/别的来源产生的标记） |
| APK（0.3.20） | `setDownloadListener`：真有下载就交给系统（以前什么都没接 → 静默）；`shouldOverrideUrlLoading`：非本机 URL 交给系统浏览器打开（以前会把整个应用变成浏览器，回不来） |

### 3. 验证

`probe/file-reference-click.test.mjs`（**14 项全过**，跑的是**真实**的点击处理器 + 监听器 + 渲染器）：

```
ok  点绝对路径会打开侧栏文件面板 / 并且真的去读那个文件
ok  相对路径按 cwd 拼成绝对路径        ok  ~/ 会展开成家目录
ok  引用带行号时标题标出范围
ok  读失败时把桥返回的真实原因 toast 出来 / 失败也写进桥日志
ok  空路径被安全忽略（不打开面板也不报错）
ok  不带行号的本地 Markdown 链接 → data-file-reference（并且不再是 data-file-download）
ok  带行号的链接 → 引用 + 行号        ok  绝对路径也是引用
ok  外链仍是外链（不当成文件引用）
```

**真机验证**（`adb` 深链打开一条含 `[PLAN.md](PLAN.md)` 的会话，点击后）：

```
client: file reference click: /data/data/com.termux/files/home/codex-gui/PLAN.md -> …PLAN.md
client: side panel view=files title=文件 … files(active)=文件
client: fs list -> 200
client: fs read -> 200
```

截图 `~/shots/ref-click-test2.png`：文件面板里正显示 `PLAN.md` 的内容（含查看器的编辑/分享/打开/下载按钮）✓。

### 4. 如实标注

- APK 侧那两处（DownloadListener、外链交给系统）是**代码 + 构建 + 安装**验证，**没有真机触发过**
  （需要一条真正的下载链接或外链；我不想在你手机上乱点陌生链接）。改动本身很小且只影响"原本什么都不发生"的场景。
- 裸相对路径的判定是**启发式**：要求最后一段带扩展名。所以 `[x](README.md)` 会当文件，
  而 `[x](settings)` 仍按普通链接处理（那更像路由）。边界在探测里写明了。
