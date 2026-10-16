#!/data/data/com.termux/files/usr/bin/sh
# codexgui 构建脚本 —— 本机没有 Gradle/AGP，走 aapt + javac + d8 + apksigner 手工流水线
# （与 ~/android-build/CodexBridge 同一套，已在 Termux aarch64 上验证过）。
#
#   sh build.sh              构建并签名
#   sh build.sh --install    构建后复制到 /sdcard/Download/codex-gui/ 方便点击安装
set -eu

PROJ="$(cd "$(dirname "$0")" && pwd)"
ANDROID_JAR="${ANDROID_JAR:-$HOME/android-build/android-35/android.jar}"
OUT="$PROJ/build"
GEN="$PROJ/gen"
OBJ="$PROJ/obj"
NAME="codexgui"
KEYSTORE="${CODEXGUI_KEYSTORE:-$HOME/android-build/CodexBridge/debug.keystore}"
SHARE_DIR="/sdcard/Download/codex-gui"

if [ ! -f "$ANDROID_JAR" ]; then
  echo "android.jar not found: $ANDROID_JAR" >&2
  exit 1
fi

VERSION="$(sed -n 's/.*android:versionName="\([^"]*\)".*/\1/p' "$PROJ/AndroidManifest.xml" | head -1)"
STAMP="$(date '+%Y%m%d-%H%M%S')"
ARTIFACT="$OUT/$NAME-$VERSION-$STAMP.apk"

# 每次迭代都要能把新包"盖"上去：Android 只认更高的 versionCode。
# 同时把 versionName 的补丁位自增（0.1.0 → 0.1.1 …），否则用户看不出装的是哪一版。
# 两个号都在构建时自增，用户不必记这件事。
CURRENT_CODE="$(sed -n 's/.*android:versionCode="\([0-9]*\)".*/\1/p' "$PROJ/AndroidManifest.xml" | head -1)"
NEXT_CODE=$(( ${CURRENT_CODE:-0} + 1 ))
NEXT_NAME="$(echo "$VERSION" | awk -F. '{ if (NF>=3) printf "%s.%s.%d", $1, $2, $3+1; else printf "%s.1", $0 }')"
sed -i "s/android:versionCode=\"[0-9]*\"/android:versionCode=\"$NEXT_CODE\"/; s/android:versionName=\"[^\"]*\"/android:versionName=\"$NEXT_NAME\"/" "$PROJ/AndroidManifest.xml"
echo "versionCode: ${CURRENT_CODE:-0} -> $NEXT_CODE ; versionName: $VERSION -> $NEXT_NAME"
VERSION="$NEXT_NAME"
ARTIFACT="$OUT/$NAME-$VERSION-$STAMP.apk"

mkdir -p "$OUT" "$GEN" "$OBJ"
find "$GEN" -name '*.java' -delete 2>/dev/null || true
find "$OBJ" -name '*.class' -delete 2>/dev/null || true
rm -f "$OUT/$NAME-unsigned.apk" "$OUT/$NAME.apk"

echo "[1/6] aapt: 编译资源 + 生成 R.java"
aapt package -f -m \
  -J "$GEN" \
  -M "$PROJ/AndroidManifest.xml" \
  -S "$PROJ/res" \
  -I "$ANDROID_JAR" \
  -F "$OUT/$NAME-unsigned.apk"

echo "[2/6] javac: 编译 Java"
javac --release 11 -encoding UTF-8 \
  -classpath "$ANDROID_JAR" \
  -d "$OBJ" \
  $(find "$PROJ/src" "$GEN" -name '*.java')

echo "[3/6] d8: 生成 dex"
d8 --release --min-api 30 --lib "$ANDROID_JAR" \
  --output "$OUT" \
  $(find "$OBJ" -name '*.class')

echo "[4/6] 组装 APK"
cp "$OUT/$NAME-unsigned.apk" "$OUT/$NAME.apk"
( cd "$OUT" && zip -q -u "$NAME.apk" classes.dex )

echo "[5/6] 签名"
apksigner sign --ks "$KEYSTORE" --ks-key-alias androiddebugkey \
  --ks-pass pass:android --key-pass pass:android \
  --out "$ARTIFACT" "$OUT/$NAME.apk"

echo "[6/6] 校验 + 对齐检查"
apksigner verify --print-certs "$ARTIFACT" | head -3
ls -l "$ARTIFACT"

if [ "${1:-}" = "--install" ]; then
  mkdir -p "$SHARE_DIR"
  cp "$ARTIFACT" "$SHARE_DIR/"
  echo "已复制到 $SHARE_DIR/$(basename "$ARTIFACT")（在文件管理器里点击即可安装）"
fi

echo "OK -> $ARTIFACT"
