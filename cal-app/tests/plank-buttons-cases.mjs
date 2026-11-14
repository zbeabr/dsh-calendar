// 木板按钮左右顺序回归。跑法：node cal-app/tests/plank-buttons-cases.mjs
//
// 用户反馈：「木板上的编辑按钮应该放在删除的左边」。
// 两个按钮都是 position:absolute，DOM 顺序不决定视觉左右，真正决定的是 right 值：
// right 越大越靠左。build 47 的 .del=62px / .edit=40px，所以显示成
// 「× 在左、✎ 在右」，正好反了。
//
// 这里同时锁三件事：顺序、不互相压住、不压到右侧标签/黄铜孔。
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

check('编辑在删除的左边（edit 的 right 必须大于 del）', () => {
  assert.ok(edit.right > del.right,
    `edit.right=${edit.right}px，del.right=${del.right}px：编辑还显示在删除右边`);
});

check('两个按钮不互相压住', () => {
  // 以木板右边缘为 0：edit 占 [-edit.right-edit.width, -edit.right]，
  // del 占 [-del.right-del.width, -del.right]。edit 整体在 del 左侧才不重叠。
  assert.ok(edit.right >= del.right + del.width,
    `edit.right=${edit.right} 应 >= del.right+del.width=${del.right + del.width}`);
});

check('按钮组不压到右侧文字/标签区', () => {
  const txt = rule('.plank .txt');
  assert.ok(txt, '找不到 .plank .txt 规则');
  const m = /padding:\s*0\s+(\d+)px\s+0\s+\d+px/u.exec(txt.body);
  assert.ok(m, '读不到 .txt 的右内边距');
  const paddingRight = Number(m[1]);
  // 文字区右边界离木板右边缘 paddingRight；最左的按钮不能越过它。
  const leftmost = edit.right + edit.width;
  assert.ok(paddingRight >= leftmost,
    `右内边距 ${paddingRight}px 小于按钮组最左边界 ${leftmost}px，会压到标签`);
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

check('两个按钮都压过右侧黄铜孔，不会被盖住半边', () => {
  // .grommet 是 z-index:2；.del 旧版没有 z-index，移到右边后被铜环压住。
  const grommet = rule('.grommet');
  assert.ok(grommet, '找不到 .grommet 规则');
  const z = (r) => {
    const m = /z-index:\s*(\d+)/u.exec(r.body);
    return m ? Number(m[1]) : 0;
  };
  const hole = z(grommet);
  assert.ok(z(edit) > hole, `edit z-index=${z(edit)} 未超过铜环 ${hole}`);
  assert.ok(z(del) > hole, `del z-index=${z(del)} 未超过铜环 ${hole}`);
});

let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `  ← ${r.detail}`}`);
  if (!r.ok) failed += 1;
}
console.log(`${results.length - failed}/${results.length} 通过${failed ? `，${failed} 条失败` : ''}`);
process.exit(failed ? 1 : 0);
