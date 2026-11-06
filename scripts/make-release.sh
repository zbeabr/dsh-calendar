#!/bin/zsh
# 打一个「下载即可安装」的发行包：预编译通用 App + 后端源码 + 安装脚本。
#
#   ./scripts/make-release.sh 1.0.0
#
# 产出 dist/dsh-cal-<版本>-macos.zip，接着建发行版：
#   gh release create v1.0.0 dist/dsh-cal-1.0.0-macos.zip \
#     --title "DSH 日历 v1.0.0" --notes-file dist/notes.md
#
# 注意：包里只有本机 ad-hoc 签名，没有 Apple 公证（需要付费开发者账号）。
# install.sh 会替用户摘掉 quarantine 标记，双击打不开的用户请看 安装说明.txt。
set -euo pipefail

VERSION="${1:?用法: ./scripts/make-release.sh <版本号>，例如 1.0.0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAME="dsh-cal-${VERSION}-macos"
DIST="$ROOT/dist"
STAGE="$DIST/$NAME"
APP_NAME="DSH 日历"

# 版本号必须和 Info.plist 一致，否则签名里的版本和 tag 会各说各话
PLIST_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$ROOT/cal-app/Info.plist")"
if [ "$PLIST_VERSION" != "$VERSION" ]; then
  echo "✗ Info.plist 里是 $PLIST_VERSION，和参数的 $VERSION 不一致" >&2
  echo "  先改 cal-app/Info.plist 的 CFBundleShortVersionString，再打包。" >&2
  exit 1
fi

echo "▸ 清理旧产物"
rm -rf "$STAGE" "$DIST/$NAME.zip"
mkdir -p "$STAGE"

echo "▸ 编译通用 App（arm64 + x86_64）"
# 传目标路径，避免装进 ~/Applications 影响开发机
"$ROOT/cal-app/build.sh" "$STAGE/$APP_NAME.app" >/dev/null

echo "▸ 校验二进制"
ARCHS="$(lipo -archs "$STAGE/$APP_NAME.app/Contents/MacOS/DSHCalendar")"
case "$ARCHS" in
  *arm64*x86_64*|*x86_64*arm64*) ;;
  *) echo "✗ 不是通用二进制：$ARCHS" >&2; exit 1 ;;
esac
MINOS="$(
  for a in arm64 x86_64; do
    vtool -arch "$a" -show-build "$STAGE/$APP_NAME.app/Contents/MacOS/DSHCalendar" 2>/dev/null |
      awk '/minos/{print $2}'
  done | sort -u
)"
echo "  架构：$ARCHS　最低系统：$(echo "$MINOS" | tr '\n' ' ')"
[ "$MINOS" = "14.0" ] || { echo "✗ 最低系统版本不是 14.0（实际：$MINOS）" >&2; exit 1; }

echo "▸ 组装发行包"
cp "$ROOT/install.sh" "$ROOT/uninstall.sh" "$ROOT/README.md" "$ROOT/config.example.json" "$STAGE/"
chmod +x "$STAGE/install.sh" "$STAGE/uninstall.sh"
# 后端：只要运行时需要的，测试用例和文档不进包
mkdir -p "$STAGE/cal-mcp/src"
cp "$ROOT/cal-mcp/cli.mjs" "$ROOT/cal-mcp/mcp-server.mjs" \
   "$ROOT/cal-mcp/package.json" "$STAGE/cal-mcp/"
cp "$ROOT/cal-mcp/src/"*.mjs "$STAGE/cal-mcp/src/"

cat > "$STAGE/安装说明.txt" <<'NOTE'
DSH 日历 · 安装说明

一、先装 Node（只要这一个依赖，18 以上）
    去 https://nodejs.org 下 macOS 安装包，双击装完即可。

二、安装本程序
    1. 解压这个 zip，进入 dsh-cal-x.x.x-macos 文件夹
    2. 双击 install.sh 一般会被拦；请在「终端」里跑：

         cd ~/Downloads/dsh-cal-1.0.0-macos
         ./install.sh

    装完 App 在 ~/Applications/DSH 日历.app，命令行工具是 dsh-cal。

三、首次连接日历（只做一次）
    1. 打开 https://appleid.apple.com → 登录与安全 → App 专用密码 → 生成
       （要的是「App 专用密码」，不是 Apple ID 登录密码，账号需已开启双重认证）
    2. 终端里跑：dsh-cal login
    3. 检查连通：dsh-cal doctor

四、关于「无法验证开发者」
    这个包没有 Apple 付费开发者账号的公证（一年 99 美元），所以系统默认会拦。
    安装脚本已经帮你摘掉下载隔离标记；万一还是被拦，在 App 上右键 →「打开」，
    或终端里执行：xattr -dr com.apple.quarantine ~/Applications/DSH\ 日历.app

五、卸载
    cd ~/Downloads/dsh-cal-1.0.0-macos && ./uninstall.sh
    你的日程在苹果服务器上，卸载不会动它。
NOTE

echo "▸ 压缩"
# ditto 才能保住 .app 里的符号链接和签名；zip -r 会把 bundle 压坏
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$STAGE" "$DIST/$NAME.zip"

SIZE="$(du -h "$DIST/$NAME.zip" | cut -f1)"
echo ""
echo "✓ $DIST/$NAME.zip（$SIZE）"
echo ""
echo "下一步："
echo "  git tag v$VERSION && git push origin v$VERSION"
echo "  gh release create v$VERSION \"$DIST/$NAME.zip\" --title \"DSH 日历 v$VERSION\" --notes-file <说明文件>"
