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

# ── 打包前：包里的代码必须等于仓库里的代码 ──────────────────────
# 历史教训：v1.0.0 的 dmg 里装的是修复前的源码，脚本一声不吭打了出去，
# 最后是靠人手动比对 sha256 才发现。两道闸：工作区干净、测试全绿。
if [ -n "${ALLOW_DIRTY:-}" ]; then
  echo "⚠ ALLOW_DIRTY=1：跳过工作区检查，产出的包可能含未提交改动"
else
  DIRTY="$(cd "$ROOT" && git status --porcelain)"
  if [ -n "$DIRTY" ]; then
    echo "✗ 工作区有未提交改动，打出来的包会和仓库对不上：" >&2
    echo "$DIRTY" >&2
    echo "  先提交，或用 ALLOW_DIRTY=1 强制打包（不建议）。" >&2
    exit 1
  fi
fi

if [ -z "${SKIP_TEST:-}" ]; then
  echo "▸ 跑测试"
  if ! ( cd "$ROOT/cal-mcp" && npm test > /tmp/dsh-release-test.log 2>&1 ); then
    echo "✗ 测试没通过，拒绝打包。最后 15 行：" >&2
    tail -15 /tmp/dsh-release-test.log >&2
    exit 1
  fi
  echo "  $(tail -3 /tmp/dsh-release-test.log | tr '\n' ' ')"
fi

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
cp "$ROOT/install.sh" "$ROOT/uninstall.sh" "$ROOT/README.md" "$ROOT/README.en.md" "$ROOT/config.example.json" "$STAGE/"
chmod +x "$STAGE/install.sh" "$STAGE/uninstall.sh"
# 后端：只要运行时需要的，测试用例和文档不进包
mkdir -p "$STAGE/cal-mcp/src"
cp "$ROOT/cal-mcp/cli.mjs" "$ROOT/cal-mcp/mcp-server.mjs" \
   "$ROOT/cal-mcp/package.json" "$STAGE/cal-mcp/"
cp "$ROOT/cal-mcp/src/"*.mjs "$STAGE/cal-mcp/src/"

echo "▸ 校验包内后端是不是当前源码"
# P0-3 的根因就在这里：包和源码不一致而脚本不报错。逐文件比对 sha256，
# 少一个文件、多一个字节都直接失败，不要只看退出码。
for f in cli.mjs mcp-server.mjs package.json src/caldav.mjs src/tools.mjs src/nlp.mjs src/store.mjs src/llm.mjs; do
  A="$(shasum -a 256 "$STAGE/cal-mcp/$f" 2>/dev/null | cut -d' ' -f1)"
  B="$(shasum -a 256 "$ROOT/cal-mcp/$f" 2>/dev/null | cut -d' ' -f1)"
  if [ -z "$A" ] || [ "$A" != "$B" ]; then
    echo "✗ 包内 $f 与源码不一致（包=${A:-缺失} 源=${B:-缺失}）" >&2
    exit 1
  fi
done
echo "  8 个文件逐字节一致"

cat > "$STAGE/安装说明.txt" <<NOTE
DSH 日历 · 安装说明

一、只想用它（不需要终端）
    1. 把本文件夹里的「DSH 日历.app」拖进「应用程序」文件夹
    2. 打开它。首次启动会把解析器自动装到 ~/.local，不用跑脚本
    3. 机器上没有 Node.js 时，窗口会告诉你，去 https://nodejs.org 装一个
       （要 18 以上），回来点「重新检测」即可

二、想用命令行 / MCP
    在「终端」里执行：

        cd ~/Downloads/$NAME
        ./install.sh --cli-only

    装完命令是 dsh-cal，可以用 dsh-cal parse "明天三点开会" 试一下。

三、首次连接日历（只做一次）
    1. 打开 https://appleid.apple.com → 登录与安全 → App 专用密码 → 生成
       （要的是「App 专用密码」，不是 Apple ID 登录密码，账号需已开启双重认证）
    2. 在 App 弹出的设置页里填 Apple ID 和这串密码
    3. 终端里可以跑：dsh-cal doctor 检查连通

四、关于「无法验证开发者」
    这个包没有 Apple 付费开发者账号的公证（一年 99 美元），所以系统默认会拦。
    在 App 上右键 →「打开」→ 再点一次「打开」即可；若提示「已损坏」，终端执行：
        xattr -dr com.apple.quarantine "$HOME/Applications/DSH\\ 日历.app"

