#!/usr/bin/env bash
# 构建（可选）→ 打 tag → 建 GitHub Release → 把 APK 作为发行版资产传上去。
#
# 为什么要有这个脚本：用户要求"每次更新都发行一遍"。手工做这件事要记三件事
# （构建会把 AndroidManifest 的 versionCode/Name 自增、tag 必须和 APK 版本一致、
# Release 说明要写清"这只是壳、后端在 Termux"），任何一步漏了都会让下载的人拿到看不懂的东西。
#
# 用法：
#   scripts/release-apk.sh                      # 构建 + 发布（版本号由 build.sh 自增）
#   scripts/release-apk.sh --no-build           # 直接发布 build/ 里最新的那个 APK
#   scripts/release-apk.sh --apk <path>         # 发布指定的 APK
#   scripts/release-apk.sh --notes "补充说明"    # 在自动生成的说明后面追加一段
#   scripts/release-apk.sh --dry-run            # 只打印将要做什么，不 commit/tag/push
#
# 依赖：gh（已登录）、git、以及 android/build.sh 那套构建工具。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BUILD=1
APK=""
EXTRA_NOTES=""
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --no-build) BUILD=0 ;;
    --apk) APK="${2:-}"; shift ;;
    --notes) EXTRA_NOTES="${2:-}"; shift ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) printf '未知参数：%s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

command -v gh >/dev/null 2>&1 || { echo "需要 gh（pkg install gh 并 gh auth login）" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh 还没登录：gh auth login" >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "需要 git" >&2; exit 1; }

if [ "$BUILD" = 1 ] && [ -z "$APK" ]; then
  echo "== 构建 =="
  ( cd "$ROOT/android" && sh build.sh )
fi

if [ -z "$APK" ]; then
  APK="$(ls -t "$ROOT/android/build/"codexgui-*.apk 2>/dev/null | head -1 || true)"
fi
[ -n "$APK" ] && [ -f "$APK" ] || { echo "找不到 APK：先跑 android/build.sh" >&2; exit 1; }

VERSION="$(basename "$APK" | sed -E 's/^codexgui-([0-9][0-9.]*)-.*/\1/')"
TAG="v$VERSION"
echo "== 要发布的 APK =="
echo "  文件：$APK"
echo "  版本：$VERSION    tag：$TAG"

MANIFEST_VERSION="$(sed -n 's/.*android:versionName="\([^"]*\)".*/\1/p' "$ROOT/android/AndroidManifest.xml" | head -1)"
if [ "$MANIFEST_VERSION" != "$VERSION" ]; then
  echo "注意：AndroidManifest 里的版本是 $MANIFEST_VERSION，与 APK 的 $VERSION 不一致。" >&2
  echo "      （如果是 --apk 指定了旧包，这是正常的；否则请重新构建。）" >&2
fi

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "tag $TAG 已经存在——同一版本不重复发。要重发就换版本号，或先 git push --delete origin $TAG。" >&2
  exit 1
fi

# 自上一个 tag 以来的提交，用来写 Release 说明
PREV_TAG="$(git describe --tags --abbrev=0 2>/dev/null || true)"
if [ -n "$PREV_TAG" ]; then
  CHANGELOG="$(git log --oneline --no-decorate "$PREV_TAG"..HEAD | sed 's/^/- /')"
else
  CHANGELOG="$(git log --oneline --no-decorate | head -20 | sed 's/^/- /')"
fi
[ -n "$CHANGELOG" ] || CHANGELOG="- （无新提交）"

NOTES_FILE="$(mktemp "${TMPDIR:-/tmp}/release-notes.XXXXXX")"
trap 'rm -f "$NOTES_FILE"' EXIT
cat > "$NOTES_FILE" <<EOF
## 这是什么

Android 上的 Codex 图形界面（**只有壳**：WebView + 前台服务 + 本地桥客户端）。
执行后端仍然是你自己 Termux 里的 \`codex app-server\` —— 装了这个 APK 不代表手机上有模型。

## 安装前你需要有什么

1. Termux + **Termux:API**（同一个来源装，别用 Google Play 版），
   \`~/.termux/termux.properties\` 里 \`allow-external-apps = true\` 后 \`termux-reload-settings\`；
2. Termux 里能跑 \`codex\`（本项目验证的是 \`npm install -g @mmmbuto/codex-cli-termux\`）；
3. 本仓库的桥与脚本已就位（\`git clone\` 到 \`~/codex-gui\`、\`cp bin/* ~/bin/\`、\`cd app && npm install\`）。

完整步骤见仓库 README 的「10 步教程」，或 \`docs/INSTALL.md\`。

## 这个包的说明

- \`minSdk 30\`（Android 11+）；**自签名**（debug 级密钥），首次安装需允许"安装未知应用"；
- 首次打开需要给应用一次 \`com.termux.permission.RUN_COMMAND\`（否则每次冷启动会短暂切到 Termux）；
- 应用内「设置 → 配置 → 启动自检」会列出两侧事实，缺什么都会给具体动作。

## 本版变更

$CHANGELOG
EOF
if [ -n "$EXTRA_NOTES" ]; then
  printf '\n%s\n' "$EXTRA_NOTES" >> "$NOTES_FILE"
fi

echo "== Release 说明（前 12 行）=="
head -12 "$NOTES_FILE"

if [ "$DRY_RUN" = 1 ]; then
  echo "== dry-run：不提交、不打 tag、不发布 =="
  exit 0
fi

# 版本号是构建时写进 AndroidManifest 的：把它一起提交，仓库里的版本号才和发行版对得上
if ! git diff --quiet -- android/AndroidManifest.xml; then
  echo "== 提交 AndroidManifest 的版本号变化 =="
  git add android/AndroidManifest.xml
  git commit -m "release: $TAG"
fi
git push

echo "== 打 tag =="
git tag -a "$TAG" -m "$TAG"
git push origin "$TAG"

echo "== 建 Release 并上传 APK =="
gh release create "$TAG" "$APK" \
  --title "$TAG — Codex GUI for Android" \
  --notes-file "$NOTES_FILE"

gh release view "$TAG" --json url,assets --jq '"Release: \(.url)\n资产：\(.assets[] | "\(.name) (\(.size) 字节)")"'
