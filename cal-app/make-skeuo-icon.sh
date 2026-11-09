#!/bin/zsh
# 从预烘焙的 1024 位图生成「全拟物外观」专用 AppIconSkeuo.icns。
#
# 玻璃版图标是 Icon.swift 用 CoreGraphics 逐尺寸矢量渲染的；拟物版不行 ——
# 它的拉丝金属 / 木纹 / 绿磷光屏是 skeuo.html 那套 CSS+SVG 材质，用 AppKit
# 重画必然和界面不像（前面几轮已经验证过）。所以设计稿定稿后直接烘焙成
# 1024 RGBA 位图放进仓库，这里只做标准的 iconset 缩放，不重新绘制任何东西。
#
# 设计稿源：会话目录 icon-preview/gen_icon_reframe.py（SVG 生成），
# 交付位图：web/icon-skeuo-1024.png。改了设计稿就替换这张 PNG 再跑本脚本。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/web/icon-skeuo-1024.png"
OUT="$HERE/icon/AppIconSkeuo.iconset"
ICNS="$HERE/icon/AppIconSkeuo.icns"

if [ ! -f "$SRC" ]; then
  echo "✗ 找不到 $SRC（拟物图标位图）" >&2
  exit 1
fi

# 源图 / 脚本没变就不重做，避免每次 build 都白跑十次 sips
if [ -f "$ICNS" ] && [ ! "$SRC" -nt "$ICNS" ] && [ ! "$0" -nt "$ICNS" ]; then
  exit 0
fi

mkdir -p "$OUT"

# iconutil 要求的固定文件名 → 像素尺寸（与 Icon.swift 的 jobs 完全一致）
jobs=(
  "icon_16x16.png 16"
  "icon_16x16@2x.png 32"
  "icon_32x32.png 32"
  "icon_32x32@2x.png 64"
  "icon_128x128.png 128"
  "icon_128x128@2x.png 256"
  "icon_256x256.png 256"
  "icon_256x256@2x.png 512"
  "icon_512x512.png 512"
  "icon_512x512@2x.png 1024"
)

for spec in "${jobs[@]}"; do
  name="${spec%% *}"
  px="${spec##* }"
  sips -z "$px" "$px" "$SRC" --out "$OUT/$name" >/dev/null
done

iconutil -c icns "$OUT" -o "$ICNS"
echo "  ✓ 拟物图标已生成：$ICNS"
