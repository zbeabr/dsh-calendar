// 节假日 / 农历短语回归。跑法：node holiday-cases.mjs
// 表是数据，不是算法猜的：2026–2028 的传统节日公历日期按公开万年历核对内置，
// 每年需要更新一次；没收录的年份必须明确报错，不许瞎猜（产品原则：报错优于猜测）。
import assert from 'node:assert/strict';

const NOW = new Date('2026-11-14T10:00:00+08:00');
let holidays;
try {
  holidays = await import('./src/holidays.mjs');
} catch {
  holidays = null;
}
const { apply, resolve } = holidays ?? {};
const results = [];
function check(name, fn) {
  try {
    if (!holidays) throw new Error('src/holidays.mjs 还不存在');
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, detail: error.message.split('\n')[0] });
  }
}
const iso = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value));

check('「中秋」取下一个还没到的中秋：2027-09-15', () => {
  const hit = resolve('中秋', NOW);
  assert.equal(iso(hit.date), '2027-09-15');
});
check('「中秋前一天」= 2027-09-14', () => {
  assert.equal(iso(resolve('中秋前一天', NOW).date), '2027-09-14');
});
check('「春节」取下一个：2027-02-06', () => {
  assert.equal(iso(resolve('春节', NOW).date), '2027-02-06');
});
check('「元旦」是公历固定日 2027-01-01', () => {
  assert.equal(iso(resolve('元旦', NOW).date), '2027-01-01');
});
check('「国庆后第一个工作日」跳过周末', () => {
  const hit = resolve('国庆后第一个工作日', NOW);
  assert.equal(iso(hit.date), '2027-10-04');
  assert.equal(hit.date.getUTCDay(), 1, '应是周一');
});
check('「中秋晚上八点吃饭」替换后仍保留时间与标题', () => {
  const text = apply('中秋晚上八点吃饭', NOW);
  assert.match(text, /2027年9月15日/u);
  assert.match(text, /晚上八点吃饭/u);
  assert.ok(!text.includes('中秋'), '节日短语本身要被吃掉，别又进标题');
});
check('替换结果能被现有解析器直接吃下', async () => {
  const { parseEvent } = await import('./src/nlp.mjs');
  const text = apply('中秋前一天晚上八点吃饭', NOW);
  const parsed = parseEvent(text, NOW);
  assert.equal(parsed.start.toISOString(), '2027-09-14T12:00:00.000Z');
  assert.equal(parsed.title, '吃饭');
});
check('不含节日的普通句子不动', () => {
  const text = '明天下午三点在图书馆开会';
  assert.equal(apply(text, NOW), text);
  assert.equal(resolve(text, NOW), null);
});
check('超出收录年份必须报错，不猜', () => {
  assert.throws(() => resolve('中秋', new Date('2031-01-01T10:00:00+08:00')), /更新|收录|年份/u);
});

console.log(`节假日 / 农历短语 ${results.length} 条`);
let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `  ← ${r.detail}`}`);
  if (!r.ok) failed += 1;
}
console.log(`${results.length - failed}/${results.length} 通过${failed ? `，${failed} 条失败` : ''}`);
process.exit(failed ? 1 : 0);
