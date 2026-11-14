#!/bin/zsh
# 真机定量：在装机 App 里注入一条演示日程，量出木板上「改」与「×」的实际 x 坐标。
# 断言：编辑中心在删除中心左边、两块矩形不重叠。
#
# 跑法：zsh cal-app/tests/plank-buttons-runtime.sh
# 需要 --snapshot 自检通道 DSH_CAL_SNAP_EVAL；旧版没有这个通道时会明确报失败。
set -euo pipefail

APP="${DSH_CAL_APP:-$HOME/Applications/DSH 日历.app/Contents/MacOS/DSHCalendar}"
if [ ! -x "$APP" ]; then
  echo "✗ 找不到装机 App：$APP" >&2
  exit 2
fi

WORK="$(mktemp -d /tmp/dsh-plankbtn.XXXXXX)"
PNG="$WORK/shot.png"
LOG="$WORK/run.log"

JS="window.dshRender({events:[{uid:'demo1',when:'11/14 周五',what:'示例 · 20:00',tag:'学习',title:'示例日程',start:'2026-11-14T12:00:00.000Z',end:'2026-11-14T13:00:00.000Z',location:'图书馆',recurring:'0',occurrence:'2026-11-14T12:00:00.000Z'}],sys:'演示'});"
# 悬停态只改 opacity，不影响矩形；这里显式点亮，顺带让快照能看见两个按钮。
JS+="var b=document.querySelector('.plank .edit'),d=document.querySelector('.plank .del');"
JS+="if(b)b.style.opacity=1;if(d)d.style.opacity=1;"

EVAL="(function(){var b=document.querySelector('.plank .edit'),d=document.querySelector('.plank .del');"
EVAL+="if(!b||!d)return JSON.stringify({missing:true});var x=b.getBoundingClientRect(),y=d.getBoundingClientRect();"
EVAL+="var hit=function(r){var e=document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2);"
EVAL+="return e?String(e.className||''):'(none)'};"
EVAL+="return JSON.stringify({editX:x.left,editRight:x.right,delX:y.left,delRight:y.right,"
EVAL+="editCenter:(x.left+x.right)/2,delCenter:(y.left+y.right)/2,"
EVAL+="hitEdit:hit(x),hitDel:hit(y)});})()"

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
if (r.missing) { console.log('✗ 没找到木板上的两个按钮'); process.exit(1); }
const ordered = r.editCenter < r.delCenter;
const apart = r.editRight <= r.delX + 0.5;
// 矩形位置对了不等于点得到：右侧黄铜孔 .grommet 会盖住没给 z-index 的删除钮。
const editable = /edit/u.test(r.hitEdit ?? '');
const deletable = /del/u.test(r.hitDel ?? '');
const ok = ordered && apart && editable && deletable;
console.log(ok
  ? '✓ 按钮顺序 PASS：编辑在删除左边，两块不重叠，中心点都命中自己的按钮'
  : `✗ 按钮顺序 FAIL：编辑中心 ${r.editCenter} / 删除中心 ${r.delCenter}，`
    + `重叠=${!apart}，命中 edit=${r.hitEdit} / del=${r.hitDel}`);
process.exit(ok ? 0 : 1);
NODE
