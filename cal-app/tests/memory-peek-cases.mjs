// 过去日程小盒子「右缘抽屉」回归。跑法：node cal-app/tests/memory-peek-cases.mjs
//
// 用户 2026-11-15：「帮我把那个装一大堆的木板的盒子自动收起到右下角的右侧边缘，
// 只留一个边边，鼠标过去的时候自动弹出来盒子」。
// 旧行为：盒子常驻右下角（right:24px、完整 188px 宽），要点一下盖子才摊开列表。
// 新行为：默认整只滑到窗口右侧外，只露 14px 黄铜边；鼠标进入感应区自动滑回来
// 并摊开列表，离开自动收起。展开后右边缘贴窗口边（right:0），否则鼠标可能落在
// 盒子右缘之外，滑出瞬间就触发 mouseleave，来回抖动。
//
// 纯静态契约，读 skeuo.html 文本，不碰用户配置。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(HERE, '..', 'web', 'skeuo.html'), 'utf8');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, detail: error.message.split('\n')[0] }); }
}

/** 取一条 CSS 规则的花括号内容；块起点就是 '{' 本身。 */
function block(selector) {
  const key = selector.endsWith('{') ? selector : `${selector}{`;
  const at = html.indexOf(key);
  if (at < 0) return null;
  const open = at + key.length - 1;
  const close = html.indexOf('}', open);
  return close < 0 ? null : html.slice(open + 1, close);
}

const boxCss = block('.memory-box') ?? '';
const openCss = block('.memory-box.open') ?? '';

// ── A. 收起态：贴右边缘、只露一条窄边 ─────────────────────────────
check('盒子贴在窗口右侧边缘（right:0），不是留 24px 悬在半空', () => {
  assert.ok(boxCss, '找不到 .memory-box 规则');
  assert.match(boxCss, /right:\s*0(?:px)?\b/u);
});

check('默认整只滑出屏幕，只留一条 8~20px 的边', () => {
  assert.match(boxCss, /transform:\s*translateX\(/u, '没有收起位移');
  // 按自身宽度算（calc(100% - Npx)），别硬编码 188px：盒子宽度以后变了也不会失效。
  const m = /translateX\(\s*calc\(100%\s*-\s*(\d+)px\)\s*\)/u.exec(boxCss);
  assert.ok(m, `收起位移不是 calc(100% - Npx)：${boxCss.slice(0, 120)}`);
  const peek = Number(m[1]);
  assert.ok(peek >= 8 && peek <= 20, `露出的边是 ${peek}px，用户要「只留一个边边」`);
});

check('滑出/滑回有 transform 过渡，不是瞬移', () => {
  assert.match(boxCss, /transition:\s*transform\s+/u);
});

check('展开态盒子回到窗口内（translateX(0)）', () => {
  assert.ok(openCss, '找不到 .memory-box.open 规则');
  assert.match(openCss, /transform:\s*translateX\(0\)/u);
});

// ── B. 鼠标过去的入口要够宽、看得见 ───────────────────────────────
check('右缘有透明感应区，不用精确瞄准那条窄边', () => {
  const before = block('.memory-box::before') ?? '';
  assert.ok(before, '缺少 ::before 感应区');
  assert.match(before, /content:\s*""|content:\s*''/u);
  assert.match(before, /background:\s*transparent/u, '热区必须透明，不能盖一块色板');
  const left = /left:\s*-(\d+)px/u.exec(before);
  const width = /width:\s*(\d+)px/u.exec(before);
  assert.ok(left && width, '读不到热区范围');
  assert.ok(Number(width[1]) >= 20, `感应区只有 ${width[1]}px，太窄`);
  assert.ok(Math.abs(Number(left[1]) - Number(width[1])) <= 2,
    '热区要从盒子左缘往屏幕内延伸，不能偏到别处');
});

check('收起时露出黄铜边作指引，展开后淡出', () => {
  const after = block('.memory-box::after') ?? '';
  assert.ok(after, '缺少 ::after 把手');
  assert.match(after, /linear-gradient|#f0d79a/u, '把手要有可见材质');
  assert.match(block('.memory-box.open::after') ?? '', /opacity:\s*0/u);
});

// ── C. 自动开合，且不与内层滚动打架 ───────────────────────────────
check('鼠标进入自动弹出、离开自动收起', () => {
  assert.match(html, /function dshMemorySet/u);
  assert.match(html, /mouseenter[\s\S]{0,220}?dshMemorySet\(true\)/u);
  assert.match(html, /mouseleave[\s\S]{0,220}?dshMemorySet\(false\)/u);
  assert.match(html, /window\.dshMemorySet\s*=/u, '离屏自检要能显式注入开合');
});

check('旧的「点一下盖子才开」已移除，避免 hover 打开后点一下又关上', () => {
  assert.ok(!/classList\.toggle\('open'\)/u.test(html),
    '还留着无参 toggle：鼠标在盒子上点一下会把刚弹出的盒子关掉');
});

check('hover 状态仍与内层滚动共用，收起时滚轮回到整页', () => {
  const at = html.indexOf('window.dshScroll = function');
  const ds = at < 0 ? '' : html.slice(at, at + 1600);
  assert.match(ds, /dshMemoryHover/u);
  assert.match(ds, /classList\.contains\(['"]open['"]\)/u);
  assert.match(html, /window\.dshMemoryHover\s*=\s*false/u);
});

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `  ← ${r.detail}`}`);
  if (!r.ok) failed += 1;
}
console.log(`${results.length - failed}/${results.length} 通过${failed ? `，${failed} 条失败` : ''}`);
process.exit(failed ? 1 : 0);