五、卸载
    把 App 拖进废纸篓。装过命令行的再跑一次本目录的 ./uninstall.sh。
    你的日程在苹果服务器上，卸载不会动它。
NOTE

echo "▸ 压缩"
# ditto 才能保住 .app 里的符号链接和签名；zip -r 会把 bundle 压坏
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$STAGE" "$DIST/$NAME.zip"

echo "▸ 制作 dmg"
# 注意：不要用 hdiutil create -srcfolder。它内部会挂载临时卷再用 ditto 拷入，
# ditto 在 _CodeSignature 里留下的 .BC.T_* 临时文件会被安全策略当成
# 「删除已安装 App 的签名文件」，整个打包被拒。这里改成：建空卷 → cp 进去 → 压缩。
DMG_RW="$DIST/dmg-rw.dmg"
DMG_OUT="$DIST/$NAME.dmg"
rm -f "$DMG_RW" "$DMG_OUT"

cat > "$DIST/使用说明.txt" <<'NOTE'
DSH 日历 · 安装

1. 把左边这个「DSH 日历」拖到右边的 Applications 文件夹
2. 打开「应用程序」里的 DSH 日历
3. 如果提示缺 Node.js：到 nodejs.org 下 macOS 安装包，装完回到窗口点「重新检测」
   （后端是 App 首次启动时自动装的，不需要命令行，也不需要输密码）

如果提示「无法验证开发者」：
  在 App 上右键 →「打开」→ 再点一次「打开」
  仍旧不行就打开「终端」执行这一行：
    xattr -dr com.apple.quarantine "/Applications/DSH 日历.app"

第一次连接日历（只做一次）：
  1. 打开 https://appleid.apple.com → 登录与安全 → App 专用密码 → 生成
     （要的是「App 专用密码」形如 abcd-efgh-ijkl-mnop，不是登录密码；账号需已开双重认证）
  2. 在 App 弹出的设置页里填 Apple ID 和这串密码

卸载：
  把 App 拖进废纸篓。你的日程在苹果服务器上，不受影响。
  想连命令行工具一起清掉，用发行包里的 uninstall.sh。
NOTE

hdiutil create -quiet -size 40m -fs HFS+ -volname "$APP_NAME" "$DMG_RW"
# 挂载点不一定是 /Volumes/<卷名>：同名卷已挂载时系统会加 " 1"、" 2" 后缀，
# 拼字符串就会把内容拷到错的地方。从 attach 输出里取真实挂载点。
MOUNT="$(hdiutil attach -nobrowse "$DMG_RW" | awk -F'\t' '/\/Volumes\//{print $NF}' | tail -1)"
if [ -z "$MOUNT" ] || [ ! -d "$MOUNT" ]; then
  echo "✗ dmg 挂载失败（可能残留了同名卷，先 hdiutil detach 掉再试）" >&2
  exit 1
fi
trap 'hdiutil detach "$MOUNT" -quiet 2>/dev/null || true' EXIT

cp -R "$STAGE/$APP_NAME.app" "$MOUNT/"
ln -s /Applications "$MOUNT/Applications"
cp "$DIST/使用说明.txt" "$MOUNT/使用说明.txt"
# 卸载前校验一次，确认拷进卷里的包签名没坏
codesign -v "$MOUNT/$APP_NAME.app" || { echo "✗ dmg 里的 App 签名损坏" >&2; exit 1; }
hdiutil detach "$MOUNT" -quiet
trap - EXIT
hdiutil convert -quiet "$DMG_RW" -format UDZO -o "$DMG_OUT"
rm -f "$DMG_RW"

SIZE_ZIP="$(du -h "$DIST/$NAME.zip" | cut -f1)"
SIZE_DMG="$(du -h "$DMG_OUT" | cut -f1)"
echo ""
echo "✓ $DMG_OUT（$SIZE_DMG）  ← 给普通用户"
echo "✓ $DIST/$NAME.zip（$SIZE_ZIP）  ← 含源码，给要改的人"
echo ""
echo "下一步（tag 只新建；已发布的 tag 不要移动，改代码就换版本号）："
echo "  git tag v$VERSION && git push origin v$VERSION"
echo "  gh release create v$VERSION \"$DMG_OUT\" \"$DIST/$NAME.zip\" \\"
echo "    --title \"DSH 日历 v$VERSION\" --notes-file <说明文件>"
