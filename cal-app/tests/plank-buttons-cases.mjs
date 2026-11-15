// 木板按钮左右顺序回归。跑法：node cal-app/tests/plank-buttons-cases.mjs
//
// 用户要求（第二次明确纠正）：「删除键位置不变，编辑键放在其左侧」。
// 两个按钮都是 position:absolute，DOM 顺序不决定视觉左右，真正决定的是 right 值：
// right 越大越靠左。
//   build 47 基线：.del=62px（用户认可的位置）/ .edit=40px → × 在左、✎ 在右，反了。
//   build 48 误把 .del 挪到 40px，超出要求（用户没让动删除键），已回退。
//   build 49：.del 保持 62px 原样；.edit 放到 82px（占距右 82~104），
//             与删除键（62~78）留 4px，左边离标签文字还有 2px。
//
// 这里锁四件事：删除键原位、编辑在左、不互相压住、不压标签/黄铜孔。
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

/** 取某条规则块里 `right:<n>px` 与 `width:<n>px` 的数值。
 *  只认「行首（可缩进）+ 选择器 + {」，避免命中注释里对选择器的文字提及。
 *  早期版本用 indexOf 且把 `{` 算进 selector，既会命中注释、又会跳到下一条规则。 */
function rule(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const m = new RegExp(`(?:^|\\n)[ \\t]*${esc}[ \\t]*\\{([^}]*)\\}`, 'u').exec(html);
  if (!m) return null;
  const body = m[1];
  const num = (prop) => {
    const m = new RegExp(`${prop}:\\s*(\\d+(?:\\.\\d+)?)px`, 'u').exec(body);
    return m ? Number(m[1]) : null;
  };
  return { body, right: num('right'), width: num('width') };
}

const edit = rule('.plank .edit');
const del = rule('.plank .del');

check('两个按钮的定位规则都在', () => {
  assert.ok(edit, '找不到 .plank .edit 规则');
  assert.ok(del, '找不到 .plank .del 规则');
  assert.ok(edit.right !== null && del.right !== null, 'right 值缺失');
  assert.ok(edit.width !== null && del.width !== null, 'width 值缺失');
});

check('删除键位置仍是 build 47 原值 62px（用户要求不许动）', () => {
  assert.equal(del.right, 62,
    `del.right=${del.right}px：删除键被挪动了，用户只要求移动编辑键`);
  assert.equal(del.width, 16, '删除键尺寸也不该变');
});

check('编辑在删除的左边（edit 的 right 必须大于 del）', () => {
  assert.ok(edit.right > del.right,
    `edit.right=${edit.right}px，del.right=${del.right}px：编辑还显示在删除右边`);
});

check('两个按钮不互相压住', () => {
  // 以木板右边缘为 0：edit 占 [edit.right, edit.right+edit.width]，
  // del 占 [del.right, del.right+del.width]（数值越大越靠左）。
  assert.ok(edit.right >= del.right + del.width,
    `edit.right=${edit.right} 应 >= del.right+del.width=${del.right + del.width}`);
});

check('按钮组不压到右侧文字/标签区', () => {
  const txt = rule('.plank .txt');
  assert.ok(txt, '找不到 .plank .txt 规则');
  const m = /padding:\s*0\s+(\d+)px\s+0\s+\d+px/u.exec(txt.body);
  assert.ok(m, '读不到 .txt 的右内边距');
  const paddingRight = Number(m[1]);
  const tag = rule('.plank .tag');
  const tagMargin = tag ? Number(/margin-right:\s*(\d+)px/u.exec(tag.body)?.[1] ?? 0) : 0;
  // 标签文字右边界离木板右边缘 = paddingRight + tag.margin-right；
  // 编辑键最左边界（离右边缘 edit.right+width）不能越过它。
  const labelEdge = paddingRight + tagMargin;
  const leftmost = edit.right + edit.width;
  assert.ok(labelEdge >= leftmost,
    `标签文字右边界 ${labelEdge}px < 编辑键最左边界 ${leftmost}px，会压到标签`);
});

check('DOM 里编辑按钮也排在删除前面', () => {
  const a = html.indexOf('class="edit"');
  const b = html.indexOf('class="del"');
  assert.ok(a > 0 && b > 0 && a < b, 'DOM 顺序不对，键盘 Tab 顺序会反');
});

check('两个按钮共用同一套悬停显现规则', () => {
  assert.match(html, /\.plank:hover \.edit\{opacity:1/u);
  assert.match(html, /\.plank:hover \.del\{opacity:1/u);
});

check('删除键保持原样：不靠 z-index 硬压黄铜孔', () => {
  // .del 回到 62px 后本来就避开铜环（.grommet.r 占距右约 24~48），
  // 不需要 build 48 那次加的 z-index；加回去等于又在改删除键。
  assert.ok(!/z-index/u.test(del.body),
    '.del 规则里出现了 z-index：删除键应保持 build 47 原样');
  assert.ok(del.right >= 52,
    `del.right=${del.right}px 太靠近右缘，会与黄铜孔（占距右 24~48）重叠`);
});

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `  ← ${r.detail}`}`);
  if (!r.ok) failed += 1;
}
console.log(`${results.length - failed}/${results.length} 通过${failed ? `，${failed} 条失败` : ''}`);
process.exit(failed ? 1 : 0);
