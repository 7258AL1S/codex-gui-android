# PATCHES.md — 对上游 codex-webui 的本地改动

基座：`lezi-fun/codex-webui`（MIT，快照取自 2026-10-04 `main`，解包到 `app/`）
原则：保持改动**小而可重放**。上游更新后按本文档逐条重做，不要手工挑拣。

---

## 已应用的改动

### 0001 — 审批按钮必须来自 `availableDecisions`

**脚本**：`patches/0001-approval-decisions.mjs`（幂等，可重复执行）
**影响文件**：`app/public/app.js`（需重建 `public/app.bundle.js`）、`app/public/codex-surfaces.js`

**上游问题**：`buildApprovalModel` 里 `primary`（Allow once）和 `deny`（Deny）是**写死**的，没有用 `availableDecisions` 约束；`cancel` 在模型里恒为 `null`，从未渲染。实测服务器对一次只读命令审批给出的集合是
`["accept", {acceptWithExecpolicyAmendment}, "cancel"]`——**根本不含 `decline`**。上游 UI 在这种情况下仍然渲染并允许点击 Deny，等于发送服务器未提供的决策、扩大用户授权范围。

**改法**：
1. `hasDecision`：`availableDecisions` 缺失时保持宽松（兼容旧服务器）；存在但不是数组时**失败关闭**。
2. 新增 `explicitlyOffered()`，仅当服务器显式列出时才提供（用于 `cancel`）。
3. `base.primary` / `base.deny` / `base.cancel` 全部按可用性生成，不再写死。
4. `proposedExecpolicyAmendment` 分支补上 `hasDecision(available, "acceptWithExecpolicyAmendment")` 判断。
5. 渲染层：`primary` / `deny` 为空则不渲染按钮；新增 `cancel` 按钮；`form.onsubmit` 与 `deny` 绑定做空值保护。
6. `setApprovalWaiting` 不再依赖 `model.deny` 存在。

**验证**：`node probe/approval-model.test.mjs` → 14 项断言全过（含线上实测的那一组决策集）。

### 0002 — 桥宿主改为共享 app-server 实例

**影响文件**：`app/server.ts`（非脚本化，直接编辑）

把 `spawn("codex", ["app-server","--stdio"])` 改为
`spawn("codex", ["app-server","--listen","ws://127.0.0.1:<port>","--ws-auth","capability-token","--ws-token-file",…])`，
桥自身改为 WS 客户端连接同一实例。目的：让 CLI（`codex --remote`）与 GUI 共享**同一个** app-server 的实时状态。

新增：
- `ensureAppServerToken()` — 生成/复用 capability token（`0600`），路径 `~/.codex/codex-webui/ws-token`
- `installLauncherScript()` — 生成 `~/bin/codex-gui`（`0700`），用户无需手输 URL 或令牌
- `connectAppServerSocket()` / `consumeAppServerFrames()` — WS 传输与分帧
- `adoptExistingAppServer()` — 启动时若端口上已有可用的 app-server 则**复用而非重复拉起**（实测：陈旧实例占住端口会让朴素实现崩溃重启刷屏）
- 崩溃重启**指数退避**（1s→30s），端口冲突时打印可操作的提示
- `GET /api/appserver/attach` — 返回接入信息，**不含 token**

### 0003 — 移除 `node-pty` 依赖

**影响文件**：`app/package.json`

`node-pty` 是纯原生模块，Termux 上需要编译。它是**延迟加载**的（`terminal-service.js` 内 `require.resolve`），移除后不影响启动；集成终端将改用协议原生 PTY（`command/exec{tty:true}`，见 VERIFICATION.md E11）。
撤销该改动需要重新编译原生模块。

### 0004 — RPC 白名单扩展到已核实方法集

**影响文件**：`app/server-security.js`

`BROWSER_RPC_METHODS` 从 13 个扩展到 60+ 个，按「只读 / 会话 / 回合 / 文件系统 / 终端 / 配置扩展 / 桥内部」分组，每一项都对照生成的协议类型核对过。文件顶部写明了信任模型：桥只在回环地址可达且必须通过来源与鉴权校验；真正做到隔离的手段是让产物与预览运行在**不同源或沙箱 frame**，而不是靠限制方法。

### 0005 — 去掉硬编码的 OpenAI 模型过滤（阻塞性缺陷）

**影响文件**：`app/public/ui-core.js`（需重建 bundle）

上游 `filterAppModels` 用 `/^gpt(?:[-_.\s]|$)/i` 过滤模型目录，只保留 `gpt` 开头的模型。
本机 provider 是 DeepSeek（`deepseek-flash` / `deepseek-v4-pro`），目录被清空 →
`selectModelState` 回退成 `model: ""` → 服务端拒绝：

```
No models are available. Set `model` explicitly or check your model catalog configuration.
```

用户侧表现为**浏览器里完全发不出消息**（能回答审批卡片，因为那条路径不发 `turn/start`）。

改为按真实能力发现筛选：排除 `hidden === true` 与没有 id 的条目，不做 provider 前缀过滤。
回归测试：`node probe/model-catalog.test.mjs`（8 项，夹具是本机真实 `model/list` 载荷）。

### 0006 — 浏览器 RPC 观测日志

**影响文件**：`app/server.ts`

失败时打印 `browser rpc failed: <method> -> <error>`；`turn/start` / `thread/start` 打印到达记录。
用途：区分「请求到了服务端但被拒」与「请求根本没离开浏览器」——正是定位 0005 时缺的那一环。

### 0007 — 救回被「空模型」毒化的旧会话

**影响文件**：`app/public/app.js`（`resumeActiveThread`，需重建 bundle）

在 0005 之前创建的会话会持久化 `model: ''`，此后 `thread/resume` 会直接失败
（`No models are available…`），表现为**旧会话在界面上永久打不开**（用户截图 03:21 的错误卡片）。

`ThreadResumeParams` 本身带 `model` 字段（注释：Configuration overrides for the resumed thread），
因此改为：会话自身 `model` 为空时，用当前选中的模型做覆盖。

实测：`resume {threadId, model:"deepseek-flash"}` → 会话恢复（model 正确、3 回合可读），
随后 `turn/start` 正常。见 VERIFICATION.md E36。

### 0008 — 手机端输入区：模型名可读 + 追加失败能回退

**脚本**：`patches/0008-mobile-composer.mjs`（幂等）
**影响文件**：`app/public/app.js`、`app/public/style.css`（需重建 bundle）

1. `modelDisplay` 从「只剥 `GPT-`」改为通用剥离首个厂商段，且不足 2 字符时保留原名；
   窄屏标签上限 54/78px → 76/104px，触发器 118px → 136px。
   针对截图里 chip 只显示 `DeepS…` 的问题（E39）。
2. `turn/steer` 报「no active turn」时，清掉活动回合状态并把文本放回，重新走一次提交（走 `turn/start`），
   不再让发送键永远失败（E40）。

> 幂等性提醒：第 2 条的替换文本本身包含锚点，所以脚本用显式 `skipIf` 标记判断，
> 不能只靠「替换结果是否已存在」。早期版本没加这层，重复执行时插了两遍（已用一条去重规则修回）。

### 0009 — 空模型目录的可见空状态

**脚本**：`patches/0009-empty-model-state.mjs`（幂等）
**影响文件**：`app/public/app.js`、`app/public/i18n.js`（需重建 bundle）

目录为空时不再让 `Select model` 和裸服务端报错面对用户：
发送前拦下并解释原因，chip 显示真实空状态，i18n 增加简中条目。见 E42。

### 0010 — 安卓返回键关抽屉 + 顶部安全区

**脚本**：`patches/0010-android-back-and-safe-area.mjs`（幂等）
**影响文件**：`app/public/app.js`、`app/public/style.css`（需重建 bundle）

1. 新增 `createOverlayBackGuard`（`ui-core.js`，纯状态机、可单测）并接入抽屉：
   返回键先关抽屉而不是退出应用；界面自己关闭时同步弹掉历史，保持平衡。见 E43。
2. 顶栏/网格行/抽屉/审查面板统一改用 `calc(46px + env(safe-area-inset-top,0px))`，
   顺带修正移动端网格 48px 与顶栏 46px 的 2px 不一致。

**注意**：`overlayBack` 是 `const`（TDZ）。已核对它在文件中的声明位置（约 18k 偏移）远早于
`setSidebarOpen` 的首次调用（约 108k 偏移），因此不会出现「先使用后初始化」。

### 0029 — 附件：系统文件选择器 → 桥落盘 → `localImage` / `mention`

**脚本**：`patches/0029-attachments.mjs`（幂等，三个文件一起改）
**影响文件**：`app/public/app.js`（需重建 bundle）、`app/public/index.html`、`app/public/i18n.js`
**配套的非脚本改动**：`app/server.ts` 新增 `POST /api/uploads`；新增模块 `app/upload-service.js`

用户 2026-10-14 决策走**系统文件选择器**，因此必须经桥中转：浏览器只给字节、不给路径，而协议
要的是路径。`+` 按钮原来是死的（`toast('File attachments require the native desktop
attachment bridge.')`），现在打开选择器 → 读成 base64 → `POST /api/uploads` → 拿到
`{path,name,kind}` → 图片发 `localImage{path}`、其它文件发 `mention{name,path}`。

