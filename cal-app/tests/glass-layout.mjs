// 液态玻璃视觉契约（纯 Node，零依赖）。
//
// 这些是「规格」，不是对当前实现的描述。每一条都对应一次真实的用户反馈：
//   ① 开玻璃模式后上半部金属像蒙了一层 → 任何铺满整窗 / 全屏的装饰层都不许有；
//   ② 边缘和中间透明度不一样 → tint 必须是单一均匀值，不许横向 / 纵向渐变；
//   ③ 参考图是「中心均匀 + 一圈明确的亮边」→ 亮边只能画在木板区的边上；
//   ④ 木板本身保持不透明（所有者 2026-11-13 拍板）。
//
// 跑法：node cal-app/tests/glass-layout.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '..', 'web', 'skeuo.html'), 'utf8');

function block(selector) {
  // selector 以 '{' 结尾：块起点就是它的最后一个字符，不能从它之后再找 '{'，
  // 否则会跳到下一个规则（曾经让两条断言假通过）。
  const key = selector.endsWith('{') ? selector : selector + '{';
  const at = css.indexOf(key);
  if (at < 0) return null;
  const open = at + key.length - 1;
  const close = css.indexOf('}', open);
  return close < 0 ? null : css.slice(open + 1, close);
}
const has = (selector) => css.includes(selector);
const text = (selector) => block(selector) ?? '';

const results = [];
function check(name, ok, why) {
  results.push({ name, ok, why });
}

// ① 上半部零影响
check('没有铺满全屏的 body::after 装饰层',
  !has('html.liquid-bg body::after{'),
  'fixed inset:0 的层会盖住 .chrome，金属材质就变了');
check('没有整窗 .app-window 装饰块',
  !has('html.liquid-bg .app-window{'),
  '整窗圆角 / inset 阴影会改掉金属顶边的观感');
check('底部雾层不含渐变',
  !text('html.liquid-bg .app-window::after{').includes('linear-gradient'),
  '上下渐变会让中心亮度不均');
check('.chrome 的 isolation 写在基础规则里',
  text('.chrome{').includes('isolation:isolate'),
  '两种模式必须走同一套混合，否则开关前后金属像素会变');
check('没有 liquid 专属的 .chrome 规则',
  !has('html.liquid-bg .chrome{'),
  '只在玻璃模式改 .chrome，等于给上半部加蒙版');

// ② 中心均匀
check('木板区 tint 不含任何渐变',
  !text('html.liquid-bg .plank-area{').includes('linear-gradient'),
  '36px 侧向渐变 + 上下 tint 渐变正是「边缘和中间透明度不一样」');
check('边缘伪元素不铺颜色填充',
  !/background\s*:/.test(text('html.liquid-bg .plank-area::after{')),
  '色散渐变属于填充，只在边缘画亮线 / 高光才对');
check('三档浓度只改一个 --tint 变量',
  !/--tint-top|--tint-bottom/.test(css)
    && [0, 1, 2].every((n) => /--tint\s*:/.test(text(`html.liquid-bg.glass-strength-${n} .plank-area{`))),
  '深浅可以有，但同一档里中心必须处处相同');

// ③ 边缘亮边
const edge = text('html.liquid-bg .plank-area::after{');
const alphas = [...edge.matchAll(/rgba\(255,\s*255,\s*255,\s*(\.\d+|\d*\.?\d+)\)/g)]
  .map((m) => Number(m[1]));
check('木板区有左右亮边且足够明显',
  /border-left\s*:/.test(edge) && /border-right\s*:/.test(edge)
    && alphas.some((a) => a >= 0.5),
  '参考图的胶囊靠一圈亮线认出玻璃，不是靠一片渐变');

// ④ 木板不透明（所有者拍板，写进规格防回归）
check('liquid 模式没有把木板改成半透明',
  !/html\.liquid-bg[^{]*\.plank\s*\{[^}]*opacity/.test(css)
    && !/html\.liquid-bg[^{]*\.plank\s*\{[^}]*rgba/.test(css),
  '木板本身保持不透明，玻璃只在木板背后 / 缝隙可见');

let failed = 0;
console.log(`液态玻璃视觉契约 ${results.length} 条`);
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `  ← ${r.why}`}`);
  if (!r.ok) failed += 1;
}
console.log(`${results.length - failed}/${results.length} 通过${failed ? `，${failed} 条失败` : ''}`);
process.exit(failed ? 1 : 0);
