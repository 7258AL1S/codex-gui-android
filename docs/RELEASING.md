# 发行流程（每次更新都要发一版）

**约定**：只要产出新的 APK，就同时发一个 GitHub Release（tag + APK 资产）。
不要说"代码推了就行"——下载页面是别人唯一看得到的入口，说明写在那里才有用。

## 一条命令

```sh
cd ~/codex-gui-github          # 或你克隆的位置
scripts/release-apk.sh
```

它会按顺序做：

1. `android/build.sh` 构建（`versionCode`/`versionName` 自动 +1）；
2. 把 `android/AndroidManifest.xml` 的版本号变化提交并推送（**仓库里的版本号必须和发行版对得上**，
   否则下一个构建的版本号会与线上不一致）；
3. 打 tag `v<版本>` 并推送；
4. 建 Release，上传 `codexgui-<版本>-<时间戳>.apk`，说明里自动带上**自上版以来的提交**，
   以及固定的"这是什么 / 安装前需要什么 / 这个包的说明"三段。

## 其他用法

| 目的 | 命令 |
|---|---|
| 只发布已构建好的 APK（不重新构建） | `scripts/release-apk.sh --no-build` |
| 发布指定文件 | `scripts/release-apk.sh --apk path/to/codexgui-x.y.z-….apk` |
| 追加一段说明 | `scripts/release-apk.sh --notes "本次特别说明…"` |
| 先看会做什么 | `scripts/release-apk.sh --dry-run` |

## 说明里必须写清楚的三件事（脚本已内置，改脚本时别删）

1. **这只是壳**：WebView + 前台服务 + 本地桥客户端；执行后端是用户自己 Termux 里的 `codex app-server`。
   下载的人最容易误会的就是这一点。
2. **安装前提**：Termux + Termux:API（同源安装）、`allow-external-apps`、CLI 能跑、桥与脚本就位。
3. **包的性质**：`minSdk 30`、自签名（debug 级密钥）、首次要授一次 `RUN_COMMAND` 权限。

## 发布之后自己核一遍（30 秒）

```sh
gh release view v<版本> --json url,assets --jq '.url, (.assets[] | "\(.name) \(.size)")'
curl -sL -o /tmp/released.apk <资产下载地址>
sha256sum /tmp/released.apk android/build/codexgui-<版本>-*.apk    # 两个哈希应当一致
aapt dump badging /tmp/released.apk | head -3                      # versionName 与 label 对不对
```

（本地验证过：v0.3.19 的资产哈希与本地构建完全一致，`application-label: 'Codex GUI'`，
`application-icon-480` 指向自适应图标。）

## 同一版本不要重发

脚本发现 tag 已存在就直接退出。确实需要重发时：先 `gh release delete v<版本> --yes` +
`git push --delete origin v<版本>`，或者干脆递增版本号（推荐后者）。