要点：

1. 落盘在 `~/.codex/codex-webui/uploads/`（0600）。**选这个目录是有理由的**：`homeDir` 已经是
   `/api/images/local` 的允许根，所以上传的截图不需要放宽任何路径白名单就能在会话里渲染。
2. 文件名净化后才落盘，且落点二次校验仍在目录内（穿越名 `../../etc/passwd` → 只留 `passwd`）。
3. 上限 25MB，**在解码前**按 base64 长度先拦；超限与"body 太大"给同一句可读文案。
4. 上传目录是**缓存不是存档**：桥启动时清一次，之后每小时一次，7 天前的自动删。
5. 四处出站 `input` 数组（两处 steer、`turn/start`、`queue/add`）与乐观气泡都带上附件；
   发送后清空、失败回填（沿用 E40 的恢复路径）。
6. i18n：`Attach files`（按钮不再承诺"文件夹"，目录走 @-mention）、`Upload failed`。

**验证**：`probe/upload-service.test.mjs`（36 项）+ `probe/p4-attachments.mjs` +
`probe/p4-attachment-turn.mjs` 全过，见 E82。

**踩过的幂等坑（与 0008 同类）**：`skipIf` 标记不能是"替换结果里也有的字符串"。
本例中 `input:[{type:'text',text}]` 会变成 `input:[{type:'text',text},...attachmentInputs()]`
——旧文本仍是新文本的**前缀**，所以这一条改用**出现次数断言（4 次）**而不是 `skipIf`。

### 0030 — 一行裸解引用把整个 bundle 打死（E86 根因 A）

**脚本**：`patches/0030-fix-composer-wiring.mjs`（幂等）
**影响文件**：`app/public/app.js`（需重建 bundle）

0029 保留了上游的 `document.querySelector('[data-composer-control="add"]').onclick=…`，
但 `+` 控件后来被替换成两个 `<label for=…>`（安卓上唯一可靠的触发方式，见 E85/E86），
**该属性随旧按钮一起消失** → `null.onclick = …` → `TypeError` → 模块求值中断 →
静态页面正常、全部 JS 失效。诊断代价极高（见 E86），所以做两件事：

1. 两处接线改为 `const el=…; if(el) el.onclick=…`；
2. 文件末尾追加启动指纹 `clientLog('bundle evaluated to end; controls wired, attachments bound')`。

**配套护栏**：`probe/dom-contract-audit.mjs`（改完前端必跑，用法与自检见 E86；负向对照实测 `rc=1`）。

### 0031 — 让"没反应"可测量，并给半死连接加超时（E87）

**脚本**：`patches/0031-stall-observability-and-rpc-timeout.mjs`（幂等）
**影响文件**：`app/public/app.js`（需重建 bundle）、`app/public/i18n.js`

| 改动 | 为什么 |
|---|---|
| `clientLog()` 携带 `at/pid/vis/transport`，桥侧打印 `+Δms` | 只有拿到"浏览器发出→桥收到"的延迟，才能区分"代码慢"和"进程被冻结"（实测出现 +130229ms） |
| WS 上的 RPC 20s 超时 → 拒绝 + 切 SSE | `readyState===OPEN` 但连接已死的 socket 会**永远**不回；发送闸门因此卡 45 秒，界面上就是"点发送没反应" |
| 上传立即插入「（上传中…）」占位 chip + 分步日志 | 选择器回来到落盘之间有延迟，之前这段时间界面完全无反馈 |
| 待上传的占位 chip 不进 `input` 数组 | 否则会把一个桥还没有的路径发给模型 |
| 闸门吞掉发送时弹提示 | 原来只在日志里写一行，用户看不到 |
| `openThread` 在 `thread/read{includeTurns}` 失败时回退 `thread/resume` | 有些线程这个 app-server build 答 `list_turns is not supported yet`，界面直接显示空会话 |
| `visibilitychange / pagehide / pageshow / freeze / resume / online / offline` 上报 + transport 变化上报 | 抓"页面被挂起/恢复"这一类现象 |

### 0032 — 附件"发得出去"且"上传不会永远转圈"（E88）

**脚本**：`patches/0032-attachment-send-and-upload-retry.mjs`（幂等）
**影响文件**：`app/public/app.js`（需重建 bundle）、`app/public/i18n.js`

| 改动 | 为什么 |
|---|---|
| 四处出站 `input` 与乐观气泡改用 `textPart(text)`（文本为空就不生成 `{type:'text'}` 段） | 只有附件没有文字是合法消息；原来 `if(!text)return;` 会把整次发送丢掉，界面上就是"点了没反应"（实测 `submit: finished in 0ms`） |
| 空文本且仍有附件在上传时提示 `Still uploading — wait a moment.` | 静默丢失是不可接受的 |
| 上传 45 秒超时 + 一次重试（`AbortController`） | 桥被冻结时 fetch 永不 settle，chip 永远停在「（上传中…）」；实测图片其实**已经落盘**两次 |
| `attachmentInputs()` 过滤 `pending` 占位 chip（0031 已加） | 不把桥还没有的路径发给模型 |

**协议层验证**：`turn/start` 只带 `localImage` 无文本 → 接受；rollout 里出现 `<image name=[Image #1] …>`。

### 0033 — 出站 payload 用快照，不用已被清空的状态（E89）

**脚本**：`patches/0033-send-the-snapshot-not-the-cleared-state.mjs`（幂等）
**影响文件**：`app/public/app.js`（需重建 bundle）

`submitPromptInner` 的顺序是「快照 → 清空 `state.composerAttachments` → 用 `attachmentInputs()` 组 payload」，
而 `attachmentInputs()` 读的正是被清空的状态，于是**每次发送都丢掉附件**（模型只收到 `user.text`，
chip 消失、文件留在磁盘）。修法：`attachmentInputs(list=…)` / `attachmentContent(list=…)` 接收列表，
四处出站 `input` 与乐观气泡改传快照。

**护栏**：`probe/attachment-payload-audit.mjs`（静态检查 + 反向自检，改回裸调用必须 rc=1）。

**操作提醒**：改前端**不需要重启桥**（静态文件逐请求读盘，刷新页面即可）；bun 会重命名调用点变量
（本次 `attachments`→`attachments2`），断言打在源码上。

### 0034 — 上传失败说人话 + 醒来自动重试（E90）

**脚本**：`patches/0034-upload-failure-wording-and-resume-retry.mjs`（幂等）
**影响文件**：`app/public/app.js`（需重建 bundle）、`app/public/i18n.js`

| 改动 | 为什么 |
|---|---|
| `uploadErrorText()` 把 `AbortError / timeout / Failed to fetch` 映射成「桥没有响应（手机可能休眠了），会自动重试一次」 | 原来直接把 `signal is aborted without reason` 甩给用户 |
| 失败时保留 `File` 句柄，`visibilitychange → visible` 时自动重试一次（≥8s 间隔，重试前清标记） | 设备醒来的那一刻正是该重试的那一刻；不复制 base64，内存代价为零 |
| `openThread` 的 catch 里补 `history load FAILED for <id>: …` | 冻结把历史加载打断时，界面只剩一个 `Loading conversation…`，日志里也要留下痕迹 |

### 0035 — 上传进度条画在 chip 的背景上（E91）

**脚本**：`patches/0035-upload-progress-on-the-chip.mjs`（幂等）
**影响文件**：`app/public/app.js`（需重建 bundle）、`app/public/i18n.js`、`app/public/style.css`（静态，无需重建）

| 改动 | 为什么 |
|---|---|
| 上传改走 `XMLHttpRequest`（`postUploadWithProgress`），返回 `{ok,status,json()}` 外壳 | `fetch` 拿不到上传进度，做动画就是假数据；外壳让调用点不变 |
| chip 增加 `.composer-context-fill`（背景填充层）+ `.composer-context-phase` | 用户要求"进度条在文件背景上"；三阶段：`（读取中…）` → `42%` → `等待桥响应…` |
| 待上传 chip 加 `.pending` 虚线边框；填充层只在 pending 时渲染 | 一眼看出"还没传完" |
| `updateAttachmentProgress()` 原地更新 DOM | 每次进度事件都 `renderContextTray()` 会重建其他 chip，和用户的手打架 |

**护栏**：`probe/upload-progress-contract.mjs`（markup + CSS 定位 + XHR 挂钩，带反向自检）。

### 0036 — 「等待桥响应」开始数秒（E92）

**脚本**：`patches/0036-count-the-wait-out-loud.mjs`（幂等）**影响文件**：`app/public/app.js`

用户实测：进度条瞬间满格，然后长时间停在「等待桥响应…」。量化后确认这段等待就是冻结本身
（客户端自测 12718ms，同一窗口桥自报挂起 27045ms；同样的 266KB body 用 curl 打只要 5–16ms）。
改动：`waiting for the bridge…` 后面每 500ms 追加已等秒数，四条结束路径都停表。

### 0037 — 用户气泡里显示自己发的图片（E93）

**脚本**：`patches/0037-render-user-message-images.mjs`（幂等）
**影响文件**：`app/public/app.js`（需重建 bundle）、`app/public/i18n.js`、`app/public/style.css`

