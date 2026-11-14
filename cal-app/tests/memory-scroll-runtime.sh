#!/bin/zsh
# 真机定量：灌 20 条过去日程 → 展开木盒 → 模拟鼠标悬停 → 走一次滚轮转发。
# 断言：列表 scrollTop 变大（盒子内部真的滚了）、window.scrollY 保持 0（整页没被带走）。
#
# 跑法：zsh cal-app/tests/memory-scroll-runtime.sh
# 需要 --snapshot 自检通道 DSH_CAL_SNAP_EVAL；旧版没有这个通道时会明确报失败。
set -euo pipefail

APP="${DSH_CAL_APP:-$HOME/Applications/DSH 日历.app/Contents/MacOS/DSHCalendar}"
if [ ! -x "$APP" ]; then
  echo "✗ 找不到装机 App：$APP" >&2
  exit 2
fi

# BSD/macOS 的 mktemp 不认「XXXXXX 后面还带后缀」，会撞成同一个名字报 File exists。
# 先要一个临时目录，里面用固定文件名最稳。
WORK="$(mktemp -d /tmp/dsh-memscroll.XXXXXX)"
PNG="$WORK/shot.png"
LOG="$WORK/run.log"

JS="var rows=[];for(var i=0;i<20;i++){rows.push({when:'11/'+String(10-i).padStart(2,'0')+' 周',what:'过去的第'+(i+1)+'件事 · 09:00'});}"
JS+="renderMemory(rows);document.getElementById('memoryBox').classList.add('open');"
JS+="window.dshMemoryHover=true;window.dshScroll(120);window.renderMemory=function(){};"

EVAL="JSON.stringify({top:document.getElementById('memoryList').scrollTop,"
EVAL+="sh:document.getElementById('memoryList').scrollHeight,"
EVAL+="ch:document.getElementById('memoryList').clientHeight,"
EVAL+="pageY:window.scrollY,hover:window.dshMemoryHover===true,"
EVAL+="open:document.getElementById('memoryBox').classList.contains('open')})"

env DSH_CAL_SNAPSHOT_DELAY=2 DSH_CAL_SNAP_JS="$JS" DSH_CAL_SNAP_EVAL="$EVAL" \
  "$APP" --snapshot "$PNG" >/dev/null 2>"$LOG" || true

LINE="$(grep -o 'EVAL .*' "$LOG" | tail -1 || true)"
echo "原始输出: ${LINE:-（无 EVAL 行）}"

node - "$LINE" <<'NODE'
const line = process.argv[2] || '';
const m = line.match(/EVAL\s+(\{.*\})/u);
if (!m) {
  console.log('✗ 没拿到 EVAL 定量结果：自检通道缺失，或 App 没能启动');
  process.exit(1);
}
let r;
try { r = JSON.parse(m[1]); } catch { console.log('✗ EVAL 不是 JSON:', m[1]); process.exit(1); }
console.log('读数:', JSON.stringify(r));
const ok = r.sh > r.ch && r.top > 0 && r.pageY === 0 && r.hover && r.open;
console.log(ok
  ? '✓ 盒子内部滚动 PASS：列表内容溢出、内层滚了、整页没动'
  : '✗ 盒子内部滚动 FAIL：内层没滚，或滚轮把整页带走了');
process.exit(ok ? 0 : 1);
NODE
