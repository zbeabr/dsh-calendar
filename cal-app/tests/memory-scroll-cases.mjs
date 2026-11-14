// 过去日程小盒子「内部能上下滑动」的接线契约：纯读源码文本，零依赖。
//
// 根因（2026-11-14 实测）：原生 installScrollForwarder() 把窗口里**所有**滚轮事件
// 吞掉，只调 window.dshScroll(dy)；而 dshScroll 只滚 window，从来不碰
// .memory-list 的 scrollTop。所以鼠标放在展开的盒子上滑动，动的是整页，
// 盒子内部纹丝不动 —— 用户原话「按了那个盒子内部不能上下滑动」。
//
// 跑法：node cal-app/tests/memory-scroll-cases.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = readFileSync(join(root, 'cal-app', 'web', 'skeuo.html'), 'utf8');
const swift = readFileSync(join(root, 'cal-app', 'App.swift'), 'utf8');

const results = [];
function check(name, ok, why) { results.push({ name, ok: Boolean(ok), why }); }

/** 取一条 CSS 规则的花括号内容；块起点就是 '{' 本身，别再往后找（踩过假通过）。 */
function block(selector) {
  const key = selector.endsWith('{') ? selector : `${selector}{`;
  const at = html.indexOf(key);
  if (at < 0) return null;
  const open = at + key.length - 1;
  const close = html.indexOf('}', open);
  return close < 0 ? null : html.slice(open + 1, close);
}
const listCss = block('.memory-list') ?? '';
const dsAt = html.indexOf('window.dshScroll = function');
const dsBody = dsAt < 0 ? '' : html.slice(dsAt, dsAt + 1600);

// ① 保住既有能力：列表本身要能滚、页面滚动转发器还在
check('列表仍是 overflow:auto 的独立滚动容器', /overflow(-y)?\s*:\s*auto/u.test(listCss),
  '别为了修滚动把内层容器改成 visible');
check('原生滚轮转发器仍在（页面滚动不能回退）', /installScrollForwarder\(\)/u.test(swift),
  '删掉它整页又不滚了');

// ② 滚轮必须优先喂给盒子内层
check('dshScroll 里有内层列表分支', /memoryList|memory-list/u.test(dsBody),
  '滚轮现在只滚 window，盒子收不到');
check('滚轮目标由「鼠标在盒子上」决定', /dshMemoryHover|memoryHover/u.test(dsBody),
  '没有 hover 判断，盒子没展开时也会抢走整页滚轮');
check('盒子有 mouseenter / mouseleave 维护悬停态',
  /mouseenter/u.test(html) && /mouseleave/u.test(html) && /memoryBox/u.test(html),
  '自检与真机都靠这个状态判断滚轮该给谁');
check('悬停态可被自检注入', /window\.dshMemoryHover/u.test(html),
  '离屏自检没有真鼠标，需要能显式设 hover');

// ③ 滚到头不要把整页带走
// 不能只搜 /return/：原函数开头「参数不是数字就 return」会让断言假通过。
// 这里要求 return 紧跟着内层分支，才真的表示「这一次滚轮已被盒子消费」。
check('内层吃掉的滚轮不叠加到整页', /dshMemoryHover[\s\S]{0,800}?return/u.test(dsBody),
  '内外一起滚会变成双倍，手感更怪');
check('盒子收起时不抢整页滚轮', /classList\.contains\(['"]open['"]\)/u.test(dsBody),
  '收起状态下滚轮必须回到整页，否则背后木板再也滚不动');
check('列表声明 overscroll-behavior:contain', /overscroll-behavior\s*:\s*contain/u.test(listCss),
  '拖滚动条到头时滚动链会传给整页');

// ④ 得看得见「这里能滚」
check('列表显式声明 scrollbar-width', /scrollbar-width\s*:\s*thin/u.test(listCss),
  'html/body 隐藏了滚动条，内层要显式拿回自己的');
// 只认 .memory-list 自己那条，别把 html/body 的「隐藏滚动条」当成已有样式。
check('列表有专属的可见滚动条样式', /\.memory-list::-(webkit|moz)-scrollbar/u.test(html),
  '没有滚动条，用户看不出这里能滑/能拖');

// ⑤ 真机定量自检通道
check('--snapshot 有 EVAL 回传通道', /DSH_CAL_SNAP_EVAL/u.test(swift),
  '没有它就没法量 scrollTop，只能靠眼睛猜');

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `  ← ${r.why}`}`);
  if (!r.ok) failed += 1;
}
console.log(`${results.length - failed}/${results.length} 通过${failed ? `，${failed} 条失败` : ''}`);
process.exit(failed ? 1 : 0);