| 改动 | 为什么 |
|---|---|
| `textFromInput` 接受 `text` 与 `input_text`，并剔除 `<image …>` 标记 | 服务端回声用 `input_text`，原来带图消息渲染成空气泡；标记是元数据，不该进正文 |
| 用户气泡改走 `renderUserMessage()`（正文转义 + 图片用 `renderImagePreview`） | 乐观气泡的 `localImage` 与服务端回声的 `input_image` 都要画出来，并可点开全屏查看器 |
| 图片源优先用路径、其次才用 data URL；非图片用 `isImageReference` 挡掉 | 路径走 `/api/images/local` 只要几字节，data URL 是整张图进 DOM；PDF 的 `mention{path}` 不能渲染成破图 |
| `dataset.renderKey` 缓存 | upsert 会重复调用，无脑重建会打掉正在加载的缩略图 |

**验证**：`probe/user-message-image.test.mjs`（8 项，含自检；用 app.js 的真实函数 + rendering.js 的真实渲染器跑四种真实形状）。

### 0038 / 0039 — 新对话发附件（E94 的两个根因）

**脚本**：`patches/0038-new-conversation-shows-your-message-at-once.mjs`、`patches/0039-wait-for-pending-uploads-before-sending.mjs`（均幂等）
**影响文件**：`app/public/app.js`（需重建 bundle）、`app/public/i18n.js`

| 改动 | 为什么 |
|---|---|
| 乐观气泡挪到 `await rpc('thread/start')` **之前**；之后不再 `innerHTML=''`（只清占位状态） | 新对话里 15 秒的 `thread/start` 期间界面曾是一片空白 + 输入框已清空，看起来就是"发不出去"；已有对话因为 `state.active` 早就存在，表现不同 |
| 发送时若快照里有 pending 上传，先等它们传完（≤60s，弹提示），再用 `attachmentsForSend()` 组 input | 打完字就按发送时附件还在路上，会被 `pending` 过滤掉 → 消息发了、文件没跟上、还不报错 |
| `attachmentsForSend()` = 快照 ∪ 之后完成的，去重保序 | 发送那一刻的附件可能在这之后才落盘 |

**验证**：`probe/attachments-for-send.test.mjs`（5 项；**当场抓出第一版未对快照内部去重的 bug**）。

### 0040 — 等待期间持有屏幕唤醒锁（E95）

**脚本**：`patches/0040-hold-the-screen-awake-while-waiting.mjs`（幂等）**影响文件**：`app/public/app.js`

实测：4.6KB 的 .md 回执等了 **41930ms**，同一时刻 `event loop blocked for ~41606ms`（另有 336097ms 的一次）。
新发现是**设备挂起时页面自己的计时器也停**——45 秒超时与自动重试在 41.9 秒的等待里都没能生效。

改动：`beginBridgeWait()/endBridgeWait()` 计数，在**上传在途 / 提交在途**时持有
`navigator.wakeLock.request('screen')`，等待结束立即释放；页面隐藏由浏览器自动释放，回前台若仍在等待则重新获取。
边界：挡的是自动进入 Doze，挡不住主动熄屏与 OEM 强制冻结。

### 0039 修正（回归修复）— TDZ：发送全线崩掉（E96）

0039 把"等附件传完"的检查插在 `const mentions=…,attachments=…` 之前，块里却用了 `attachments` →
`const` 的 TDZ → `submitPromptInner` 每次第一行就抛 `Cannot access 'attachments2' before initialization`，
**一条消息都发不出去**（真机日志实证）。修正为在该处读 `state.composerAttachments`（快照紧随其后、中间无改动），
从根上取消对声明顺序的依赖。

**新增护栏**：`probe/attachment-payload-audit.mjs` 增加"submitPromptInner 内的快照使用不得早于声明"检查，
负向对照实测 rc=1。TDZ 属于运行期错误，打包与此前所有静态检查都发现不了。

### 0041 — 先等附件、再判断能不能发（E97）

**脚本**：`patches/0041-wait-before-deciding-not-after.mjs`（幂等）**影响文件**：`app/public/app.js`

真机日志里 `submit: finished in 4736ms (gate released)` 却**没有任何 `turn/start`/`turn/steer` 到达桥**：
`if(!text&&!hasContext){…return}` 在"空文本 + 附件仍在传"时早退，而 0039 加的等待块在它之后，永不执行。
顺序改为：中断判断 → 模型判断 → **等附件传完** → 判断可不可以发 → 取快照 → 清空 → 发送。

**护栏**：payload 体检新增"等待块必须早于 hasContext 判断"（负向对照 FAIL）。

### 0042 — 等待超过 8 秒就说明原因（E98）

**脚本**：`patches/0042-say-why-the-wait-is-long.mjs`（幂等）**影响文件**：`app/public/app.js`、`app/public/i18n.js`

同刻实测：桥对同一份 27KB 文件只要 **2.9ms**（curl），而页面在等几十秒；两侧唤醒锁都持有仍发生
21–63 秒的挂起（累计 73 次）→ 更像 OEM 对后台应用的强制冻结。前端无法缩短它，于是改成：
等待超过 8 秒时提示一次「等待桥响应已超过 8 秒：Termux 很可能被系统挂起了。把 Termux 的省电策略设成「无限制」就能改善。」
（每页一次；日志记 `bridge wait exceeded 8s`）。

### 0045–0052 — P5 交互闭环（E113–E115）

| 补丁 | 内容 | 真机验证 |
|---|---|---|
| `0045` | 旧版 `execCommandApproval`/`applyPatchApproval`（原来回 `-32601`）+ 重复请求只出一张卡 + `serverRequest/resolved` 收卡 | 单测 + 接线测试（14 项） |
| `0046` | 审批卡片说中文（渲染处包 `t()`；带变量的标题保持英文） | ✓ 卡片变「允许运行这条命令？/ 原因 / 取消 / 允许一次」 |
| `0047` | 待答卡片在会话重绘后能回来（清掉"已不在 DOM"的记录 + 会话渲染完再恢复一次） | ✓ 重启应用后提问卡片自己回来 |
| `0048` | 补 `question`/`plug` 两个图标；**未知图标不再抛异常**（退化成问号）——缺一个名字就整卡消失 | ✓ 提问卡片与 MCP 表单从"什么都不显示"变成正常渲染 |
| `0049` | 这两张卡片的 CSS（类名齐全但**零样式**）+ 卡片内统一 `box-sizing:border-box` | ✓ 选项/按钮排版正常 |
| `0050` | 页面级 `error`/`unhandledrejection` 与每次交互应答（requestId+载荷）上报到桥日志 | ✓ 让"点了没反应"变成可诊断 |
| `0052` | **空表单可提交**：`canAccept` 原来要求 `fields.length > 0`，于是"无字段的 MCP 表单/工具授权"提交按钮从渲染起就是禁用的 | ✓ MCP 工具授权可批（pending id=4 → id=5），夹具 elicitation 表单也能提交 |
| （0051 是对同一问题的误判文件，已删除；编号留空） | | |

**新增验证资产**：`probe/approval-wiring.test.mjs`（14 项）、`probe/user-input-wiring.test.mjs`（9 项）、
`probe/icon-contract-audit.mjs`（带负向对照）、`probe/mcp-elicitation-server.mjs`（elicitation 夹具 server）。

### 0053 / 0054 — 通知改由应用自己发（E116）

**脚本**：`patches/0053-notifications-come-from-the-app.mjs`、`patches/0054-register-native-notifier-on-every-connect.mjs`（均幂等）
**影响文件**：`app/public/app.js`（需重建 bundle）

| 改动 | 说明 |
|---|---|
| `nativeNotify(title,body,tag)` + 启动注册 | 检测 `window.CodexNative.notify`（APK 注入）；存在则原生优先，浏览器退回 Web Notification |
| `maybeNotifyTaskCompleted()` 原生优先 | 回合完成时由**应用**提醒，不再依赖 agent 调 Termux |
| 桥的 `notification/native` 事件 → 原生 | agent/CLI 侧发起的提醒也走应用 |
| **每次 `bridge/status === connected` 都重新注册**（0054） | 桥侧是内存租约，重启即归零；只在启动注册一次会导致桥重启后提醒退回 Termux |

**非补丁改动**（直接编辑）：

| 文件 | 改动 |
|---|---|
| `app/server.ts` | `POST /api/notify`（agent/CLI 入口，应用在跑 → 广播 `codex/notification` → 页面 → 原生；不在 → `termux-notification` 兜底）+ `POST /api/notify/register`（租约：30 秒续、90 秒过期）；修掉 `rpcStartedAt` 的作用域错误（catch 里引用 try 内的 const，会把任何 RPC 失败显示成 `rpcStartedAt is not defined`） |
| `android-build/codexgui/.../NativeNotifier.java` | 新增：`@JavascriptInterface notify()`，渠道 `codex-app`（IMPORTANCE_HIGH），同 tag 覆盖，点击打开应用；并把结果上报到桥日志（`native notification posted`） |
| `android-build/codexgui/.../MainActivity.java` | `addJavascriptInterface(new NativeNotifier(this), "CodexNative")` |
| `~/bin/codex-notify` | 新增：参数对齐 `termux-notification`（`-t/-c/-i`），POST 到桥，失败退回 `termux-notification` |
| `~/.codex/AGENTS.md`、`~/AGENTS.md` | 两层约定都改成调用 `~/bin/codex-notify`（更具体的那层优先，必须都改） |

