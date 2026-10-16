# 发布前自查（2026-10-16，作者自用）

这份文件是**发布前的一次自查记录**，不是给使用者看的说明书。它回答三件事：
树里有没有不该公开的东西、结构是否自洽、以及哪些内容需要作者自己拍板。

## 1. 密钥与凭据扫描（已执行，全部为空）

| 检查 | 命令 | 结果 |
|---|---|---|
| 明文密钥形状 | `rg "sk-[A-Za-z0-9_-]{16,}\|Bearer [A-Za-z0-9._-]{20,}\|AIza[0-9A-Za-z_-]{20,}\|ghp_[A-Za-z0-9]{20,}"` | 无 |
| 凭据文件名/私钥 | `find . -name "*.pem" -o -name "id_rsa*" -o -name "*token*" -o -name "*.keystore" -o -name "*.jks"` | 无 |
| `KEY=value` 形式的赋值 | `rg "(API_KEY\|PASSWORD\|SECRET\|TOKEN)\s*=\s*[\"'][^\"']{6,}"` | 只有两类**正常**命中：`bin/codex-gui` 运行时从 `$HOME/.codex/codex-webui/ws-token` 读令牌；上游 `app/README*.md` 里的示例占位符（`use-a-long-random-password`、`openssl rand -hex 32`） |

另外确认**不在树里**的：`~/.codex/config.toml`（含 provider 凭据）、`ws-token`、
`~/.codex/codex-webui/` 下的运行状态（自动化记录、上传的附件）、`~/shots/`（含聊天截图）、
`android-build/CodexBridge/debug.keystore`、`app/node_modules/`、`app/cw.tar.gz`（上游源码快照）。
`.gitignore` 已把这些模式挡住（`node_modules/`、`*.apk`、`*.keystore`、`*.log`、`tmp/`、`ws-token`…）。

## 2. 需要作者拍板的隐私项（技术结论不依赖它们）

| 内容 | 出现次数 | 说明 | 建议 |
|---|---|---|---|
| 第三方 provider 名（`deepseek`） | 文档里 18 处 | 只是"用第三方 provider 验证"的事实依据 | 想更中性可以替换成 `<third-party provider>` |
| 设备型号/系统（`2602BRT18C`、`Redmi`、`HyperOS`） | 13 处 | 用于解释"为什么这台机器上会这样"（冻结、选择器行为等） | 保留更可信；介意就删 |
| Termux 绝对路径（`/data/data/com.termux/files/home`） | 9 处 | Termux 上就是这个路径，删了反而看不懂 | 建议保留 |
| 手机号/邮箱/姓名/家庭住址 | 0 | 递归扫描未发现 | — |

`probe/` 里的夹具都是合成数据（文件名如 `笔记.txt`、`图.png`；会话预览已改成"示例会话"，
原来是作者的一条真实对话标题）。

## 3. 结构自洽性核对

| 项 | 状态 |
|---|---|
| 1050 个文件、9.2 MB（最大单文件是生成的前端 bundle 1.7 MB） | ✓ 适合 git |
| `README.md` 里的架构图 / 目录表 / 快速开始 / 已知限制 | ✓ 与实际树一致 |
| `LICENSE`（MIT）+ 上游 `app/LICENSE` + `app/THIRD_PARTY_NOTICES.md`（Lucide 等） | ✓ 都在 |
| `proto-ts/` 的来源（本机 CLI 导出） | ✓ 在 `LICENSE` 末尾与 `README` 里写明 |
| `docs/` 里引用的截图（`~/shots/*.png`）**不在仓库里** | 已声明为"证据引用"；如需公开可另行挑选去隐私的图 |
| `bin/` 脚本的家目录 | 已把仅剩的一处硬编码改成 `$HOME` |
| APK 源码不含 keystore（`build.sh` 用 `CODEXGUI_KEYSTORE` 指向仓库外的密钥） | ✓ |
| `tools/` | 放了 ReVa 启动器（`RevaServerMain.java`）与 Termux libc++ 的 `hash_memory_shim.cc`，两者都在文档里被引用 |

## 4. 发布前建议的一次"冷启动"验证

在干净目录里 `git clone` 本仓库，然后：

1. `cd app && npm install && bun run server.ts` —— 桥应该起来，`curl 127.0.0.1:8899/api/health` 有 `ready:true`；
2. `node probe/automation.test.mjs`、`node probe/settings-live.test.mjs`、`node probe/dom-contract-audit.mjs`
   —— 应当全绿（这三个不依赖真机、不依赖模型）；
3. `sh android/build.sh` —— 应当产出可签名 APK（需要 `ANDROID_JAR` 与 keystore，脚本头部写了来源）。

第 1 步若失败，最可能是 `app/public/app.bundle.js` 与 `public/*.js` 不一致：重建即可
（`bun build public/app.js --target=browser --outfile=public/app.bundle.js`）。
