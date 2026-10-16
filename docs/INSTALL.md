# Codex GUI（dev.termux.codexgui）安装 / 升级 / 卸载

最后更新：2026-10-16（对应版本 **0.3.7**）

---

## 1. 这个包里有什么

| 文件 | 说明 |
|---|---|
| `codexgui-<版本>-<时间戳>.apk` | 可安装的 Android 应用（WebView 壳 + 前台服务）。**只留最新一版** |
| `HANDOFF.md` | 交接说明：项目是什么、环境怎么摆、踩过哪些坑 |
| `PLAN.md` / `FEATURES.md` / `VERIFICATION.md` / `PATCHES.md` | 计划、功能对照表、证据库、补丁与重放顺序 |

**它不是一个自带运行时的 App**：真正的执行后端在 Termux（`codex app-server`）里，
应用只是连到 `127.0.0.1:8899` 的本地桥。所以 Termux 那边的东西不能删。

---

## 2. 首次安装（需要先在 Termux 里准备好）

Termux 侧前提（一次性）：

1. Termux 应用本身，以及 **Termux:API**（`termux-wake-lock` / `termux-notification` / `termux-job-scheduler` 都靠它）；
2. `~/.termux/termux.properties` 里 `allow-external-apps = true`，然后 `termux-reload-settings`；
3. 桥的启动脚本存在且可执行：`~/bin/codex-gui-web`（`codex-gui-web status` 能看到状态）；
4. 给本应用授予一次 **`com.termux.permission.RUN_COMMAND`**（缺它时应用会静默降级成"分享给 Termux"那条路，界面会短暂跳到 Termux）。

安装应用：

- **手机上**：在文件管理器里点这个 APK → 允许"安装未知应用"→ 安装；
- **或者用 adb**（USB/无线调试已连上时）：`adb install -r codexgui-<版本>.apk`。

首次打开：应用会自己把桥拉起来（不需要你先开 Termux）。**如果 Termux 刚被系统清理过**，
应用会自动把 Termux 切到前台解冻并重新请求启动（0.3.5 起），就绪后会发一条"点这里回到应用"的通知。

---

## 3. 升级（覆盖安装）

**直接点新 APK 安装即可**，不用先卸载：

- 签名不变（同一个 debug keystore），`versionCode` 每次构建自动 +1 —— 这是 Android 允许覆盖安装的前提；
- 版本号在**应用内可见**：前台服务通知标题是 `Codex <版本>`，启动页右下角也写着 `v<版本>`；
- **不会丢**：会话与配置都在 `~/.codex/` 与 Termux 里，定时任务在
  `~/.codex/codex-webui/automation.json`，上传的附件在 `~/.codex/codex-webui/uploads/` ——
  这些都属于 Termux，不属于 APK。APK 自己的数据只有 WebView 缓存与通知偏好；
- 升级后**不用**动 Termux 侧的任何东西（脚本、JobScheduler 作业、唤醒锁都照旧）。

回滚：装回旧版本的 APK 会因 `versionCode` 更低而失败；需要先卸载再装（会丢 APK 侧缓存，不影响上面的数据）。

---

## 4. 卸载

卸载应用**不影响** Termux、`~/.codex/` 里的任何数据，也不影响桥（桥是独立进程）。

如果连 Termux 侧的常驻也想去掉，按需要执行：

```sh
~/bin/codex-gui-web stop                      # 停桥（会成对释放 termux-wake-lock）
termux-job-scheduler --cancel --job-id 4711   # 去掉 15 分钟的兜底唤醒作业（codex-gui-watchdog）
pkg uninstall termux-api                      # 只在确认没有别的脚本用它时
```

另外两处可选的、与这个 App 无关但由本项目装的常驻：`~/bin/reva-server stop`
（Ghidra/ReVa 的 Java 进程，不用就停掉，它常驻约 400MB）。**不会**有 cron/systemd 之类的残留。

---

## 5. 出问题怎么办

| 现象 | 先做什么 |
|---|---|
| 打开应用一直转圈 | 应用会在 8 秒后自动唤醒 Termux（0.3.5 起）；若仍超时，失败面板会说明。也可以直接开一次 Termux 再回来 |
| 界面停在"等待桥响应" | 桥被系统冻结了（Termux 进程被回收/冻结）。下拉通知里的「重启桥」，或 `~/bin/codex-gui-web restart` |
| 上传/发送没反应 | 看桥日志 `~/.codex/codex-webui/bridge.log`（应用侧的启动判断也会写在这里，带 `apk:` 前缀） |
| 定时任务没按时跑 | 桥不在时到点不会触发；`~/.codex/codex-webui/watchdog.log` 能看到 15 分钟兜底作业有没有把它拉起来 |

> 诊断信息都落在 `~/.codex/codex-webui/` 下：`bridge.log`（桥 + 应用侧判断）、`watchdog.log`（兜底作业）、
> `automation.json`（定时任务与运行记录）。**从 Termux 里就能看**，不需要连电脑。