---

### 非补丁脚本的改动（本轮新增，直接编辑，需手工比对）

| 文件 | 改动 |
|---|---|
| `app/server.ts` | **启动时不再无条件重建前端 bundle**（bundle 比 `public/*.js` 都新就跳过；启动 8–13s → 5s，并消掉 8329ms 的 `event loop blocked`）；新增**事件循环卡顿检测**（500ms 心跳，报 `event loop blocked for ~Nms`）；每条浏览器 RPC 打印 `>> method` / `<< method Nms`（原来只有 `turn/start`、`thread/start` 有）；`/api/client-log` 打印 `+Δms`、`pid`、`vis`、`transport` |
| `app/server.ts` | 抽出 `stampIndexHtml()`，登录墙与静态两条分支都注入 `?v=<build>` + `codex-build` meta + 内联启动 beacon（`html-boot`）；新增 `shortUa()`；顶层文档请求打印 `doc … authorized=… site=…`；静态访问日志对 `/` 与 `app.bundle.js` 附 UA；`/api/client-log` 打印 `claimed-build=`，未授权时打印 `client log UNAUTHORIZED` |
| `app/public/auth-bootstrap.js` | 新增 `beacon()`：`bootstrap start build=…`、`bundle import ok`、`bundle import FAILED: …`、`bootstrap FAILED: …`；`import()` 包 try/catch 后再向上抛 |
| `app/public/index.html` | 输入区改为**两个静态输入框 + 两个 `<label for>`**：`#attachmentPicker`（`accept="image/*,video/*"`）与 `#filePicker`（`accept="application/*,text/*,.pdf,.md,.json,.csv,.zip,.apk"`，强制走文档选择器）；删掉重复的 hidden 同 id 输入框；**`data-composer-control="add"` 随旧按钮一起移除**（这正是 0030 的起因） |
| `app/public/style.css` | `.attachment-input{position:fixed;left:50%;top:50%;width:1px;height:1px;opacity:0;z-index:-1}`（留在视口内，安卓才会把选择结果交回来） |
| `~/bin/codex-gui-web`（非仓库文件） | `start` 成功后取 `termux-wake-lock`、`stop` 释放；脚本头部写清"不持锁会被 HyperOS 冻结"的实测量化结果（E87） |
| `~/bin/codex-gui-watchdog`（非仓库文件，新增） | 每 15 分钟（`termux-job-scheduler` Job 4711，`--persisted true`）：重取 `termux-wake-lock` + 桥 `ready` 不为真就 `codex-gui-web start`；日志 `~/.codex/codex-webui/watchdog.log`（自动截断 200 行）。起因见 E99：唤醒锁在桥重启时被释放且**静默** |
| `~/bin/codex-gui-web`（非仓库文件） | ① 新增 `hold_wake_lock()`：重试两次 + 打印结果（含 `timeout 10`，Termux:API 卡住时不再拖住 start），并在"已经在跑"的早退路径上也补锁；② `health_ok()` 改用 curl（原来每次 fork 一个 `bun -e`，25 次等待循环实测把一次 start 拖到 ~170 秒，现在 0 秒） |

### 0043 — 页面可见期间保持屏幕常亮（E100）

**脚本**：`patches/0043-keep-the-screen-awake-while-the-page-is-open.mjs`（幂等）**影响文件**：`app/public/app.js`

唤醒锁与省电策略都正常时仍出现 158s / 167s / 230s 的挂起，且都落在"没人动手机"的窗口；
而主动操作手机的测量漂移全为 0 → 真正的变量是**屏幕熄灭后的设备睡眠**。
改为：页面可见即持有屏幕唤醒锁，隐藏即释放（切走/熄屏/关标签立刻恢复）。
代价：看着页面时屏幕不自动灭。日志 `screen wake lock held (page visible)`。

### 0044 — WebView 里没有 Notification，不许裸用（E102）

**脚本**：`patches/0044-webview-notification-guard.mjs`（幂等 + 自带静态自检）
**影响文件**：`app/public/app.js`（需重建 bundle）

装机首测时 bundle 在 WebView 里求值即崩：`Notification is not defined`。根因是
`syncTaskNotifySettings()` 裸读 `Notification.permission`，它在顶层接线块上被调用，
且 `codex-webui-task-notify=true` 让 `&&` 不短路。修法：`notificationSupported()` 统一守卫，
自检禁止再出现裸用。

**护栏**：`probe/webview-compat-audit.mjs`（逐行检查 WebView 缺失 API 是否有守卫）。

### APK 侧（`~/android-build/codexgui/`，非补丁）

| 改动 | 为什么 |
|---|---|
| `MainActivity` 补 `setOnApplyWindowInsetsListener`（systemBars/displayCutout 与 ime 取大者做 padding） | targetSdk 35 强制 edge-to-edge，而 `env(safe-area-inset-*)` 在 WebView 里恒为 0 → 输入区被手势条压住（截图可见） |
| `build.sh` 每次构建 `versionCode` 自增 + 文件名带秒级时间戳 | 否则覆盖安装会被 Android 拒绝；也便于区分迭代 |
| 失败面板：检测 `com.termux.permission.RUN_COMMAND`，缺则给「打开本应用设置」按钮 | 首次配置最容易卡在权限上，别让用户猜 |

### 桥侧：`mention` → 文本路径（E103，非补丁脚本的改动）

`app/server.ts` 新增 `rewriteMentionsForModel()`：任何带 `input` 数组的 RPC，
把 `{type:"mention",name,path}` 改写成 `{type:"text",text:"附件（本地路径，可直接读取）：<path>"}`。

**为什么必须这么做**：该 app-server 接受 `mention` 却不把它送进模型上下文——
实测 `turn/start` 后该回合的用户消息是 `[]`，模型答"没有收到具体任务"；
`localImage` 则正常（E88）。这是**当前后端能力缺口**，桥侧兜住；等它真正支持就要删掉这层。

验证：raw-rpc 与经桥的 `/api/rpc` 两条路径下，rollout 的用户消息都出现了该路径文本。

---

## 重放顺序

### 0010–0029（重放顺序）

| 补丁 | 内容 | 影响的文件 |
|---|---|---|
| 0010 | 安卓返回键先关抽屉（`createOverlayBackGuard`）+ 顶部安全区统一 `calc(46px + env(...))` | `app.js`、`style.css` |
| 0011 | 折叠态命令标签改走 `t()`，并补上缺失的 `"Ran"` 词条（E45） | `app.js`、`i18n.js` |
| 0012 | 连接时 `restorePendingRequests()`：把仍未应答的审批/提问重新渲染成卡片（E54） | `app.js` |
| 0013 | `createSubmitGate()` 单飞闸门（E55）；`submitPrompt` 包一层，原函数改名 `submitPromptInner` | `app.js`、`ui-core.js` |
| 0014 | 线程行「⋯」菜单：重命名 / 分叉 / 归档（E56） | `app.js` |
| 0015 | 补齐 0014 的图标、样式与简中词条 | `app.js`、`style.css`、`i18n.js` |
| 0016 | 侧栏搜索改为防抖调用服务端 `thread/list{searchTerm}`（E56） | `app.js` |
| 0017 | 修「行菜单被祖先裁剪」——弹层只露出第一项（截图发现） | `app.js`、`style.css` |
| 0018 | 已归档视图：侧栏可切「进行中 / 已归档」，行菜单据此显示「恢复」（E58） | `app.js`、`index.html`、`style.css` |
| 0019 | 补上 0018 漏掉的两条简中词条（0018 的幂等标记撞了上游已有词条） | `i18n.js` |
| 0020 | 置顶/取消置顶 + 侧栏「置顶」分组（E59/E60） | `app.js`、`style.css`、`i18n.js` |
| 0021 | 把分区移动改成运行时可认的 `thread/section/move`（类型里写的是 `threadSection/move`） | `app.js` |
| 0022 | 置顶分组排到最前（原排序规则让「当前项目」先截胡） | `app.js` |
| 0023 | 行菜单新增「压缩上下文」（`thread/compact/start`，E61） | `app.js`、`i18n.js` |
| 0024 | composer 的 Default / Plan 模式 chip（E66/E67） | `app.js`、`index.html`、`style.css`、`i18n.js` |
| 0025 | 修模式参数：`collaborationMode.settings.model` 必须是字符串 | `app.js` |
| 0026 | 运行中显示「排队」按钮（`thread/queue/add`，E72） | `app.js`、`index.html`、`style.css`、`i18n.js` |
| 0027 | 排队项必须带 `clientUserMessageId`（E73） | `app.js` |
| 0028 | 项目叠加分组：有 `project/list` 就按项目分组，没有就保留按 `cwd`（E80/E81） | `app.js` |
| 0029 | 附件：系统文件选择器 → `POST /api/uploads` → `localImage` / `mention`（E82） | `app.js`、`index.html`、`i18n.js` |

