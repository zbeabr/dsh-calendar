// 常用地点回归。跑法：node places-cases.mjs
// 存储全部注入内存假实现，绝不碰用户真实的 config.json。
import assert from 'node:assert/strict';

let places;
try {
  places = await import('./src/places.mjs');
} catch {
  places = null;
}
const { normalizePlaces, learnPlaces, knownPlaces, extractKnownPlace } = places ?? {};
const results = [];
function check(name, fn) {
  try {
    if (!places) throw new Error('src/places.mjs 还不存在');
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, detail: error.message.split('\n')[0] });
  }
}

function fakeStore(initial = []) {
  let config = { recentPlaces: initial };
  return {
    read: () => config,
    write: (next) => { config = next; },
    current: () => config.recentPlaces,
  };
}

check('「在图书馆学习」把介词短语里的地点剥出来', () => {
  assert.deepEqual(extractKnownPlace('在图书馆学习', ['图书馆']), { title: '学习', location: '图书馆' });
});
check('「图书馆学习」没有介词也能认出常去的地方', () => {
  assert.deepEqual(extractKnownPlace('图书馆学习', ['图书馆']), { title: '学习', location: '图书馆' });
});
check('「去食堂吃饭」剥完标题还剩「吃饭」', () => {
  assert.deepEqual(extractKnownPlace('去食堂吃饭', ['食堂']), { title: '吃饭', location: '食堂' });
});
check('「图书馆学导论」不是地点，不能误伤', () => {
  assert.equal(extractKnownPlace('图书馆学导论', ['图书馆']), null);
});
check('词典里没有这个词就不动', () => {
  assert.equal(extractKnownPlace('在宿舍睡觉', ['图书馆']), null);
});
check('多个地点按最长匹配，别把「大学图书馆」切成「大学」', () => {
  assert.deepEqual(extractKnownPlace('在大学图书馆复习', ['大学', '大学图书馆']),
    { title: '复习', location: '大学图书馆' });
});
check('写过的地点去重、新的排前面、最多留 20 个', () => {
  const store = fakeStore(['宿舍']);
  const merged = learnPlaces(['图书馆', '宿舍', ' 图书馆 '], store);
  assert.deepEqual(merged, ['图书馆', '宿舍']);
  assert.deepEqual(knownPlaces(store), ['图书馆', '宿舍']);
  const many = learnPlaces(Array.from({ length: 25 }, (_, i) => `地点${i}`), store);
  assert.equal(many.length, 20);
});
check('没给地点时不动配置', () => {
  const store = fakeStore(['宿舍']);
  assert.deepEqual(learnPlaces([], store), ['宿舍']);
});

console.log(`常用地点 ${results.length} 条`);
let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `  ← ${r.detail}`}`);
  if (!r.ok) failed += 1;
}
console.log(`${results.length - failed}/${results.length} 通过${failed ? `，${failed} 条失败` : ''}`);
process.exit(failed ? 1 : 0);
