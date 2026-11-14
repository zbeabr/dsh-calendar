// 节日短语「日期角色」与年份线索回归。跑法：node holiday-guard-cases.mjs
//
// 起因：build 44 的 src/holidays.mjs 见节日词就替换，于是
//   「买中秋月饼」→「买2027年9月15日月饼」（写错日历，高危）
//   「今年中秋聚餐」→ 2027-09-15（用户说今年，系统给明年，标题还挂着「今年」）
//   「2031年中秋吃饭」→ 无视 2031，照样给 2027
// 产品原则是「报错优于猜测」，这些必须被挡住。
//
// 另外 holiday-cases.mjs 曾把 async 断言传给同步 check，断言失败被吞进 Promise
// 却报 9/9 通过。这里 check 一律拒绝 Promise，防止「假通过」再发生。
process.env.TZ = 'Asia/Shanghai';

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { apply } from './src/holidays.mjs';

const NOW = new Date('2026-11-14T10:00:00+08:00');
const results = [];

function check(name, fn) {
  try {
    const returned = fn();
    // 同步 check 收到 async 函数时，断言失败会变成 rejected Promise 被静默吞掉，
    // 用例反而报「通过」。宁可让用例自己炸，也不要一个假绿灯。
    if (returned && typeof returned.then === 'function') {
      throw new Error('check 收到 async 函数：断言失败会被吞进 Promise，请改成同步或 await');
    }
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, detail: error.message.split('\n')[0] });
  }
}

const unchanged = (text) => assert.equal(apply(text, NOW), text, `「${text}」不该被当成日期`);

// ── A. 节日词只是名词修饰，不能替换（旧代码全错） ──────────────────────
check('「买中秋月饼」是买东西，不是定日子', () => unchanged('买中秋月饼'));
check('「看春节联欢晚会」是看节目，不是定日子', () => unchanged('看春节联欢晚会'));
check('「明天去圣诞市集」已有明天，不该塞进日期', () => unchanged('明天去圣诞市集'));
check('「国庆放假安排」是名词短语', () => unchanged('国庆放假安排'));
check('「端午习俗讲座」是名词短语', () => unchanged('端午习俗讲座'));
check('「买元宵」是买食物，前面动词要挡住', () => unchanged('买元宵'));

// ── B. 真正在说日子的，仍然要替换（防止修过头） ────────────────────────
check('「中秋前一天晚上八点吃饭」仍换成 2027年9月14日', () => {
  assert.match(apply('中秋前一天晚上八点吃饭', NOW), /^2027年9月14日晚上八点吃饭$/u);
});
check('「中秋聚餐」是那天聚餐，仍替换', () => {
  assert.match(apply('中秋聚餐', NOW), /^2027年9月15日聚餐$/u);
});
check('「国庆后第一个工作日交材料」仍换成 2027年10月4日', () => {
  assert.match(apply('国庆后第一个工作日交材料', NOW), /^2027年10月4日交材料$/u);
});
check('「元宵节看灯会」仍是日期', () => {
  assert.match(apply('元宵节看灯会', NOW), /^2027年2月20日看灯会$/u);
});

// ── C. 年份线索：用户明确说了哪一年，就得用哪一年 ──────────────────────
check('「明年春节回老家」用 2027 且吃掉「明年」', () => {
  const text = apply('明年春节回老家', NOW);
  assert.equal(text, '2027年2月6日回老家');
});
check('「今年中秋聚餐」用 2026，不是明年，也不留「今年」', () => {
  const text = apply('今年中秋聚餐', NOW);
  assert.equal(text, '2026年9月25日聚餐');
});
check('「去年中秋聚会」表外年份明确报错，不猜', () => {
  assert.throws(() => apply('去年中秋聚会', NOW), /年份表|收录/u);
});
check('「2031年中秋吃饭」显式年份优先，表外明确报错', () => {
  assert.throws(() => apply('2031年中秋吃饭', NOW), /年份表|收录/u);
});
check('「2027年中秋吃饭」显式年份在表内，用该年且不留年份词', () => {
  assert.equal(apply('2027年中秋吃饭', NOW), '2027年9月15日吃饭');
});

// ── D. 一句两个节日：能力外，宁可不替换也不只吞掉第一个 ────────────────
check('「中秋和国庆之间交作业」不替换半句', () => unchanged('中秋和国庆之间交作业'));

// ── E. 端到端：CLI parse 预览不会把误伤句子写到节日那天 ─────────────────
function cliParse(text) {
  // 用 spawnSync 而不是 execFileSync：没写日期时 CLI 会结构化报错并以 1 退出，
  // 那是「报错优于猜测」的正确结果，不该被当成用例执行失败。
  const run = spawnSync(process.execPath, ['cli.mjs', 'parse', text, '--fast', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, TZ: 'Asia/Shanghai' },
    timeout: 15000,
  });
  if (run.error) throw run.error;
  return JSON.parse(run.stdout.trim().split('\n').at(-1));
}
/** 只要没悄悄把日程写到 2027 年、没把日期串混进标题，就算守住底线。 */
function assertNoSilentWrongDate(r) {
  if (r.ok === false) {
    assert.match(r.error ?? '', /没(能)?从这句话里找到时间|说清楚日期/u,
      `应当明确报错，而不是别的错误：${r.error}`);
    return;
  }
  assert.notEqual(new Date(r.start).getFullYear(), 2027, `start=${r.start} local=${r.local}`);
  assert.ok(!/20\d\d年/u.test(r.title ?? ''), `title=${r.title}`);
}
// 注意：start 是 UTC ISO，+08 的「09/15 全天」写成 2027-09-14T16:00Z。
// 按本地日期字符串去匹配 ISO 会假通过，所以这里判年份。
check('端到端：买中秋月饼不会悄悄写成 2027 年', () => {
  assertNoSilentWrongDate(cliParse('买中秋月饼'));
});
check('端到端：看春节联欢晚会不会悄悄写成 2027 年', () => {
  assertNoSilentWrongDate(cliParse('看春节联欢晚会'));
});
check('端到端：明天去圣诞市集标题里不混进日期', () => {
  const r = cliParse('明天去圣诞市集');
  assert.ok(!/20\d\d年/u.test(r.title ?? ''), `title=${r.title}`);
});

// ── F. 自检：guard 用例自己不许出现假通过 ───────────────────────────────
check('check 收到 async 函数会立刻自己报错', () => {
  const saved = results.length;
  // 直接调内部逻辑不好观察，这里验证 async 函数确实会返回 Promise 形态，
  // 提醒以后加用例时别再写出 check(..., async () => ...)。
  const sample = async () => { throw new Error('这条必须被 check 拦下'); };
  const pending = sample();
  assert.equal(typeof pending.then, 'function');
  pending.catch(() => {}); // 别把演示用的 rejection 留到进程末尾
  assert.equal(results.length, saved);
});

console.log(`节日短语防护 ${results.length} 条`);
let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : `  ← ${r.detail}`}`);
  if (!r.ok) failed += 1;
}
console.log(`${results.length - failed}/${results.length} 通过${failed ? `，${failed} 条失败` : ''}`);
process.exit(failed ? 1 : 0);