> 0013 的坑：E40 的兜底在提交**内部**递归调用 `submitPrompt`，套上闸门会被自己拦住
> （E40 的修复会静默失效），所以那处改为直调 `submitPromptInner`。
> 给带自调用的函数加单飞保护时，务必一并处理内部调用。

> 0029 的坑（**与 0008 同类，务必照做**）：`skipIf` 不能是"替换结果里也包含的字符串"。
> `input:[{type:'text',text}]` → `input:[{type:'text',text},...attachmentInputs()]` 之后，
> 旧文本仍是新文本的前缀，于是这一条不用 `skipIf`，改用**断言出现 4 次**。

### 非补丁脚本的改动（直接编辑，需手工比对）

| 文件 | 改动 |
|---|---|
| `app/server.ts` | 桥宿主改为 WS 共享实例；`/api/appserver/attach`；`/api/requests/pending`；`/api/health` 增加 `ready`；浏览器 RPC 观测日志；启动器生成模板（含自动拉起桥）；子进程 SIGKILL 升级与端口死实例清理 |
| `app/server-security.js` | RPC 白名单扩展到 60+；配置密钥后回环不再免鉴权 |
| `app/request-registry.js` | 新增（纯状态机，P2 第二/三项） |
| `app/public/ui-core.js` | `filterAppModels` 去掉 `^gpt` 硬过滤；新增 `createOverlayBackGuard`、`createSubmitGate` |
| `app/package.json` | 移除 `node-pty` 依赖 |
| `app/public/index.html` | viewport 增加 `interactive-widget=resizes-content` |

```sh
# 1) 解包上游快照到 app/
tar xzf cw.tar.gz && mv codex-webui-main app
# 2) 依赖（去掉 node-pty）
cd app && npm install --no-audit --no-fund
# 3) 补丁 0001（幂等）
cd .. && node patches/0001-approval-decisions.mjs
# 4) 重建前端 bundle
cd app && bun build public/app.js --target=browser --outfile=public/app.bundle.js
# 5) 0002 与 0004 需要手工比对本文件说明后重新应用
```

### 0056 — 附件消息渲染成一行芯片（E119）

**脚本**：`patches/0056-attachment-path-chip.mjs`（幂等，含 CSS，无需重启桥，重建 bundle 即可）
**影响文件**：`app/public/app.js`、`app/public/style.css`、`app/public/i18n.js`

桥把文档附件写成固定句式「附件（本地路径，可直接读取）：<绝对路径>」(server.ts:568)，
那是一个 250+ 字符、**没有空格**的长串；用户气泡是 `white-space:pre-wrap` 且没有 `overflow-wrap`，
于是横向冲出卡片、右半边被裁掉；补上折行后又变成 7 行、每行几个字符（E119 的两张真机截图）。

| 改动 | 说明 |
|---|---|
| CSS 兜底 | `.user-message{overflow-wrap:anywhere;word-break:break-word}`、`.user-message code{…break-all}`（这两条原先是我直接编辑 style.css 加的，现在收进脚本，重放不会再漏） |
| 芯片渲染 | `userMessageBody()` 逐行识别附件句式 → `userAttachmentChipHtml()`：图标 + 文件名 + 「路径」；点一下展开完整路径（提示变「收起路径」） |
| 认领本地气泡 | `claimOptimisticUser` 用 `textContent` 比对，芯片会改 `textContent` → 原文存 `dataset.rawText`，优先用它 |
| 事件委托 | 展开/收起挂在 `document` 上（芯片是 `innerHTML` 生成的，重渲染不必重新绑定） |
| 词条 | `Path`→「路径」、`Collapse path`→「收起路径」 |

**只动渲染层**：发给模型、写进历史的文本仍是完整路径。

### 0057 — 折叠态的附件名也收短（E119 收尾）

**脚本**：`patches/0057-shorten-attachment-name.mjs`（幂等；既能从 0056 的原始状态插入，
也能把"36/14/18"的旧参数升到"26/12/13"）
**影响文件**：`app/public/app.js`、`app/public/style.css`

上传文件名常是 70+ 字符（时间戳 + 哈希），折叠态照抄会把气泡又拉成三行乱码似的哈希。
改成「头 12 + … + 尾 13」= 26 字符：**33 字符时真机仍折两行**（`~/shots/e119-m.png`），
26 字符正好一行（`~/shots/e119-r.png`）；展开时隐藏文件名（路径本身以文件名结尾）。

### 0058 — 桥的 gzip 缓存按 mtime 失效（E120）

**脚本**：`patches/0058-gzip-cache-by-mtime.mjs`（幂等，**改的是 `app/server.ts`，要重启桥**）

缓存失效条件只有 `compressed.size !== body.length`，而注释里写的 mtime 从没参与判断。
两次构建**长度恰好相同**时（只改两个数字），桥会一直重放旧 gzip —— 磁盘是新的、日志说读了新文件，
发出去的却是旧字节。E119 排查里实测到：`disk has26 true / served has26 false`，
且 `grep -rl 'name.length <= 36' ~/` 只命中 curl 输出（旧字节根本不在磁盘上）。
修法：缓存条目带 `mtimeMs` + 日志加 `mt=`。

### 重放顺序（新增）

| 补丁 | 内容 | 影响的文件 |
|---|---|---|
| 0056 | 附件消息渲染成芯片（含 `overflow-wrap` 兜底） | `app.js`、`style.css`、`i18n.js` |
| 0057 | 折叠态文件名收短到 26 字符、展开时隐藏文件名 | `app.js`、`style.css` |
| 0058 | gzip 缓存按 mtime 失效 + 静态日志 `mt=` | `server.ts`（需重启桥） |

> 0056/0057 之后必须重建 bundle；0058 之后必须 `~/bin/codex-gui-web restart`。
> 改完后**先看桥日志里的 `mt=`**（或 `curl -s --compressed http://127.0.0.1:8899/app.bundle.js`
> 对一下内容），再断言"改动生效"——E120 就是这么咬人的。

## P6（文件 / Git / 审查 / 终端）—— 0059–0075

这一轮把 P6 的三块面板与撤销链路做完。**后端来源分三类**，每处的边界都写在对应文件头：
app-server 提供的（`fs/*`、`command/exec` 的 PTY）、上游前端已有的（changes/review 面板）、
本项目自己实现的（Git 操作、文件面板接线、diff 合成、撤销的回源）。

### 0059 — 终端改用协议 PTY（去掉 node-pty）

**脚本**：`patches/0059-terminal-over-the-protocol-pty.mjs`（改 `server.ts`，需重启桥）
新增 `app/protocol-terminal.js`；`/terminal` WebSocket 的页面契约**保持不变**。
node-pty 在 Termux aarch64 装不出来（早已从 package.json 移除），所以终端一直是坏的——
协议里的 `command/exec{tty:true}` 是真 PTY，行为先用 `probe/pty-exec.mjs` 对着真 app-server 验过。
顺带：`command/exec` 的最终响应要等进程退出，所以 `request()` 加了可选 `timeoutMs`（0 = 不超时）。

### 0060–0065 — Git 面板

| 补丁 | 内容 |
|---|---|
| 0060 | 桥开 `POST /api/git {action,cwd,…}` → `app/git-service.js`（argv 直传、不走 shell、路径与分支都对真实状态校验、失败带 git 原始 stderr） |
| 0061 | 侧栏 Git 面板（分支/上游、Staged/Changes/Untracked 三段、提交、worktree 段、确认弹层）；launcher 多一项 Git |
| 0062 | Fetch 按钮 + 打开面板时尽力 fetch（`ahead/behind` 用的是本地 remote-tracking ref，不 fetch 就是旧值） |
| 0063 | 对比度修复（`--app-bg` 不存在 → 白底白字）+ 面板诊断日志 |
| 0064 | `.side-panel-git[hidden]{display:none}`（`display:flex` 会盖掉 `[hidden]`） |
| 0065 | 行内动作按钮走词条表（原来显示成英文 `stage`/`discard`） |

### 0066 — 手机端终端辅助按键

**脚本**：`patches/0066-terminal-mobile-keys.mjs`
手机没有 Ctrl/Tab/Esc/方向键。按键行把字节直接写进 pty（与 xterm 的 `onData` 同一条路），
只加在侧栏终端（手机入口），底部面板仍按硬件键盘用。

### 0067–0069 — 文件面板

| 补丁 | 内容 |
|---|---|
| 0067 | 桥开 `POST /api/fs {action(cwd)}` → 协议 `fs/readDirectory` / `fs/readFile` / `fs/writeFile` / `fs/getMetadata`；读取 2 MB 上限（`getMetadata` **不返回大小**，所以用本地 stat 预检 + 读后复核）；搜索复用 `searchWorkspaceFiles`；侧栏文件面板（搜索 + 上级 + 列表 + 查看/编辑/保存） |
| 0068 | 补上 0067 被幂等标记撞车跳过的四步接线（`kind==='files'` 上游也有） |
| 0069 | 打开文件后查看器独占面板（原来被排在整页目录下面，等于打不开） |

### 0070–0075 — 文件撤销链路（E122）

