#!/bin/zsh
# 真机定量：小盒子右缘抽屉 —— 默认只露一条边、mouseenter 弹出、mouseleave 收起、
# 感应区与右缘都能命中。靠 --snapshot 的 DSH_CAL_SNAP_JS/EVAL 通道读真实几何。
#
# 跑法：zsh cal-app/tests/memory-peek-runtime.sh
# 注意：离屏渲染会把 CSS transition 停在起始帧，必须先注入 transition:none!important，
# 否则量到的是动画中间值（这个坑在木板按钮自检里踩过）。
set -euo pipefail

APP="${DSH_CAL_APP:-$HOME/Applications/DSH 日历.app/Contents/MacOS/DSHCalendar}"
if [ ! -x "$APP" ]; then
  echo "✗ 找不到装机 App：$APP" >&2
  exit 2
fi

WORK="$(mktemp -d /tmp/dsh-mempeek.XXXXXX)"
PNG="$WORK/shot.png"
LOG="$WORK/run.log"

JS="var st=document.createElement('style');"
JS+="st.textContent='.memory-box,.memory-box::after{transition:none!important}';"
JS+="document.head.appendChild(st);"
JS+="window.dshRender=function(){};window.renderMemory=function(){};"

# 测量放在 EVAL 里一次求值：SNAP_JS 与 EVAL 是两个阶段，中间原生会重推状态，
# 挂在 window 上的中间结果会丢；IIFE 直接返回 JSON 更稳，异常也能带回来。
EVAL="(function(){try{"
EVAL+="var b=document.getElementById('memoryBox'),W=window.innerWidth;"
EVAL+="function m(){var r=b.getBoundingClientRect(),y=Math.max(2,r.top+18);"
# 命中盒子的子元素（mb-body / mbCount…）也算「鼠标还在盒子上」：
# mouseleave 看的是是否离开整只盒子，不是看 elementFromPoint 返回的元素名。
EVAL+="var h=function(x){var e=document.elementFromPoint(x,y);"
EVAL+="if(!e)return '(none)';"
EVAL+="return (e.closest&&e.closest('#memoryBox'))?'memoryBox':(e.id||e.className||'');};"
EVAL+="return {left:r.left,right:r.right,"
EVAL+="visible:Math.max(0,Math.min(W,r.right)-Math.max(0,r.left)),"
EVAL+="open:b.classList.contains('open'),hover:window.dshMemoryHover===true,"
EVAL+="hit:h(W-20),hitEdge:h(W-5)};}"
EVAL+="var idle=m();b.dispatchEvent(new MouseEvent('mouseenter'));var shown=m();"
EVAL+="b.dispatchEvent(new MouseEvent('mouseleave'));var hidden=m();"
EVAL+="return JSON.stringify({W:W,idle:idle,shown:shown,hidden:hidden});"
EVAL+="}catch(e){return JSON.stringify({err:String((e&&e.stack)||e)});}})()"

# WKWebView 的 evaluateJavaScript 把语法错误静默丢掉，先在 Node 里过一遍。
printf '%s\n%s\n' "$JS" "$EVAL" > "$WORK/inject.js"
if ! node --check "$WORK/inject.js" >/dev/null 2>"$WORK/jserr"; then
  echo "--- 注入 JS 语法错误 ---"
  cat "$WORK/jserr"
  exit 2
fi

env DSH_CAL_SNAPSHOT_DELAY=2 DSH_CAL_SNAP_JS="$JS" DSH_CAL_SNAP_EVAL="$EVAL" \
  "$APP" --snapshot "$PNG" >/dev/null 2>"$LOG" || true

LINE="$(grep -o 'EVAL .*' "$LOG" | tail -1 || true)"
echo "原始输出: ${LINE:-（无 EVAL 行）}"
if [[ -z "$LINE" || "$LINE" == *"EVAL nil"* || "$LINE" == *"EVAL undefined"* ]]; then
  echo "--- 自检日志尾部（注入的 JS 可能抛错）---"
  tail -25 "$LOG"
fi

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

const { W, idle, shown, hidden } = r;
const edge = (v) => v >= 8 && v <= 20;                 // 只留一条边
const full = (v) => v >= 170;                          // 盒子基本全露出来
const hitBox = (s) => /memoryBox|memory-box/u.test(String(s || ''));
const checks = [
  ['默认收起且没挂 open', idle && idle.open === false],
  ['默认只露一条边（8~20px）', idle && edge(idle.visible)],
  ['默认贴右缘（左边缘约 W-14）', idle && Math.abs(idle.left - (W - 14)) <= 3],
  ['默认 hover=false，滚轮不会被盒子抢走', idle && idle.hover === false],
  ['收起时感应区能命中盒子', hitBox(idle && idle.hit)],
  ['mouseenter 自动弹出并摊开', shown && shown.open === true && shown.hover === true],
  ['弹出后盒子基本完整可见', shown && full(shown.visible)],
  ['弹出后右缘内侧仍命中盒子（不会 mouseleave 抖动）', hitBox(shown && shown.hitEdge)],
  ['mouseleave 自动收起', hidden && hidden.open === false && hidden.hover === false],
  ['收起后回到只露一条边', hidden && edge(hidden.visible)],
];
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${name}`);
  if (!ok) failed += 1;
}
console.log(failed
  ? `✗ 右缘抽屉 FAIL：${failed} 条不满足`
  : '✓ 右缘抽屉 PASS：默认只露窄边、悬停自动弹出、移开自动收起');
process.exit(failed ? 1 : 0);
NODE
