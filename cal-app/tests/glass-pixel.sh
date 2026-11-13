#!/bin/zsh
# 液态玻璃像素回归：证明「开/关玻璃模式，上半部拟物界面像素完全不变」。
#
# 跑法：zsh cal-app/tests/glass-pixel.sh
# 依赖：已装机的 DSH 日历.app（脚本用它的 --snapshot 离屏通道）、swiftc、sips。
# 会临时改 liquidBackdrop 偏好拍两张图，退出时一定恢复（trap）。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HOME/Applications/DSH 日历.app/Contents/MacOS/DSHCalendar"
if [ ! -x "$APP" ]; then
  print -u2 "✗ 找不到已装机的 App：$APP"
  exit 2
fi

TMP="$(mktemp -d /tmp/dsh-glass-pixel.XXXXXX)"
PREFS="$TMP/prefs.plist"
defaults export app.dsh.calendar "$PREFS"
restore() { defaults import app.dsh.calendar "$PREFS" >/dev/null 2>&1 || true }
trap restore EXIT

echo "▸ 拍「玻璃关」…"
defaults write app.dsh.calendar liquidBackdrop -bool false
env DSH_CAL_SNAPSHOT_DELAY=2 "$APP" --snapshot "$TMP/off.png" >"$TMP/off.log" 2>&1
echo "▸ 拍「玻璃开」…"
defaults write app.dsh.calendar liquidBackdrop -bool true
env DSH_CAL_SNAPSHOT_DELAY=2 "$APP" --snapshot "$TMP/on.png" >"$TMP/on.log" 2>&1
restore

for f in "$TMP/off.png" "$TMP/on.png"; do
  [ -s "$f" ] || { print -u2 "✗ 快照没生成：$f"; tail -20 "$TMP/off.log"; exit 2; }
done

echo "▸ 编译像素工具…"
swiftc -O "$HERE/glass-pixel.swift" -o "$TMP/pix"

W=$(sips -g pixelWidth "$TMP/off.png" | awk '/pixelWidth/{print $2}')
H=$(sips -g pixelHeight "$TMP/off.png" | awk '/pixelHeight/{print $2}')
W2=$(sips -g pixelWidth "$TMP/on.png" | awk '/pixelWidth/{print $2}')
H2=$(sips -g pixelHeight "$TMP/on.png" | awk '/pixelHeight/{print $2}')
if [ "$W" != "$W2" ] || [ "$H" != "$H2" ]; then
  print -u2 "✗ 两张快照尺寸不一致：$W×$H vs $W2×$H2"; exit 2
fi
echo "  快照尺寸 ${W}×${H}（Retina 2x）"

# 阈值依据：抗锯齿 / 亚像素渲染允许 ≤2/255；一圈 alpha≥.5 的白边会带来上百的差。
# 三个区域分开量，避免「整块平均」把只有几像素宽的亮边稀释掉。
# 保守取约 200pt（400px @2x），确保整个取样区都在 .chrome 内，
# 不含铜杆以下的木板区 —— 木板区本来就该随玻璃开关变化，混进来会污染指标。
CHROME_H=$(( H * 28 / 100 ))
FAILED=0
function region() {
  local name="$1" x="$2" y="$3" w="$4" h="$5" limit="$6"
  local out diff
  out=$("$TMP/pix" "$TMP/off.png" "$TMP/on.png" "$x" "$y" "$w" "$h")
  diff=$(print -r -- "$out" | awk -F'=' '/^DIFF=/{print $2}')
  if awk -v d="$diff" -v l="$limit" 'BEGIN{exit !(d<=l)}'; then
    echo "✓ $name  $out  阈值≤$limit"
  else
    echo "✗ $name  $out  阈值≤$limit  ← 上半部被玻璃模式改了材质"
    FAILED=1
  fi
}

echo "=== 玻璃关 vs 玻璃开（原始输出）==="
region "上半部整块"   0 0 "$W" "$CHROME_H" 1.5
region "顶部亮边带"   0 0 "$W" 12 2.0
region "左侧亮边带"   0 0 12 "$CHROME_H" 2.0

if [ "$FAILED" -ne 0 ]; then
  echo "结果：FAIL（$TMP 保留供查看）"
  exit 1
fi
echo "结果：PASS  偏好已恢复：$(defaults read app.dsh.calendar liquidBackdrop)"