| 补丁 | 内容 |
|---|---|
| 0070 | `unifiedDiffFromFileChanges`：add/delete 的 `diff` 是**整份内容**，要自己补 hunk 头与 `+`/`-` 前缀，并保证补丁以换行结尾 |
| 0071 | 撤销按钮的点击诊断（点了要能看见：按钮是否 disabled、动作是什么） |
| 0072 | 撤销时 store 未命中 → **回源重建**（`thread/read{includeTurns}` → 同一套合成）再重试 |
| 0073 | `reviewRoots` 覆盖真实工作区（原来只取 `defaultCwd`，项目目录一律 `outside allowed roots`） |
| 0074 | 合成前按仓库根把**绝对路径**裁成相对路径（`git apply` 只认仓库内相对路径） |
| 0075 | 读会话时的补录钩子 `recordReviewDiffsFromRpc` 也走同一套（三条入口，改两条不够） |

> **重放顺序**：0059 → 0060 → 0061 → 0062 → 0063 → 0064 → 0065 → 0066 → 0067 → 0068 → 0069 →
> 0070 → 0071 → 0072 → 0073 → 0074 → 0075。
> 改前端后 `bun build public/app.js --target=browser --outfile=public/app.bundle.js`；
> 0059/0060/0067/0072–0075 改的是 `server.ts`（或它 import 的模块）→ **要重启桥**。

### 非补丁改动（本轮）

| 文件 | 改动 |
|---|---|
| `app/public/style.css` | `.icon-button[hidden]{display:none}`——`.icon-button` 自带 `display`，同样会盖掉 `hidden`（与 0064 同一类坑；文件面板的"保存"按钮靠它藏得住） |
| `app/terminal-service.js` | 文件头写明 `createTerminalSession`（node-pty 版）已废弃，只剩两个纯函数还在用 |
| `app/public/codex-surfaces.js` | `unifiedDiffFromFileChanges` 由 patches/0070 改写（前端与桥共用这一份） |

## 0076–0080 — 启动路径：把"启动桥很慢"的三个原因修掉（E124）

用户报"启动桥又变得很慢，一直等待"。App 上报 `ready after 14s / 23s`，而单独起 app-server 只要 615ms
——问题在桥自己的启动路径上。五个补丁：

| 补丁 | 内容 | 验证 |
|---|---|---|
| 0077 | **启动阶段打点**：`START +Nms <阶段>`（模块载入 → adopt → spawn → socket → initialize → ready）。这类"启动慢"的问题必须能自己在日志里回答，不能靠事后拼时间线 | 一次普通启动即可读出各段耗时 |
| 0076 | `startCodex()` **单飞闸门**：adopt 的 1.2 秒窗口里页面重连的 RPC 会各自触发一轮 "adopt→spawn"，几个 app-server 抢同一端口，桥的兜底逻辑还会把自己刚起的那个杀掉重起 | 并发 3 次 `start`：1 个 start 标记、1 次 spawn、0 冲突、0 杀进程 |
| 0078 | 孩子报 "listening on" 时**立刻连**（重置退避、清掉退避定时器、丢掉未 OPEN 的旧 socket） | — |
| 0079 | **不再等 stdout**：管道下 stdout 是块缓冲，那行 "listening on" 晚 6 秒才到；改成每 200ms 探端口 | 启动打点里 spawn→connected 从 6027ms 降到 ~350ms |
| 0080 | **fast adopt probe**：先用 HTTP `/readyz`（500ms 超时）判断"端口上有人吗"，没人立刻 spawn；不再拿 WebSocket 干等 1.2 秒 | adopt 判定 1210ms → 5ms |

**结果**：桥 `ready` 从 7241ms → ~353ms；`codex-gui-web start` 从 8720ms → ~1.5s；
App 的 boot 从 `ready after 14s/23s` → **`ready after 1s`**。连续 3 次重启均稳定。

### 非补丁改动（本轮）

| 文件 | 改动 |
|---|---|
| `~/bin/codex-gui-web`（非仓库文件） | `start-lock` **单飞锁**（陈旧锁 2 分钟失效）：App 每 60 秒巡检、`.bashrc` 每个 shell、手动 start 三个来源并发时只允许一个真正去起进程；拿到锁后**再确认一次**是否已就绪（否则等锁者会在拿到锁后接着起第二个）。`restart` 整段（停→起）持锁 |

## 0081–0084 — P0–P6 残项收口（E125）

用户要求"先把前边能修的修了"。这批是计划里还挂着的功能缺项，逐个收口：

| 补丁 | 内容 | 验证 |
|---|---|---|
| 0081 | 横屏终端：宿主 `min-height` + 面板可滚动 + 按键条挪到上方（横屏+键盘时原本被挤成一条缝）；终端 resize 进日志 | 真机三读数：竖 52x38 / 横 75x12 / 横+键盘 75x7 |
| 0082 | 会话级等待徽章：侧栏行按 `status.activeFlags` 显示「等你审批 / 等你回答」 | `probe/waiting-flags.mjs` 逼出真实 `waitingOnUserInput` + 真机截图 |
| 0083 | `ready` 反映 draining：请求里一旦出现 draining → not-ready + 广播 + 重建实例（10 秒抖动保护） | 故障注入：not-ready ✓、568ms 自动重建 ✓；**但 draining 分支本身未触发**（本机 build 排空复现不出来）→ `[~]` |
| 0084 | **审查目标**（`review/start` 四种 `ReviewTarget`）+ **行内定位**（`memoryCitation` 芯片 → 打开文件并滚到该行） | 真跑一次 `uncommittedChanges` 审查回合；四种载荷单测；UI 真机可见；引用芯片仅单测（provider 不返回该字段） |

配套的新探针：`experimental-api-ab.mjs`（P0 的 `experimentalApi` A/B）、`waiting-flags.mjs`、
`queue-semantics.mjs`（P4 排队语义 9 项）、`review-targets-citations.test.mjs`（11 项）。

## 0085–0086 — P7 第一批：设置页真数据 + 受控配置写（E126/E127）

| 补丁 | 内容 |
|---|---|
| 0085 | ① 把 `config/value/write` / `config/batchWrite` 从**浏览器白名单摘掉**，改由桥的受控出口 `POST /api/config/write`（只允许 `approval_policy`/`sandbox_mode` + 枚举校验 + 单键写入）；② 设置页填真数据：配置页（`config/read`、`permissionProfile/list`，**并把"本平台沙箱不生效"的实测结论写在最显眼处**）、账户页（第三方 provider 的真实原因）、插件页（`plugin/installed` + `mcpServerStatus/list`）、技能页（`skills/list`）、钩子页（`hooks/list`）；③ 平台不可用页（浏览器自动化/电脑操作/云任务/云环境/连接器/worktree/Git/归档）给出**具体原因与替代路径**，替换掉 "Not configured" 占位 |
| 0086 | 修上游手机端缺陷：设置里点条目只改高亮、不切内容页（`setSettingsPage` 没切 `dialog.dataset.mobilePage`），观感是"点了没反应" |

配套：`probe/sandbox-enforcement.mjs`（沙箱四种测法）、`probe/settings-live.test.mjs`（jsdom，16 项）。

**安全口径变化**：浏览器不再能写任意配置键；要改配置只能走两个被白名单化的键，且由用户点击 + 确认弹层触发。
本轮为验证写同值时用真实配置做过一次幂等写入（值=原值），文件 md5 前后一致。

## 0087–0090 — P7 第二批：产物动作、实验特性页、通知深链（E128）

| 补丁 | 内容 | 验证 |
|---|---|---|
| 0087 | 桥开 `POST /api/files/action`（`termux-open --view/--send` + 复制到 `/sdcard/Download/codex-gui/`，路径过允许根校验）；文件面板：图片内联预览（`/api/images/local`）+ 打开/分享/存到 Download 三个按钮 | `probe/files-action.test.mjs` 8 项；真机截图 |
| 0088 | 设置里新增「实验特性」页：列真实开关（name/stage/enabled/default），并**如实写明本构建忽略 `experimentalFeature/enablement/set`**（实测返回空 enablement、状态不变）→ 不做假开关 | `probe/settings-live.test.mjs` 新增 5 项（含"没有提供开关按钮"） |
| 0089 | 深链 APK 侧：`NativeNotifier.notify(title,body,tag,threadId)`（保留 3 参重载）、PendingIntent 带 extra、`MainActivity` 在冷启动/`onNewIntent`/`onPageFinished` 把 id 交给页面；桥的 `notification/native` 载荷带 `threadId` | 真机：点通知跳到目标会话 |
| 0090 | 深链页面侧：`nativeNotify(...,threadId)` 透传、`notification/native` 读 `threadId`、定义 `window.codexDeepLinkOpen` | 同上 |

> 0088 又踩了一次**幂等标记撞车**（标记 `renderExperimentalFeatures(rows)` 出现在补丁自己追加的代码里 →
> 两步被整段跳过）。这是第四次（0018 / 0067 / 0088），脚本里的标记已改成"补丁引入的独特字符串"。
> 0090 也踩到一个：页面用 `api.notify.length>=4` 判断新老 APK，而 Java 桥接对象的方法 `length` 实测是 0 →
> 改成"先按 4 参调用、抛异常再退回 3 参"。

## 0091–0092 — P7 第三批：HTML 预览、拍照、MCP 重载（E129）

| 补丁 | 内容 | 验证 |
|---|---|---|
| 0091 | ① `GET /api/files/preview`（按扩展名给 content-type + `inline` + **`CSP: sandbox`**）；文件面板「预览」按钮 → 侧栏浏览器面板；② 拍照入口：`accept="image/*" capture="environment"` 的隐藏 input + 相机按钮（**不改 APK**）；③ 设置 → 插件页加「重新加载 MCP 配置」→ `config/mcpServer/reload` | 预览：`curl -i` 看响应头 + 真机在浏览器面板里显示本地 HTML；拍照：真机起系统图片选择器（第一格是相机）；MCP 重载：接口返回 `{}` |
| 0092 | 修 P6 遗留 bug：文件面板搜索结果**点不开**——桥返回的是工作区相对路径，面板当绝对路径用 → ENOENT。按工作区根补成绝对路径，并区分 `kind==='folder'` | 真机：搜索 → 打开成功 |

> 0091 里连着踩了两个"面板自己会覆盖"的坑：直接写 `#browserFrame.src` 会被面板渲染覆盖（停在空态）；
> 传相对 URL 会被地址解析器当成主机名（变成 `https://api/files/…`）。改用面板自己的 `navigateBrowser()`
> 并给绝对 URL 才对。

> 另：`inlineVisualization` 不是图表，是**实时语音** UI 的展示层（`ThreadRealtimeBemItemPresentation`），
> 本构建无音频后端（E20）。FEATURES 里那条已更正为"不属于本机"。

## 0093–0094 — P7 第四批：插件市场/安装卸载、横屏高度夹子（E130）

| 补丁 | 内容 | 验证 |
|---|---|---|
| 0093 | 桥开受控出口 `POST /api/plugins`（`marketplace/*` **不在浏览器白名单**，实测被拒）：`marketplaceAdd`（只放行「允许根内本地目录」或 `https://`）/ `marketplaceRemove` / `install` / `uninstall`；设置 → 插件页加市场列表、添加/移除市场、每个插件「安装/卸载」 | 整条链路实测：加市场 → 安装（`authPolicy:ON_INSTALL`、`installed:true`）→ 卸载 → 移除市场；`settings-live.test.mjs` 19 项全过；残留（`[marketplaces]`、插件缓存目录、两条测试用 `[projects]` 信任项）已清 |
| 0094 | 横屏高度夹子：`.folder-card` 桌面规则 `min-height:430px` 在手机横屏（≈412 CSS px 高）下大过可用高度（min 赢 max）→ 卡片比屏幕高；横屏把 min 也夹进 `100dvh` | **静态修复**，真机横屏截图待设备解锁后补（PLAN 已记） |

> 插件格式是**试出来的**（官方市场 schema 未公开、github.com 在本机 DNS 不可达）：
> 清单固定放在 `<root>/.agents/plugins/marketplace.json`；插件项 `{name, source}`，`source` 相对**市场根**；
> 插件目录需要 `.codex-plugin/plugin.json` 且**必须带 `$schema`**
> （`https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`，该 schema 可访问且与内置校验一致）。
> `marketplace/remove` 的参数名是 `marketplaceName`（不是 `name`）。

## 0095 — 设置页 MCP 行按 daemon 真实字段渲染（E131）

| 补丁 | 内容 | 验证 |
|---|---|---|
| 0095 | 真接上 MCP server（ReVa）后暴露：daemon 0.160.0 的 `mcpServerStatus/list` 返回 `runtimeStatus` / `httpOrigin` / `serverInfo` / `tools`(**map**)，而页面原来只读 `item.status || item.state` → 真实数据渲染成 `reva·?`。改为：状态优先 `runtimeStatus`（缺失时显示"配置已加载"并加一行说明 runtime status 是 per-thread 的）、工具数按 map/array 两种形态计、附带 `serverInfo.name` | `bundle` 重建；`probe/settings-live.test.mjs` 23 项全过；真值来自 `probe/reva-mcp-live.mjs`（86 tools） |

## 0096 — P8 定时任务：调度内核 + 桥出口 + 设置页（E132）

| 补丁 | 内容 | 验证 |
|---|---|---|
| 0096 | 侧栏 Coding 组加 **Automation** 入口（`index.html`）；`app.js` 加 `renderAutomationSettings()` / `automationCall()`（任务列表 + 运行一次/暂停恢复/删除 + 创建表单 + 运行记录 + **保活三条说明**）；`i18n.js` 补中文；`style.css` 补 `input[type=time]`/`[type=number]`/星期多选的样式 | `probe/automation-page.test.mjs` **31 项全过**（含每个按钮发出的请求、空状态、weekly 切换、桥报错时的真实提示）；`probe/settings-live.test.mjs` 26 项回归全过；bundle 重建 |

同一次改动里**不在前端补丁序列**的部分（都在桥侧）：

| 文件 | 内容 |
|---|---|
| `app/automation-service.js`（新增） | 调度内核：时间槽幂等键、先落盘再执行、`catchUp` 只补最新一个、并发上限、回合超时中断、原子写存储 |
| `app/server.ts` | 挂载服务 + `initialize()` 后 `sweep("startup")` + `turn/completed` 挂钩 + `GET/POST /api/automation` 受控出口 |
| `probe/automation.test.mjs`（新增） | 假时钟单测 **39 项**（到点触发/幂等/重启不重复/补跑/暂停恢复/失败/超时/并发上限） |
| `probe/automation-live.mjs`（新增） | 真桥端到端：建一个两分钟后的任务，等到点自己触发，验完删干净（14 项） |

> 改 `server.ts` 需要重启桥（会打断页面几秒）；这次重启后 `/api/automation` 立即可用，前端只改了静态资源。

## 0097 — 输入区附件入口：删掉假相机按钮，"+"换成图片图标（E133）

| 补丁 | 内容 | 验证 |
|---|---|---|
| 0097 | ① 删除相机 label + `#cameraPicker`（`accept="image/*" capture="environment"`）——APK 的 `onShowFileChooser` 用 `params.createIntent()`，**忽略 `capture`**，那个按钮与图片入口行为完全相同；② 图片/视频入口图标 `plus` → `image`（用户要求），侧栏 `New chat` 的 `+` 不动 | `probe/composer-attach-contract.mjs` **13 项全过**；`curl /` 核对 `image`×1、`plus`×2（都在侧栏）、`cameraPicker` 0 次；8 个既有前端 probe 全部回归通过 |

> 真正的拍照入口不在这个补丁里：需要 APK 侧 `FileProvider` + `ACTION_IMAGE_CAPTURE`
> （VERIFICATION.md 里一直列着这条待办）。删掉假入口是**如实呈现**，不是功能退步。

## 0140 — 被冻结的监听：启动脚本自己收掉它（E140，桥侧 + APK 0.3.10）

这个补丁**不在前端序列里**（它改的是 Termux 侧的启动脚本和 APK），记在这里是因为它决定了"打开应用要等多久"：

| 位置 | 内容 | 验证 |
|---|---|---|
| `~/bin/codex-gui-web` | 有桥进程但 `health` 不就绪时，先看 `curl` 的退出码：**28（连上但不应答）= 冻住的监听 → 跳过原本 25 秒的等待**，直接按卡死重启；否则保持原逻辑（正常启动途中必须等）。只收掉按 cmdline+cwd 匹配到的**本项目** `server.ts` 进程 | 夹具 `probe/frozen-bridge-lookalike/server.ts`：`start` 从 **78s → 5s**；安全上验过"非本项目进程不杀"（`port 8899 is occupied by a silent listener that is not ours`，夹具事后仍在跑） |
| APK 0.3.10 | 升级节奏 20s → 10s（首次仍 8s） | 真机端到端：桥被冻住时**打开应用 8 秒就绪**（APK 日志 `apk: boot: ready after 6s`），改前是 35~37s |

> 关键认识：这个尾延迟的根因**不在 APK 的探测频率**，而在 Termux 侧的启动脚本
> —— 它对着"冻住的监听"照样去 `spawn`，然后 `Failed to start server. Is port 8899 in use?` 白等一轮。

## 0101 — 设置 → 配置页的「启动自检」（P9 首次配置引导，E139）

| 补丁 | 内容 | 验证 |
|---|---|---|
| 0101 | 配置页最上面新增「启动自检」：桥的启动脚本（带真路径）、Termux:API 三项、Codex CLI 版本、状态目录可写、兜底唤醒作业与最近运行、**应用侧最近一次上报**；缺 `~/bin/codex-gui-web` / 缺 termux-api / 未授权 run command 时各给一条具体动作 | `probe/settings-live.test.mjs` **32 项全过**（+6：自检段落、启动脚本真路径、termux-api 三项、codex 版本、兜底唤醒真值与时间、"应用还没上报"如实提示）；`patches/0101` 重跑四个 `skip` |

同一次改动里**不在前端补丁序列**的部分：

| 位置 | 内容 |
|---|---|
| `app/server.ts` | `GET /api/setup`（桥现查 Termux 侧事实）+ `POST /api/setup`（应用上报 Android 侧事实，内存存 30 分钟） |
| APK 0.3.9 | `BridgeClient.reportSetup()` + `MainActivity.boot()` 上报四项能真查证的事实；查不到的不报 |

> **坑（值得单独记）**：第一版用 `which <cmd>` 判断 termux-api 是否安装，结果四项全 MISSING ——
> 本机**根本没有 `which`**，`execFileSync` 抛错被 `catch` 吞掉，每一项都变成 null，
> 看上去像"termux-api 没装"。改成按 `~/bin` 与 `$PREFIX/bin` 直接解析后立刻正常（E139）。

## 0100 — 定时回合遇到审批/提问：记账 + 带深链的通知 + 页面能跳过去（E138）

| 补丁 | 内容 | 验证 |
|---|---|---|
| 0100 | 运行记录里标出「等待你审批 / 等待你回答」，带 `threadId` 的运行多一个「打开会话」按钮（先关设置、再 `openThread()`） | `probe/automation-page.test.mjs` **53 项全过**（+3：徽标、按钮存在、点击真的关设置并打开那条会话） |

同一次改动里**不在前端补丁序列**的部分（桥侧）：

| 文件 | 内容 |
|---|---|
| `app/automation-service.js` | `onServerRequest()`：用请求参数里的 `threadId` 找到正在跑的那次运行 → 记 `run.awaiting` + **立刻发带会话深链的通知**；`onRequestResolved()` 与运行结束都会清标记 |
| `app/server.ts` | 请求到达时挂钩 `automation.onServerRequest(message)`；`serverRequest/resolved` 时挂钩 `onRequestResolved` |

> 真机端到端**没能触发审批**：`probe/automation-approval-live.mjs` 让 `default` 档任务写工作区外的文件，
> 结果后端压根没发审批请求（与 E126"本平台沙箱不生效"一致，模型自己也在回复里指出了）。
> 所以这条能力的记账/通知/跳转由单元测试与 DOM 测试钉住；"后端何时才真的发审批"**仍未观察到**，
> 探针带 `--expect-approval` 以便条件一旦明确就升级成硬断言。

## 0099 — 定时任务：会话选择器（threadId 不再要用户手抄，E137）

| 补丁 | 内容 | 验证 |
|---|---|---|
| 0099 | 「继续某个会话」从**空文本框**改成真的会话选择器：切到该模式时用页面本来就有的 `rpc('thread/list',{limit:50,sortKey:'recency_at',sortDirection:'desc'})` 拉最近 50 条，显示成「标题/预览 · id 前 8 位」；**拉不到就退回手填并写出真实原因**（空下拉框会让人误以为"没有会话"）；提交时没选会话会被拦下；任务行标出「继续会话 <id8>」 | `probe/automation-page.test.mjs` 增到 **46 项**（新增 13 项：选项来自 thread/list、只有预览的会话不显示"未命名"、选择器可见/手填框隐藏、创建请求带对选中 id、拉取失败退回手填并显示 `bridge said no`、空选择被拦下、手填 id 也能提交、任务行显示「继续会话 01a144af」）；真机数据面核对：`thread/list` 返回的 `id`/`name`/`preview`/`status` 字段与选择器用法一致（`name` 可能是 null，已用 preview 兜底） |

## 0098 — 上传改成原始字节：更快、且进度条真的会动（E134）

| 补丁 | 内容 | 验证 |
|---|---|---|
| 0098 | ① 前端：`xhr.send(file)` 直接发 **File 原始字节** + `x-upload-name`（URL 编码）与文件自身的 MIME，不再 `FileReader.readAsDataURL` + `JSON.stringify`（`readFileAsDataUrl` 已删）；② 字节发完、等桥响应时芯片加 `.waiting` 条纹动画（这一段是本机最长的等待）；③ 未传完的占位芯片按 MIME 显示图片/文件图标；④ 桥侧新增 `saveUploadStream()`（边收边写盘、超限/空/断流都清理干净），`/api/uploads` 按 `content-type` 分流，**旧的 base64+JSON 路径保留兼容** | `probe/upload-raw-live.mjs`：同一份 8.49 MB 文件，旧路径 **425ms** → 新路径 **37ms**（桥侧接收），落盘逐字节一致，超 25 MB / 空文件 / 路径逃逸都正确拒绝；`probe/upload-stream-service.test.mjs` 14 项（含"失败不留半截文件"）；`probe/upload-client.test.mjs` 17 项（File 身份、请求头、50% 进度、waiting 条纹、成功替换、5xx 重试）；`p4-attachments` / `upload-service` / `upload-progress-contract` / `attachments-for-send` 全部回归通过 |

> 这个补丁的起因是用户报"上传好慢而且没进度条了"。量出来的结论有点反直觉：
> **桥侧接收 8.49 MB 只用 0.08–0.10s**，慢的是浏览器那两步——把文件读成 data URL、
> 再 `JSON.stringify` 成一个 11.3 MB 的字符串（主线程同步）。而**字符串 body 的
> `upload.onprogress` 拿不到 `lengthComputable/length`**，代码里的早退分支把进度条按在 0 ——
> 这才是"没有进度条"的真正原因。写 DOM 级测试时还抓到一个当场写坏的 bug：
> 改造后 `xhr.send(body)` 里的 `body` 已经不存在（ReferenceError），上传会直接失败。
>
> **又踩了一次幂等标记的坑（第 6 次）**：第一次写这个脚本时，四个文件共用标记 `x-upload-name`，
> 而 `style.css` / `upload-service.js` 里根本没有这个串 → 脚本往这两个文件里**又追加了一份**
> （CSS 块多一份、`saveUploadStream` 多一份，后者会让桥启动直接 `SyntaxError`）。
> 当场发现并清理（截掉重复块 + 去掉重复 import），脚本改成**一个文件一个标记**；
> 现在再跑是四个 `skip`。教训写进 HANDOFF 的坑表。

## 环境侧改动（在 codex-gui 仓库之外，E131）

这些不是前端补丁，但重放时顺序有意义（都在本机；管理脚本 `~/bin/reva-server`）：

| # | 位置 | 内容 |
|---|---|---|
| 1 | `~/tools/ghidra/ghidra_12.1.3_PUBLIC/` | Ghidra 12.1.3 官方发行包（`ghidra_12.1.3_PUBLIC_20260817.zip`，569,445,154 B）。**官方只带 `linux_x86_64`/`win_x86_64` 原生件**，没有 aarch64 |
| 2 | `~/tools/decompiler-build/cpp/` | 从发行包解出 `Ghidra/Features/Decompiler/src/decompile/cpp`；改 Makefile：`ARCH=aarch64 → ARCH_TYPE= / OSDIR=linux_arm_64`；**`make ghidra_opt` 与 `make sleigh_opt` 分开跑**（一起传目标会让 `DEPNAMES` 退化成 `com_*/depend`，那组要 `bfd.h`） |
| 3 | `~/tools/decompiler-build/hash_memory_shim.cc` | Termux libc++ 的 `std::__ndk1::__hash_memory` 在 Android linker 下解析不了（`libc++_shared.so` 里是 GLOBAL DEFAULT 也没用）。用 libc++ 自己的 murmur2/cityhash 补定义，**链接时加进可执行文件**；哈希值与 dylib 版一致 |
| 4 | `…/Features/Decompiler/os/linux_arm_64/{decompile,sleigh}` | 自编出的 `ghidra_opt`/`sleigh_opt` 拷成这两个名字（运行时枚举 `LINUX_ARM_64 → linux_arm_64`） |
| 5 | `<ghidra>/Extensions/Ghidra/reva/` | ReVa 7.3.1 扩展（`ghidra_12.1.3_PUBLIC_20260903_reverse-engineering-assistant.zip`） |
| 6 | `<ghidra>/Extensions/Ghidra/reva/lib/reva-server.jar` | 自写启动器 `reva.local.RevaServerMain`（源码 `~/tools/reva-server/RevaServerMain.java`）——绕开官方 PyGhidra/JPype 路径（本机 Python 3.14 没有对应 jpype wheel） |
| 7 | `~/tools/reva-server/reva-headless.properties` | 端口 8080、host 127.0.0.1（由扩展自带的 example 复制） |
| 8 | `~/bin/reva-server` | `start/stop/restart/status/log`；`setsid nohup java -Xmx4G -Dghidra.install.dir=… -cp <Ghidra 全部 jar> reva.local.RevaServerMain …` |
| 9 | `~/.codex/config.toml` | 新增 3 行：`[mcp_servers.reva]` + `url = "http://127.0.0.1:8080/mcp/message"`。撤销：`codex mcp remove reva`（改动前的备份留在 `$TMPDIR/config.toml.bak-*`） |

仓库内的新增验证脚本：`probe/reva-mcp-live.mjs`（reload + 状态 + `mcpServer/tool/call`）、
`probe/reva-model-turn.mjs`（真跑一个回合让模型用 ReVa 反编译）。

## 待办的本地改动（尚未实施）

- 移动端布局与简体中文（默认中文、保留英文切换）
- 顶部头部尺寸按手机安全区与触控重做（不照搬桌面 46px）
- `item/tool/requestUserInput` 与 `mcpServer/elicitation/request` 两个交互面（上游只处理三类审批请求，遇到这两个会回 `-32601`）
- 文件/Git/worktree 面板；产物预览；通知深链
